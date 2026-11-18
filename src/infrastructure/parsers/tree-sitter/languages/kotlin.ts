/** Kotlin. Rules for this language only: changing them changes no other language. */
import type { Node } from "../node.js";
import type { CallRule, LanguageSpec } from "./spec.js";
import { blank, capitalised, firstChild, firstIdent, keyword, parentsIn, returnsAfter, typeIdentifier } from "./shared.js";

/** Kotlin modifiers the bundled grammar cannot read as a name (`internal.run()`, `open = 1`, `{ override -> }`). */
const KOTLIN_MODIFIER_NAMES =
  "open|override|internal|final|abstract|public|private|protected|sealed|annotation|inline|operator|infix|external|lateinit|vararg|const|suspend|tailrec|crossinline|noinline|enum";
const KOTLIN_MODIFIER_AS_NAME = new RegExp(`(?<![\\w.@\`$])(?:${KOTLIN_MODIFIER_NAMES})(?=[ \\t]*(?:\\?\\.|\\.|->|=(?!=)))`, "g");
/** Stands in for the first letter of an infix function that starts with `e` (see kotlinPrepare): a Cyrillic "е", one character wide like the Latin one. */
const KOTLIN_E = "\u0435";
const balanced = (text: string): boolean => {
  let depth = 0;
  for (const ch of text) {
    if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) return false;
  }
  return depth === 0;
};

/**
 * Kotlin the bundled grammar (2023) cannot read, rewritten for the parser only. Every
 * change keeps each character's place, so lines and columns stay those of the file.
 * - `fun interface Lease {`: `fun` is blanked; it is read as an interface, which it is.
 * - `perform: Outer.Inner.() -> Unit`: the dots of the receiver type become `_`.
 * - `{ (_, key): Record -> key }`: the type after the destructured names is blanked.
 * - `view.get().visible = true`, `find<T>(id).text = x`: an assignment to a property of what a
 *   call returns. `=` becomes `==`, so both sides are still read, calls included.
 * - `map.getOrPut(k) { list() } += x`: the same, for `+=` after a trailing lambda.
 * - a modifier used as a name (`internal.launch()`, `{ open -> open.id }`, `override = x`):
 *   its last letter becomes `_`. A real modifier is never followed by `.`, `=` or `->`.
 * - `.where { }` and `fun where(`: a name here, a keyword only in `where T : Any`. The same.
 * - `1..<n` (Kotlin 1.9): read as `1.. n`.
 * - `a eq b`: an infix function whose name starts with `e` is not read (the grammar's own
 *   scanner takes the `e` for the start of `else`). The `e` is written as another letter.
 * Names changed on the way are put back by kotlinRestore, so the map shows what the file says.
 */
const kotlinPrepare = (source: string): string =>
  source
    .replace(/\bfun(?=[ \t]+interface\b)/g, blank)
    .replace(/\b[A-Z]\w*(?:\.[A-Z]\w*)+(?=\.\()/g, (m) => m.replace(/\./g, "_"))
    .replace(/(\{\s*\([^(){}\n]*\))(\s*:\s*[\w.<>?, ]+?)(?=\s*->)/g, (_, names: string, type: string) => names + blank(type))
    .replace(/^([ \t]*[^\n=]*\)\??\.[\w.?]+) = (?!=)/gm, (m, lhs: string) => (balanced(lhs) ? `${lhs}== ` : m))
    .replace(/\} \+= /g, "} == ")
    .replace(/\.\.<(?=[\w(])/g, ".. ")
    .replace(/(?<=\.)where\b|\bwhere(?=[ \t]*[({])/g, "wher_")
    .replace(/(?<=[\w)\]}"'] )e(?=\w* [\w("'{\[-])(?!(?:lse|num|xternal|xpect)\b)/g, KOTLIN_E)
    .replace(KOTLIN_MODIFIER_AS_NAME, (m) => m.slice(0, -1) + "_");

/** The names kotlinPrepare changed, as they are written in the file: `wher_` -> `where`, `interna_` -> `internal`. */
const KOTLIN_CHANGED_NAME = new RegExp(`\\b(?:${`${KOTLIN_MODIFIER_NAMES}|where`.split("|").map((w) => w.slice(0, -1)).join("|")})_(?![\\w])`, "g");
const KOTLIN_WRITTEN: Record<string, string> = Object.fromEntries(`${KOTLIN_MODIFIER_NAMES}|where`.split("|").map((w) => [w.slice(0, -1) + "_", w]));
const kotlinRestore = (text: string): string =>
  (text.includes("_") ? text.replace(KOTLIN_CHANGED_NAME, (m) => KOTLIN_WRITTEN[m] ?? m) : text).replaceAll(KOTLIN_E, "e");

/** `a eq b`, `mock returns x`: a function called between what it is called on and its one argument. */
const kotlinInfix: CallRule = (n) => {
  const [on, name] = n.namedChildren;
  if (!on || name?.type !== "simple_identifier" || n.namedChildren.length !== 3) return null;
  return { name: name.text, receiver: on.text, at: name, infix: true };
};

export const kotlin: LanguageSpec = {
  id: "kotlin",
  extensions: [".kt", ".kts"],
  family: "jvm",
  variableTypes: ["cast", "colonType", "constructed"],
  prepare: kotlinPrepare,
  restore: kotlinRestore,
  defs: {
    class_declaration: {
      kind: "class",
      name: firstIdent,
      kindOf: (n) => (keyword(n, "interface") ? "interface" : keyword(n, "enum") ? "enum" : "class"),
      supers: parentsIn("delegation_specifier", "delegation_specifiers"),
    },
    object_declaration: { kind: "module", name: firstIdent, supers: parentsIn("delegation_specifier", "delegation_specifiers") },
    function_declaration: { kind: "function", name: firstIdent, returns: returnsAfter(":") },
    secondary_constructor: { kind: "method", name: () => "constructor" },
    // val total: Int get() = ... (a property with code)
    property_declaration: {
      kind: "method",
      when: (n) => /^(getter|setter)$/.test(n.nextNamedSibling?.type ?? ""),
      name: (n) => n.namedChildren.find((c) => c.type === "variable_declaration")?.namedChildren[0]?.text ?? null,
      extendTo: (n) => {
        let last: Node | null = null;
        for (let s = n.nextNamedSibling; s && /^(getter|setter)$/.test(s.type); s = s.nextNamedSibling) last = s;
        return last;
      },
    },
  },
  typeName: (n) => typeIdentifier(n) ?? (n.type === "navigation_expression" ? capitalised(n.namedChildren[0]?.type === "simple_identifier" ? n.namedChildren[0] : null) : null),
  calls: { call_expression: firstChild, infix_expression: kotlinInfix },
};
