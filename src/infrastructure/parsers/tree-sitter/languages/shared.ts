/**
 * Helpers that several languages' rules are built from. A change here can change
 * every language that uses the helper: run scripts/compare-links.ts before and
 * after. A rule for one language belongs in that language's file instead.
 */
import type { Node } from "../node.js";
import type { CallRule } from "./spec.js";

export const IDENT = /(^|_)identifier$|^name$|^constant$|^word$/;
/** A name written with what it belongs to: Rust `a::B::c`, C++ `ns::Svc::make`. */
export const SCOPED = /^(scoped_identifier|scoped_type_identifier|qualified_identifier)$/;

/** The text of a node's identifier-like part: `a.b.c` -> "c", `Foo<T>` -> "Foo". */
export function lastName(n: Node | null): string | null {
  if (!n) return null;
  // A::b::c is one node that reads like an identifier: the name is its last part.
  if (SCOPED.test(n.type)) return lastName(n.childForFieldName("name") ?? n.namedChildren[n.namedChildren.length - 1] ?? null);
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

export const field = (f: string): CallRule => (n) => lastName(n.childForFieldName(f));

/**
 * Rust and C++: `Type::make(1)` is `make` called on Type; `module::run()`, `crate::run()` and
 * `ns::run()` are plain functions reached through a module or namespace. The two are told
 * apart the way the code is written: types start with a capital, modules and namespaces do not.
 * `pathField` is the field holding what comes before the name ("path" in Rust, "scope" in C++).
 */
export const scopedCall = (pathField: string): CallRule => (n) => {
  let f = n.childForFieldName("function");
  // make::<T>(x) / make<T>(x): the function inside the generic arguments
  if (f && /^(generic_function|template_function)$/.test(f.type)) f = f.childForFieldName("function") ?? f.childForFieldName("name") ?? f;
  if (!f || !SCOPED.test(f.type)) return lastName(f);
  const name = lastName(f);
  if (!name) return null;
  const path = f.childForFieldName(pathField);
  // std::move(x), std::mem::take(x), core::..., alloc::...: the standard library, never repo code.
  if (/^(std|core|alloc)\b/.test(path?.text.replace(/^::/, "") ?? "")) return null;
  const on = lastName(path);
  if (!on || !/^[A-Z]/.test(on)) return { name, receiver: "" };
  return { name, receiver: on === "Self" ? "self" : on };
};
export const firstChild: CallRule = (n) => lastName(n.namedChildren[0] ?? null);
export const fieldName = (f: string) => (n: Node) => lastName(n.childForFieldName(f));

export const hasBody = (n: Node) => n.childForFieldName("body") !== null;

/** Generic arguments and constructor arguments are not parent types: `Base<T>(x)` -> Base. */
export const NOT_A_PARENT = /type_arguments|type_parameters|type_argument_list|template_argument_list|value_arguments|^arguments$/;

/**
 * Parent types written in the given child nodes (`extends`, `implements`, `: Base`):
 * every capitalised name in them, skipping generic arguments. Package parts
 * (`com.x.Base`) are lowercase, so only `Base` is kept.
 */
export const parentsIn =
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

/** The type a node names: its first capitalised name outside generic arguments (`*Order`, `Order?`, `(Order, error)` -> Order). */
export function typeName(n: Node | null): string | null {
  if (!n || NOT_A_PARENT.test(n.type)) return null;
  if (n.namedChildCount === 0) return /^[A-Z]\w*$/.test(n.text) ? n.text : null;
  for (const c of n.namedChildren) {
    const found = typeName(c);
    if (found) return found;
  }
  return null;
}

/** Return type in a field: `type` (Java, C#, C++), `return_type` (Rust, Scala, Python, PHP), `result` (Go). */
export const returnsIn = (f: string) => (n: Node) => typeName(n.childForFieldName(f));

/** Return type written after a token: `-> Order` (Swift), `): Order` (Kotlin). */
export const returnsAfter = (token: string) => (n: Node) => {
  const kids = n.children;
  const at = kids.findIndex((c) => c.type === token);
  if (at < 0) return null;
  const t = kids.slice(at + 1).find((c) => c.isNamed && !/body|block/.test(c.type));
  return typeName(t ?? null);
};

/** True when the node has this keyword as a direct child (Kotlin `interface X`, `enum class X`). */
export const keyword = (n: Node, word: string) => n.children.some((c) => c.type === word);

/** The usual tree-sitter node for a type's name, in most grammars. */
export const typeIdentifier = (n: Node): string | null => (n.type === "type_identifier" ? n.text : null);

/** A name written after `std::`, `core::` or `alloc::` (C++, Rust): the standard library's, never the repo's. */
export const inStandardLibrary = (n: Node): boolean => {
  const p = n.parent;
  if (!p || !/^(qualified_identifier|scoped_type_identifier|scoped_identifier)$/.test(p.type)) return false;
  const path = p.childForFieldName("scope") ?? p.childForFieldName("path");
  return !!path && path.id !== n.id && /^(::)?(std|core|alloc)\b/.test(path.text);
};

/** `Kind.ONLINE`, `Kind::Online`: a capitalised name in front of a member is a type (an enum, a class's statics). */
export const capitalised = (n: Node | null | undefined): string | null => (n && /^[A-Z][A-Za-z0-9_]*$/.test(n.text) ? n.text : null);

export const blank = (m: string): string => m.replace(/[^\n]/g, " ");
