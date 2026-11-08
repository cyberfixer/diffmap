import type Parser from "web-tree-sitter";
import type { SymbolKind } from "../../../domain/symbol.js";

type Node = Parser.SyntaxNode;

/** How to recognise one kind of definition in a grammar. */
export interface DefRule {
  kind: SymbolKind;
  /** Pick the kind from the node when one node type covers several (Go `type X struct|interface`). */
  kindOf?: (n: Node) => SymbolKind;
  /** Only count the node when this holds (e.g. a JS variable whose value is a function). */
  when?: (n: Node) => boolean;
  /** Name of the definition; default: the "name" field, else the first identifier child. */
  name?: (n: Node) => string | null;
  /** Names nested definitions (Rust `impl Svc { fn x }` -> "Svc.x") but is not a symbol itself. */
  containerOnly?: boolean;
}

/** How to find the called name in one kind of call node. */
export type CallRule = (n: Node) => string | null;

export interface LanguageSpec {
  id: string; // grammar name in tree-sitter-wasms: tree-sitter-<id>.wasm
  extensions: string[];
  defs: Record<string, DefRule>;
  calls: Record<string, CallRule>;
}

const IDENT = /(^|_)identifier$|^name$|^constant$|^word$/;

/** The text of a node's identifier-like part: `a.b.c` -> "c", `Foo<T>` -> "Foo". */
export function lastName(n: Node | null): string | null {
  if (!n) return null;
  if (IDENT.test(n.type)) return n.text;
  const kids = n.namedChildren.filter((c) => !/argument|parameter|type_arguments|generic/.test(c.type));
  for (let i = kids.length - 1; i >= 0; i--) {
    const found = lastName(kids[i]);
    if (found) return found;
  }
  return null;
}

/** First identifier-like direct child (for grammars without a "name" field). */
export function firstIdent(n: Node): string | null {
  return n.namedChildren.find((c) => IDENT.test(c.type))?.text ?? null;
}

const field = (f: string): CallRule => (n) => lastName(n.childForFieldName(f));
const firstChild: CallRule = (n) => lastName(n.namedChildren[0] ?? null);
const fieldName = (f: string) => (n: Node) => lastName(n.childForFieldName(f));

/** C/C++: the name sits inside the declarator chain, e.g. `int Svc::update(int x)`. */
function declaratorName(n: Node): string | null {
  let d: Node | null = n.childForFieldName("declarator");
  while (d && d.childForFieldName("declarator")) d = d.childForFieldName("declarator");
  return d ? d.text.replace(/::/g, ".") : null;
}

const hasBody = (n: Node) => n.childForFieldName("body") !== null;

/**
 * Languages read with tree-sitter. TypeScript is not here: it keeps the more
 * exact TypeScript-compiler engine. Calls are matched by name (see the call graph).
 */
