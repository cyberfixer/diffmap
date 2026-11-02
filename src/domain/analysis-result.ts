import type { ChangedSymbol } from "./symbol.js";

export interface AnalysisResult {
  base: string;              // resolved git SHA
  head: string;              // resolved git SHA
  symbols: ChangedSymbol[];
}
