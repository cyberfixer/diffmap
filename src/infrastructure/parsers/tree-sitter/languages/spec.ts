/** What a language's rules look like. Each language fills this in in its own file. */
import type { Node } from "../node.js";
import type { SymbolKind } from "../../../../domain/symbol.js";


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
  /**
   * Swift: the names Objective-C calls this by, written the way an Objective-C call of them is
   * read (`presentThread:` -> `presentThread(_:)`, see objc.ts `selectorName`): a method's selector,
   * a property's getter and setter, a type's Objective-C name. Empty when Objective-C cannot be
   * seen to reach it; then it is called by its own name, as before.
   */
  objcNames?: (n: Node) => string[];
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
  /** Written between its receiver and its argument (`a eq b`): only a function declared `infix` can be meant. */
  infix?: boolean;
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

/**
 * A way of writing a variable's type: `x = y as! T` (cast), `@Environment(T.self) var x`
 * (environment), `T x` (typeFirst), `for (T x : list)` (loopVariable), `(T *)x` (objcParameter), `x: T` (colonType), `x = T(..)` / `new T(..)` / `:= T{`
 * (constructed), `x *T` in a parameter list (goParam), `x = T.new` (rubyNew), `x = T<U>()` (genericCall).
 */
export type VariableForm = "cast" | "environment" | "typeFirst" | "loopVariable" | "objcParameter" | "colonType" | "constructed" | "goParam" | "rubyNew" | "genericCall";

export interface LanguageSpec {
  id: string; // grammar name in tree-sitter-wasms: tree-sitter-<id>.wasm
  /** A grammar file in diffmap's own grammars/ folder, used instead of the one in tree-sitter-wasms. */
  wasm?: string;
  /**
   * Rewrites source the grammar cannot read into source it can, for finding symbols and
   * calls only. It must keep every character's place: same length, same line breaks.
   */
  prepare?: (source: string) => string;
  /** Undoes, in a name read from the prepared text, what `prepare` did to it. */
  restore?: (text: string) => string;
  extensions: string[];
  /**
   * Languages that can call each other share a family: "jvm" (Java, Kotlin, Scala), "c" (C, C++),
   * "apple" (Swift, Objective-C).
   * A call is only linked to code of its own family; without one, a language is its own.
   */
  family?: string;
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
  /**
   * The ways this language writes a variable's type; only these are looked for in its code
   * (see typeOfVariable). Without it, every form but Swift's generic call.
   */
  variableTypes?: readonly VariableForm[];
  /** `Status.active` is a Status when Status is an enum (its cases are not symbols). */
  enumCases?: boolean;
  /** The files of one module see each other without imports (Swift). */
  moduleScope?: boolean;
  /**
   * Parents of well-known library classes (`UITableViewCell` -> `UIView`), so a repo class
   * built on one reaches what the repo adds to its parents (`extension UIView { ... }`).
   */
  knownParents?: Record<string, string>;
  /**
   * A method called on a type the repo defines is written in that type (or a parent): when it
   * is not, something outside the code provides it (Rust's derives and library traits, Lombok),
   * and a method of that name on another type is not linked. Not for languages where methods are
   * often added from outside the type (Kotlin and Swift extensions) or reached through an
   * interface nobody declares they implement (Go).
   */
  methodsAreWritten?: boolean;
  /** Method names the standard library gives nearly every type: never linked on a receiver of unknown type. */
  everyTypeHas?: ReadonlySet<string>;
  /** Words the grammar reads as names or types but the language keeps for itself (Objective-C `self`, `YES`, `@end`): coloured as keywords. */
  keywords?: ReadonlySet<string>;
  /** A value is made by calling its type (Swift `Store()`), and only types start with a capital: such a call is coloured as a type. */
  typesAreCalled?: boolean;
  /**
   * Objective-C: a call reaches Swift code that has Objective-C names (DefRule.objcNames) by those
   * names only, and a type by its Objective-C name (`@objc(MYStore) class Store` is MYStore).
   */
  callsByObjcName?: boolean;
}
