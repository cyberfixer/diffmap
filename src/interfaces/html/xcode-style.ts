/**
 * Code coloured like Xcode: its built-in themes "Default (Light)" and "Default (Dark)",
 * picked by the page's Auto / Light / Dark choice. Every value is taken from the theme files
 * themselves (`DVTSourceTextSyntaxColors`, `DVTSourceTextSyntaxFonts`, sRGB floats as hex):
 * https://github.com/adrianopaladini/Xcode27Theme ("Default (Light).xccolortheme", "Default (Dark).xccolortheme",
 * taken from a recent Xcode), checked against Xcode 11's copies at https://github.com/BeauNouvelle/Xcode-11-Themes.
 * The two agree on every colour below; Xcode 11 had none for regular expressions. The insertion
 * point (the system blue in the newer files, white and black in Xcode 11) is left out: the code has none.
 *
 * Xcode tells a name being declared from one being used, and a name the project declares from
 * one a library does (a "project" or a "system" class, function...). diffmap marks declarations
 * (HighlightDetail) and knows which names the repo defines (AnalysisResult.names, class "own").
 * Not followed: variables, properties and constants by who declares them (diffmap does not know
 * a stored property's name, so they stay plain text), macros, and the gutter, which the theme
 * files leave to the system.
 */

interface Palette {
  background: string; // DVTSourceTextBackground
  plain: string; // xcode.syntax.plain
  selection: string; // DVTSourceTextSelectionColor
  currentLine: string; // DVTSourceTextCurrentLineHighlightColor
  keyword: string;
  string: string;
  character: string;
  number: string;
  regex: string;
  comment: string;
  doc: string; // comment.doc
  docKeyword: string; // comment.doc.keyword: `- Parameter`, `- Returns:`
  mark: string; // `// MARK:`
  preprocessor: string;
  attribute: string;
  url: string;
  typeDeclaration: string; // declaration.type: `class Store`
  otherDeclaration: string; // declaration.other: `func save`
  projectType: string; // identifier.class and identifier.type (one colour in both themes)
  otherType: string; // identifier.class.system and identifier.type.system
  projectFunction: string; // identifier.function
  otherFunction: string; // identifier.function.system
  // Fonts: SF Mono 12 pt. Light: Regular, keywords Semibold. Dark: Medium, keywords Bold.
  // Both: marks and documentation keywords Bold; documentation comments in Helvetica (Neue).
  weight: number;
  keywordWeight: number;
  docFont: string;
}

export const XCODE_LIGHT: Palette = {
  background: "#FFFFFF",
  plain: "rgba(0, 0, 0, 0.85)",
  selection: "#A4CDFF",
  currentLine: "#E8F2FF",
  keyword: "#9B2393",
  string: "#C41A16",
  character: "#1C00CF",
  number: "#1C00CF",
  regex: "#C41A16",
  comment: "#5D6C79",
  doc: "#5D6C79",
  docKeyword: "#4A5560",
  mark: "#4A5560",
  preprocessor: "#643820",
  attribute: "#815F03",
  url: "#0E0EFF",
  typeDeclaration: "#0B4F79",
  otherDeclaration: "#0F68A0",
  projectType: "#1C464A",
  otherType: "#3900A0",
  projectFunction: "#326D74",
  otherFunction: "#6C36A9",
  weight: 400,
  keywordWeight: 600,
  docFont: '"Helvetica Neue", Helvetica, Arial, sans-serif',
};

export const XCODE_DARK: Palette = {
  background: "#1F1F24",
  plain: "rgba(255, 255, 255, 0.85)",
  selection: "#515B70",
  currentLine: "#23252B",
  keyword: "#FC5FA3",
  string: "#FC6A5D",
  character: "#D0BF69",
  number: "#D0BF69",
  regex: "#FC6A5D",
  comment: "#6C7986",
  doc: "#6C7986",
  docKeyword: "#92A1B1",
  mark: "#92A1B1",
  preprocessor: "#FD8F3F",
  attribute: "#BF8555",
  url: "#5482FF",
  typeDeclaration: "#5DD8FF",
  otherDeclaration: "#41A1C0",
  projectType: "#9EF1DD",
  otherType: "#D0A8FF",
  projectFunction: "#67B7A4",
  otherFunction: "#A167E6",
  weight: 500,
  keywordWeight: 700,
  docFont: 'Helvetica, "Helvetica Neue", Arial, sans-serif',
};

/**
 * The palette as CSS properties (all --xc-*, so nothing else on the page changes), plus added and
 * removed lines that stay readable on its background; the code takes them up (see XCODE_STYLE).
 */
