import { createHash } from "node:crypto";
import { extname } from "node:path";
import type { SyntaxHighlighterPort, HighlightToken } from "../../application/ports/syntax-highlighter.port.js";
import type { AnalysisResult } from "../../domain/analysis-result.js";
import type { FileView } from "../../domain/file-view.js";
import type { CallSite, GraphNode } from "../../domain/graph.js";
import type { DiffLine } from "../../domain/symbol.js";
import { intralineMarks, type CharRange } from "../../application/intraline.js";
import { STYLE } from "./html-style.js";
import { CLIENT_SCRIPT } from "./html-client.js";
import { THEME_BOOT, THEME_BUTTON } from "./theme.js";
import { MR_CLIENT_SCRIPT } from "./html-client-mr.js";
import type {
  Approvals,
  MergeRequestInfo,
  Person,
  ReviewDiscussion,
  ViewedMarks,
} from "../../application/ports/merge-request.port.js";

/** Extra data when the page shows a merge/pull request from the service. */
export interface MrPage {
  hostName?: string; // "GitLab" or "GitHub" (default GitLab)
  refPrefix?: string; // "!" or "#" (default "!")
  /** View mode: show comments and approvals, but no way to add or change them. */
  readOnly?: boolean;
  mr: MergeRequestInfo;
  discussions: ReviewDiscussion[];
  approvals: Approvals;
  user: Person;
  apiBase: string; // e.g. "/api/team/api/-/merge_requests/42"
  viewed: ViewedMarks; // what this user marked as viewed, and which version of it
  /** Whether CI's exact index was used: found, still building, not set up. */
  indexState?: "found" | "pending" | "none" | "unsupported";
}

/**
 * A short fingerprint of a file's change: its added and removed lines, in
 * order. A "viewed" mark is saved with it, so the mark stops counting when a
 * later push changes the file again. Unchanged lines and line numbers are left
 * out, so a rebase that doesn't touch the change keeps the mark.
 */
export function changeVersion(view: FileView): string {
  const hash = createHash("sha256").update(view.status);
  for (const l of view.lines) {
    if (l.type === "add" || l.type === "del") hash.update(`\n${l.type === "add" ? "+" : "-"}${l.text}`);
  }
  return hash.digest("hex").slice(0, 16);
}

export interface RenderOptions {
  mr?: MrPage;
  /** Files longer than this start collapsed (default 500). */
  maxLines?: number;
  /** The same for HTML files, which are often long and generated (default 300). */
  maxHtmlLines?: number;
}

const DEFAULT_MAX_LINES = 500;
const DEFAULT_MAX_HTML_LINES = 300;

