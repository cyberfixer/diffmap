# diffmap Roadmap

**Goal:** make code review feel as close as possible to working in an IDE, but focused on the changes, so the reviewer never gets lost.

**What diffmap does today:** you give it two git refs (CLI) or open a GitLab merge request (service). It finds the changed lines, works out which function, method, class or template each line belongs to, finds who uses them, and shows it all as an interactive map: changed files as cards, callers outside the change shown in full, arrows to the exact lines. On GitLab you can comment, reply, approve and mark functions as viewed.

---

## Done

### 24. Review screen: quick on big changes, definition above / usages below — DONE
- Big merge requests: files and list entries off screen are not laid out (`content-visibility`); dividers are 12px to grab and apply once per frame. On a made-up 400-file change a resize step went from about 960 ms to one frame, selecting a symbol from about 190 ms to under 35 ms.
- The code column goes to the definition and stays there; the panel shows usages only, with the code around the one picked. "Show in the code above" takes the code to a usage.
- ← Back and Forward → (also the arrow keys), restoring what was selected.
- "Removed code" tab and a clickable count in the top bar: every call that still points at code the change removes.

### 16. "Viewed" resets when a file changes again — DONE
- A "viewed" tick is saved with a fingerprint of the file's change (its added and removed lines). A later push that changes the file again clears the tick and marks the file "Changed since you viewed it"; a rebase that leaves the change as it was keeps it. Ticks saved before this are cleared once.

### 23. Review screen: editor-like navigation, less clutter — DONE
- Sidebar is a folder tree (folders fold, single-child folders joined); file names coloured by added / modified / deleted; the map's cards follow the same order.
- No arrows: the selected symbol's definition and usages are highlighted. Click a usage to go to the definition; click a definition to step through its usages.
- Callers outside the change are placed next to the selected symbol, not at the top of the map.
- Right panel: one header line, one line of counts, usages grouped by file one line each (before/after snippets dropped; the map shows them).
- Fix: dragging the map no longer sticks when the button is released outside the window.

