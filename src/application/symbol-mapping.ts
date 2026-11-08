import type { SymbolParserInput } from "./ports/symbol-parser.port.js";
import type { ChangedSymbol, ChangeStatus, DiffLine, LineRange, SymbolInfo } from "../domain/symbol.js";

/** Everything we learned about one side (base or head) of a file. */
interface SideAnalysis {
  all: Map<string, SymbolInfo>; // every named symbol in the whole file on this side
  touched: Set<string>; // names of symbols containing at least one changed line
  topLevelCount: number; // changed lines outside every named symbol
}

/**
 * Map a file's changed lines to the symbols that contain them. Language-neutral:
 * each language only provides `listSymbols`, which finds the symbols in a source text.
 *
 * A symbol's status comes from whether it exists in the WHOLE file on each side,
 * not from which side its changed lines were on.
 */
export function mapChangesToSymbols(
  input: SymbolParserInput,
  listSymbols: (source: string) => SymbolInfo[],
): ChangedSymbol[] {
  const { filePath, removedLines, addedLines, diffLines, baseSource, headSource } = input;
  const base = analyzeSide(baseSource, removedLines, listSymbols);
  const head = analyzeSide(headSource, addedLines, listSymbols);
  const results: ChangedSymbol[] = [];

  for (const name of new Set([...base.touched, ...head.touched])) {
    const inBase = base.all.get(name);
    const inHead = head.all.get(name);
    const info = (inHead ?? inBase)!;
    const status: ChangeStatus = inBase && inHead ? "modified" : inHead ? "added" : "removed";
    results.push({
      id: `${filePath}#${name}`,
      file: filePath,
      name,
      kind: info.kind,
      status,
      baseRange: inBase?.range ?? null,
      headRange: inHead?.range ?? null,
      diff: sliceDiff(diffLines, inBase?.range ?? null, inHead?.range ?? null),
    });
  }

  // Top-level changes: only when no named symbol was hit, to avoid noise from
  // import lines changing alongside functions.
  if (results.length === 0 && (base.topLevelCount > 0 || head.topLevelCount > 0)) {
    const b = base.topLevelCount > 0;
    const h = head.topLevelCount > 0;
    results.push({
      id: `${filePath}#top-level`,
      file: filePath,
      name: filePath,
      kind: "top-level",
      status: b && h ? "modified" : h ? "added" : "removed",
      baseRange: null,
      headRange: null,
      diff: diffLines.filter((l) => l.type !== "ctx"),
    });
  }
  return results;
}

function analyzeSide(
  source: string | null,
  lines: Set<number>,
  listSymbols: (source: string) => SymbolInfo[],
): SideAnalysis {
  const result: SideAnalysis = { all: new Map(), touched: new Set(), topLevelCount: 0 };
  if (!source) return result;
  const symbols = listSymbols(source);
  for (const sym of symbols) if (!result.all.has(sym.name)) result.all.set(sym.name, sym);
  for (const line of lines) {
    const sym = innermostAtLine(symbols, line);
    if (sym) result.touched.add(sym.name);
    else result.topLevelCount++;
  }
  return result;
}

/** Smallest symbol whose range contains the line, or null if none does. */
export function innermostAtLine<T extends { range: LineRange }>(symbols: T[], line: number): T | null {
  let best: T | null = null;
  for (const sym of symbols) {
    if (sym.range.start <= line && line <= sym.range.end) {
      if (!best || sym.range.end - sym.range.start < best.range.end - best.range.start) best = sym;
    }
  }
  return best;
}

const inRange = (n: number, r: LineRange): boolean => r.start <= n && n <= r.end;

/** Keep the diff lines that fall inside the symbol on either side. */
function sliceDiff(lines: DiffLine[], baseRange: LineRange | null, headRange: LineRange | null): DiffLine[] {
  return lines.filter((l) => {
    if (l.newLine !== null && headRange && inRange(l.newLine, headRange)) return true;
    return l.type === "del" && l.oldLine !== null && baseRange !== null && inRange(l.oldLine, baseRange);
  });
}