/** Whether a file starts collapsed because it is long. */
export function isLargeFile(view: FileView, options: RenderOptions = {}): boolean {
  const lines = view.lines.filter((l) => l.type !== "del").length || view.lines.length;
  const html = /\.html?$/i.test(view.path);
  return lines > (html ? options.maxHtmlLines ?? DEFAULT_MAX_HTML_LINES : options.maxLines ?? DEFAULT_MAX_LINES);
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const expandTabs = (s: string): string => s.replace(/\t/g, "  ");

/** JSON that is safe to place inside a <script> element. */
const scriptJson = (v: unknown): string =>
  JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

/** Unchanged lines within this distance of a change stay visible when a card is folded. */
const NEAR = 3;

const KIND_LABEL: Record<string, string> = {
  function: "function",
  method: "method",
  class: "class",
  arrow: "arrow function",
  interface: "interface",
  struct: "struct",
  enum: "enum",
  trait: "trait",
  module: "module",
  template: "template",
  "top-level": "top-level code",
};

/** A folder in the sidebar tree: sub-folders and the indexes of its files. */
interface Folder {
  name: string; // "" for the root; "a/b/c" when single-child folders are joined
  folders: Folder[];
  files: number[];
}

/** Files grouped by folder; a folder with only one sub-folder and no files is joined with it (src/main/java). */
export function folderTree(paths: string[]): Folder {
  const root: Folder = { name: "", folders: [], files: [] };
  paths.forEach((path, i) => {
    let at = root;
    const parts = path.split("/");
    for (const part of parts.slice(0, -1)) {
      let next = at.folders.find((f) => f.name === part);
      if (!next) at.folders.push((next = { name: part, folders: [], files: [] }));
      at = next;
    }
    at.files.push(i);
  });
  const join = (f: Folder): Folder => {
    let cur = { ...f, folders: f.folders.map(join) };
    while (cur.name && cur.files.length === 0 && cur.folders.length === 1) {
      const only = cur.folders[0];
      cur = { name: `${cur.name}/${only.name}`, folders: only.folders, files: only.files };
    }
    return cur;
  };
  const out = join(root);
  // The root with a single folder and no files: start the tree at that folder.
  return out.files.length === 0 && out.folders.length === 1 ? { name: "", folders: out.folders, files: [] } : out;
}

/** File indexes in the order the tree shows them. */
function treeOrder(f: Folder): number[] {
  return [...f.folders.flatMap(treeOrder), ...f.files];
}

function renderTree(f: Folder, fileRow: (i: number) => string): string {
  const kids = f.folders.map((d) => renderTree(d, fileRow)).join("") + f.files.map(fileRow).join("");
  if (!f.name) return kids;
  return `<div class="tf"><button class="tf-dir mono" type="button" aria-expanded="true" title="${esc(f.name)}"><span class="chev" aria-hidden="true"></span><span class="dn">${esc(f.name)}/</span></button><div class="tf-kids">${kids}</div></div>`;
}

function splitPath(file: string): { dir: string; base: string } {
  const slash = file.lastIndexOf("/");
  return { dir: slash >= 0 ? file.slice(0, slash + 1) : "", base: file.slice(slash + 1) };
}

const COPY_ICON = `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M0 6.75C0 5.78.78 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .14.11.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Zm5-5C5 .78 5.78 0 6.75 0h7.5C15.22 0 16 .78 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .14.11.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>`;

const copyButton = (file: string): string =>
  `<button class="cbtn copy" type="button" data-path="${esc(file)}" title="Copy path" aria-label="Copy path ${esc(file)}">${COPY_ICON}<span class="copy-label">Copy</span></button>`;

// ── right-to-left text (Arabic, Hebrew, …) ──
const RTL_CHAR = "\\u0590-\\u08FF\\uFB1D-\\uFDFF\\uFE70-\\uFEFC";
const HAS_RTL = new RegExp(`[${RTL_CHAR}]`);
/** A run of right-to-left words: letters, with only spaces and digits between them. */
const RTL_RUN = new RegExp(`[${RTL_CHAR}](?:[\\s\\d]*[${RTL_CHAR}])*`, "g");
/** The first letter that has a direction; right-to-left when it is Arabic or Hebrew. */
const FIRST_STRONG = new RegExp(`[A-Za-z\\u00C0-\\u024F\\u0370-\\u03FF\\u0400-\\u04FF${RTL_CHAR}]`);

/**
 * Escaped text for a line that reads left to right, like code. Each right-to-left
 * run is isolated (<bdi>), so it reads correctly and the browser does not move the
 * quotes, numbers and operators around it to the other side.
 */
const bidiHtml = (text: string): string => {
  const html = esc(text);
  return HAS_RTL.test(text) ? html.replace(RTL_RUN, "<bdi>$&</bdi>") : html;
};

/** Whether a line of plain text (not code) should be laid out right to left: its first letter is. */
export const startsRtl = (text: string): boolean => {
  if (!HAS_RTL.test(text)) return false;
  const first = text.match(FIRST_STRONG);
  return !!first && HAS_RTL.test(first[0]);
};

const pathHtml = (file: string): string => {
  const { dir, base } = splitPath(file);
  // Right-to-left folder names keep their order: a left-to-right mark after each slash.
  const dirHtml = HAS_RTL.test(dir) ? esc(dir).replace(/\//g, "/&lrm;") : esc(dir);
  return `<span class="fpath" title="${esc(file)}"><span class="fdir">${dirHtml}</span><span class="fname">${bidiHtml(base)}</span></span>`;
};

/**
 * A stretch of a line's text as HTML. `marks` are the characters (counted from the
 * start of the line; this stretch starts at `at`) that an edit changed: they get
 * a stronger shade of the line's green or red.
 */
const piecesHtml = (text: string, at: number, marks: CharRange[] | undefined, html: (s: string) => string): string => {
  if (!marks?.length) return html(expandTabs(text));
  let out = "";
  let pos = 0;
  for (const [from, to] of marks) {
    const a = Math.max(from - at, pos);
    const b = Math.min(to - at, text.length);
    if (a >= b) continue;
    out += `${html(expandTabs(text.slice(pos, a)))}<span class="chg">${html(expandTabs(text.slice(a, b)))}</span>`;
    pos = b;
  }
  return out + html(expandTabs(text.slice(pos)));
};

const tokensHtml = (text: string, tokens?: HighlightToken[], marks?: CharRange[]): string => {
  // Marks count characters of the line; they only fit the tokens when those spell the same line.
  if (!tokens || (marks?.length && tokens.reduce((n, t) => n + t.text.length, 0) !== text.length)) {
    return piecesHtml(text, 0, marks, bidiHtml);
  }
  let at = 0;
  return tokens
    .map((t) => {
      const html = piecesHtml(t.text, at, marks, bidiHtml);
      at += t.text.length;
      return t.kind === "plain" ? html : `<span class="tk-${t.kind}">${html}</span>`;
    })
    .join("");
};

/**
 * The text cell of a code row. In a file that is plain text (no highlighter: Markdown,
 * translations, …) a line that starts with Arabic or Hebrew is laid out right to left
 * as a whole. Code always stays left to right, with its right-to-left runs isolated.
 */
const textCell = (text: string, tokens?: HighlightToken[], prose = false, marks?: CharRange[]): string =>
  prose && startsRtl(text)
    ? `<span class="tx" dir="rtl">${piecesHtml(text, 0, marks, esc)}</span>`
    : `<span class="tx">${tokensHtml(text, tokens, marks)}</span>`;

/**
 * Colour a file view. Added lines come from the new file and removed lines from
 * the old one, so each version is tokenized as its own whole document (this keeps
 * multi-line comments and template strings right); unchanged lines are in both.
 */
function highlightView(view: FileView, hl: SyntaxHighlighterPort): HighlightToken[][] | null {
  const headAt: number[] = [];
  const baseAt: number[] = [];
  view.lines.forEach((l, i) => {
    if (l.type !== "del") headAt.push(i);
    if (l.type !== "add") baseAt.push(i);
  });
  const head = hl.highlight(view.path, headAt.map((i) => view.lines[i].text));
  const base = hl.highlight(view.path, baseAt.map((i) => view.lines[i].text));
  if (!head || !base) return null;

  const out: HighlightToken[][] = new Array(view.lines.length);
  headAt.forEach((i, k) => (out[i] = head[k]));
  baseAt.forEach((i, k) => {
    if (view.lines[i].type === "del") out[i] = base[k];
  });
  return out;
}

/** Where a symbol starts in a file view (removed symbols start on a removed line). */
function rowFor(lines: DiffLine[], n: GraphNode): number {
  const idx = lines.findIndex((l) =>
    n.status === "removed"
      ? l.type === "del" && l.oldLine === n.line
      : l.type !== "del" && l.newLine === n.line
  );
  return idx >= 0 ? idx : 0;
}

/** One place a changed symbol is used, as the browser needs it. */
interface Ref {
  file: string;
  line: number;
  text: string;
  el: string; // id of the code row in the map
  out: boolean; // the caller's file is outside the diff
  bad: boolean; // a call to code this diff removed
  impl: boolean; // the caller implements this symbol (interface method -> class method)
}

interface SymInfo {
  id: string;
  name: string;
  kind: string;
  status: string;
  file: string;
  line: number;
  end: number; // last line of the definition (in the old file for a removed symbol)
  before: string[];
  after: string[];
  refs: Ref[];
}

/** Render an AnalysisResult as one self-contained, interactive review page, laid out like a code editor. */
export function renderHtml(
  result: AnalysisResult,
  highlighters: SyntaxHighlighterPort[] = [],
  options: RenderOptions = {}
): string {
  const mrPage = options.mr;
  const hlFor = (file: string) => highlighters.find((h) => h.supportedExtensions.includes(extname(file)));
  // Same order as the sidebar tree: folders first, then files, at every level.
  const sorted = [...(result.files ?? [])].sort((a, b) => a.path.localeCompare(b.path));
  const views = treeOrder(folderTree(sorted.map((v) => v.path))).map((i) => sorted[i]);
  const viewIdx = new Map(views.map((v, i) => [v.path, i]));
  const nodeById = new Map(result.nodes.map((n) => [n.id, n]));

  // Changed symbols, in file then line order. Their index (k) is used everywhere.
  const changed = result.nodes
    .filter((n) => n.changed)
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.name.localeCompare(b.name));
  const kOf = new Map(changed.map((n, k) => [n.id, k]));
  const diffOf = new Map(result.symbols.map((s) => [s.id, s.diff]));
  const endOf = new Map(result.symbols.map((s) => [s.id, (s.status === "removed" ? s.baseRange : s.headRange)?.end]));

  // Callers outside the diff: unchanged symbols in files that have no file view.
  const outCallers: GraphNode[] = [];
  const ciOf = new Map<string, number>();

  const syms: SymInfo[] = changed.map((n) => {
    const diff = diffOf.get(n.id) ?? [];
    return {
      id: n.id,
      name: n.name,
      kind: KIND_LABEL[n.kind] ?? n.kind,
      status: n.status ?? "modified",
      file: n.file,
      line: n.line,
      end: Math.max(n.line, endOf.get(n.id) ?? n.endLine ?? n.line),
      before: diff.filter((l) => l.type === "del").map((l) => l.text),
      after: diff.filter((l) => l.type === "add").map((l) => l.text),
      refs: [],
    };
  });

  // Lines in changed files that must stay visible when folded (call sites, comments).
  const keepLines = new Map<string, Set<number>>();
  const keepOld = new Map<string, Set<number>>();
  for (const d of mrPage?.discussions ?? []) {
    const p = d.position;
    if (!p) continue;
    if (p.newLine !== null) (keepLines.get(p.path) ?? keepLines.set(p.path, new Set()).get(p.path)!).add(p.newLine);
    else if (p.oldLine !== null) (keepOld.get(p.path) ?? keepOld.set(p.path, new Set()).get(p.path)!).add(p.oldLine);
  }

  for (const e of result.edges) {
    const k = kOf.get(e.to);
    const caller = nodeById.get(e.from);
    if (k === undefined || !caller) continue;
    const sites: CallSite[] = e.sites?.length
      ? e.sites
      : [{ line: caller.line, text: caller.code?.[0] ?? "" }];
    const inDiff = viewIdx.has(caller.file);
    if (!inDiff) {
      if (!ciOf.has(caller.id)) {
        ciOf.set(caller.id, outCallers.length);
        outCallers.push(caller);
      }
    }
    for (const s of sites) {
      if (inDiff) {
        (keepLines.get(caller.file) ?? keepLines.set(caller.file, new Set()).get(caller.file)!).add(s.line);
      }
      syms[k].refs.push({
        file: caller.file,
        line: s.line,
        text: s.text,
        el: inDiff ? `L${viewIdx.get(caller.file)}-${s.line}` : `U${ciOf.get(caller.id)}-${s.line}`,
        out: !inDiff,
        bad: e.kind === "calls-removed",
        impl: e.kind === "implements",
      });
    }
  }
  for (const s of syms) s.refs.sort((a, b) => Number(a.out) - Number(b.out) || a.file.localeCompare(b.file) || a.line - b.line);

  // ── the editor: every changed file, one under the other ──
  let addedLines = 0;
  let removedLines = 0;
  const symsByFile = new Map<string, number[]>();
  changed.forEach((n, k) => symsByFile.set(n.file, [...(symsByFile.get(n.file) ?? []), k]));

  const fileStats = views.map((v) => ({
    add: v.lines.filter((l) => l.type === "add").length,
    del: v.lines.filter((l) => l.type === "del").length,
  }));

  const fileSections = views
    .map((view, fi) => {
      const hl = hlFor(view.path);
      const tokens = hl ? highlightView(view, hl) : null;
      // On an edited line, the letters that changed.
      const marks = intralineMarks(view.lines);
      const defsAt = new Map<number, number[]>();
      for (const k of symsByFile.get(view.path) ?? []) {
        const r = rowFor(view.lines, changed[k]);
        defsAt.set(r, [...(defsAt.get(r) ?? []), k]);
      }
      const keep = keepLines.get(view.path) ?? new Set<number>();
      const keepO = keepOld.get(view.path) ?? new Set<number>();

      const near = new Array<boolean>(view.lines.length).fill(false);
      view.lines.forEach((l, i) => {
        if (l.type === "ctx" && !keep.has(l.newLine ?? -1) && !keepO.has(l.oldLine ?? -1)) return;
        for (let j = Math.max(0, i - NEAR); j <= Math.min(view.lines.length - 1, i + NEAR); j++) near[j] = true;
      });

      const { add, del } = fileStats[fi];
      addedLines += add;
      removedLines += del;

      const rows: string[] = [];
      let folded = false;
      view.lines.forEach((l, i) => {
        if (!near[i] && (i === 0 || near[i - 1])) {
          let j = i;
          while (j < view.lines.length && !near[j]) j++;
          rows.push(`<div class="gap">⋯ ${j - i} unchanged line${j - i === 1 ? "" : "s"}</div>`);
          folded = true;
        }
        const defs = defsAt.get(i) ?? [];
        const cls = ["dl", l.type, near[i] ? "" : "far", defs.length ? "def" : ""].filter(Boolean).join(" ");
        const id = l.type !== "del" ? ` id="L${fi}-${l.newLine}"` : "";
        const def = defs.length
          ? ` data-sel="${defs[0]}" data-defs="${defs.join(" ")}" title="Select ${esc(defs.map((k) => changed[k].name).join(", "))}"`
          : "";
        const sign = l.type === "add" ? "+" : l.type === "del" ? "−" : "";
        rows.push(
          `<div class="${cls}"${id}${def}><span class="lo">${l.oldLine ?? ""}</span><span class="ln">${l.newLine ?? ""}</span><span class="sg">${sign}</span>${textCell(l.text, tokens?.[i], !hl, marks.get(i))}</div>`
        );
      });

      const expand = folded
        ? `<button class="cbtn expand" type="button" aria-pressed="false" title="Show the whole file">Whole file</button>`
        : "";
      // On the service: a comment on the file as a whole, next to its name.
      const fileComment = mrPage && !mrPage.readOnly
        ? `<button class="cbtn fcomment" type="button" title="Comment on this file as a whole">Comment</button>`
        : "";
      const large = isLargeFile(view, options);
      const total = view.lines.filter((l) => l.type !== "del").length || view.lines.length;
      const bigBar = large
        ? `<button class="bigbar" type="button">${total.toLocaleString("en-US")} lines · hidden because the file is large · <b>Show</b></button>`
        : "";
      return `<section class="fsec${large ? " big" : ""}" id="c${fi}" data-path="${esc(view.path)}" data-rev="${changeVersion(view)}">
  <header class="fh"><button class="fold" type="button" aria-expanded="true" title="Collapse or open this file" aria-label="Collapse or open ${esc(view.path)}"><span class="chev" aria-hidden="true"></span></button>${pathHtml(view.path)}${copyButton(view.path)}${fileComment}${expand}<span class="cmeta"><span class="add">+${add}</span><span class="del">−${del}</span></span><label class="vf" title="Mark this file as viewed and collapse it"><input type="checkbox" class="fv"> Viewed</label></header>
  ${bigBar}<div class="code">${rows.join("")}</div>
</section>`;
    })
    .join("\n");

  // ── callers outside the diff: each one's whole code, shown in the usages panel when picked ──
  const outFiles = new Set(outCallers.map((c) => c.file));
  const outBlocks = outCallers
    .map((c, ci) => {
      const hl = hlFor(c.file);
      const code = c.code ?? [];
      const tokens = hl && code.length ? hl.highlight(c.file, code) : null;
      const rows = code
        .map((text, i) => {
          const n = c.line + i;
          return `<div class="dl ctx" id="U${ci}-${n}"><span class="lo">${n}</span><span class="ln">${n}</span><span class="sg"></span>${textCell(text, tokens?.[i], !hl)}</div>`;
        })
        .join("");
      return `<div class="caller code" data-path="${esc(c.file)}">${rows || `<div class="deco" id="U${ci}-${c.line}">${esc(c.name)}</div>`}</div>`;
    })
    .join("\n");

  // ── sidebar: a folder tree, like an editor's file explorer ──
  const usesText = (n: number) => (n === 0 ? "no usages" : n === 1 ? "1 usage" : `${n} usages`);
  const fileRow = (fi: number): string => {
    const v = views[fi];
    const { base } = splitPath(v.path);
    const items = (symsByFile.get(v.path) ?? [])
      .map((k) => {
        const s = syms[k];
        return `<button class="sf-sym mono" type="button" data-sel="${k}" title="${esc(s.name)} · ${esc(s.kind)} · ${usesText(s.refs.length)}"><span class="glyph st-${s.status}" aria-hidden="true">${esc(s.kind.charAt(0))}</span><span class="nm st-${s.status}">${esc(s.name)}</span><span class="ct">${s.refs.length}</span></button>`;
      })
      .join("");
    const status = v.status === "added" ? "added" : v.status === "deleted" ? "deleted" : "modified";
    return `<div class="sf"><button class="sf-file mono fs-${status}" type="button" data-card="c${fi}" title="${esc(v.path)} · ${status}"><span class="p">${esc(base)}</span><span class="n"><span class="add">+${fileStats[fi].add}</span> <span class="del">−${fileStats[fi].del}</span></span><span class="vw" aria-hidden="true"></span></button>${items}</div>`;
  };
  const sidebar = renderTree(folderTree(views.map((v) => v.path)), fileRow);

  // ── header ──
  const short = (sha: string) => sha.slice(0, 7);
  const range = result.range;
  const commits = range ? ` · ${range.commits} commit${range.commits === 1 ? "" : "s"}` : "";
  const title = mrPage
    ? `${mrPage.refPrefix ?? "!"}${mrPage.mr.iid} · ${mrPage.mr.title}`
    : range?.title ?? (range ? `${range.headName} → ${range.baseName}` : "Code changes");
  const sub = mrPage
    ? `${mrPage.mr.author.name} · ${mrPage.mr.sourceBranch} → ${mrPage.mr.targetBranch}${commits}`
    : range
      ? `${range.headName} → ${range.baseName}${commits} · ${short(result.base)}..${short(result.head)}`
      : `${short(result.base)}..${short(result.head)}`;
  // Every line that still calls code this change removes; the pill opens the list of them.
  const broken = syms.reduce((a, s) => a + s.refs.filter((r) => r.bad).length, 0);
  const warnPill = broken
    ? `<button class="pill warn" id="brokenpill" type="button" title="List these calls">${broken === 1 ? "1 call still points" : `${broken} calls still point`} at removed code</button>`
    : "";

  const outUses = syms.reduce((a, s) => a + s.refs.filter((r) => r.out).length, 0);
  const outSummary = outFiles.size
    ? `<span>${outUses} usage${outUses === 1 ? "" : "s"} in ${outFiles.size} file${outFiles.size === 1 ? "" : "s"} outside the diff</span>`
    : "";

  const data = {
    key: `diffmap:viewed:${result.base}..${result.head}`,
    syms,
    mr: mrPage
      ? {
          apiBase: mrPage.apiBase,
          webUrl: mrPage.mr.webUrl,
          user: mrPage.user,
          approvals: mrPage.approvals,
          discussions: mrPage.discussions,
          viewed: mrPage.viewed,
          readOnly: !!mrPage.readOnly,
          hostName: mrPage.hostName ?? "GitLab",
        }
      : null,
  };

  const empty = views.length === 0;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>diffmap · ${esc(title)}</title>
<script>${THEME_BOOT}</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&amp;family=IBM+Plex+Sans:wght@400;500;600&amp;display=swap">
<style>${STYLE}</style>
</head>
<body class="${mrPage ? "mr" : ""}${mrPage && !mrPage.readOnly ? " mr-write" : ""}">
<header class="top">
  <div class="brand"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="6" r="2.5"></circle><circle cx="19" cy="6" r="2.5"></circle><circle cx="12" cy="18" r="2.5"></circle><path d="M7.5 6h9M6.5 8.2l4.2 7.6M17.5 8.2l-4.2 7.6"></path></svg><span>diffmap</span></div>
  <div class="title"><div class="t">${mrPage ? `<a href="${esc(mrPage.mr.webUrl)}" title="Open in ${esc(mrPage.hostName ?? "GitLab")}">${esc(`${mrPage.refPrefix ?? "!"}${mrPage.mr.iid}`)} · <bdi>${esc(mrPage.mr.title)}</bdi></a>` : `<bdi>${esc(title)}</bdi>`}</div><div class="s mono">${esc(sub)}</div></div>
  <div class="acts">
    ${warnPill}
    ${mrPage ? mrActions(mrPage) : ""}
    ${THEME_BUTTON}
  </div>
</header>
<div class="work" id="work">
  <aside class="side">
    <div class="rz l" id="rzl" title="Drag to resize · double-click to reset" aria-hidden="true"></div>
    <div class="side-head"><span class="cap">Changes · ${views.length} file${views.length === 1 ? "" : "s"}</span><input id="filter" type="search" placeholder="Filter files and symbols" aria-label="Filter files and symbols"></div>
    <nav class="side-list mono" aria-label="Changed files">${sidebar}</nav>
  </aside>
  <main class="main" id="main">
    <div class="ed" id="ed">
      ${empty ? `<p class="empty">No changed files in this range.</p>` : ""}
      ${fileSections}
    </div>
    <section class="dock" id="dock" aria-label="Usages">
      <div class="rz b" id="rzb" title="Drag to resize · double-click to reset" aria-hidden="true"></div>
      <div class="dtabs">
        <button class="dtab" id="tabu" type="button" aria-selected="true">Usages<em id="ucount">0</em></button>
        ${mrPage ? `<button class="dtab" id="tabc" type="button" aria-selected="false">Comments<em id="ccount">${mrPage.discussions.length}</em></button>` : ""}
        <button class="dtab" id="tabs" type="button" aria-selected="false" title="Search the text of the files in this diff (/)">Search</button>
        ${broken ? `<button class="dtab warn" id="tabb" type="button" aria-selected="false" title="Calls that still point at code this change removes">Removed code<em>${broken}</em></button>` : ""}
        <div class="what" id="what"></div>
        <button class="mini" id="back" type="button" disabled title="Back to where you were (←)">← Back</button>
        <button class="mini" id="fwd" type="button" disabled title="Forward again (→)">Forward →</button>
        <button class="mini" id="prevu" type="button" hidden title="Previous usage (↑ or Shift+F4)" aria-label="Previous usage">↑</button>
        <button class="mini" id="nextu" type="button" hidden title="Next usage (↓ or F4)" aria-label="Next usage">↓</button>
        <button class="mini" id="closed" type="button" hidden title="Close (Esc)" aria-label="Close panel">✕</button>
      </div>
      <div class="dpane" id="upane"><div class="ulist" id="ulist"></div><div class="prev" id="prev"></div></div>
      <div class="spane" id="spane" hidden>
        <div class="sbar"><input id="q" type="search" placeholder="Search in the changed files" aria-label="Search in the changed files" autocomplete="off" spellcheck="false"><span id="qn" aria-live="polite"></span></div>
        <div class="slist" id="slist"></div>
      </div>
      ${broken ? `<div class="spane" id="bpane" hidden><div class="slist" id="blist"></div></div>` : ""}
      ${mrPage ? `<div class="cpane" id="cpane" hidden></div>` : ""}
    </section>
  </main>
</div>
<footer class="status">
  <span class="mono"><span class="add">+${addedLines}</span> <span class="del">−${removedLines}</span></span>
  <span>${views.length} file${views.length === 1 ? "" : "s"} · ${changed.length} symbol${changed.length === 1 ? "" : "s"}</span>
  ${outSummary}
  ${exactNote(result, mrPage?.indexState)}
  ${mrPage && !mrPage.readOnly ? `<span class="chint"><span class="plus" aria-hidden="true">+</span>Click a line number to comment on that line</span>` : ""}
  <span class="keys" title="Keyboard shortcuts. The up and down arrows move through usages while a symbol is selected; otherwise they scroll."><span><kbd>←</kbd><kbd>→</kbd> back / forward</span><span><kbd>↑</kbd><kbd>↓</kbd> usages</span><span><kbd>N</kbd><kbd>P</kbd> next / previous file</span><span><kbd>/</kbd> search</span><span><kbd>V</kbd> viewed</span><span><kbd>C</kbd> collapse</span><span><kbd>Esc</kbd> close</span></span>
  <span class="vprog">Viewed <span><span id="vcount">0</span> of ${views.length} file${views.length === 1 ? "" : "s"}</span><span class="bar"><span id="vbar"></span></span></span>
</footer>
<div id="outsrc" hidden>
${outBlocks}
</div>
<script>var DIFFMAP = ${scriptJson(data)};</script>
<script>${CLIENT_SCRIPT}</script>${mrPage ? `\n<script>${MR_CLIENT_SCRIPT}</script>` : ""}
</body>
</html>
`;
}

/** Approve button, link back to the host and the signed-in user (service mode). */
function mrActions(p: MrPage): string {
  const a = p.approvals;
  const approvedNote = a.approvedBy.length
    ? `<span class="pill" id="approvedby" title="${esc(a.approvedBy.map((u) => u.name).join(", "))}">Approved by ${a.approvedBy.length}</span>`
    : `<span class="pill" id="approvedby" hidden></span>`;
  const label = a.userHasApproved ? "Revoke approval" : "Approve";
  const disabled = !a.userHasApproved && !a.userCanApprove ? " disabled title=\"You can't approve this merge request\"" : "";
  return `${approvedNote}
    <a class="hbtn" href="${esc(p.mr.webUrl)}">Open in ${esc(p.hostName ?? "GitLab")}</a>
    ${p.readOnly ? `<span class="pill" title="This diffmap is view-only: comment and approve in ${esc(p.hostName ?? "GitLab")}">View only</span>` : `<button class="hbtn ${a.userHasApproved ? "" : "primary"}" id="approve" type="button" aria-pressed="${a.userHasApproved}"${disabled}>${label}</button>`}
    <form method="post" action="/auth/logout" class="who"><span title="Signed in as @${esc(p.user.username)}">${esc(p.user.name)}</span><button type="submit" class="link">Sign out</button></form>`;
}

/** Whether usages come from a compiler (exact) or from matching names. */
function exactNote(result: AnalysisResult, indexState?: string): string {
  const x = result.exactness;
  if (!x || x.total === 0) return "";
  if (indexState === "pending" && x.exact < x.total) {
    return `<span title="The CI job diffmap-index is still running for this commit. Reload in a minute for exact calls.">Calls: by name · exact index still building</span>`;
  }
  if (x.exact === x.total) {
    return `<span title="Calls are resolved by a compiler (TypeScript, or an index from CI)">Calls: exact</span>`;
  }
  const title = "Calls in some languages are matched by name, so two functions with the same name can both be linked. Add a diffmap-index CI job for exact results (see README).";
  return x.exact === 0
    ? `<span title="${title}">Calls: matched by name</span>`
    : `<span title="${title}">Calls: exact in ${x.exact} of ${x.total} files</span>`;
}
