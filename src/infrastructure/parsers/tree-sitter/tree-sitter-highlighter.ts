import type { Node } from "./node.js";
import type {
  HighlightDetail,
  HighlightKind,
  HighlightToken,
  SyntaxHighlighterPort,
} from "../../../application/ports/syntax-highlighter.port.js";
import { calledName, type LanguageSpec } from "./languages.js";
import { definedName, nameNode, type TreeSitterEngine } from "./engine.js";


// Node-type patterns that mean the same thing in most tree-sitter grammars.
const COMMENT = /comment/;
const STRING = /^(string|string_literal|raw_string_literal|interpreted_string_literal|template_string|char_literal|character_literal|rune_literal|heredoc_body|encapsed_string|line_string_literal|multi_line_string_literal|verbatim_string_literal)$/;
const CHARACTER = /^(char_literal|character_literal|rune_literal)$/;
const REGEX = /^(regex|regex_literal|regex_pattern)$/;
const NUMBER = /number|integer|float|decimal|hex_|_literal$/;
const DECORATOR = /^(decorator|annotation|marker_annotation|attribute_item|attribute_list|attribute)$/; // attribute: Swift @MainActor
const TYPE = /^(type_identifier|primitive_type|integral_type|floating_point_type|boolean_type|void_type|predefined_type|builtin_type|sized_type_specifier)$/;
const CONSTANT = /^(true|false|null|nil|none|this|self|super|null_literal|boolean_literal|undefined)$/;
const IDENT = /(^|_)identifier$|^name$|^constant$/;
/** Compiler directives: C and Objective-C `#import`, `#define`, `#if`; Swift `#if`. */
const DIRECTIVE = /^(preproc_\w+|directive)$/;
/** The parts of a C or Objective-C directive that are the directive itself (an `#if` also holds the code up to its `#endif`). */
const DIRECTIVE_PARTS = ["name", "condition", "value", "parameters", "path", "directive", "argument"];
/** Kinds of symbol whose name is a type's. */
const TYPE_KINDS = /^(class|struct|interface|enum|trait|module)$/;
/** Documentation comments: `///`, `//!`, and those that open with `/**`. */
const DOC = /^(\/\/\/|\/\*\*(?!\/)|\/\/!)/;
/** Comments an editor shows as headings or reminders: `// MARK: - Actions`, `// TODO:`, `#pragma mark`. */
const MARK = /^(\/\/|#)\s*(MARK|TODO|FIXME)\s*:|^#pragma\s+mark\b/;

interface Paint {
  kind: HighlightKind;
  detail?: HighlightDetail;
}

/** One Paint per kind and detail, shared, so that runs of equal paint are easy to see. */
const paints = new Map<string, Paint>();
const p = (kind: HighlightKind, detail?: HighlightDetail): Paint => {
  const key = `${kind}/${detail ?? ""}`;
  return paints.get(key) ?? paints.set(key, detail ? { kind, detail } : { kind }).get(key)!;
};
const PLAIN = p("plain");

/**
 * Colours code for any tree-sitter language from the kind of syntax node:
 * comments, strings, numbers, keywords, types, names of functions being
 * defined or called, and decorators/annotations. Some tokens also get a detail
 * (see HighlightDetail) for colours that tell more apart, like Xcode's.
 */
export class TreeSitterHighlighter implements SyntaxHighlighterPort {
  readonly supportedExtensions: readonly string[];

  constructor(private readonly engine: TreeSitterEngine) {
    this.supportedExtensions = engine.extensions;
  }

  highlight(path: string, lines: string[]): HighlightToken[][] | null {
    if (lines.length === 0) return [];
    const source = lines.join("\n");
    const kinds: (Paint | undefined)[] = new Array(source.length);
    const ok = this.engine.with(
      path,
      source,
      (root, spec) => {
        mark(root, spec, kinds, new Map());
        return true;
      },
      true,
    );
    if (!ok) return null;

    const out: HighlightToken[][] = [[]];
    let i = 0;
    while (i < source.length) {
      if (source[i] === "\n") {
        out.push([]);
        i++;
        continue;
      }
      const paint = kinds[i] ?? PLAIN;
      let j = i + 1;
      while (j < source.length && source[j] !== "\n" && (kinds[j] ?? PLAIN) === paint) j++;
      out[out.length - 1].push(paint.detail ? { text: source.slice(i, j), kind: paint.kind, detail: paint.detail } : { text: source.slice(i, j), kind: paint.kind });
      i = j;
    }
    return out.length === lines.length ? out : null;
  }
}

function paint(kinds: (Paint | undefined)[], n: Node, with_: Paint): void {
  for (let i = n.startIndex; i < n.endIndex && i < kinds.length; i++) kinds[i] = with_;
}

/**
 * `defined`: where the names of the definitions met so far are written (start index), and
 * whether each is a type's. A definition's node comes before its name's, so it is filled in time.
 * `within`: the detail of what the node is part of (a directive, a regular expression), for its words that have none.
 */
function mark(node: Node, spec: LanguageSpec, kinds: (Paint | undefined)[], defined: Map<number, HighlightDetail>, within?: HighlightDetail): void {
  const t = node.type;
  if (COMMENT.test(t)) {
    const text = node.text;
    return paint(kinds, node, p("comment", MARK.test(text) ? "mark" : DOC.test(text) ? "doc" : undefined));
  }
  if (STRING.test(t)) return paint(kinds, node, p("string", CHARACTER.test(t) ? "character" : undefined));
  if (REGEX.test(t) && node.childCount === 0) return paint(kinds, node, p("plain", "regex"));
  if (DECORATOR.test(t)) return paint(kinds, node, p("decorator"));
  // `#pragma mark - Actions`: a heading, like `// MARK:`.
  if (DIRECTIVE.test(t) && MARK.test(node.text)) return paint(kinds, node, p("plain", "mark"));

  // The name of something diffmap lists as a symbol, where it is defined.
  const rule = spec.defs[t];
  if (rule && (!rule.when || rule.when(node))) {
    const containerOnly = typeof rule.containerOnly === "function" ? rule.containerOnly(node) : !!rule.containerOnly;
    const name = containerOnly ? null : definedName(node, rule);
    const at = name ? nameNode(node, name) : null;
    if (at) defined.set(at.startIndex, TYPE_KINDS.test(rule.kindOf?.(node) ?? rule.kind) ? "type-definition" : "definition");
  }

  if (node.childCount === 0) {
    const text = node.text;
    let kind: HighlightKind = "plain";
    let detail: HighlightDetail | undefined;
    if (spec.keywords?.has(text)) kind = "keyword";
    else if (!node.isNamed && /^[a-z_]{2,}$/.test(t)) kind = "keyword";
    // Swift `#selector`, `#available`: the "#" goes with its word.
    else if (!node.isNamed && t === "#" && /^[a-z_]{2,}$/.test(node.nextSibling?.isNamed === false ? node.nextSibling.type : "")) kind = "keyword";
    else if (CONSTANT.test(t)) kind = "keyword";
    else if (TYPE.test(t)) kind = "type";
    else if (node.isNamed && NUMBER.test(t) && /^[0-9.]/.test(text)) kind = "number";
    else if (IDENT.test(t) && isFunctionName(node, spec)) kind = "function";
    if (node.isNamed && (IDENT.test(t) || TYPE.test(t)) && kind !== "keyword") {
      detail = defined.get(node.startIndex);
      if (!detail && kind === "function" && spec.typesAreCalled && /^[A-Z]/.test(text)) detail = "constructor";
    }
    // Code in a regular expression (Ruby's `#{x}`) keeps its colours; the rest of a directive gets the directive's.
    if (within && !detail && (within === "regex" ? kind === "plain" : kind !== "keyword")) detail = within;
    if (kind !== "plain" || detail) paint(kinds, node, p(kind, detail));
    return;
  }
  for (const child of node.children) {
    const part = DIRECTIVE.test(t) && (t === "directive" || (child.childCount === 0 && !child.isNamed) || DIRECTIVE_PARTS.some((f) => same(node.childForFieldName(f), child)));
    mark(child, spec, kinds, defined, part ? "preprocessor" : DIRECTIVE.test(t) ? undefined : REGEX.test(t) ? "regex" : within);
  }
}

const same = (a: Node | null | undefined, b: Node): boolean =>
  !!a && a.startIndex === b.startIndex && a.endIndex === b.endIndex;

/** The name in a function definition, or the called name in a call. */
function isFunctionName(node: Node, spec: LanguageSpec): boolean {
  const p = node.parent;
  if (!p) return false;
  const def = spec.defs[p.type];
  if (def && /function|method|arrow/.test(def.kind) && (same(p.childForFieldName("name"), node) || same(p.namedChildren.find((c) => IDENT.test(c.type)), node))) {
    return true;
  }
  const call = spec.calls[p.type];
  if (call && calledName(call(p)) === node.text) return true;
  // A rule that points at the name itself (Swift: call > navigation_expression > navigation_suffix > name).
  for (let a: Node | null = p, depth = 0; a && depth < 3; a = a.parent, depth++) {
    const answer = spec.calls[a.type]?.(a);
    if (answer && typeof answer !== "string" && answer.at) return same(answer.at, node);
  }
  // a.b.update(...): the last part of a member access that is being called
  const g = p.parent;
  return !!g && !!spec.calls[g.type] && calledName(spec.calls[g.type](g)) === node.text && same(p.namedChildren[p.namedChildren.length - 1], node);
}
