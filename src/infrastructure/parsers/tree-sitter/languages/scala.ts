/** Scala. Rules for this language only: changing them changes no other language. */
import type { LanguageSpec } from "./spec.js";
import { field, firstChild, parentsIn, returnsIn, typeIdentifier } from "./shared.js";

export const scala: LanguageSpec = {
  id: "scala",
  extensions: [".scala"],
  family: "jvm",
  variableTypes: ["colonType", "constructed"],
  defs: {
    class_definition: { kind: "class", supers: parentsIn("extends_clause") },
    object_definition: { kind: "module", supers: parentsIn("extends_clause") },
    trait_definition: { kind: "trait", supers: parentsIn("extends_clause") },
    function_definition: { kind: "function", returns: returnsIn("return_type") },
  },
  typeName: typeIdentifier,
  calls: { call_expression: field("function"), instance_expression: firstChild },
};
