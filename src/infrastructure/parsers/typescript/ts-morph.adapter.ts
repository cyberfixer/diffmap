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

/** Everything we learned about one side (base or head) of a file. */
interface SideAnalysis {
  /** Every named symbol that exists in the full file on this side. */
  all: Map<string, SymbolInfo>;
  /** Names of symbols containing at least one changed line on this side. */
  touched: Set<string>;
  /** Number of changed lines that fall outside every named symbol. */
  topLevelCount: number;
}

// ---------------------------------------------------------------------------
// Port implementation
// ---------------------------------------------------------------------------

export class TsMorphAdapter implements SymbolParserPort {
  readonly supportedExtensions = [".ts", ".tsx"] as const;

  parse(input: SymbolParserInput): ChangedSymbol[] {
    const { filePath, removedLines, addedLines, baseSource, headSource } = input;

    const base = analyzeSide(baseSource, removedLines);
    const head = analyzeSide(headSource, addedLines);

    const results: ChangedSymbol[] = [];

    // A symbol is "changed" if any of its lines changed on either side.
    // Its status comes from whether it exists in the WHOLE file on each side,
    // not from which side its changed lines were on.
    const changedNames = new Set([...base.touched, ...head.touched]);

    for (const name of changedNames) {
      const inBase = base.all.get(name);
      const inHead = head.all.get(name);
      const info = (inHead ?? inBase)!;

      const status: ChangeStatus =
        inBase && inHead ? "modified" : inHead ? "added" : "removed";

      results.push({
        file: filePath,
        name,
        kind: info.kind,
        status,
        baseRange: inBase?.range ?? null,
        headRange: inHead?.range ?? null,
      });
    }

    // Top-level changes: only emit when there are no named hits in this file,
    // to avoid noise from import/decorator lines changing alongside methods.
    if (results.length === 0) {
      const hasBaseTopLevel = base.topLevelCount > 0;
      const hasHeadTopLevel = head.topLevelCount > 0;

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

function analyzeSide(source: string | null, lines: Set<number>): SideAnalysis {
  const result: SideAnalysis = {
    all: new Map(),
    touched: new Set(),
    topLevelCount: 0,
  };
  if (!source) return result;

  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile("__analysis__.ts", source);

  const symbols = listSymbols(sourceFile);
  for (const sym of symbols) {
    if (!result.all.has(sym.name)) result.all.set(sym.name, sym);
  }

  for (const line of lines) {
    const sym = innermostAtLine(symbols, line);
    if (sym) result.touched.add(sym.name);
    else result.topLevelCount++;
  }

  return result;
}

/** Collect every named function / method / class / arrow-variable in the file. */
function listSymbols(sourceFile: SourceFile): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];

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
      symbols.push({
        name,
        kind,
        range: { start: node.getStartLineNumber(), end: node.getEndLineNumber() },
      });
    }

    node.forEachChild(visit);
  }

  visit(sourceFile);
  return symbols;
}

/** Smallest symbol whose range contains the line, or null if none does. */
function innermostAtLine(symbols: SymbolInfo[], line: number): SymbolInfo | null {
  let best: SymbolInfo | null = null;
  for (const sym of symbols) {
    if (sym.range.start <= line && line <= sym.range.end) {
      if (!best || sym.range.end - sym.range.start < best.range.end - best.range.start) {
        best = sym;
      }
    }
  }
  return best;
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
