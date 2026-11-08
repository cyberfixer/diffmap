import { Node, Project, SyntaxKind, ts } from "ts-morph";
import type {
  CallGraphInput,
  CallGraphPort,
  CallGraphResult,
} from "../../../application/ports/call-graph.port.js";
import type { GraphEdge, GraphNode } from "../../../domain/graph.js";
import { CallCollector, walkNeighbourhood } from "../../../application/call-graph-walk.js";
import { listSymbolNodes } from "./symbols.js";

export class TsMorphCallGraph implements CallGraphPort {
  readonly supportedExtensions = [".ts", ".tsx"] as const;

  isExact(): boolean {
    return true; // the TypeScript type checker resolves every call
  }

  build(input: CallGraphInput): CallGraphResult {
    // Load the whole repo at head into memory so the type checker can resolve
    // calls across files (this.service.update() -> Service.update).
    const project = new Project({
      useInMemoryFileSystem: true,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        experimentalDecorators: true,
        jsx: ts.JsxEmit.Preserve,
      },
    });
    for (const f of input.files) {
      project.createSourceFile("/" + f.path, f.source, { overwrite: true });
    }

    // Index every symbol by its AST node.
    const idOf = new Map<Node, string>();
    const meta = new Map<string, GraphNode>();
    const linesOf = new Map<string, string[]>();
    for (const sf of project.getSourceFiles()) {
      const file = sf.getFilePath().replace(/^\//, "");
      linesOf.set(file, sf.getFullText().split("\n").map((l) => l.replace(/\r$/, "")));
      for (const sn of listSymbolNodes(sf)) {
        const id = `${file}#${sn.info.name}`;
        if (meta.has(id)) continue; // overloads: keep the first
        idOf.set(sn.node, id);
        meta.set(id, {
          id,
          file,
          name: sn.info.name,
          kind: sn.info.kind,
          changed: false,
          line: sn.info.range.start,
          endLine: sn.info.range.end,
          labels: sn.labels,
        });
      }
    }

    const removedByName = new Map<string, string[]>();
    for (const r of input.removed) {
      const simple = r.name.split(".").pop()!;
      removedByName.set(simple, [...(removedByName.get(simple) ?? []), r.id]);
    }

    // Resolve every call / new expression to the symbol it targets.
    const collector = new CallCollector();
    const addEdge = (from: string, to: string, kind: GraphEdge["kind"], call: Node): void => {
      const line = call.getStartLineNumber();
      const file = call.getSourceFile().getFilePath().replace(/^\//, "");
      collector.add(from, to, kind, line, linesOf.get(file)?.[line - 1] ?? "");
    };

    for (const sf of project.getSourceFiles()) {
      const exprs = [
        ...sf.getDescendantsOfKind(SyntaxKind.CallExpression),
        ...sf.getDescendantsOfKind(SyntaxKind.NewExpression),
      ];
      for (const call of exprs) {
        const from = enclosingSymbol(call, idOf);
        if (!from) continue;

        const target = call.getExpression();
        let sym = target.getSymbol();
        if (sym?.isAlias()) sym = sym.getAliasedSymbol() ?? sym;
        const decls = sym?.getDeclarations() ?? [];

        const to = decls.map((d) => idOf.get(d)).find((id) => id !== undefined);
        if (to) {
          addEdge(from, to, "calls", call);
        } else if (decls.length === 0) {
          // Unresolved: if the name matches a removed symbol, it is probably
          // a call to code this diff deleted.
          const name = Node.isPropertyAccessExpression(target)
            ? target.getName()
            : Node.isIdentifier(target)
              ? target.getText()
              : undefined;
          for (const removedId of (name && removedByName.get(name)) || []) {
            addEdge(from, removedId, "calls-removed", call);
          }
        }
      }
    }

    return walkNeighbourhood({ meta, linesOf, calls: collector.calls, changedIds: input.changedIds, depth: input.depth });
  }
}

/** Innermost symbol that contains the node, or null at module top level. */
function enclosingSymbol(node: Node, idOf: Map<Node, string>): string | null {
  let cur: Node | undefined = node;
  while (cur) {
    const id = idOf.get(cur);
    if (id) return id;
    cur = cur.getParent();
  }
  return null;
}
