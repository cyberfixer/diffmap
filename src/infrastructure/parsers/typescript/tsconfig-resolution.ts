import { posix } from "node:path";
import { ts } from "ts-morph";

/** The config files module resolution reads: `tsconfig.json`, `tsconfig.base.json` (Nx), `tsconfig.app.json`, ..., `jsconfig.json`. */
export const isTsConfig = (path: string): boolean => /(^|\/)(tsconfig(\.[\w-]+)?|jsconfig)\.json$/i.test(path);

interface Resolved {
  /** Absolute (in the in-memory project, where the repo is mounted at "/"). */
  baseUrl?: string;
  /** Every target made absolute, so no baseUrl is needed to read them. */
  paths?: Record<string, string[]>;
}

/**
 * Resolves imports the way the repo's own tsconfig files say: `baseUrl` (`import "src/services/x"`)
 * and `paths` aliases (`import "@app/services/x"`), following `extends` between the repo's configs.
 * Each file uses the nearest config above it, so the projects of a monorepo keep their own aliases.
 * Without this, such an import resolves to nothing and calls through it are lost.
 *
 * Files are mounted at "/" + their path in the repo, as the call graph does.
 */
export class TsConfigResolution {
  private readonly byDir = new Map<string, Resolved>();
  private readonly options = new Map<string, ts.CompilerOptions>();

  constructor(configs: { path: string; source: string }[]) {
    const sources = new Map(configs.map((c) => [c.path, c.source]));
    const cache = new Map<string, Resolved>();
    const read = (path: string, seen: Set<string>): Resolved => {
      const known = cache.get(path);
      if (known) return known;
      const out: Resolved = {};
      if (seen.has(path)) return out; // a loop of extends
      seen.add(path);
      const { config } = ts.parseConfigFileTextToJson(path, sources.get(path) ?? "{}");
      const dir = posix.dirname(path);
      // What it extends comes first; its own options win.
      const parents = config?.extends === undefined ? [] : Array.isArray(config.extends) ? config.extends : [config.extends];
      for (const parent of parents) {
        if (typeof parent !== "string" || !parent.startsWith(".")) continue; // a package (@tsconfig/node20): no aliases of the repo
        let target = posix.normalize(posix.join(dir, parent));
        if (!sources.has(target) && sources.has(`${target}.json`)) target = `${target}.json`;
        if (sources.has(target)) Object.assign(out, read(target, seen));
      }
      const options = config?.compilerOptions ?? {};
      if (typeof options.baseUrl === "string") out.baseUrl = abs(posix.join(dir, options.baseUrl));
      if (options.paths && typeof options.paths === "object") {
        // Targets are relative to baseUrl when there is one (from here or what this extends), else to this file.
        const from = out.baseUrl ?? abs(dir);
        out.paths = Object.fromEntries(
          Object.entries(options.paths as Record<string, unknown>).map(([alias, targets]) => [
            alias,
            (Array.isArray(targets) ? targets : []).filter((t): t is string => typeof t === "string").map((t) => posix.join(from, t)),
          ]),
        );
      }
      cache.set(path, out);
      return out;
    };

    // One config per folder: tsconfig.json, else tsconfig.base.json (an Nx workspace's root), else jsconfig.json.
    const rank = (path: string) => ["tsconfig.json", "tsconfig.base.json", "jsconfig.json"].indexOf(posix.basename(path).toLowerCase());
    const chosen = new Map<string, string>();
    for (const path of sources.keys()) {
      const r = rank(path);
      if (r < 0) continue;
      const dir = posix.dirname(path);
      const had = chosen.get(dir);
      if (had === undefined || r < rank(had)) chosen.set(dir, path);
    }
    for (const [dir, path] of chosen) {
      const r = read(path, new Set());
      if (r.baseUrl || r.paths) this.byDir.set(dir === "." ? "" : dir, r);
    }
  }

  /** Whether any config says anything about resolution; when none does, the default resolution is all there is. */
  get any(): boolean {
    return this.byDir.size > 0;
  }

  /** Compiler options for a file: `base` with the nearest config's baseUrl and paths. */
  optionsFor(file: string, base: ts.CompilerOptions): ts.CompilerOptions {
    let dir = posix.dirname(file.replace(/^\//, ""));
    for (;;) {
      const key = dir === "." ? "" : dir;
      const r = this.byDir.get(key);
      if (r) {
        let options = this.options.get(key);
        if (!options) this.options.set(key, (options = { ...base, ...(r.baseUrl ? { baseUrl: r.baseUrl } : {}), ...(r.paths ? { paths: r.paths } : {}) }));
        return options;
      }
      if (key === "") return base;
      dir = posix.dirname(dir);
    }
  }

  /** A ts-morph resolution host that resolves each import with the options of the file that writes it. */
  host(): (host: ts.ModuleResolutionHost, getOptions: () => ts.CompilerOptions) => { resolveModuleNames: (names: string[], file: string) => (ts.ResolvedModuleFull | undefined)[] } {
    return (host, getOptions) => ({
      resolveModuleNames: (names, file) => {
        const options = this.optionsFor(file, getOptions());
        return names.map((name) => ts.resolveModuleName(name, file, options, host).resolvedModule);
      },
    });
  }
}

const abs = (path: string): string => "/" + posix.normalize(path).replace(/^\.?\/?/, "").replace(/^\.$/, "");
