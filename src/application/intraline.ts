import type { DiffLine } from "../domain/symbol.js";

/** Characters [start, end) of a line's text. */
export type CharRange = [start: number, end: number];

const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;
/** Lines longer than this (in words and signs) are compared by their two ends only. */
const MAX_TOKENS = 300;
/** Below this share of unchanged text the line counts as rewritten: nothing to point at. */
const MIN_SAME = 0.4;

/** Arabic, Syriac and other scripts whose letters join into words. */
const JOINED = /[\u0600-\u08FF\uFB50-\uFDFF\uFE70-\uFEFC]/;

interface Tok {
  text: string;
  at: number;
}

function tokens(text: string): Tok[] {
  const out: Tok[] = [];
  for (const m of text.matchAll(TOKEN)) out.push({ text: m[0], at: m.index });
  return out;
}

const visible = (s: string): number => s.replace(/\s+/g, "").length;

/**
 * What changed inside one line: the parts of the old text that are gone and the
 * parts of the new text that are new. Compared word by word; where one word
 * became another (`userName` → `userNames`), only the letters that differ.
 * Returns null when the lines have too little in common to be "the same line, edited".
 */
export function diffLine(oldText: string, newText: string): { old: CharRange[]; new: CharRange[] } | null {
  if (oldText === newText || !oldText.trim() || !newText.trim()) return null;
  const a = tokens(oldText);
  const b = tokens(newText);

  // The same words at both ends need no comparing.
  let head = 0;
  while (head < a.length && head < b.length && a[head].text === b[head].text) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail].text === b[b.length - 1 - tail].text) tail++;
  const n = a.length - head - tail;
  const m = b.length - head - tail;

  // same[i][j]: the longest run of words the rest of both lines share, in order.
  const small = n <= MAX_TOKENS && m <= MAX_TOKENS;
  const w = m + 1;
  const same = small ? new Uint16Array((n + 1) * w) : null;
  if (same) {
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        same[i * w + j] =
          a[head + i].text === b[head + j].text ? same[(i + 1) * w + j + 1] + 1 : Math.max(same[(i + 1) * w + j], same[i * w + j + 1]);
      }
    }
  }

  const oldOut: CharRange[] = [];
  const newOut: CharRange[] = [];
  let kept = 0; // unchanged letters and signs
  for (let k = 0; k < head; k++) kept += visible(a[k].text);
  for (let k = 0; k < tail; k++) kept += visible(a[a.length - 1 - k].text);

  const endOf = (t: Tok[], i: number, text: string) => (i < t.length ? t[i].at : text.length);
  /** One stretch that differs: words [i0, i1) of the old line became words [j0, j1) of the new one. */
  const changed = (i0: number, i1: number, j0: number, j1: number) => {
    let oa = endOf(a, head + i0, oldText);
    let ob = endOf(a, head + i1, oldText);
    let na = endOf(b, head + j0, newText);
    let nb = endOf(b, head + j1, newText);
    // One word turned into another: keep the letters they share at both ends. Not in
    // scripts that join their letters (Arabic): shading half a word would break it apart.
    if (!JOINED.test(oldText.slice(oa, ob)) && !JOINED.test(newText.slice(na, nb))) {
      while (oa < ob && na < nb && oldText[oa] === newText[na]) (oa++, na++, kept++);
      while (oa < ob && na < nb && oldText[ob - 1] === newText[nb - 1]) (ob--, nb--, kept++);
    }
    if (oa < ob) oldOut.push([oa, ob]);
    if (na < nb) newOut.push([na, nb]);
  };

  if (!same) changed(0, n, 0, m);
  else {
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[head + i].text === b[head + j].text) {
        kept += visible(a[head + i].text);
        i++;
        j++;
        continue;
      }
      const i0 = i;
      const j0 = j;
      while ((i < n || j < m) && !(i < n && j < m && a[head + i].text === b[head + j].text)) {
        if (j >= m || (i < n && same[(i + 1) * w + j] >= same[i * w + j + 1])) i++;
        else j++;
      }
      changed(i0, i, j0, j);
    }
  }

  if (kept < MIN_SAME * Math.max(visible(oldText), visible(newText))) return null;
  return { old: joinAcrossSpaces(oldOut, oldText), new: joinAcrossSpaces(newOut, newText) };
}

/** Two changed parts with only spaces between them read better as one. */
function joinAcrossSpaces(ranges: CharRange[], text: string): CharRange[] {
  const out: CharRange[] = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && !text.slice(last[1], r[0]).trim()) last[1] = r[1];
    else out.push([r[0], r[1]]);
  }
  return out;
}

/**
 * For a file's lines: which characters to point out on edited lines. Where a
 * block of removed lines is followed by a block of added lines, the first
 * removed line is compared with the first added one, the second with the
 * second, and so on. Returns line index → changed character ranges.
 */
export function intralineMarks(lines: DiffLine[]): Map<number, CharRange[]> {
  const marks = new Map<number, CharRange[]>();
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type !== "del") {
      i++;
      continue;
    }
    const del = i;
    while (i < lines.length && lines[i].type === "del") i++;
    const add = i;
    while (i < lines.length && lines[i].type === "add") i++;
    const pairs = Math.min(add - del, i - add);
    for (let k = 0; k < pairs; k++) {
      const d = diffLine(lines[del + k].text, lines[add + k].text);
      if (!d) continue;
      if (d.old.length) marks.set(del + k, d.old);
      if (d.new.length) marks.set(add + k, d.new);
    }
  }
  return marks;
}
