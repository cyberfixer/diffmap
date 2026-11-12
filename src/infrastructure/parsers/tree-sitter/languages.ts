import type { Node } from "./node.js";
import type { SymbolKind } from "../../../domain/symbol.js";


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
  /** The declared return type of a function or method (`Order find()` -> "Order"). */
  returns?: (n: Node) => string | null;
  /** A property with code (Swift `var total: Int { ... }`): reading it counts as a use, like a call. */
  property?: boolean;
  /** True for a member of the type itself (`static func make()`), which `.make()` can mean. */
  isStatic?: (n: Node) => boolean;
  /**
   * The parameters one by one, where the language tells them apart by label (Swift).
   * Without it only their number is read (see paramRange).
   */
  signature?: (n: Node) => Param[];
}

/** One parameter of a function whose arguments are matched by label. */
export interface Param {
  /** The label a call writes, "_" for none. */
  label: string;
  /** Has a default value, so a call may leave it out. */
  optional: boolean;
  /** Takes any number of values: `_ xs: Int...`. */
  variadic: boolean;
  /** Can take a closure, so a trailing closure may fill it: `done: () -> Void`, or a type we cannot see into. */
  closure: boolean;
}

/** What a call rule can say beyond the called name (Swift needs all of it). */
export interface CallShape {
  name: string;
  /**
   * What the call is made on, when the text before the name is not it: "self", "super",
   * "." for an implicit member (Swift `.make()`), or an expression.
   */
  receiver?: string;
  /**
   * For an implicit member (receiver "."): a type name, or an expression of the type it
   * belongs to, when one is written nearby: `let tab: Tab = .init(1)` -> "Tab", `tab = .next()` -> "tab".
   */
  context?: string;
  /** Argument labels as written, "_" for none: `load(1, cache: true)` -> ["_", "cache"]. */
  labels?: string[];
  /** Trailing closures after the arguments. */
  closures?: number;
  /** Not a call: "ref" names a function without calling it (`#selector(save)`, `action: save`), "read" reads a property. */
  use?: "ref" | "read";
  /** The node that holds the name, for the line it is written on. */
  at?: Node;
}

/** How to find the called name in one kind of call node; null when the node is not a call after all. */
export type CallRule = (n: Node) => string | CallShape | null;

/** The called name in a call rule's answer. */
export const calledName = (r: string | CallShape | null): string | null => (typeof r === "string" ? r : r?.name ?? null);

/** The names a second look at a file should report uses of (see `LanguageSpec.uses`). */
export interface UseNames {
  /** Names of properties with code. */
  properties: ReadonlySet<string>;
  /** Names of functions and methods (reported only where a function can be passed by name). */
  functions: ReadonlySet<string>;
}

/** How to find a use that is not a call in one kind of node. */
export type UseRule = (n: Node, names: UseNames) => CallShape | null;

