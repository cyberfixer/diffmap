import type { SymbolParserInput } from "./ports/symbol-parser.port.js";
import type { ChangedSymbol, ChangeStatus, DiffLine, LineRange, SymbolInfo } from "../domain/symbol.js";

/** Everything we learned about one side (base or head) of a file. */
interface SideAnalysis {
  all: Map<string, SymbolInfo>; // every named symbol in the whole file on this side
  named: Map<string, SymbolInfo[]>; // the same, with every symbol of a name (overloads that differ by type share one)
  touched: Map<string, SymbolInfo>; // by name, the symbols containing at least one changed line
  topLevelCount: number; // changed lines outside every named symbol
}

/**
 * Map a file's changed lines to the symbols that contain them. Language-neutral:
 * each language only provides `listSymbols`, which finds the symbols in a source text.
 *
 * A symbol's status comes from whether it exists in the WHOLE file on each side,
 * not from which side its changed lines were on.
 *
 * `sameAs`: for languages whose names carry the signature (Swift's `load(_:cache:)`),
 * the part of a name that stays when the signature changes ("load"). A symbol
 * that is gone under its old name and new under another with the same part is
 * then one modified symbol, not a removed and an added one.
 */
export function mapChangesToSymbols(
  input: SymbolParserInput,
  listSymbols: (source: string) => SymbolInfo[],
  sameAs?: (name: string) => string,
): ChangedSymbol[] {
  const { filePath, removedLines, addedLines, diffLines, baseSource, headSource } = input;
  const base = analyzeSide(baseSource, removedLines, listSymbols);
  const head = analyzeSide(headSource, addedLines, listSymbols);
  const results: ChangedSymbol[] = [];

  // The one symbol on the other side that `name` (found on `here`) was or became, if it is clear which.
  const twin = (name: string, here: SideAnalysis, there: SideAnalysis): SymbolInfo | undefined => {
    if (!sameAs || there.all.has(name)) return undefined;
    const key = sameAs(name);
    const only = (side: SideAnalysis, other: SideAnalysis) => [...side.all.values()].filter((s) => sameAs(s.name) === key && !other.all.has(s.name));
    const [mine, theirs] = [only(here, there), only(there, here)];
    return mine.length === 1 && theirs.length === 1 ? theirs[0] : undefined;
  };
  // Report a symbol whose signature changed under its new name only.
  const current = (name: string) => (base.all.has(name) ? twin(name, base, head)?.name ?? name : name);

  // Of several symbols with one name, the one the change is in; on the other side, the one in the same place among them.
  const samePlace = (sym: SymbolInfo, here: SideAnalysis, there: SideAnalysis): SymbolInfo | undefined =>
    there.named.get(sym.name)?.[here.named.get(sym.name)?.indexOf(sym) ?? 0];

  for (const name of new Set([...base.touched.keys(), ...head.touched.keys()].map(current))) {
    const touchedBase = base.touched.get(name);
    const touchedHead = head.touched.get(name);
    const inHead = touchedHead ?? (touchedBase && samePlace(touchedBase, base, head)) ?? head.all.get(name);
    const inBase =
      touchedBase ?? (touchedHead && samePlace(touchedHead, head, base)) ?? base.all.get(name) ?? (inHead ? twin(name, head, base) : undefined);
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
  const result: SideAnalysis = { all: new Map(), named: new Map(), touched: new Map(), topLevelCount: 0 };
  if (!source) return result;
  const symbols = listSymbols(source);
  for (const sym of symbols) {
    if (!result.all.has(sym.name)) result.all.set(sym.name, sym);
    result.named.set(sym.name, [...(result.named.get(sym.name) ?? []), sym]);
  }
  for (const line of lines) {
    const sym = innermostAtLine(symbols, line);
    // Two symbols can share a name (overloads that differ by type): the one holding the change counts.
    if (sym && !result.touched.has(sym.name)) result.touched.set(sym.name, sym);
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
