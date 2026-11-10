import { extname } from "node:path";
import type { SyntaxHighlighterPort, HighlightToken } from "../../application/ports/syntax-highlighter.port.js";
import type { AnalysisResult } from "../../domain/analysis-result.js";
import type { FileView } from "../../domain/file-view.js";
import type { CallSite, GraphNode } from "../../domain/graph.js";
import type { DiffLine } from "../../domain/symbol.js";
import { STYLE } from "./html-style.js";
import { CLIENT_SCRIPT } from "./html-client.js";
import { THEME_BOOT, THEME_BUTTON } from "./theme.js";
import { MR_CLIENT_SCRIPT } from "./html-client-mr.js";
import type {
  Approvals,
  MergeRequestInfo,
  Person,
  ReviewDiscussion,
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
  viewed: string[]; // ids of symbols this user marked as viewed
  /** Whether CI's exact index was used: found, still building, not set up. */
  indexState?: "found" | "pending" | "none" | "unsupported";
}

export interface RenderOptions {
  mr?: MrPage;
  /** Files longer than this start collapsed in the map (default 500). */
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

// Layout of the map canvas (px).
export const MARGIN = 40;
const LABEL_H = 28; // room for the column titles above the cards
const LANES = 56; // space between the two columns
const CODE_CHAR = 7.4;
const CODE_GUTTER = 112; // two line-number columns, sign column and padding
const MIN_W = 380;
const MAX_W = 760;
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

function codeWidth(lines: string[]): number {
  let w = 0;
  for (const l of lines) w = Math.max(w, expandTabs(l).length * CODE_CHAR + CODE_GUTTER);
  return Math.round(Math.min(MAX_W, Math.max(MIN_W, w)));
}

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

const pathHtml = (file: string): string => {
  const { dir, base } = splitPath(file);
  return `<span class="fpath" title="${esc(file)}"><span class="fdir">${esc(dir)}</span><span class="fname">${esc(base)}</span></span>`;
};

const tokensHtml = (text: string, tokens?: HighlightToken[]): string =>
  tokens
    ? tokens
        .map((t) =>
          t.kind === "plain"
            ? esc(expandTabs(t.text))
            : `<span class="tk-${t.kind}">${esc(expandTabs(t.text))}</span>`
        )
        .join("")
    : esc(expandTabs(text));

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
  before: string[];
  after: string[];
  refs: Ref[];
}

