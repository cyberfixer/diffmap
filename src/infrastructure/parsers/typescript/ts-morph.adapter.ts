import { Project, Node, SyntaxKind, type SourceFile } from "ts-morph";
import type { SymbolParserPort, SymbolParserInput } from "../../../application/ports/symbol-parser.port.js";
import type { ChangedSymbol, ChangeStatus, LineRange, SymbolKind } from "../../../domain/symbol.js";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  range: LineRange;
}

interface SymbolCollection {
  named: Map<string, SymbolInfo>;
  topLevelCount: number;
}

// ---------------------------------------------------------------------------
// Port implementation
// ---------------------------------------------------------------------------

export class TsMorphAdapter implements SymbolParserPort {
  readonly supportedExtensions = [".ts", ".tsx"] as const;

  parse(input: SymbolParserInput): ChangedSymbol[] {
    const { filePath, removedLines, addedLines, baseSource, headSource } = input;

    const baseSymbols = collectSymbols(baseSource, removedLines);
    const headSymbols = collectSymbols(headSource, addedLines);

    const results: ChangedSymbol[] = [];

    // Merge named symbols by name
    const allNames = new Set([
      ...baseSymbols.named.keys(),
      ...headSymbols.named.keys(),
    ]);

    for (const name of allNames) {
      const inBase = baseSymbols.named.get(name);
      const inHead = headSymbols.named.get(name);

      const status: ChangeStatus =
        inBase && inHead ? "modified" : inHead ? "added" : "removed";

      results.push({
        file: filePath,
        name,
        kind: (inHead ?? inBase!).kind,
        status,
        baseRange: inBase?.range ?? null,
        headRange: inHead?.range ?? null,
      });
    }

    // Top-level changes: only emit when there are no named hits in this file,
    // to avoid noise from import/decorator lines changing alongside methods.
    if (results.length === 0) {
      const hasBaseTopLevel = baseSymbols.topLevelCount > 0;
      const hasHeadTopLevel = headSymbols.topLevelCount > 0;

      if (hasBaseTopLevel || hasHeadTopLevel) {
        const status: ChangeStatus =
          hasBaseTopLevel && hasHeadTopLevel
            ? "modified"
            : hasHeadTopLevel
              ? "added"
              : "removed";
        results.push({
          file: filePath,
          name: filePath,
          kind: "top-level",
          status,
          baseRange: null,
          headRange: null,
        });
      }
    }

    return results;
  }
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

function collectSymbols(
  source: string | null,
  lines: Set<number>
): SymbolCollection {
  if (!source || lines.size === 0) {
    return { named: new Map(), topLevelCount: 0 };
  }

  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile("__analysis__.ts", source);

  const named = new Map<string, SymbolInfo>();
  let topLevelCount = 0;

  for (const line of lines) {
    const sym = findSymbolAtLine(sourceFile, line);
    if (sym) {
      if (!named.has(sym.name)) named.set(sym.name, sym);
    } else {
      topLevelCount++;
    }
  }

  return { named, topLevelCount };
}

function findSymbolAtLine(
  sourceFile: SourceFile,
  line: number
): SymbolInfo | null {
  let best: { info: SymbolInfo; size: number } | undefined;

  function visit(node: Node): void {
    let kind: SymbolKind | null = null;
    let name: string | null = null;

    if (Node.isFunctionDeclaration(node)) {
      name = node.getName() ?? null;
      if (name) kind = "function";
    } else if (Node.isMethodDeclaration(node)) {
      name = buildMethodName(node);
      kind = "method";
    } else if (Node.isConstructorDeclaration(node)) {
      const cls = node.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
      name = cls?.getName() ? `${cls.getName()}.constructor` : "constructor";
      kind = "method";
    } else if (Node.isClassDeclaration(node)) {
      name = node.getName() ?? null;
      if (name) kind = "class";
    } else if (Node.isVariableDeclaration(node)) {
      const init = node.getInitializer();
      if (init && Node.isArrowFunction(init)) {
        name = buildVariableName(node);
        kind = "arrow";
      }
    }

    if (kind !== null && name !== null) {
      const start = node.getStartLineNumber();
      const end = node.getEndLineNumber();
      if (start <= line && line <= end) {
        const size = end - start;
        if (!best || size < best.size) {
          best = { info: { name, kind, range: { start, end } }, size };
        }
      }
    }

    node.forEachChild(visit);
  }

  visit(sourceFile);
  return best?.info ?? null;
}

function buildMethodName(node: Node): string {
  const methodName = Node.isMethodDeclaration(node) ? node.getName() : "";
  const cls = node.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
  return cls?.getName() ? `${cls.getName()}.${methodName}` : methodName;
}

function buildVariableName(node: Node): string {
  const varName = Node.isVariableDeclaration(node) ? node.getName() : "";
  const cls = node.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
  return cls?.getName() ? `${cls.getName()}.${varName}` : varName;
}
