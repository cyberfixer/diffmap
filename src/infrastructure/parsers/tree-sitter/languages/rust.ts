/** Rust. Rules for this language only: changing them changes no other language. */
import type { LanguageSpec } from "./spec.js";
import { capitalised, fieldName, inStandardLibrary, returnsIn, scopedCall, typeIdentifier } from "./shared.js";

/** Methods of Rust's standard traits and of Option, Result, iterators and collections. */
const RUST_COMMON_METHODS: ReadonlySet<string> = new Set(
  (
    "clone clone_from into try_into from try_from default as_ref as_mut borrow borrow_mut deref deref_mut drop fmt to_string to_owned " +
    "eq ne cmp partial_cmp hash next into_iter iter iter_mut collect map map_err and_then or_else ok ok_or ok_or_else err unwrap " +
    "unwrap_or unwrap_or_else unwrap_or_default expect is_some is_none is_ok is_err take replace as_deref as_deref_mut as_slice " +
    "as_str as_bytes as_ptr len is_empty push pop insert remove get get_mut contains extend filter fold for_each any all find " +
    "enumerate zip rev skip chain count sum cloned copied lock read write send recv poll await_ready to_vec into_inner with_capacity"
  ).split(" "),
);

export const rust: LanguageSpec = {
  id: "rust",
  extensions: [".rs"],
  variableTypes: ["colonType", "constructed"],
  defs: {
    function_item: { kind: "function", returns: returnsIn("return_type") },
    function_signature_item: { kind: "method", returns: returnsIn("return_type") },
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
  typeName: (n) => (inStandardLibrary(n) ? null : typeIdentifier(n)) ?? (n.type === "scoped_identifier" ? capitalised(n.childForFieldName("path")) : null),
  calls: { call_expression: scopedCall("path") },
  methodsAreWritten: true,
  everyTypeHas: RUST_COMMON_METHODS,
};
