import { Node, Project, SyntaxKind, ts } from "ts-morph";
import type {
  CallGraphInput,
  CallGraphPort,
  CallGraphResult,
} from "../../../application/ports/call-graph.port.js";
import type { CallSite, GraphEdge, GraphNode } from "../../../domain/graph.js";
import { listSymbolNodes } from "./symbols.js";

export class TsMorphCallGraph implements CallGraphPort {
  readonly supportedExtensions = [".ts", ".tsx"] as const;

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
    const calls = new Map<string, GraphEdge & { sites: CallSite[] }>();
    const addEdge = (from: string, to: string, kind: GraphEdge["kind"], call: Node): void => {
      if (from === to) return;
      const key = `${from}>${to}>${kind}`;
      const edge = calls.get(key) ?? calls.set(key, { from, to, kind, sites: [] }).get(key)!;
      const line = call.getStartLineNumber();
      if (edge.sites.some((s) => s.line === line)) return;
      const file = call.getSourceFile().getFilePath().replace(/^\//, "");
      edge.sites.push({ line, text: linesOf.get(file)?.[line - 1] ?? "" });
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

    // Walk outward from the changed symbols, `depth` hops each direction.
    const out = new Map<string, Set<string>>();
    const inn = new Map<string, Set<string>>();
    for (const e of calls.values()) {
      if (e.kind !== "calls") continue;
      (out.get(e.from) ?? out.set(e.from, new Set()).get(e.from)!).add(e.to);
      (inn.get(e.to) ?? inn.set(e.to, new Set()).get(e.to)!).add(e.from);
    }

    const changed = new Set(input.changedIds.filter((id) => meta.has(id)));
    const included = new Set(changed);
    const edges = new Map<string, GraphEdge>();
    const keep = (from: string, to: string): void => {
      const key = `${from}>${to}>calls`;
      edges.set(key, calls.get(key)!);
    };

    for (const direction of ["callees", "callers"] as const) {
      let frontier = new Set(changed);
      for (let hop = 0; hop < input.depth; hop++) {
        const next = new Set<string>();
        for (const id of frontier) {
          const neighbours = (direction === "callees" ? out : inn).get(id) ?? [];
          for (const n of neighbours) {
            if (direction === "callees") keep(id, n);
            else keep(n, id);
            if (!included.has(n)) next.add(n);
            included.add(n);
          }
        }
        frontier = next;
      }
    }

    // Calls into removed symbols always show, with their callers.
    for (const e of calls.values()) {
      if (e.kind !== "calls-removed") continue;
      edges.set(`${e.from}>${e.to}>${e.kind}`, e);
      included.add(e.from);
    }

    const nodes: GraphNode[] = [];
    for (const id of included) {
      const n = meta.get(id);
      if (!n) continue;
      const isChanged = changed.has(id);
      // Unchanged neighbours carry their whole source, so the report can show
      // a caller outside the diff in full.
      const code = isChanged
        ? undefined
        : linesOf.get(n.file)?.slice(n.line - 1, n.endLine ?? n.line);
      nodes.push({ ...n, changed: isChanged, ...(code ? { code } : {}) });
    }

    return { nodes, edges: [...edges.values()] };
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
