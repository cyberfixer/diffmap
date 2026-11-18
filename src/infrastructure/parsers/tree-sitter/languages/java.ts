/** Java. Rules for this language only: changing them changes no other language. */
import type { LanguageSpec } from "./spec.js";
import { capitalised, field, lastName, parentsIn, returnsIn, typeIdentifier } from "./shared.js";

export const java: LanguageSpec = {
  id: "java",
  extensions: [".java"],
  family: "jvm",
  variableTypes: ["typeFirst", "loopVariable", "constructed"],
  defs: {
    class_declaration: { kind: "class", supers: parentsIn("superclass", "super_interfaces") },
    record_declaration: { kind: "class", supers: parentsIn("super_interfaces") },
    interface_declaration: { kind: "interface", supers: parentsIn("extends_interfaces") },
    enum_declaration: { kind: "enum", supers: parentsIn("super_interfaces") },
    method_declaration: { kind: "method", returns: returnsIn("type") },
    constructor_declaration: { kind: "method" },
  },
  methodsAreWritten: true,
  typeName: (n) => typeIdentifier(n) ?? (n.type === "field_access" ? capitalised(n.childForFieldName("object")) : null),
  calls: {
    method_invocation: field("name"),
    object_creation_expression: field("type"),
    // this::check, Order::total -> the method; Foo::new -> the class
    method_reference: (n) => lastName(n.namedChildren[n.namedChildren.length - 1] ?? null),
  },
};