export interface LanguageSpec {
  id: string; // grammar name in tree-sitter-wasms: tree-sitter-<id>.wasm
  /** A grammar file in diffmap's own grammars/ folder, used instead of the one in tree-sitter-wasms. */
  wasm?: string;
  /**
   * Rewrites source the grammar cannot read into source it can, for finding symbols and
   * calls only. It must keep every character's place: same length, same line breaks.
   */
  prepare?: (source: string) => string;
  extensions: string[];
  defs: Record<string, DefRule>;
  calls: Record<string, CallRule>;
  /**
   * Uses that are not calls, by node type: property reads and functions passed by name.
   * They need the names of the repo's properties and functions, so they are
   * collected in a second look at each file (see TreeSitterEngine.uses).
   */
  uses?: Record<string, UseRule>;
  /** A plain `x()` inside a type calls the type's own `x` first (no `self.` needed). */
  implicitSelf?: boolean;
  /** Name of constructors (`init`): `Svc(x)` then also links to the matching `Svc.init`. */
  constructorName?: string;
  /** A capitalised call makes a type, also with generic arguments: `Box<Int>()` (no `new`). */
  typeCalls?: boolean;
  /** `Status.active` is a Status when Status is an enum (its cases are not symbols). */
  enumCases?: boolean;
  /** The files of one module see each other without imports (Swift). */
  moduleScope?: boolean;
  /**
   * Parents of well-known library classes (`UITableViewCell` -> `UIView`), so a repo class
   * built on one reaches what the repo adds to its parents (`extension UIView { ... }`).
   */
  knownParents?: Record<string, string>;
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

/** The type a node names: its first capitalised name outside generic arguments (`*Order`, `Order?`, `(Order, error)` -> Order). */
function typeName(n: Node | null): string | null {
  if (!n || NOT_A_PARENT.test(n.type)) return null;
  if (n.namedChildCount === 0) return /^[A-Z]\w*$/.test(n.text) ? n.text : null;
  for (const c of n.namedChildren) {
    const found = typeName(c);
    if (found) return found;
  }
  return null;
}

/** Return type in a field: `type` (Java, C#, C++), `return_type` (Rust, Scala, Python, PHP), `result` (Go). */
const returnsIn = (f: string) => (n: Node) => typeName(n.childForFieldName(f));

/** Return type written after a token: `-> Order` (Swift), `): Order` (Kotlin). */
const returnsAfter = (token: string) => (n: Node) => {
  const kids = n.children;
  const at = kids.findIndex((c) => c.type === token);
  if (at < 0) return null;
  const t = kids.slice(at + 1).find((c) => c.isNamed && !/body|block/.test(c.type));
  return typeName(t ?? null);
};

/** True when the node has this keyword as a direct child (Kotlin `interface X`, `enum class X`). */
const keyword = (n: Node, word: string) => n.children.some((c) => c.type === word);

// ---- Swift -----------------------------------------------------------------

/**
 * A Swift function's name with its argument labels, the way Swift writes it:
 * `func tableView(_ t: UITableView, cellForRowAt i: IndexPath)` -> "tableView(_:cellForRowAt:)".
 * Without parameters it is the plain name ("viewDidLoad"). Swift tells same-named
 * methods apart by these labels, so each one must be its own symbol.
 */
function swiftName(base: string | null | undefined, n: Node, subscript = false): string | null {
  if (!base) return null;
  const unlabelled = subscript || !/^[\w`]/.test(base); // subscripts and operators (==) take values without labels
  const labels = swiftParams(n, unlabelled).map((p) => p.label);
  return labels.length ? `${base}(${labels.map((x) => x + ":").join("")})` : base;
}

/** Can a parameter of this type take a closure? Yes for a function type; maybe for a plain name (a typealias). */
function swiftTakesClosure(type: Node | undefined): boolean {
  if (!type) return true;
  if (type.type === "function_type" || type.descendantsOfType("function_type").length > 0) return true;
  if (type.type === "optional_type") return swiftTakesClosure(type.namedChildren[0]);
  // Handler may be a typealias for a closure; Int, [Int], Box<Int>, some View are not.
  return type.type === "user_type" && type.namedChildren.length === 1 && !/^(Int|UInt|Double|Float|CGFloat|Bool|String|Character|Data|Date|URL|UUID|Any|AnyObject|Never|Void)$/.test(type.text);
}

/** The parameters of a function, init or subscript, as its callers must write them. */
function swiftParams(n: Node, unlabelled = false): Param[] {
  const out: Param[] = [];
  const kids = n.children;
  kids.forEach((c, i) => {
    if (c.type !== "parameter") return;
    const names = c.namedChildren.filter((k) => k.type === "simple_identifier");
    // The type comes last, after `inout` and attributes: `handler: @escaping @Sendable (Int) -> Void`.
    const type = [...c.namedChildren].reverse().find((k) => /_type$/.test(k.type));
    out.push({
      label: c.childForFieldName("external_name")?.text ?? (unlabelled ? "_" : names[0]?.text ?? "_"),
      optional: kids[i + 1]?.type === "=",
      variadic: c.children.some((k) => k.type === "..."),
      closure: swiftTakesClosure(type),
    });
  });
  return out;
}

const blank = (m: string): string => m.replace(/[^\n]/g, " ");

/**
 * `catch A.x, B.y {`: the text from the first comma between patterns up to the `{`,
 * blanked, so that one pattern is left. Commas inside brackets belong to a pattern.
 */
function swiftOneCatchPattern(source: string): string {
  // After a "}": the word also turns up in comments ("...or catch errors, then {").
  return source.replace(/(?<=\}\s*)catch\b[^{}]{0,600}?\{/g, (clause) => {
    let depth = 0;
    for (let i = 0; i < clause.length - 1; i++) {
      const ch = clause[i];
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
      else if (ch === "," && depth === 0) return clause.slice(0, i) + blank(clause.slice(i, -1)) + "{";
    }
    return clause;
  });
}

/**
 * What the grammar (tree-sitter-swift 0.7.3) cannot read, rewritten for the parser only
 * (a wrong guess there can swallow the rest of a type). Every character keeps its place.
 * - `if let x = try await load() {` and `if let x = try? (a as? B)?.c {`: it takes the `{` for
 *   a trailing closure. `try` says nothing about symbols or calls, so it is blanked.
 * - `#if` / `#else` / `#endif` around part of a type, a `case` or a modifier chain. Without
 *   those lines the code of every branch is read, which is what a reviewer sees too.
 * - `x as? String ?? ""`: it reads `String?`. Any other operator in place of `??` will do.
 * - `@available(iOS 17, *)` on a macro (`#Preview`): blanked.
 * - `unsafe` before an expression (Swift 6.2): blanked.
 * - `catch A.x, B.y {`: only the first pattern is left.
 * - `{ (self: Self, _) in`: a closure parameter called self gets another name.
 */
const swiftPrepare = (source: string): string =>
  swiftOneCatchPattern(
    source
      .replace(/\btry[?!]?(?=\s)/g, blank)
      .replace(/^[ \t]*#(?:if|elseif|else|endif)\b[^\n]*/gm, blank)
      .replace(/(\bas[?!]?\s[^\n?]*?)\?\?/g, "$1||")
      .replace(/^[ \t]*@available\([^)\n]*\)(?=\s*\n[ \t]*#[A-Za-z])/gm, blank)
      .replace(/(?<=^|[\s=(,{:\[])unsafe(?=[ \t]+[A-Za-z_.(\[&"])(?![ \t]+(?:in|as|is)\b)/gm, blank)
      .replace(/(\(\s*)self(?=\s*:\s*Self\b)/g, "$1this"),
  );

/** `static func make()` / `class func make()`. */
const swiftIsStatic = (n: Node): boolean =>
  /\b(static|class)\b/.test(n.namedChildren.find((c) => c.type === "modifiers")?.text ?? "");

/**
 * How UIKit's own classes build on each other. The repo cannot show it, yet
 * `class Cell: UITableViewCell` calling `pin()` from `extension UIView` depends on it.
 */
const UIKIT_PARENTS: Record<string, string> = Object.fromEntries(
  (
    [
      ["UIResponder", ["UIView", "UIViewController", "UIApplication", "UIWindowScene"]],
      ["NSObject", ["UIResponder"]],
      ["UIView", ["UILabel", "UIImageView", "UIStackView", "UIScrollView", "UIControl", "UITableViewCell", "UICollectionReusableView", "UITableViewHeaderFooterView", "UIVisualEffectView", "UIWindow", "UIActivityIndicatorView", "UIProgressView", "UIPickerView", "UISearchBar", "UINavigationBar", "UITabBar", "UIToolbar", "UIInputView", "WKWebView", "MKMapView"]],
      ["UIScrollView", ["UITableView", "UICollectionView", "UITextView"]],
      ["UICollectionReusableView", ["UICollectionViewCell"]],
      ["UIControl", ["UIButton", "UITextField", "UISwitch", "UISlider", "UISegmentedControl", "UIStepper", "UIPageControl", "UIDatePicker", "UIRefreshControl"]],
      ["UIViewController", ["UITableViewController", "UICollectionViewController", "UINavigationController", "UITabBarController", "UIPageViewController", "UISplitViewController", "UIAlertController", "UIHostingController", "UIActivityViewController", "UISearchController"]],
      ["UINavigationController", ["UIImagePickerController"]],
    ] as [string, string[]][]
  ).flatMap(([parent, children]) => children.map((c) => [c, parent])),
);

/** The name in `var name: T`. */
const swiftPropertyName = (n: Node): string | null =>
  n.childForFieldName("name")?.childForFieldName("bound_identifier")?.text ?? null;

/** True for a property of a type or a global; false for a `let` inside a function or closure. */
function swiftIsMember(n: Node): boolean {
  for (let p = n.parent; p; p = p.parent) {
    if (/^(class_body|enum_class_body|protocol_body|source_file)$/.test(p.type)) return true;
    if (/^(statements|function_body|computed_property|lambda_literal)$/.test(p.type)) return false;
  }
  return true;
}

/**
 * A Swift property that holds code: computed (`var total: Int { ... }`), set up by
 * a closure (`lazy var table: UITableView = { ... }()`, `let onTap = { ... }`), or
 * with observers (`didSet`). Plain stored properties stay part of their type.
 */
function swiftPropertyHasCode(n: Node): boolean {
  if (n.childForFieldName("computed_value")) return true;
  if (!swiftIsMember(n)) return false;
  if (n.namedChildren.some((c) => c.type === "willset_didset_block")) return true;
  const value = n.childForFieldName("value");
  return value?.type === "lambda_literal" || (value?.type === "call_expression" && value.namedChildren[0]?.type === "lambda_literal");
}

/** Labels of a call's arguments ("_" for none) and how many trailing closures follow. */
function swiftArguments(call: Node): { labels: string[]; closures: number; subscript: boolean } {
  const suffix = call.namedChildren.find((c) => c.type === "call_suffix");
  const list = suffix?.namedChildren.find((c) => c.type === "value_arguments");
  const labels = (list?.namedChildren ?? [])
    .filter((a) => a.type === "value_argument")
    // #selector(save(_:)) writes labels without values: they sit in "reference_specifier".
    .map((a) => (a.childForFieldName("name") ?? a.childForFieldName("reference_specifier"))?.text.replace(/:$/, "") ?? "_");
  return {
    labels,
    closures: suffix?.namedChildren.filter((c) => c.type === "lambda_literal").length ?? 0,
    subscript: list?.children[0]?.type === "[",
  };
}

/**
 * What a member is reached through: `self.x` -> "self", `super.x` -> "super", `a.b.x` -> "a.b".
 * Calls keep their shape only: `repo.find(id).x` -> "repo.find()", and a SwiftUI
 * `VStack { ...40 lines... }.padding()` is made on "VStack()", not on the 40 lines.
 */
function swiftReceiver(target: Node | null): string {
  if (!target) return "";
  switch (target.type) {
    case "simple_identifier":
      return target.text;
    case "self_expression":
      return "self";
    case "super_expression":
      return "super";
    case "navigation_expression": {
      const name = target.childForFieldName("suffix")?.childForFieldName("suffix");
      return name ? `${swiftReceiver(target.childForFieldName("target"))}.${name.text}` : "?";
    }
    case "call_expression": {
      const callee = target.namedChildren[0];
      if (!callee || callee.type === "lambda_literal") return "?";
      return swiftReceiver(callee) + (swiftArguments(target).subscript ? "[]" : "()");
    }
    default:
      // a?.b, (a as? B), try x: short enough to read as text; anything bigger is unknown
      return target.endIndex - target.startIndex <= 120 && target.startPosition.row === target.endPosition.row ? target.text : "?";
  }
}

/** The type a type node names when it is a plain one: `Tab`, `Tab?`, `Outer.Tab`, `Box<Int>`; not `[Tab]` or a closure. */
function swiftPlainType(t: Node | null | undefined): string | null {
  if (t?.type === "optional_type") return swiftPlainType(t.namedChildren[0]);
  if (t?.type !== "user_type") return null;
  return t.namedChildren.filter((c) => c.type === "type_identifier").pop()?.text ?? null;
}

/** The type written after a property's name: `var tab: Tab`. */
const swiftAnnotatedType = (property: Node): string | null =>
  swiftPlainType(property.namedChildren.find((c) => c.type === "type_annotation")?.childForFieldName("name"));

/**
 * Where the type of an implicit member is written nearby:
 * `let tab: Tab = .init(1)` -> "Tab"; `tab = .next()` -> "tab" (whatever tab's type is);
 * `func make() -> Tab { .init(1) }` and `var tab: Tab { .init(1) }` -> "Tab" (`-> Self`: the surrounding type).
 */
function swiftImplicitBase(call: Node): string | null {
  let n = call;
  while (n.parent && /^(try_expression|await_expression)$/.test(n.parent.type)) n = n.parent;
  const p = n.parent;
  if (!p) return null;
  if (p.type === "property_declaration" && p.childForFieldName("value")?.id === n.id) return swiftAnnotatedType(p);
  if (p.type === "assignment" && p.childForFieldName("result")?.id === n.id) {
    const target = swiftReceiver(p.childForFieldName("target")?.namedChildren[0] ?? null);
    return target && !target.includes("?") ? target : null;
  }
  // What a function or a computed property returns: `return .x()`, or the only expression of its body.
  const returns = p.type === "control_transfer_statement" && p.text.startsWith("return");
  const statements = returns ? p.parent : p;
  if (statements?.type !== "statements") return null;
  if (!returns && (statements.namedChildCount !== 1 || !/^(function_body|computed_property)$/.test(statements.parent?.type ?? ""))) return null;
  for (let a = statements.parent; a; a = a.parent) {
    if (a.type === "function_body") {
      const fn = a.parent;
      if (fn?.type !== "function_declaration") return null;
      const arrow = fn.children.findIndex((c) => c.type === "->");
      const type = arrow < 0 ? null : swiftPlainType(fn.children.slice(arrow + 1).find((c) => c.isNamed));
      if (type !== "Self") return type;
      for (let t = fn.parent; t; t = t.parent) {
        if (/^(class_declaration|protocol_declaration)$/.test(t.type)) return t.childForFieldName("name")?.text.split(".").pop() ?? null;
      }
      return null;
    }
    if (a.type === "computed_property") return a.parent?.type === "property_declaration" ? swiftAnnotatedType(a.parent) : null;
    if (/^(lambda_literal|class_body|enum_class_body|protocol_body|source_file)$/.test(a.type)) return null;
  }
  return null;
}

/**
 * A Swift call: `save()`, `repo.save(x)`, `super.viewDidLoad()`, `.make(1)`, `Svc(x)`.
 * Not calls, though the grammar shapes them alike: `items[i]` (a subscript),
 * `{ ... }()` (a closure run on the spot) and `defer { ... }`.
 */
function swiftCall(call: Node): CallShape | null {
  const callee = call.namedChildren[0];
  if (!callee || callee.type === "lambda_literal") return null;
  const { labels, closures, subscript } = swiftArguments(call);
  if (subscript) return null;
  // #selector(save(_:)) names the method, it does not call it.
  const use = call.parent?.type === "selector_expression" ? ({ use: "ref" } as const) : {};
  if (callee.type === "simple_identifier") {
    if (callee.text === "defer" && labels.length === 0) return null;
    return { name: callee.text, receiver: "", labels, closures, at: callee, ...use };
  }
  if (callee.type === "navigation_expression") {
    const at = callee.childForFieldName("suffix")?.childForFieldName("suffix");
    if (!at || at.type !== "simple_identifier") return null; // tuple.0(...)
    return { name: at.text, receiver: swiftReceiver(callee.childForFieldName("target")), labels, closures, at, ...use };
  }
  // .make(1), .init(x): a member of a type only the compiler knows
  if (callee.type === "prefix_expression" && callee.text.startsWith(".")) {
    const at = callee.childForFieldName("target");
    if (at?.type !== "simple_identifier") return null;
    const context = swiftImplicitBase(call);
    return { name: at.text, receiver: ".", ...(context ? { context } : {}), labels, closures, at };
  }
  const name = lastName(callee);
  return name ? { name, labels, closures } : null;
}

/** `#selector(save)`, `#selector(Svc.save)`: the method is named, not called. (`#selector(save(_:))` is seen by swiftCall.) */
function swiftSelector(n: Node): CallShape | null {
  const inner = n.namedChildren[0];
  if (inner?.type === "simple_identifier") return { name: inner.text, receiver: "", use: "ref", at: inner };
  if (inner?.type !== "navigation_expression") return null;
  const at = inner.childForFieldName("suffix")?.childForFieldName("suffix");
  return at?.type === "simple_identifier" ? { name: at.text, receiver: swiftReceiver(inner.childForFieldName("target")), use: "ref", at } : null;
}

/** Where a bare name is being declared or is a label, not used. */
const SWIFT_NOT_A_USE = /^(pattern|parameter|lambda_parameter|value_argument_label|navigation_suffix|function_declaration|protocol_function_declaration|enum_entry|capture_list_item|attribute|identifier|macro_invocation|selector_expression|type_parameter|key_path_expression|precedence_group_declaration|operator_declaration|typealias_declaration|associatedtype_declaration)$/;

/**
 * A bare name that is used: `header` in a SwiftUI body (a property of the same type),
 * or `save` in `Button("Save", action: save)` (a function passed by name).
 */
function swiftNameUse(n: Node, names: UseNames): CallShape | null {
  const p = n.parent;
  if (!p || SWIFT_NOT_A_USE.test(p.type)) return null;
  // The callee of a call is a call (but `items[0]` reads items); the head of `a.b` is a use of a.
  if (p.type === "call_expression" && p.namedChildren[0]?.id === n.id && !swiftArguments(p).subscript) return null;
  if (p.type === "value_argument" && p.childForFieldName("value")?.id !== n.id) return null;
  const name = n.text.replace(/^\$/, ""); // $showSheet is a binding to showSheet
  if (names.properties.has(name)) return { name, receiver: "", use: "read", at: n };
  if (p.type === "value_argument" && names.functions.has(name)) return { name, receiver: "", use: "ref", at: n };
  return null;
}

/** `viewModel.title`, `self.header`: a property read through something (not `a.b()`, which is a call). */
function swiftMemberUse(n: Node, names: UseNames): CallShape | null {
  const p = n.parent;
  if (p?.type === "call_expression" && p.namedChildren[0]?.id === n.id && !swiftArguments(p).subscript) return null;
  if (p?.type === "selector_expression") return null;
  const at = n.childForFieldName("suffix")?.childForFieldName("suffix");
  if (!at || at.type !== "simple_identifier") return null;
  const name = at.text;
  const receiver = swiftReceiver(n.childForFieldName("target"));
  if (names.properties.has(name)) return { name, receiver, use: "read", at };
  // A method passed as an argument: `perform: self.save`, `action: model.save`
  if (p?.type === "value_argument" && p.childForFieldName("value")?.id === n.id && names.functions.has(name)) return { name, receiver, use: "ref", at };
  return null;
}

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
      function_definition: { kind: "function", returns: returnsIn("return_type") },
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
      method_declaration: { kind: "method", returns: returnsIn("type") },
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
      method_declaration: { kind: "method", returns: returnsIn("return_type") },
      function_definition: { kind: "function", returns: returnsIn("return_type") },
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
      function_declaration: { kind: "function", name: firstIdent, returns: returnsAfter(":") },
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
    wasm: "tree-sitter-swift.wasm", // newer than tree-sitter-wasms has; see grammars/README.md
    extensions: [".swift"],
    prepare: swiftPrepare,
    implicitSelf: true,
    constructorName: "init",
    typeCalls: true,
    enumCases: true,
    moduleScope: true,
    knownParents: UIKIT_PARENTS,
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
      // Names carry their argument labels: tableView(_:cellForRowAt:), init(frame:)
      function_declaration: {
        kind: "function",
        name: (n) => swiftName(n.childForFieldName("name")?.text, n),
        returns: returnsAfter("->"),
        isStatic: swiftIsStatic,
        signature: (n) => swiftParams(n, !/^[\w`]/.test(n.childForFieldName("name")?.text ?? "")),
      },
      protocol_function_declaration: {
        kind: "method",
        name: (n) => swiftName(n.childForFieldName("name")?.text, n),
        returns: returnsAfter("->"),
        signature: (n) => swiftParams(n),
      },
      init_declaration: { kind: "method", name: (n) => swiftName("init", n), signature: (n) => swiftParams(n) },
      deinit_declaration: { kind: "method", name: () => "deinit" },
      subscript_declaration: { kind: "method", name: (n) => swiftName("subscript", n, true), signature: (n) => swiftParams(n, true) },
      // var total: Int { ... } / lazy var table: UITableView = { ... }() / var items = [] { didSet { ... } }
      property_declaration: { kind: "function", when: swiftPropertyHasCode, name: swiftPropertyName, property: true },
      // var title: String { get } in a protocol, so that implementations link to it
      protocol_property_declaration: { kind: "method", name: swiftPropertyName, property: true },
    },
    calls: { call_expression: swiftCall, selector_expression: swiftSelector },
    uses: { simple_identifier: swiftNameUse, navigation_expression: swiftMemberUse },
  },
  {
    id: "scala",
    extensions: [".scala"],
    defs: {
      class_definition: { kind: "class", supers: parentsIn("extends_clause") },
      object_definition: { kind: "module", supers: parentsIn("extends_clause") },
      trait_definition: { kind: "trait", supers: parentsIn("extends_clause") },
      function_definition: { kind: "function", returns: returnsIn("return_type") },
    },
    calls: { call_expression: field("function"), instance_expression: firstChild },
  },
  {
    id: "c",
    extensions: [".c", ".h"],
    defs: {
      function_definition: { kind: "function", name: declaratorName, returns: returnsIn("type") },
      struct_specifier: { kind: "struct", when: hasBody },
    },
    calls: { call_expression: field("function") },
  },
  {
    id: "cpp",
    extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
    defs: {
      function_definition: { kind: "function", name: declaratorName, returns: returnsIn("type") },
      class_specifier: { kind: "class", when: hasBody, supers: parentsIn("base_class_clause") },
      struct_specifier: { kind: "struct", when: hasBody, supers: parentsIn("base_class_clause") },
      namespace_definition: { kind: "module", containerOnly: true },
    },
    calls: { call_expression: field("function"), new_expression: field("type") },
  },
];
