/** C#. Rules for this language only: changing them changes no other language. */
import type { LanguageSpec } from "./spec.js";
import { field, parentsIn, returnsIn } from "./shared.js";

export const csharp: LanguageSpec = {
  id: "c_sharp",
  extensions: [".cs"],
  variableTypes: ["typeFirst", "constructed"],
  defs: {
    class_declaration: { kind: "class", supers: parentsIn("base_list") },
    record_declaration: { kind: "class", supers: parentsIn("base_list") },
    struct_declaration: { kind: "struct", supers: parentsIn("base_list") },
    interface_declaration: { kind: "interface", supers: parentsIn("base_list") },
    enum_declaration: { kind: "enum" },
    namespace_declaration: { kind: "module", containerOnly: true },
    method_declaration: { kind: "method", returns: returnsIn("type") },
    constructor_declaration: { kind: "method" },
    local_function_statement: { kind: "function", returns: returnsIn("type") },
    // int Total { get { ... } } / int Fast => ...; (not `{ get; set; }`)
    property_declaration: {
      kind: "method",
      when: (n) =>
        n.childForFieldName("value")?.type === "arrow_expression_clause" ||
        (n.childForFieldName("accessors")?.namedChildren.some((a) => a.namedChildren.length > 0) ?? false),
    },
  },
  typeName: (n) => n.type === "identifier" && n.parent && (/^(base_list|type_argument_list|nullable_type|array_type)$/.test(n.parent.type) || n.parent.childForFieldName("type")?.id === n.id) ? n.text : null,
  calls: { invocation_expression: field("function"), object_creation_expression: field("type") },
};
