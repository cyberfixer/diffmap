export const MARGIN = 40;
export const GAP_X = 150;

/** One file window. Its height is unknown here: the browser measures it. */
export interface WindowSpec {
  id: string;
  width: number;
}

export interface Placed {
  id: string;
  x: number;
  col: number;
  order: number; // position within the column, top to bottom
  width: number;
}

export interface Layout {
  placed: Map<string, Placed>;
  columns: string[][]; // window ids per column, in vertical order
  width: number;
}

/**
 * Left-to-right layered layout of file windows: files that call into other
 * files sit to their left. Cycles are broken by ignoring back edges.
 * Only x, column and vertical order are decided here; y comes from the
 * measured heights in the browser.
 */
export function layoutWindows(
  windows: WindowSpec[],
  edges: { from: string; to: string }[]
): Layout {
  const ids = new Set(windows.map((w) => w.id));
  const byId = new Map(windows.map((w) => [w.id, w]));
  const out = new Map<string, string[]>(windows.map((w) => [w.id, []]));
  const preds = new Map<string, string[]>(windows.map((w) => [w.id, []]));
  const seen = new Set<string>();
  for (const e of edges) {
    const key = `${e.from}>${e.to}`;
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to || seen.has(key)) continue;
    seen.add(key);
    out.get(e.from)!.push(e.to);
    preds.get(e.to)!.push(e.from);
  }

  const sorted = [...windows].sort((a, b) => a.id.localeCompare(b.id));

  // DFS: reverse postorder is a topological order once back edges are skipped.
  const state = new Map<string, 0 | 1 | 2>();
  const back = new Set<string>();
  const post: string[] = [];
  const dfs = (u: string): void => {
    state.set(u, 1);
    for (const v of out.get(u)!) {
      const s = state.get(v) ?? 0;
      if (s === 1) back.add(`${u}>${v}`);
      else if (s === 0) dfs(v);
    }
    state.set(u, 2);
    post.push(u);
  };
  for (const w of sorted) if (!state.get(w.id)) dfs(w.id);

  const layer = new Map<string, number>(windows.map((w) => [w.id, 0]));
  for (const u of post.reverse()) {
    for (const v of out.get(u)!) {
      if (back.has(`${u}>${v}`)) continue;
      layer.set(v, Math.max(layer.get(v)!, layer.get(u)! + 1));
    }
  }

  const maxLayer = Math.max(0, ...layer.values());
  const columns: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const w of sorted) columns[layer.get(w.id)!].push(w.id);

  const placed = new Map<string, Placed>();
  let x = MARGIN;

  columns.forEach((column, col) => {
    // Order by the average slot of already-placed callers (barycenter), which
    // keeps edges short and mostly uncrossed.
    const slot = (id: string): number => {
      const ps = preds
        .get(id)!
        .map((p) => placed.get(p))
        .filter((p): p is Placed => p !== undefined);
      return ps.length ? ps.reduce((a, p) => a + p.order, 0) / ps.length : Infinity;
    };
    column.sort((a, b) => {
      const sa = slot(a);
      const sb = slot(b);
      if (sa !== sb) return sa === Infinity ? 1 : sb === Infinity ? -1 : sa - sb;
      return a.localeCompare(b);
    });

    let colW = 0;
    column.forEach((id, order) => {
      const width = byId.get(id)!.width;
      placed.set(id, { id, x, col, order, width });
      colW = Math.max(colW, width);
    });
    x += colW + GAP_X;
  });

  return { placed, columns, width: Math.max(x - GAP_X + MARGIN, 2 * MARGIN) };
}