const tokens = (c: Palette, dark: boolean): string => `
--xc-bg:${c.background}; --xc-plain:${c.plain}; --xc-selection:${c.selection}; --xc-line:${c.currentLine};
--xc-keyword:${c.keyword}; --xc-string:${c.string}; --xc-character:${c.character}; --xc-number:${c.number}; --xc-regex:${c.regex};
--xc-comment:${c.comment}; --xc-doc:${c.doc}; --xc-doc-keyword:${c.docKeyword}; --xc-mark:${c.mark}; --xc-preprocessor:${c.preprocessor};
--xc-attribute:${c.attribute}; --xc-url:${c.url}; --xc-type-declaration:${c.typeDeclaration}; --xc-declaration:${c.otherDeclaration};
--xc-type:${c.projectType}; --xc-type-other:${c.otherType}; --xc-function:${c.projectFunction}; --xc-function-other:${c.otherFunction};
--xc-weight:${c.weight}; --xc-keyword-weight:${c.keywordWeight}; --xc-doc-font:${c.docFont};
--xc-mono:ui-monospace, "SF Mono", SFMono-Regular, Menlo, Monaco, Consolas, monospace;
${
  dark
    ? "--xc-add-bg:#1B3526; --xc-add-gut:#214431; --xc-add-hl:#2C6A45; --xc-del-bg:#3D1F25; --xc-del-gut:#4F252C; --xc-del-hl:#80303C; --xc-use-bg:#1E2B45; --xc-use-gut:#263A5E;"
    : "--xc-add-bg:#E3F5E8; --xc-add-gut:#CDEBD6; --xc-add-hl:#A3DDB6; --xc-del-bg:#FDEBEC; --xc-del-gut:#F7D6D8; --xc-del-hl:#F5B5B0; --xc-use-bg:#EAF0FC; --xc-use-gut:#D9E4F8;"
}`;

/**
 * The Xcode colours, on when the page has data-style="xcode" (see theme.ts). Only the code
 * (the changed files and the code in the panel) changes; the rest of the page keeps its colours.
 */
export const XCODE_STYLE = `
  :root[data-style="xcode"] { ${tokens(XCODE_LIGHT, false)} }
  @media (prefers-color-scheme: dark) {
    :root[data-style="xcode"]:not([data-theme="light"]) { ${tokens(XCODE_DARK, true)} }
  }
  :root[data-style="xcode"][data-theme="dark"] { ${tokens(XCODE_DARK, true)} }
  [data-style="xcode"] .ed, [data-style="xcode"] .prev { background:var(--xc-bg); }
  [data-style="xcode"] .code { --add-bg:var(--xc-add-bg); --add-gut:var(--xc-add-gut); --add-hl:var(--xc-add-hl); --del-bg:var(--xc-del-bg);
                               --del-gut:var(--xc-del-gut); --del-hl:var(--xc-del-hl); --use-bg:var(--xc-use-bg); --use-gut:var(--xc-use-gut); }
  /* SF Mono 12 pt, line spacing 1.1 (DVTLineSpacing) of its 1.19 line: 16px. */
  [data-style="xcode"] .dl { font:var(--xc-weight) 12px/16px var(--xc-mono); min-height:16px; color:var(--xc-plain); }
  [data-style="xcode"] .dl.ctx.sel { background:var(--xc-line); }
  [data-style="xcode"] .code ::selection { background:var(--xc-selection); }
  [data-style="xcode"] .tk-keyword { color:var(--xc-keyword); font-weight:var(--xc-keyword-weight); }
  [data-style="xcode"] .tk-string { color:var(--xc-string); }
  [data-style="xcode"] .tk-character { color:var(--xc-character); }
  [data-style="xcode"] .tk-number { color:var(--xc-number); }
  [data-style="xcode"] .tk-regex { color:var(--xc-regex); }
  [data-style="xcode"] .tk-comment { color:var(--xc-comment); font-style:normal; }
  [data-style="xcode"] .tk-doc { color:var(--xc-doc); font-family:var(--xc-doc-font); }
  [data-style="xcode"] .tk-doc-keyword { color:var(--xc-doc-keyword); font-family:var(--xc-mono); font-weight:700; }
  [data-style="xcode"] .tk-mark { color:var(--xc-mark); font-weight:700; }
  [data-style="xcode"] .tk-preprocessor { color:var(--xc-preprocessor); }
  [data-style="xcode"] .tk-decorator { color:var(--xc-attribute); }
  [data-style="xcode"] .tk-url { color:var(--xc-url); }
  /* Later rules win: a type called like a function (constructor) is a type; a declared name is a declaration. */
  [data-style="xcode"] .tk-function { color:var(--xc-function-other); }
  [data-style="xcode"] .tk-function.own { color:var(--xc-function); }
  [data-style="xcode"] .tk-type, [data-style="xcode"] .tk-constructor { color:var(--xc-type-other); }
  [data-style="xcode"] .tk-type.own, [data-style="xcode"] .tk-constructor.own { color:var(--xc-type); }
  [data-style="xcode"] .tk-type-definition { color:var(--xc-type-declaration); }
  [data-style="xcode"] .tk-definition { color:var(--xc-declaration); }
`;
