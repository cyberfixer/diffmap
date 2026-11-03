import type { GraphEdge, GraphNode } from "../../domain/graph.js";
import type { DiffLine } from "../../domain/symbol.js";

export const CHANGED_W = 460;
export const CONTEXT_W = 270;
export const LINE_H = 17;
export const BODY_PAD = 8;
export const MAX_DIFF_LINES = 80;
const GAP_X = 140;
const GAP_Y = 30;
const MARGIN = 40;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  headH: number;
}

export interface Layout {
  boxes: Map<string, Box>;
  width: number;
  height: number;
}

export const headHeight = (n: GraphNode): number => 50 + (n.labels.length > 0 ? 20 : 0);

/** Number of rendered diff rows, including the "N more" row when truncated. */
export const visibleRows = (lines: DiffLine[]): number =>
  Math.min(lines.length, MAX_DIFF_LINES) + (lines.length > MAX_DIFF_LINES ? 1 : 0);

function boxSize(n: GraphNode, diff: DiffLine[]): { w: number; h: number; headH: number } {
  const headH = headHeight(n);
  const rows = n.changed ? visibleRows(diff) : 0;
  const bodyH = rows > 0 ? BODY_PAD * 2 + rows * LINE_H : 0;
  return { w: n.changed ? CHANGED_W : CONTEXT_W, h: headH + bodyH, headH };
}

/**
 * Left-to-right layered layout: callers sit left of what they call.
 * Cycles are broken by ignoring back edges when assigning layers.
 */
export function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  diffs: Map<string, DiffLine[]>
): Layout {
  const ids = new Set(nodes.map((n) => n.id));
  const out = new Map<string, string[]>();
  const preds = new Map<string, string[]>();
  for (const n of nodes) {
    out.set(n.id, []);
    preds.set(n.id, []);
  }
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
    out.get(e.from)!.push(e.to);
    preds.get(e.to)!.push(e.from);
  }

  const sorted = [...nodes].sort(
    (a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name)
  );

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
  for (const n of sorted) if (!state.get(n.id)) dfs(n.id);

  const layer = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const u of post.reverse()) {
    for (const v of out.get(u)!) {
      if (back.has(`${u}>${v}`)) continue;
      layer.set(v, Math.max(layer.get(v)!, layer.get(u)! + 1));
    }
  }

  const maxLayer = Math.max(0, ...layer.values());
  const columns: GraphNode[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const n of sorted) columns[layer.get(n.id)!].push(n);

  const boxes = new Map<string, Box>();
  let x = MARGIN;
  let height = 0;

  for (const column of columns) {
    // Order by the average vertical position of already-placed callers,
    // which keeps edges short and mostly uncrossed.
    const centre = (n: GraphNode): number => {
      const ys = preds
        .get(n.id)!
        .map((p) => boxes.get(p))
        .filter((b): b is Box => b !== undefined)
        .map((b) => b.y + b.headH / 2);
      return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Infinity;
    };
    column.sort((a, b) => {
      const ca = centre(a);
      const cb = centre(b);
      if (ca !== cb) return ca === Infinity ? 1 : cb === Infinity ? -1 : ca - cb;
      return a.file.localeCompare(b.file) || a.name.localeCompare(b.name);
    });

    let y = MARGIN;
    let colW = 0;
    for (const n of column) {
      const size = boxSize(n, diffs.get(n.id) ?? []);
      boxes.set(n.id, { x, y, ...size });
      y += size.h + GAP_Y;
      colW = Math.max(colW, size.w);
    }
    height = Math.max(height, y);
    x += colW + GAP_X;
  }

  return { boxes, width: Math.max(x - GAP_X + MARGIN, 2 * MARGIN), height: height + MARGIN - GAP_Y };
}
