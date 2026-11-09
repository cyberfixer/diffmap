import { posix } from "node:path";

/** Lines that bring other files or modules into scope, in the languages tree-sitter reads. */
const IMPORT_LINE = /^\s*(import|from|require|require_relative|use|using|#\s*include|include|include_once|require_once|mod|extern\s+crate|load)\b|\brequire\s*\(|\bimport\s*\(/;

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
 */
export class Visibility {
  private importText = new Map<string, string>();

  constructor(files: { path: string; source: string }[]) {
    for (const f of files) {
      this.importText.set(
        f.path,
        f.source
          .split("\n")
          .filter((l) => IMPORT_LINE.test(l))
          .join("\n"),
      );
    }
  }

  canSee(from: string, target: string): boolean {
    if (from === target || posix.dirname(from) === posix.dirname(target)) return true;
    const imports = this.importText.get(from) ?? "";
    if (!imports) return false;
    return moduleWords(target).some((w) => w.length > 1 && new RegExp(`(^|[^\\w$-])${escape(w)}($|[^\\w$-])`).test(imports));
  }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The declared type of a variable inside a piece of code, from the usual forms:
 * `Svc svc` (Java, C#, C++), `svc: Svc` (TS, Kotlin, Swift, Python, Rust, Scala),
 * `svc = Svc(...)` / `svc = new Svc(...)` / `svc := Svc{` / `$svc = new Svc(`,
 * `svc Svc` / `svc *pkg.Svc` (Go fields and parameters), `@svc = Svc.new` (Ruby).
 */
export function typeOfVariable(variable: string, code: string): string | null {
  const v = escape(variable.replace(/^[$@]/, "")) + "`?"; // Swift: let `default` = ...
  const patterns = [
    new RegExp(`\\b([A-Z][\\w]*)(?:<[^>]*>)?[*&\\s]+\\$?${v}\\b\\s*[=;,)]`), // Svc svc = / (Svc svc)
    new RegExp(`\\$?\\b${v}\\s*:\\s*(?:&\\s*(?:mut\\s+)?)?\\*?([A-Z][\\w]*)`), // svc: Svc
    new RegExp(`\\$?\\b${v}\\s*:?=\\s*(?:new\\s+|&)?([A-Z][\\w]*)\\s*[({]`), // svc = Svc( / new Svc( / := Svc{
    new RegExp(`(?:^|[(,])[ \\t]*${v}[ \\t]+\\*?(?:[a-z]\\w*\\.)?([A-Z][\\w]*)`, "m"), // Go: svc *Svc / (svc pkg.Svc)
    new RegExp(`@?\\b${v}\\s*=\\s*([A-Z][\\w]*)\\.new\\b`), // Ruby: @svc = Svc.new
  ];
  for (const p of patterns) {
    const m = code.match(p);
    if (m) return m[1];
  }
  return null;
}
