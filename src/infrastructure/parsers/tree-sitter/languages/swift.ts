/** Swift and iOS code. Rules for this language only: changing them changes no other language. */
import type { Node } from "../node.js";
import type { Param, CallShape, UseNames, LanguageSpec } from "./spec.js";
import { blank, lastName, parentsIn, returnsAfter } from "./shared.js";
import { selectorName } from "./objc.js";

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

/** The attributes written before a declaration: `@objc(save:)` -> { name: "objc", argument: "save:" }. */
function swiftAttributes(n: Node): { name: string; argument: string | null }[] {
  const modifiers = n.namedChildren.find((c) => c.type === "modifiers");
  return (modifiers?.namedChildren ?? [])
    .filter((c) => c.type === "attribute")
    .map((a) => {
      const m = /^@\s*(\w+)\s*(?:\(([^)]*)\))?/.exec(a.text);
      return { name: m?.[1] ?? "", argument: m?.[2]?.replace(/\s+/g, "") || null };
    });
}

/** Attributes that make a declaration seen by Objective-C. */
const OBJC_ATTRIBUTES = /^(objc|IBAction|IBOutlet|IBInspectable|IBSegueAction|NSManaged|GKInspectable)$/;

/**
 * Can Objective-C be seen to reach this declaration? It says so (`@objc`, `@IBAction`, ...), or
 * it is in an `@objcMembers` class, an `@objc extension` or an `@objc protocol`. Not `@nonobjc`.
 * (Swift also exposes a class's other extensions and subclasses under `@objcMembers`, and
 * methods that satisfy an `@objc` protocol; those are not seen here.)
 */
function swiftIsObjc(n: Node): boolean {
  const own = swiftAttributes(n).map((a) => a.name);
  if (own.includes("nonobjc")) return false;
  if (own.some((a) => OBJC_ATTRIBUTES.test(a))) return true;
  for (let p = n.parent; p; p = p.parent) {
    if (/^(function_body|computed_property|lambda_literal|statements)$/.test(p.type)) return false;
    if (p.type === "protocol_declaration") return swiftAttributes(p).some((a) => a.name === "objc");
    if (p.type === "class_declaration") {
      const outer = swiftAttributes(p).map((a) => a.name);
      return outer.includes("objcMembers") || (outer.includes("objc") && p.childForFieldName("declaration_kind")?.text === "extension");
    }
  }
  return false;
}

/** Prepositions, as lib/Basic/PartsOfSpeech.def in the Swift compiler lists them. */
const PREPOSITIONS = new Set([
  "above", "after", "along", "alongside", "as", "at", "before", "below", "by", "following", "for", "from", "given", "in",
  "including", "inside", "into", "matching", "of", "on", "passing", "preceding", "since", "to", "until", "using", "via",
  "when", "with", "within",
]);
/** The first and last words of a camel-case name (`moveTo` -> "move", "To"; `loadURL` -> "URL"). */
const firstWord = (s: string): string => /^(?:[a-z0-9]+|[A-Z]+(?![a-z])|[A-Z][a-z0-9]*)/.exec(s)?.[0] ?? s;
const lastWord = (s: string): string => /(?:[A-Z]?[a-z0-9]+|[A-Z]+)$/.exec(s)?.[0] ?? s;
const isPreposition = (word: string): boolean => PREPOSITIONS.has(word.toLowerCase());
const capitalized = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The selector Swift gives an `@objc` method or init that names none, by the compiler's rules
 * (AbstractFunctionDecl::getObjCSelector in lib/AST/Decl.cpp, github.com/swiftlang/swift):
 * - no arguments: the name (`reload`); one argument without a label: `reload:`;
 * - otherwise one piece per argument, the later ones their labels. The first label is added to
 *   the name, with "With" between unless the label starts with a preposition or the name ends
 *   with one: `present(view:)` -> `presentWithView:`, `move(to:)` -> `moveTo:`, `init(name:)` -> `initWithName:`;
 * - `async` adds a piece `completionHandler:` at the end (`WithCompletionHandler:` when it is the
 *   first); `throws` a piece `error:` (`AndReturnError:`) after the last argument that is not one of
 *   the `trailingClosures`, the closures at the end (errorParameterIndex in lib/Sema/TypeCheckDeclObjC.cpp):
 *   `fetch(id:completion:) throws` -> `fetchWithId:error:completion:`.
 * Names are taken without their backticks: ``h(`default`:)`` -> `hWithDefault:`.
 */
export function objcSelector(base: string, labels: string[], throws = false, async = false, trailingClosures = 0): string {
  const name = base.replace(/`/g, "");
  const names = labels.map((l) => (l === "_" ? "" : l.replace(/`/g, "")));
  const extraAt = async ? names.length : throws ? names.length - Math.min(trailingClosures, names.length) : -1;
  const count = names.length + (extraAt >= 0 ? 1 : 0);
  if (count === 0) return name;
  if (count === 1 && names.length === 1 && !names[0]) return `${name}:`;
  const pieces: string[] = [];
  let arg = 0;
  for (let piece = 0; piece < count; piece++) {
    if (piece === extraAt) pieces.push(piece > 0 ? (async ? "completionHandler" : "error") : name + (async ? "WithCompletionHandler" : "AndReturnError"));
    else if (piece > 0) pieces.push(names[arg++]);
    else {
      const first = names[arg++];
      pieces.push(first ? name + (isPreposition(firstWord(first)) || isPreposition(lastWord(name)) ? "" : "With") + capitalized(first) : name);
    }
  }
  return pieces.map((p) => `${p}:`).join("");
}

