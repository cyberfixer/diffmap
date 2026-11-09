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
  containerOnly?: boolean | ((n: Node) => boolean);
  /** The symbol also covers this later node (Kotlin puts a property's `get()` next to it, not inside). */
  extendTo?: (n: Node) => Node | null;
  /** Names of the types this one extends or implements (`class A extends B implements C` -> B, C). */
  supers?: (n: Node) => string[];
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

/** Generic arguments and constructor arguments are not parent types: `Base<T>(x)` -> Base. */
const NOT_A_PARENT = /type_arguments|type_parameters|type_argument_list|template_argument_list|value_arguments|^arguments$/;

/**
 * Parent types written in the given child nodes (`extends`, `implements`, `: Base`):
 * every capitalised name in them, skipping generic arguments. Package parts
 * (`com.x.Base`) are lowercase, so only `Base` is kept.
 */
const parentsIn =
  (...childTypes: string[]) =>
  (n: Node): string[] => {
    const out: string[] = [];
    const walk = (c: Node): void => {
      if (NOT_A_PARENT.test(c.type)) return;
      if (c.namedChildCount === 0) {
        if (/^[A-Z]\w*$/.test(c.text) && !out.includes(c.text)) out.push(c.text);
        return;
      }
      for (const k of c.namedChildren) walk(k);
    };
    for (const c of n.namedChildren) if (childTypes.includes(c.type)) walk(c);
    return out;
  };

/** True when the node has this keyword as a direct child (Kotlin `interface X`, `enum class X`). */
const keyword = (n: Node, word: string) => n.children.some((c) => c.type === word);

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
    defs: {
      function_definition: { kind: "function" },
      class_definition: { kind: "class", supers: parentsIn("argument_list") }, // class A(Base, Mixin)
    },
    calls: { call: field("function") },
  },
  {
    id: "java",
    extensions: [".java"],
    defs: {
      class_declaration: { kind: "class", supers: parentsIn("superclass", "super_interfaces") },
      record_declaration: { kind: "class", supers: parentsIn("super_interfaces") },
      interface_declaration: { kind: "interface", supers: parentsIn("extends_interfaces") },
      enum_declaration: { kind: "enum", supers: parentsIn("super_interfaces") },
      method_declaration: { kind: "method" },
      constructor_declaration: { kind: "method" },
    },
    calls: {
      method_invocation: field("name"),
      object_creation_expression: field("type"),
      // this::check, Order::total -> the method; Foo::new -> the class
      method_reference: (n) => lastName(n.namedChildren[n.namedChildren.length - 1] ?? null),
    },
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
      class_declaration: { kind: "class", supers: parentsIn("base_list") },
      record_declaration: { kind: "class", supers: parentsIn("base_list") },
      struct_declaration: { kind: "struct", supers: parentsIn("base_list") },
      interface_declaration: { kind: "interface", supers: parentsIn("base_list") },
      enum_declaration: { kind: "enum" },
      namespace_declaration: { kind: "module", containerOnly: true },
      method_declaration: { kind: "method" },
      constructor_declaration: { kind: "method" },
      local_function_statement: { kind: "function" },
      // int Total { get { ... } } / int Fast => ...; (not `{ get; set; }`)
      property_declaration: {
        kind: "method",
        when: (n) =>
          n.childForFieldName("value")?.type === "arrow_expression_clause" ||
          (n.childForFieldName("accessors")?.namedChildren.some((a) => a.namedChildren.length > 0) ?? false),
      },
    },
    calls: { invocation_expression: field("function"), object_creation_expression: field("type") },
  },
  {
    id: "php",
    extensions: [".php"],
    defs: {
      class_declaration: { kind: "class", supers: parentsIn("base_clause", "class_interface_clause") },
      interface_declaration: { kind: "interface", supers: parentsIn("base_clause") },
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
      class: { kind: "class", supers: parentsIn("superclass") },
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
      // impl Trait for Svc { ... }: names Svc's methods, and Svc implements Trait
      impl_item: {
        kind: "class",
        containerOnly: true,
        name: fieldName("type"),
        supers: (n) => {
          const t = fieldName("trait")(n);
          return t ? [t] : [];
        },
      },
    },
    calls: { call_expression: field("function") },
  },
  {
    id: "kotlin",
    extensions: [".kt", ".kts"],
    defs: {
      class_declaration: {
        kind: "class",
        name: firstIdent,
        kindOf: (n) => (keyword(n, "interface") ? "interface" : keyword(n, "enum") ? "enum" : "class"),
        supers: parentsIn("delegation_specifier", "delegation_specifiers"),
      },
      object_declaration: { kind: "module", name: firstIdent, supers: parentsIn("delegation_specifier", "delegation_specifiers") },
      function_declaration: { kind: "function", name: firstIdent },
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
    calls: { call_expression: firstChild },
  },
  {
    id: "swift",
    extensions: [".swift"],
    defs: {
      // class, struct, enum, actor; an extension only names what is inside it (Order.total)
      class_declaration: {
        kind: "class",
        kindOf: (n) => {
          const k = n.childForFieldName("declaration_kind")?.text;
          return k === "struct" ? "struct" : k === "enum" ? "enum" : "class";
        },
        containerOnly: (n) => n.childForFieldName("declaration_kind")?.text === "extension",
        supers: parentsIn("inheritance_specifier"),
      },
      protocol_declaration: { kind: "interface", supers: parentsIn("inheritance_specifier") },
      function_declaration: { kind: "function" },
      protocol_function_declaration: { kind: "method" },
      init_declaration: { kind: "method", name: () => "init" },
      deinit_declaration: { kind: "method", name: () => "deinit" },
      subscript_declaration: { kind: "method", name: () => "subscript" },
      // var total: Int { ... } (a computed property)
      property_declaration: {
        kind: "method",
        when: (n) => n.childForFieldName("computed_value") !== null,
        name: (n) => n.childForFieldName("name")?.childForFieldName("bound_identifier")?.text ?? null,
      },
    },
    calls: { call_expression: firstChild },
  },
  {
    id: "scala",
    extensions: [".scala"],
    defs: {
      class_definition: { kind: "class", supers: parentsIn("extends_clause") },
      object_definition: { kind: "module", supers: parentsIn("extends_clause") },
      trait_definition: { kind: "trait", supers: parentsIn("extends_clause") },
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
      class_specifier: { kind: "class", when: hasBody, supers: parentsIn("base_class_clause") },
      struct_specifier: { kind: "struct", when: hasBody, supers: parentsIn("base_class_clause") },
      namespace_definition: { kind: "module", containerOnly: true },
    },
    calls: { call_expression: field("function"), new_expression: field("type") },
  },
];
