/** Go. Rules for this language only: changing them changes no other language. */
import type { LanguageSpec } from "./spec.js";
import { field, returnsIn, typeIdentifier } from "./shared.js";

export const go: LanguageSpec = {
  id: "go",
  extensions: [".go"],
  variableTypes: ["constructed", "goParam"],
  defs: {
    function_declaration: { kind: "function", returns: returnsIn("result") },
    method_declaration: {
      kind: "method",
      returns: returnsIn("result"),
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
  typeName: typeIdentifier,
  calls: { call_expression: field("function") },
};
