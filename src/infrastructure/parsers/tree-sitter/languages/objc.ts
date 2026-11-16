/** Objective-C. Rules for this language only: changing them changes no other language. */
import type { Node } from "../node.js";
import type { CallRule, CallShape, LanguageSpec, Param } from "./spec.js";
import { field } from "./shared.js";
import { declaratorName } from "./c.js";

/**
 * Methods are named the way Swift sees them, so that the two languages meet on one name:
 * `- saveItem:(Item *)item completion:(Block)done` is `saveItem(_:completion:)`,
 * `- initWithName:(NSString *)name` is `init(name:)`, `- flush` is `flush`.
 * Swift's further renaming (`saveItem:` imported as `save(_:)`, NS_SWIFT_NAME) is not followed.
 */
function swiftStyle(pieces: string[], takesArguments: boolean): { name: string; labels: string[] } {
  const first = pieces[0] ?? "";
  if (!takesArguments) return { name: first, labels: [] };
  const init = /^init(?:With([A-Z]\w*))?$/.exec(first);
  const base = init ? "init" : first;
  const firstLabel = init?.[1] ? init[1][0].toLowerCase() + init[1].slice(1) : "_";
  return { name: base, labels: [firstLabel, ...pieces.slice(1)] };
}

const labelled = (name: string, labels: string[]): string => (labels.length ? `${name}(${labels.map((l) => `${l}:`).join("")})` : name);

/**
 * A selector written out (`presentThread:`, `initWithName:`, `sharedStore`) as the name an
 * Objective-C call of it is read under: `presentThread(_:)`, `init(name:)`, `sharedStore`.
 * Swift names what Objective-C sees of its own code this way (see swift.ts, `objcNames`).
 */
export function selectorName(selector: string): string {
  const pieces = selector.split(":");
  const takesArguments = pieces.length > 1;
  const { name, labels } = swiftStyle(takesArguments ? pieces.slice(0, -1) : pieces, takesArguments);
  return labelled(name, labels);
}

/** The parts of a method's selector, in order: `saveItem`, `completion`. */
const selectorPieces = (method: Node): string[] => method.namedChildren.filter((c) => c.type === "identifier").map((c) => c.text);
const methodParameters = (method: Node): Node[] => method.namedChildren.filter((c) => c.type === "method_parameter");

function methodName(method: Node): string | null {
  const pieces = selectorPieces(method);
  if (!pieces.length) return null;
  const { name, labels } = swiftStyle(pieces, methodParameters(method).length > 0);
  return labelled(name, labels);
}

function methodSignature(method: Node): Param[] {
  const parameters = methodParameters(method);
  const { labels } = swiftStyle(selectorPieces(method), parameters.length > 0);
  // A block parameter (`void (^)(BOOL)`) can be filled by a Swift trailing closure.
  return labels.map((label, i) => ({ label, optional: false, variadic: false, closure: (parameters[i]?.text ?? "").includes("^") }));
}

/** `@interface Store : NSObject <StoreDelegate>` -> NSObject, StoreDelegate. A category (`Store (Extras)`) has none. */
function parentsOf(n: Node): string[] {
  const head = n.text.slice(0, 400).split("\n")[0];
  const superclass = /^@interface\s+\w+\s*:\s*(\w+)/.exec(head)?.[1];
  const protocols = /<([^>]*)>/.exec(head)?.[1].split(",").map((p) => p.trim()).filter(Boolean) ?? [];
  return [...(superclass ? [superclass] : []), ...protocols];
}

/**
 * `[cache storeItem:item forKey:key]` is `storeItem(_:forKey:)` called on `cache`;
 * `[[Cache alloc] initWithSize:10]` and `[Cache new]` are `init` called on the type Cache.
 */
const message: CallRule = (n): CallShape | null => {
  const methods = n.childrenForFieldName("method");
  const receiver = n.childForFieldName("receiver");
  if (!methods.length || !receiver) return null;
  const takesArguments = n.children.some((c) => c.type === ":");
  let { name, labels } = swiftStyle(methods.map((m) => m.text), takesArguments);
  let on = receiver.text;
  if (receiver.type === "message_expression") {
    // [[Cache alloc] init...]: what is made is a Cache.
    const made = receiver.childForFieldName("receiver");
    const how = receiver.childrenForFieldName("method")[0]?.text;
    if (made && /^[A-Z]\w*$/.test(made.text) && how === "alloc") on = made.text;
  } else if (name === "new" && !takesArguments && /^[A-Z]\w*$/.test(on)) {
    name = "init";
    labels = [];
  }
  return { name, receiver: on, labels, at: methods[0] };
};

/** `@selector(didTap:)` names a method without calling it; its pieces are its labels, like a message's. */
const selector: CallRule = (n): CallShape | null => {
  const written = /\(\s*([A-Za-z_][\w:\s]*?)\s*\)/.exec(n.text)?.[1].replace(/\s+/g, "");
  if (!written) return null;
  const pieces = written.split(":");
  const takesArguments = pieces.length > 1;
  const { name, labels } = swiftStyle(takesArguments ? pieces.slice(0, -1) : pieces, takesArguments);
  return { name, receiver: "", labels, use: "ref" };
};

export const objc: LanguageSpec = {
  id: "objc",
  extensions: [".m", ".mm"],
  // Objective-C and Swift call each other (bridging headers, @objc).
  family: "apple",
  variableTypes: ["typeFirst", "objcParameter", "constructed"],
  // Like Swift, the files of one target see each other without naming each other.
  moduleScope: true,
  // Swift code that Objective-C sees under another name (`@objc(presentThread:)`) is called by that name.
  callsByObjcName: true,
  defs: {
    class_implementation: { kind: "class" },
    // In a .m file: the class extension `@interface Store () <StoreDelegate>`. It names what is in it.
    class_interface: { kind: "class", containerOnly: true, supers: parentsOf },
    protocol_declaration: { kind: "interface" },
    method_definition: { kind: "method", name: methodName, signature: methodSignature, isStatic: (n) => n.text.startsWith("+") },
    // A protocol's requirement, so that implementations link to it.
    method_declaration: { kind: "method", name: methodName, signature: methodSignature, when: (n) => n.parent?.type === "protocol_declaration" },
    function_definition: { kind: "function", name: declaratorName },
  },
  calls: { message_expression: message, selector_expression: selector, call_expression: field("function") },
  // The grammar reads these as names or types: `self`, `YES`, `instancetype`, `@end`, `void`.
  keywords: new Set([
    "self", "super", "nil", "Nil", "NULL", "YES", "NO", "id", "instancetype",
    "void", "char", "short", "int", "long", "float", "double", "signed", "unsigned", "bool",
    "@implementation", "@interface", "@protocol", "@end", "@property", "@synthesize", "@dynamic", "@class",
    "@selector", "@encode", "@optional", "@required", "@public", "@private", "@protected", "@package",
    "@try", "@catch", "@finally", "@throw", "@synchronized", "@autoreleasepool",
  ]),
};
