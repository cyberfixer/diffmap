import { posix } from "node:path";

/** Lines that bring other files or modules into scope, in the languages tree-sitter reads. */
const IMPORT_LINE = /^\s*(import|from|require|require_relative|use|using|#\s*include|include|include_once|require_once|mod|extern\s+crate|load)\b|\brequire\s*\(|\bimport\s*\(|^\s*(?:@[\w.]+\s+)+(?:\w+\s+)?import\b|^\s*(?:public|internal|private|fileprivate|package)\s+import\b/;

/** Swift: the module an import line names: `@testable import Library`, `import struct Library.Order` -> "Library". */
const SWIFT_IMPORT = /^\s*(?:@[\w.]+\s+)*(?:(?:public|internal|private|fileprivate|package)\s+)?import\s+(?:(?:struct|class|enum|protocol|typealias|func|let|var)\s+)?(\w+)/;

/** A folder name as a module name: Swift turns "Kickstarter-Framework" into Kickstarter_Framework. */
const moduleName = (folder: string): string => folder.replace(/[^A-Za-z0-9_]/g, "_");

/** The words an import of a file could use: its name without extension, and its folder name. */
export function moduleWords(path: string): string[] {
  const base = posix.basename(path).replace(/\.[^.]+$/, "");
  const dir = posix.basename(posix.dirname(path));
  const words = [base];
  if (base === "index" || base === "__init__" || base === "mod" || base === "lib") words.push(dir);
  else if (dir && dir !== ".") words.push(dir); // Go and Python packages are imported by folder
  return words;
}

/**
 * Which files a file can see: itself, files in the same folder (one package in
 * Go, Java, C#, Kotlin...), and files whose name or folder appears on one of its
 * import lines.
 *
 * Swift has no file imports: every file of a module sees the others, and
 * `import X` brings in module X. Without the build files, a module is a folder
 * named after something the repo imports (or a folder right under Sources/ or
 * Tests/), unless files inside it import that very name (Extensions/UIKit/ is
 * not UIKit). Files in no such folder form one more module, the app.
 */
export class Visibility {
  private importText = new Map<string, string>();
  /** Module of each file whose language has module scope ("" for the unnamed one). */
  private moduleOf = new Map<string, string>();
  /** Modules each of those files imports. */
  private modulesImported = new Map<string, Set<string>>();

  constructor(files: { path: string; source: string }[], moduleScoped: (path: string) => boolean = () => false) {
    for (const f of files) {
      this.importText.set(
        f.path,
        f.source
          .split("\n")
          .filter((l) => IMPORT_LINE.test(l))
          .join("\n"),
      );
    }
    this.findModules(files.map((f) => f.path).filter(moduleScoped));
  }

  private findModules(paths: string[]): void {
    if (!paths.length) return;
    const everImported = new Set<string>();
    for (const path of paths) {
      const mine = new Set<string>();
      for (const line of (this.importText.get(path) ?? "").split("\n")) {
        const m = SWIFT_IMPORT.exec(line);
        if (m) mine.add(m[1]);
      }
      this.modulesImported.set(path, mine);
      for (const m of mine) everImported.add(m);
    }
    const foldersOf = (path: string): string[] => {
      const out: string[] = [];
      for (let d = posix.dirname(path); d && d !== "." && d !== "/"; d = posix.dirname(d)) out.push(d);
      return out; // deepest first
    };
    // Folders with a file that imports the folder's own name are not that module.
    const importsItself = new Set<string>();
    for (const path of paths) {
      for (const d of foldersOf(path)) if (this.modulesImported.get(path)!.has(moduleName(posix.basename(d)))) importsItself.add(d);
    }
    const isModule = (d: string): boolean =>
      !importsItself.has(d) && (everImported.has(moduleName(posix.basename(d))) || /^(Sources|Tests)$/.test(posix.basename(posix.dirname(d))));
    for (const path of paths) {
      const root = foldersOf(path).find(isModule);
      this.moduleOf.set(path, root ? moduleName(posix.basename(root)) : "");
    }
  }

  /**
   * Of several targets, those the file imports by full path: `import com.x.Order` -> com/x/Order.java,
   * `import com.x.*` / `using App.Models` -> files in com/x / App/Models, `from app.models import X` ->
   * app/models.py. All of them when none (or every one) matches.
   * `nearest` (module scope only): also prefer the targets nearest in the folder tree.
   */
  preferImported<T>(from: string, targets: T[], fileOf: (t: T) => string, nearest = true): T[] {
    if (targets.length < 2) return targets;
    if (this.moduleOf.has(from)) return this.preferNear(from, targets, fileOf, nearest);
    const paths = this.importPaths(from);
    if (!paths.length) return targets;
    const at = (path: string) => paths.some((p) => path === p || path.endsWith("/" + p));
    const noExt = (t: T) => fileOf(t).replace(/\.[^./]+$/, "");
    // The file itself first (import com.x.Order), then its folder (import com.x.*).
    for (const kept of [targets.filter((t) => at(noExt(t))), targets.filter((t) => at(posix.dirname(noExt(t))))]) {
      if (kept.length && kept.length < targets.length) return kept;
    }
    return targets;
  }

  /**
   * Module scope (Swift): of several targets, those the file can see; of those, with
   * `nearest`, the ones nearest in the folder tree (two sample apps in one repo each have a ContentView).
   */
  private preferNear<T>(from: string, targets: T[], fileOf: (t: T) => string, nearest: boolean): T[] {
    const seen = targets.filter((t) => this.canSee(from, fileOf(t)));
    const kept = seen.length ? seen : targets;
    if (kept.length < 2 || !nearest) return kept;
    const mine = posix.dirname(from).split("/");
    const shared = (t: T): number => {
      const theirs = posix.dirname(fileOf(t)).split("/");
      let n = 0;
      while (n < mine.length && n < theirs.length && mine[n] === theirs[n]) n++;
      return n;
    };
    const best = Math.max(...kept.map(shared));
    return kept.filter((t) => shared(t) === best);
  }

  private readonly importPathCache = new Map<string, string[]>();

  private importPaths(file: string): string[] {
    const cached = this.importPathCache.get(file);
    if (cached) return cached;
    const out: string[] = [];
    for (const line of (this.importText.get(file) ?? "").split("\n")) {
      const m = /^\s*(?:import|from|using|use)\s+(?:static\s+)?([\w.:\\]+)/.exec(line);
      if (m) out.push(m[1].replace(/::|\.|\\/g, "/").replace(/\/+$/, ""));
    }
    this.importPathCache.set(file, out);
    return out;
  }

  private readonly seen = new Map<string, boolean>();

  canSee(from: string, target: string): boolean {
    if (from === target) return true;
    const key = `${from}\n${target}`;
    const known = this.seen.get(key);
    if (known !== undefined) return known;
    const answer = this.looksUp(from, target);
    this.seen.set(key, answer);
    return answer;
  }

  private looksUp(from: string, target: string): boolean {
    if (posix.dirname(from) === posix.dirname(target)) return true;
    const theirs = this.moduleOf.get(target);
    const mine = this.moduleOf.get(from);
    if (theirs !== undefined && mine !== undefined) return theirs === mine || this.modulesImported.get(from)!.has(theirs);
    const imports = this.importText.get(from) ?? "";
    if (!imports) return false;
    return moduleWords(target).some((w) => w.length > 1 && new RegExp(`(^|[^\\w$-])${escape(w)}($|[^\\w$-])`).test(imports));
  }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The forms a variable's type is written in (see typeOfVariable), built once per variable name. */
const patternsByName = new Map<string, RegExp[]>();
function variablePatterns(name: string, typeCalls: boolean): RegExp[] {
  const key = `${typeCalls ? 1 : 0}${name}`;
  const known = patternsByName.get(key);
  if (known) return known;
  const v = escape(name) + "`?"; // Swift: let `default` = ...
  const patterns = [
    new RegExp(`\\b${v}\\s*=[^=\\n][^\\n]*?\\bas[?!]\\s+([A-Z][\\w]*)\\s*(?:$|[;,){]|else\\b)`, "m"), // Swift, Kotlin: cell = table.dequeue(...) as! ItemCell
    new RegExp(`@Environment\\(\\s*([A-Z][\\w]*)\\.self\\s*\\)[^\\n=]*\\bvar\\s+${v}\\b`), // SwiftUI: @Environment(Theme.self) private var theme
    new RegExp(`\\b([A-Z][\\w]*)(?:<[^>]*>)?[*&\\s]+\\$?${v}\\b\\s*[=;,)]`), // Svc svc = / (Svc svc)
    new RegExp(`\\$?\\b${v}\\s*:\\s*(?:&\\s*(?:mut\\s+)?)?\\*?([A-Z][\\w]*)`), // svc: Svc
    new RegExp(`\\$?\\b${v}\\s*:?=\\s*(?:new\\s+|&)?([A-Z][\\w]*)\\s*[({]`), // svc = Svc( / new Svc( / := Svc{
    new RegExp(`(?:^|[(,])[ \\t]*${v}[ \\t]+\\*?(?:[a-z]\\w*\\.)?([A-Z][\\w]*)`, "m"), // Go: svc *Svc / (svc pkg.Svc)
    new RegExp(`@?\\b${v}\\s*=\\s*([A-Z][\\w]*)\\.new\\b`), // Ruby: @svc = Svc.new
  ];
  // Swift: box = Box<Int>() makes a Box. (In C#, `x = Load<T>()` is a method call, so this is not for everyone.)
  if (typeCalls) patterns.push(new RegExp(`\\b${v}\\s*=\\s*([A-Z][\\w]*)<[^>\\n]*>\\s*\\(`));
  // A repo has a bounded number of variable names, but keep the memory bounded anyway.
  if (patternsByName.size > 50_000) patternsByName.clear();
  patternsByName.set(key, patterns);
  return patterns;
}

/**
 * The declared type of a variable inside a piece of code, from the usual forms:
 * `Svc svc` (Java, C#, C++), `svc: Svc` (TS, Kotlin, Swift, Python, Rust, Scala),
 * `svc = Svc(...)` / `svc = new Svc(...)` / `svc := Svc{` / `$svc = new Svc(`,
 * `svc Svc` / `svc *pkg.Svc` (Go fields and parameters), `@svc = Svc.new` (Ruby),
 * `cell = ... as! ItemCell` (Swift, Kotlin casts), `@Environment(Theme.self) var theme` (SwiftUI).
 * With `typeCalls` (a capitalised call makes a type, Swift), also `box = Box<Int>()`.
 */
export function typeOfVariable(variable: string, code: string, typeCalls = false): string | null {
  const name = variable.replace(/^[$@]/, "");
  // Every form below writes the variable's name: code without it needs no search.
  if (!code.includes(name)) return null;
  const patterns = variablePatterns(name, typeCalls);
  for (const p of patterns) {
    const m = code.match(p);
    if (m) return m[1];
  }
  return null;
}