/** Render an AnalysisResult as one self-contained, interactive review page. */
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

  // Callers outside the diff: unchanged symbols in files that have no file view.
  const outCallers: GraphNode[] = [];
  const ciOf = new Map<string, number>();
  const callsInto = new Map<string, Set<number>>(); // caller id -> changed symbols it calls

  const syms: SymInfo[] = changed.map((n) => {
    const diff = diffOf.get(n.id) ?? [];
    return {
      id: n.id,
      name: n.name,
      kind: KIND_LABEL[n.kind] ?? n.kind,
      status: n.status ?? "modified",
      file: n.file,
      line: n.line,
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
      (callsInto.get(caller.id) ?? callsInto.set(caller.id, new Set()).get(caller.id)!).add(k);
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

  // ── left column: one card per changed file ──
  let addedLines = 0;
  let removedLines = 0;
  // Collapsed large files don't make every card wide.
  const leftW = Math.max(MIN_W, ...views.filter((v) => !isLargeFile(v, options)).map((v) => codeWidth(v.lines.map((l) => l.text))));
  const symsByFile = new Map<string, number[]>();
  changed.forEach((n, k) => symsByFile.set(n.file, [...(symsByFile.get(n.file) ?? []), k]));

  const fileStats = views.map((v) => ({
    add: v.lines.filter((l) => l.type === "add").length,
    del: v.lines.filter((l) => l.type === "del").length,
  }));

  const leftCards = views
    .map((view, fi) => {
      const hl = hlFor(view.path);
      const tokens = hl ? highlightView(view, hl) : null;
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
          rows.push(`<button class="gap" type="button" data-n="${j - i}">⋯ ${j - i} unchanged line${j - i === 1 ? "" : "s"}</button>`);
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
          `<div class="${cls}"${id}${def}><span class="lo">${l.oldLine ?? ""}</span><span class="ln">${l.newLine ?? ""}</span><span class="sg">${sign}</span><span class="tx">${tokensHtml(l.text, tokens?.[i])}</span></div>`
        );
      });

      const expand = folded
        ? `<button class="cbtn expand" type="button" aria-pressed="false" title="Show the whole file">Whole file</button>`
        : "";
      const large = isLargeFile(view, options);
      const total = view.lines.filter((l) => l.type !== "del").length || view.lines.length;
      const bigBar = large
        ? `<button class="bigbar" type="button">${total.toLocaleString("en-US")} lines · hidden because the file is large · <b>Show</b></button>`
        : "";
      return `<section class="card in${large ? " big" : ""}" id="c${fi}" style="left:${MARGIN}px;width:${leftW}px">
  <header class="ch">${pathHtml(view.path)}${copyButton(view.path)}${expand}<span class="cmeta"><span class="add">+${add}</span><span class="del">−${del}</span></span></header>
  ${bigBar}<div class="code">${rows.join("")}</div>
</section>`;
    })
    .join("\n");

  // ── right column: files outside the diff, one block per calling symbol ──
  const outByFile = new Map<string, GraphNode[]>();
  for (const c of outCallers) outByFile.set(c.file, [...(outByFile.get(c.file) ?? []), c]);
  const outFiles = [...outByFile.keys()].sort();
  const rightX = MARGIN + leftW + LANES;
  const rightW = Math.max(MIN_W, ...outCallers.map((c) => codeWidth(c.code ?? [])));

  const rightCards = outFiles
    .map((file, oi) => {
      const callers = outByFile.get(file)!.sort((a, b) => a.line - b.line);
      const hl = hlFor(file);
      const forCard = new Set<number>();
      const blocks = callers
        .map((c) => {
          const ci = ciOf.get(c.id)!;
          const ks = [...(callsInto.get(c.id) ?? [])];
          ks.forEach((k) => forCard.add(k));
          const code = c.code ?? [];
          const tokens = hl && code.length ? hl.highlight(file, code) : null;
          const rows = code
            .map((text, i) => {
              const n = c.line + i;
              return `<div class="dl ctx" id="U${ci}-${n}"><span class="lo">${n}</span><span class="ln">${n}</span><span class="sg"></span><span class="tx">${tokensHtml(text, tokens?.[i])}</span></div>`;
            })
            .join("");
          return `<div class="caller" data-for="${ks.join(" ")}">${rows || `<div class="deco">${esc(c.name)}</div>`}</div>`;
        })
        .join("");
      return `<section class="card out" id="o${oi}" data-for="${[...forCard].join(" ")}" style="left:${rightX}px;width:${rightW}px">
  <header class="ch">${pathHtml(file)}${copyButton(file)}</header>
  <div class="code">${blocks}</div>
</section>`;
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
        return `<button class="sf-sym" type="button" data-sel="${k}"><span class="b"><span class="nm mono st-${s.status}">${esc(s.name)}</span><span class="sub">${esc(s.kind)} · ${usesText(s.refs.length)}</span></span><span class="vw" aria-hidden="true"></span></button>`;
      })
      .join("");
    const status = v.status === "added" ? "added" : v.status === "deleted" ? "deleted" : "modified";
    return `<div class="sf"><button class="sf-file mono fs-${status}" type="button" data-card="c${fi}" title="${esc(v.path)} · ${status}"><span class="p"><b>${esc(base)}</b></span><span class="n"><span class="add">+${fileStats[fi].add}</span> <span class="del">−${fileStats[fi].del}</span></span></button>${items}</div>`;
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
  const broken = result.edges.filter((e) => e.kind === "calls-removed").length;
  const warnPill = broken
    ? `<span class="pill warn">${broken === 1 ? "1 call still points" : `${broken} calls still point`} at removed code</span>`
    : "";

  const outUses = syms.reduce((a, s) => a + s.refs.filter((r) => r.out).length, 0);
  const outSummary = outFiles.length
    ? `<span>${outUses} usage${outUses === 1 ? "" : "s"} in ${outFiles.length} file${outFiles.length === 1 ? "" : "s"} outside the diff</span>`
    : "";

  const data = {
    key: `diffmap:viewed:${result.base}..${result.head}`,
    syms,
    leftX: MARGIN,
    leftW,
    rightX,
    rightW,
    top: MARGIN + LABEL_H,
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
<body class="show-out${mrPage ? " mr" : ""}${mrPage && !mrPage.readOnly ? " mr-write" : ""}">
<header class="top">
  <div class="brand"><svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="6" r="2.5"></circle><circle cx="19" cy="6" r="2.5"></circle><circle cx="12" cy="18" r="2.5"></circle><path d="M7.5 6h9M6.5 8.2l4.2 7.6M17.5 8.2l-4.2 7.6"></path></svg><span>diffmap</span></div>
  <div class="title"><div class="t">${mrPage ? `<a href="${esc(mrPage.mr.webUrl)}" title="Open in ${esc(mrPage.hostName ?? "GitLab")}">${esc(title)}</a>` : esc(title)}</div><div class="s mono">${esc(sub)}</div></div>
  <div class="pills">
    <span class="pill mono"><span class="add">+${addedLines}</span><span class="del">−${removedLines}</span></span>
    <span class="pill">${views.length} file${views.length === 1 ? "" : "s"} · ${changed.length} symbol${changed.length === 1 ? "" : "s"}</span>
    ${THEME_BUTTON}
    ${warnPill}
    ${exactPill(result, mrPage?.indexState)}
    ${mrPage ? mrActions(mrPage) : ""}
  </div>
</header>
<div class="panes" id="panes">
  <div class="rz l" id="rzl" title="Drag to resize · double-click to reset" aria-hidden="true"></div>
  <div class="rz r" id="rzr" title="Drag to resize · double-click to reset" aria-hidden="true"></div>
  <aside class="side">
    <div class="side-head"><h2>Changed files</h2><span>${views.length}</span></div>
    <div class="side-list">${sidebar}</div>
    <div class="progress">
      <div class="r"><span>Viewed</span><span><span id="vcount">0</span> of ${changed.length} symbols</span></div>
      <div class="bar"><div id="vbar"></div></div>
    </div>
  </aside>
  <main class="map">
    <div class="map-head">
      <div>
        <h1>Change map</h1>
        <div class="sub"><span>${changed.length} changed symbol${changed.length === 1 ? "" : "s"}</span>${outSummary}</div>
      </div>
      <div class="tools">
        <button class="switch" id="outsw" type="button" role="switch" aria-checked="true"><span class="tr"><span class="kn"></span></span><span>Usages outside the diff</span></button>
        <div class="zoom"><button type="button" id="zout" aria-label="Zoom out">−</button><span id="zpct">100%</span><button type="button" id="zin" aria-label="Zoom in">+</button><button type="button" class="fit" id="fit">Fit</button></div>
      </div>
    </div>
    <div id="vp">
      ${empty ? `<p class="empty" style="padding:40px;text-align:center">No changed files in this range.</p>` : ""}
      <div id="cv">
        <svg id="sv" width="10" height="10" aria-hidden="true">
          <defs>
            <marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z"/></marker>
            <marker id="ah-bad" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z"/></marker>
          </defs>
          <g id="edges"></g>
        </svg>
        <div class="col-label" style="left:${MARGIN}px">Changed in this range</div>
        <div class="col-label r" id="rlabel" style="left:${rightX}px">Where it is used · outside the diff</div>
        ${leftCards}
        ${rightCards}
      </div>
    </div>
    <div class="legend">
      <span><span class="sw a"></span>Added line</span>
      <span><span class="sw d"></span>Removed line</span>
      <span><span class="sw u"></span>Uses the selected symbol</span>
      <span><span class="sw o"></span>File not in diff</span>
      <span style="margin-left:auto;color:var(--muted)">click a usage to go to its definition · click a definition to step through its usages · drag or scroll to move · ctrl+scroll to zoom · Esc clears</span>
    </div>
  </main>
  <aside class="detail" id="detail">
    <div id="ov">
      <div class="sec">
        <div class="lbl">Overview</div>
        <p class="summary">Pick a changed symbol in the list, or click its line in the map, to see where it is used.</p>
      </div>
      <div class="stats" style="margin-top:18px">
        <div class="stat"><b>${views.length}</b><span>files changed</span></div>
        <div class="stat"><b>${changed.length}</b><span>symbols changed</span></div>
        <div class="stat"><b class="add">+${addedLines}</b><span>lines added</span></div>
        <div class="stat"><b class="del">−${removedLines}</b><span>lines removed</span></div>
      </div>
      ${broken ? `<div class="warnbox" style="margin-top:18px">${broken === 1 ? "1 call still points" : `${broken} calls still point`} at code this change removes. Select the removed symbol to see them, highlighted in red.</div>` : ""}
    </div>
    <div id="dt" hidden></div>
  </aside>
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
    <span class="pill" id="ccount">${p.discussions.length} comment${p.discussions.length === 1 ? "" : "s"}</span>
    <a class="hbtn" href="${esc(p.mr.webUrl)}">Open in ${esc(p.hostName ?? "GitLab")}</a>
    ${p.readOnly ? `<span class="pill" title="This diffmap is view-only: comment and approve in ${esc(p.hostName ?? "GitLab")}">View only</span>` : `<button class="hbtn ${a.userHasApproved ? "" : "primary"}" id="approve" type="button" aria-pressed="${a.userHasApproved}"${disabled}>${label}</button>`}
    <form method="post" action="/auth/logout" class="who"><span title="Signed in as @${esc(p.user.username)}">${esc(p.user.name)}</span><button type="submit" class="link">Sign out</button></form>`;
}

/** Whether usages come from a compiler (exact) or from matching names. */
function exactPill(result: AnalysisResult, indexState?: string): string {
  const x = result.exactness;
  if (!x || x.total === 0) return "";
  if (indexState === "pending" && x.exact < x.total) {
    return `<span class="pill" title="The CI job diffmap-index is still running for this commit. Reload in a minute for exact calls.">Calls: by name · exact index still building</span>`;
  }
  if (x.exact === x.total) {
    return `<span class="pill" title="Calls are resolved by a compiler (TypeScript, or an index from CI)">Calls: exact</span>`;
  }
  const title = "Calls in some languages are matched by name, so two functions with the same name can both be linked. Add a diffmap-index CI job for exact results (see README).";
  return x.exact === 0
    ? `<span class="pill" title="${title}">Calls: matched by name</span>`
    : `<span class="pill" title="${title}">Calls: exact in ${x.exact} of ${x.total} files</span>`;
}
