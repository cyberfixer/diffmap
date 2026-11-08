# gitmap Roadmap

**Goal:** make PR review feel as close as possible to working in an IDE, but focused on the changes, so the reviewer never gets lost.

**What gitmap does today:** you give it two git refs. It finds which lines changed, works out which function, method or class each line sits in, and prints that as JSON.

## Fixes

These come first because everything later builds on this output.

### 1. Wrong `added`/`removed` status (real bug) — DONE
- **Problem:** the status is derived only from the changed lines. A function that already existed, with a line added inside it, is reported as `added`. A function that only lost a line is reported as `removed`.
- **Evidence:** in the sample-api fix commit, `TasksService.update` and `remove` showed as `added` but were modified.
- **Fix:** check whether the symbol exists in the whole base file and the whole head file, not just on the changed lines.
- **Status:** fixed; covered by tests for add-only and remove-only edits.

### 2. `.tsx` files may parse wrongly — DONE
- **Problem:** every file is parsed as `.ts`, and JSX is not valid there.
- **Fix:** parse the file with its real extension.

### 3. Arrow functions as class properties are missed
- **Problem:** `handler = () => {...}` inside a class is not recognised. Only `const x = () =>` is.
- **Fix:** handle class property declarations whose value is an arrow function.

### 4. `interface`, `type` and `enum` are not symbols
- **Problem:** a change to `Task` in `task.interface.ts` falls into `top-level`.
- **Fix:** add them as symbol kinds in `src/domain/symbol.ts`.

### 5. Small polish
- Add a `prepare` script so `npm install` builds `dist/` (`git-map` fails without it).
- Add a test that runs the real CLI end to end.

## Features

### 6. Call graph — DONE
- **Adds:** for each changed symbol, find who calls it.
- **Why:** it answers "which code does this diff affect?", the point of the tool.
- **How:** `CallGraphPort` + ts-morph type checker; `nodes`/`edges` on the result, `--depth N` hops.
- **Status:** done. Calls into removed code are flagged `calls-removed`. Known gaps: calls through interfaces, class-property arrows.

### 7. Impact analysis
- **Adds:** follow callers of callers to get the full blast radius, ranked by distance.
- **Depends on:** the call graph.

### 8. HTML graph output — DONE (first version)
- **Adds:** a shareable page showing changed functions and their callers as a graph.
- **Status:** `--format html` is a three-panel review screen (from the "Code change map" design): changed files and symbols on the left with "viewed" progress; a map in the middle with each changed file as a foldable card (whole file on demand) and, for the selected symbol, the whole calling functions outside the diff with arrows to each call line; details on the right (before/after, every place it is used). Branch names and commit count come from git.
- **Next:** "implemented by" arrows (needs interface tracking), compiler errors at call sites, minimap/search for big diffs.

### 9. Nx support
- **Adds:** understand Nx monorepo project boundaries, so callers are labelled by project.

### 10. Other languages — DONE (tree-sitter)
- **Status:** JavaScript, Python, Java, Go, C#, PHP, Ruby, Rust, Kotlin, Swift, Scala, C and C++ through tree-sitter (symbols, call graph by name, highlighting). TypeScript keeps the TypeScript compiler, which resolves calls exactly. Other changed text files show as plain cards.
- **Known gap:** name matching can over-link when unrelated classes share a method name (calls with more than 5 same-named targets are skipped).

### 11. Exact calls from CI indexes — DONE
- **Status:** SCIP indexes (scip-typescript, scip-java incl. Kotlin, scip-clang) from a `gitmap-index` CI job or `--scip`; "implements" arrows; Angular templates linked by selector. Swift has no SCIP indexer yet.
- **Next:** "Mark as viewed" reset when a symbol changes again; Swift via its index store if an indexer appears.

## Order

1 → 2–5 → 6 → 7 → 8. Then 9 and 10, which are independent of each other.
