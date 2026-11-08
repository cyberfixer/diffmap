import type Parser from "web-tree-sitter";
import type {
  HighlightKind,
  HighlightToken,
  SyntaxHighlighterPort,
} from "../../../application/ports/syntax-highlighter.port.js";
import type { LanguageSpec } from "./languages.js";
import type { TreeSitterEngine } from "./engine.js";

type Node = Parser.SyntaxNode;

// Node-type patterns that mean the same thing in most tree-sitter grammars.
const COMMENT = /comment/;
const STRING = /^(string|string_literal|raw_string_literal|interpreted_string_literal|template_string|char_literal|character_literal|rune_literal|heredoc_body|encapsed_string|line_string_literal|multi_line_string_literal|verbatim_string_literal)$/;
const NUMBER = /number|integer|float|decimal|hex_|_literal$/;
const DECORATOR = /^(decorator|annotation|marker_annotation|attribute_item|attribute_list)$/;
const TYPE = /^(type_identifier|primitive_type|integral_type|floating_point_type|boolean_type|void_type|predefined_type|builtin_type|sized_type_specifier)$/;
const CONSTANT = /^(true|false|null|nil|none|this|self|super|null_literal|boolean_literal|undefined)$/;
const IDENT = /(^|_)identifier$|^name$|^constant$/;

/**
 * Colours code for any tree-sitter language from the kind of syntax node:
 * comments, strings, numbers, keywords, types, names of functions being
 * defined or called, and decorators/annotations.
 */
export class TreeSitterHighlighter implements SyntaxHighlighterPort {
  readonly supportedExtensions: readonly string[];

  constructor(private readonly engine: TreeSitterEngine) {
    this.supportedExtensions = engine.extensions;
  }

  highlight(path: string, lines: string[]): HighlightToken[][] | null {
    if (lines.length === 0) return [];
    const source = lines.join("\n");
    const kinds: (HighlightKind | undefined)[] = new Array(source.length);
    const ok = this.engine.with(path, source, (root, spec) => {
      mark(root, spec, kinds);
      return true;
    });
    if (!ok) return null;

    const out: HighlightToken[][] = [[]];
    let i = 0;
    while (i < source.length) {
      if (source[i] === "\n") {
        out.push([]);
        i++;
        continue;
      }
      const kind = kinds[i] ?? "plain";
      let j = i + 1;
      while (j < source.length && source[j] !== "\n" && (kinds[j] ?? "plain") === kind) j++;
      out[out.length - 1].push({ text: source.slice(i, j), kind });
      i = j;
    }
    return out.length === lines.length ? out : null;
  }
}

function paint(kinds: (HighlightKind | undefined)[], n: Node, kind: HighlightKind): void {
  for (let i = n.startIndex; i < n.endIndex && i < kinds.length; i++) kinds[i] = kind;
}

function mark(node: Node, spec: LanguageSpec, kinds: (HighlightKind | undefined)[]): void {
  const t = node.type;
  if (COMMENT.test(t)) return paint(kinds, node, "comment");
  if (STRING.test(t)) return paint(kinds, node, "string");
  if (DECORATOR.test(t)) return paint(kinds, node, "decorator");

  if (node.childCount === 0) {
    if (!node.isNamed && /^[a-z_]{2,}$/.test(t)) paint(kinds, node, "keyword");
    else if (CONSTANT.test(t)) paint(kinds, node, "keyword");
    else if (TYPE.test(t)) paint(kinds, node, "type");
    else if (node.isNamed && NUMBER.test(t) && /^[0-9.]/.test(node.text)) paint(kinds, node, "number");
    else if (IDENT.test(t) && isFunctionName(node, spec)) paint(kinds, node, "function");
    return;
  }
  for (const child of node.children) mark(child, spec, kinds);
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
  if (call && call(p) === node.text) return true;
  // a.b.update(...): the last part of a member access that is being called
  const g = p.parent;
  return !!g && !!spec.calls[g.type] && spec.calls[g.type](g) === node.text && same(p.namedChildren[p.namedChildren.length - 1], node);
}