### 22. Smarter name matching (no compiler) — DONE
- Still one pass over the files, no build, no new dependencies. Measured with `scripts/measure-links.ts` (calls to repo code linked to exactly one target): Spring PetClinic 93.1% → 94.4%, macrozheng/mall 83.0% → 87.7% (too many candidates 6.4% → 0.7%), Alamofire 57.8% → 66.9%.
- Field and property types (`repo.save()`, `this.repo.save()`), also from Swift extensions and Go methods; calls on library types (`List`, `String`) are left out.
- Missing definitions: Swift structs, enums, `init`, protocol methods, computed properties, subscripts (extensions name what's inside them); Kotlin interfaces, enums, constructors, properties with a getter; C# properties with code; Java method references.
- Interface → implementation links (`implements`/`extends`, `: Base`, `impl Trait for`), through chains of parents; inherited methods; a changed implementation shows who calls the interface at depth 1.
- Return types and chains: `var o = repo.find(id); o.total()`, `repo.find(id).total()`, `-> Self`, globals like `let AF = Session.default`.
- Overloads by argument count; of same-named classes, the one the file imports.

### 21. GitHub pull requests — DONE
- One service per code host (`CODE_HOST`); run two copies for both. GitHub: pull requests incl. forks, review and conversation comments, line comments, replies, Approve (an APPROVE review), exact index from an Actions artifact, GitHub Enterprise. Full mode with a GitHub OAuth App, or view-only with personal tokens.

### 3. Arrow functions as class properties — DONE
- `handler = () => {...}` (and `= function () {}`) inside a class is a symbol in TypeScript and JavaScript; `this.handler()` links to it inside its class.

### 15. Better name matching — DONE
- Without an index, calls are narrowed to what the caller can reach: `self.x()`/`this.x()` → same class; `Svc.x()` or a variable with a written-down type → that class; else same file, then imported files or the same folder/package. Unreachable names are linked only when unique in the repo.

### 1. Wrong `added`/`removed` status — DONE
- Status comes from whether the symbol exists in the whole base and head file, not just on the changed lines. Covered by tests.

### 2. `.tsx` files parsed as `.ts` — DONE
- Files are parsed with their real extension.

### 6. Call graph — DONE
- For each changed symbol: who calls it and what it calls (`--depth N` hops), the exact lines of each call, and the whole source of callers. Calls into removed code are flagged `calls-removed`.

### 8. HTML review page — DONE
- Three-panel screen from the "Code change map" design: changed files and symbols with "viewed" progress; the map (foldable cards, whole file on demand, callers outside the diff with arrows); details (before/after, every place a symbol is used).
- Files over 500 lines (HTML over 300) start collapsed.
- Arrows: used by (solid), implemented by (dashed), call to removed code (red dashed).

### 10. Other languages — DONE
- JavaScript, Python, Java, Go, C#, PHP, Ruby, Rust, Kotlin, Swift, Scala, C and C++ through tree-sitter (symbols, calls matched by name, highlighting). TypeScript keeps the TypeScript compiler (exact). Other changed text files show as plain cards.

### 11. Exact calls from CI indexes — DONE
- SCIP indexes (scip-typescript, scip-java incl. Kotlin, scip-clang) from a `diffmap-index` CI job or `--scip`. Files the index covers get exact calls and "implements" links; the header says whether calls are exact.

### 12. GitLab service — DONE
- Docker image; sign in with GitLab (self-hosted or gitlab.com); open an MR by swapping the host or pasting the link.
- Comments synced with GitLab (line comments; quoted general comments for files outside the MR), replies, Approve / Revoke.
- Progress screen while the code downloads and is analysed; analysis in worker threads; results cached per MR version.
- "Viewed" saved per GitLab user and MR. Sign-ins in memory on purpose (a restart signs everyone out).

### 13. Angular templates — DONE
- Element and attribute selectors link templates to components and directives; `| pipe` to the pipe's `transform()`; `(click)="save()"` to the component's methods. A changed `*.component.html` counts as a change.

### 14. Ready for GitHub — DONE
- GitHub Actions (typecheck, tests, Docker build), `.env.example`, ignore rules, README.

---

## Before the first push to GitHub

- **License:** DONE (MIT).
- **Commit author:** kept as `wefc <wefc@localhost>` (decided).
- **Build error:** a `npm run build` error was reported but couldn't be reproduced; needs the error text.

## Needs a real test

- The service against a real GitLab (sign-in, comments, approve, progress screen on a big project).
- `ci/diffmap-index.gitlab-ci.yml` in a real pipeline.
- Real `scip-java` (Java, Kotlin) and `scip-clang` indexes; so far only scip-typescript was run for real.

---

## Next

### 4. `type` aliases are not symbols (rest of item 4)
- Interfaces and enums are symbols now; TypeScript `type X = ...` still falls into `top-level`.

### 17. Clearer waiting and capacity
- Show "waiting for N other merge requests" on the progress screen when all analysis slots are busy (today it already says "Analysing").
- Default `ANALYSIS_WORKERS` to the number of CPU cores instead of 2.
- Keep more than the last 20 analysed MR versions, or save them to disk so they survive a restart.

### 19. Finding your way in big changes
- Search for a file or function; a minimap of the canvas.

### 7. Impact analysis
- Follow callers of callers to get the full blast radius, ranked by distance.

### 9. Nx support
- Understand Nx monorepo project boundaries, so callers are labelled by project.

### 20. Swift exact calls
- No SCIP indexer exists for Swift yet. Possible later through Swift's own index store, or if an indexer appears.

### 5. Small polish
- `npm install` should build `dist/`, so `diffmap` works right away. (A `prepare` script would break the Docker build as it is; needs `npm ci --ignore-scripts` there.)
- A test that runs the real `diffmap` command end to end.

---

## Suggested order

Then the real tests above. Then 4 → 17, which make day-to-day reviews more accurate. 19, 7, 9 and 20 after that, in any order.