export const LANGUAGES: LanguageSpec[] = [
  {
    id: "javascript",
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    defs: {
      function_declaration: { kind: "function" },
      generator_function_declaration: { kind: "function" },
      class_declaration: { kind: "class" },
      method_definition: { kind: "method" },
      variable_declarator: {
        kind: "arrow",
        when: (n) => /^(arrow_function|function|function_expression)$/.test(n.childForFieldName("value")?.type ?? ""),
      },
      // class A { handler = () => {...} }
      field_definition: {
        kind: "arrow",
        when: (n) => /^(arrow_function|function|function_expression)$/.test(n.childForFieldName("value")?.type ?? ""),
        name: (n) => n.childForFieldName("property")?.text ?? null,
      },
    },
    calls: { call_expression: field("function"), new_expression: field("constructor") },
  },
  {
    id: "python",
    extensions: [".py"],
    defs: { function_definition: { kind: "function" }, class_definition: { kind: "class" } },
    calls: { call: field("function") },
  },
  {
    id: "java",
    extensions: [".java"],
    defs: {
      class_declaration: { kind: "class" },
      record_declaration: { kind: "class" },
      interface_declaration: { kind: "interface" },
      enum_declaration: { kind: "enum" },
      method_declaration: { kind: "method" },
      constructor_declaration: { kind: "method" },
    },
    calls: { method_invocation: field("name"), object_creation_expression: field("type") },
  },
  {
    id: "go",
    extensions: [".go"],
    defs: {
      function_declaration: { kind: "function" },
      method_declaration: {
        kind: "method",
        // func (s *Svc) Update() -> "Svc.Update"
        name: (n) => {
          const recv = n.childForFieldName("receiver");
          const type = recv?.descendantsOfType("type_identifier")[0]?.text;
          const name = n.childForFieldName("name")?.text ?? null;
          return type && name ? `${type}.${name}` : name;
        },
      },
      type_spec: {
        kind: "struct",
        kindOf: (n) => (n.childForFieldName("type")?.type === "interface_type" ? "interface" : "struct"),
        when: (n) => /^(struct_type|interface_type)$/.test(n.childForFieldName("type")?.type ?? ""),
      },
    },
    calls: { call_expression: field("function") },
  },
  {
    id: "c_sharp",
    extensions: [".cs"],
    defs: {
      class_declaration: { kind: "class" },
      record_declaration: { kind: "class" },
      struct_declaration: { kind: "struct" },
      interface_declaration: { kind: "interface" },
      enum_declaration: { kind: "enum" },
      namespace_declaration: { kind: "module", containerOnly: true },
      method_declaration: { kind: "method" },
      constructor_declaration: { kind: "method" },
      local_function_statement: { kind: "function" },
    },
    calls: { invocation_expression: field("function"), object_creation_expression: field("type") },
  },
  {
    id: "php",
    extensions: [".php"],
    defs: {
      class_declaration: { kind: "class" },
      interface_declaration: { kind: "interface" },
      trait_declaration: { kind: "trait" },
      enum_declaration: { kind: "enum" },
      method_declaration: { kind: "method" },
      function_definition: { kind: "function" },
    },
    calls: {
      function_call_expression: field("function"),
      member_call_expression: field("name"),
      nullsafe_member_call_expression: field("name"),
      scoped_call_expression: field("name"),
      object_creation_expression: firstChild,
    },
  },
  {
    id: "ruby",
    extensions: [".rb"],
    defs: {
      class: { kind: "class" },
      module: { kind: "module" },
      method: { kind: "method" },
      singleton_method: { kind: "method" },
    },
    calls: {
      // Svc.new -> "Svc"; anything else -> the method name
      call: (n) => {
        const method = n.childForFieldName("method")?.text ?? null;
        return method === "new" ? lastName(n.childForFieldName("receiver")) : method;
      },
    },
  },
  {
    id: "rust",
    extensions: [".rs"],
    defs: {
      function_item: { kind: "function" },
      function_signature_item: { kind: "method" },
      struct_item: { kind: "struct" },
      enum_item: { kind: "enum" },
      trait_item: { kind: "trait" },
      mod_item: { kind: "module", containerOnly: true },
      impl_item: { kind: "class", containerOnly: true, name: fieldName("type") },
    },
    calls: { call_expression: field("function") },
  },
  {
    id: "kotlin",
    extensions: [".kt", ".kts"],
    defs: {
      class_declaration: { kind: "class", name: firstIdent },
      object_declaration: { kind: "module", name: firstIdent },
      function_declaration: { kind: "function", name: firstIdent },
    },
    calls: { call_expression: firstChild },
  },
  {
    id: "swift",
    extensions: [".swift"],
    defs: {
      class_declaration: { kind: "class" },
      protocol_declaration: { kind: "interface" },
      function_declaration: { kind: "function" },
    },
    calls: { call_expression: firstChild },
  },
  {
    id: "scala",
    extensions: [".scala"],
    defs: {
      class_definition: { kind: "class" },
      object_definition: { kind: "module" },
      trait_definition: { kind: "trait" },
      function_definition: { kind: "function" },
    },
    calls: { call_expression: field("function"), instance_expression: firstChild },
  },
  {
    id: "c",
    extensions: [".c", ".h"],
    defs: {
      function_definition: { kind: "function", name: declaratorName },
      struct_specifier: { kind: "struct", when: hasBody },
    },
    calls: { call_expression: field("function") },
  },
  {
    id: "cpp",
    extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
    defs: {
      function_definition: { kind: "function", name: declaratorName },
      class_specifier: { kind: "class", when: hasBody },
      struct_specifier: { kind: "struct", when: hasBody },
      namespace_definition: { kind: "module", containerOnly: true },
    },
    calls: { call_expression: field("function"), new_expression: field("type") },
  },
];
