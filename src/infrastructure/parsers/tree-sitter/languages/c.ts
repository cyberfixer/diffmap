/** C. Rules for this language only: changing them changes no other language. */
import type { Node } from "../node.js";
import type { LanguageSpec } from "./spec.js";
import { field, hasBody, returnsIn, typeIdentifier } from "./shared.js";

/** C/C++: the name sits inside the declarator chain, e.g. `int Svc::update(int x)`. */
export function declaratorName(n: Node): string | null {
  let d: Node | null = n.childForFieldName("declarator");
  while (d && d.childForFieldName("declarator")) d = d.childForFieldName("declarator");
  return d ? d.text.replace(/::/g, ".") : null;
}

export const c: LanguageSpec = {
  id: "c",
  extensions: [".c", ".h"],
  family: "c",
  variableTypes: ["typeFirst", "constructed"],
  defs: {
    function_definition: { kind: "function", name: declaratorName, returns: returnsIn("type") },
    struct_specifier: { kind: "struct", when: hasBody },
  },
  typeName: typeIdentifier,
  calls: { call_expression: field("function") },
};
