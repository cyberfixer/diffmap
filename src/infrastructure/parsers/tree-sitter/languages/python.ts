/** Python. Rules for this language only: changing them changes no other language. */
import type { LanguageSpec } from "./spec.js";
import { field, parentsIn, returnsIn } from "./shared.js";

export const python: LanguageSpec = {
  id: "python",
  extensions: [".py"],
  variableTypes: ["colonType", "constructed"],
  defs: {
    function_definition: { kind: "function", returns: returnsIn("return_type") },
    class_definition: { kind: "class", supers: parentsIn("argument_list") }, // class A(Base, Mixin)
  },
  typeName: (n) => n.type === "identifier" && (n.parent?.type === "type" || n.parent?.parent?.type === "type" || (n.parent?.type === "argument_list" && n.parent.parent?.type === "class_definition")) ? n.text : null,
  calls: { call: field("function") },
};