/** Is a parameter's type a function, looking through parentheses and one Optional (`(() -> Void)?`), as the compiler does for trailing closures? */
function swiftIsFunctionType(t: Node | undefined, optional = true): boolean {
  if (!t) return false;
  if (t.type === "function_type") return true;
  if (t.type === "tuple_type" && t.namedChildCount === 1) return swiftIsFunctionType(t.namedChildren[0].namedChildren.at(-1), optional);
  return optional && t.type === "optional_type" && swiftIsFunctionType(t.namedChildren[0], false);
}

/**
 * The names Objective-C calls a declaration by (see DefRule.objcNames): `@objc(name)` when it
 * gives one, else the selector Swift makes. Not for an `override` without a name: it keeps the
 * selector of what it overrides, often a system method Swift renamed on import, which is not in the repo.
 */
function swiftObjcNames(n: Node): string[] {
  const named = swiftAttributes(n).find((a) => a.name === "objc" && a.argument)?.argument ?? null;
  const modifiers = n.namedChildren.find((c) => c.type === "modifiers")?.namedChildren ?? [];
  const override = modifiers.some((m) => m.type === "member_modifier" && m.text === "override");
  if (!named && (!swiftIsObjc(n) || override)) return [];
  switch (n.type) {
    case "class_declaration":
    case "protocol_declaration":
      // @objc(MYStore) class Store: Objective-C writes MYStore. (An extension adds no name.)
      return named && n.childForFieldName("declaration_kind")?.text !== "extension" ? [named] : [];
    case "function_declaration":
    case "protocol_function_declaration":
    case "init_declaration": {
      const base = n.type === "init_declaration" ? "init" : n.childForFieldName("name")?.text.replace(/`/g, "") ?? "";
      if (!/^\w+$/.test(base)) return []; // operators
      const kids = n.children.map((c) => c.type);
      // The parameters at the end that take a function: `throws` puts its `error:` before them.
      const types = n.children.filter((c) => c.type === "parameter").map((c) => [...c.namedChildren].reverse().find((k) => /_type$/.test(k.type)));
      let trailing = 0;
      while (trailing < types.length && swiftIsFunctionType(types[types.length - 1 - trailing])) trailing++;
      const selector = named ?? objcSelector(base, swiftParams(n).map((p) => p.label), kids.includes("throws"), kids.includes("async"), trailing);
      return [selectorName(selector)];
    }
    case "property_declaration":
    case "protocol_property_declaration": {
      // The getter is the property's name (or the one @objc gives); a `var` that can be set has `setName:`.
      const property = named ?? swiftPropertyName(n);
      if (!property) return [];
      const computed = n.childForFieldName("computed_value");
      const settable =
        n.type === "protocol_property_declaration"
          ? /\bset\b/.test(n.text)
          : n.namedChildren.find((c) => c.type === "value_binding_pattern")?.text.trim() === "var" &&
            (!computed || computed.namedChildren.some((c) => c.type === "computed_setter"));
      return settable ? [property, selectorName(`set${capitalized(property)}:`)] : [property];
    }
  }
  return [];
}

export const swift: LanguageSpec = {
  id: "swift",
  wasm: "tree-sitter-swift.wasm", // newer than tree-sitter-wasms has; see grammars/README.md
  extensions: [".swift"],
  // Swift and Objective-C call each other (bridging headers, @objc).
  family: "apple",
  variableTypes: ["cast", "environment", "colonType", "constructed", "genericCall"],
  prepare: swiftPrepare,
  implicitSelf: true,
  constructorName: "init",
  enumCases: true,
  moduleScope: true,
  knownParents: UIKIT_PARENTS,
  typesAreCalled: true,
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
      objcNames: swiftObjcNames,
    },
    protocol_declaration: { kind: "interface", supers: parentsIn("inheritance_specifier"), objcNames: swiftObjcNames },
    // Names carry their argument labels: tableView(_:cellForRowAt:), init(frame:)
    function_declaration: {
      kind: "function",
      name: (n) => swiftName(n.childForFieldName("name")?.text, n),
      returns: returnsAfter("->"),
      isStatic: swiftIsStatic,
      signature: (n) => swiftParams(n, !/^[\w`]/.test(n.childForFieldName("name")?.text ?? "")),
      objcNames: swiftObjcNames,
    },
    protocol_function_declaration: {
      kind: "method",
      name: (n) => swiftName(n.childForFieldName("name")?.text, n),
      returns: returnsAfter("->"),
      signature: (n) => swiftParams(n),
      objcNames: swiftObjcNames,
    },
    init_declaration: { kind: "method", name: (n) => swiftName("init", n), signature: (n) => swiftParams(n), objcNames: swiftObjcNames },
    deinit_declaration: { kind: "method", name: () => "deinit" },
    subscript_declaration: { kind: "method", name: (n) => swiftName("subscript", n, true), signature: (n) => swiftParams(n, true) },
    // var total: Int { ... } / lazy var table: UITableView = { ... }() / var items = [] { didSet { ... } }
    property_declaration: { kind: "function", when: swiftPropertyHasCode, name: swiftPropertyName, property: true, objcNames: swiftObjcNames },
    // var title: String { get } in a protocol, so that implementations link to it
    protocol_property_declaration: { kind: "method", name: swiftPropertyName, property: true, objcNames: swiftObjcNames },
  },
  calls: { call_expression: swiftCall, selector_expression: swiftSelector },
  uses: { simple_identifier: swiftNameUse, navigation_expression: swiftMemberUse },
};
