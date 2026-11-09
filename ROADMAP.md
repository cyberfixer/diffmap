# diffmap Roadmap

**Goal:** make code review feel as close as possible to working in an IDE, but focused on the changes, so the reviewer never gets lost.

**What diffmap does today:** you give it two git refs (CLI) or open a GitLab merge request (service). It finds the changed lines, works out which function, method, class or template each line belongs to, finds who uses them, and shows it all as an interactive map: changed files as cards, callers outside the change shown in full, arrows to the exact lines. On GitLab you can comment, reply, approve and mark functions as viewed.

---

## Done

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

### 22. Smarter name matching (no compiler)
Goal: fewer wrong and missing call links in typed languages (Java, Kotlin, Swift, C#, Scala, Go, Rust, C++), staying as light as today: same single pass over the files, no build, no new dependencies. One commit per step, each with tests.

- **22.0 Measure first.** A small script that runs the tree-sitter graph on a repo and counts calls linked to exactly one target, to several, or dropped. Run it on one real Java repo and one Swift repo before and after each step.
- **22.1 Field and property types.** `private OrderRepo repo;` / `private let repo: Repo` / `class A(private val repo: Repo)` → `repo.save()` and `this.repo.save()` link to `OrderRepo.save` only. When the variable is not found in the calling method, look in its enclosing class too; treat `this.x` / `self.x` as `x`. (`narrow()` in tree-sitter-call-graph.ts, `typeOfVariable` in visibility.ts.)
- **22.2 Missing definitions.** Swift: `init`, protocol methods, computed properties, `subscript`. Kotlin: secondary constructors, properties with getters. Java: method references (`this::check`, `Order::total`) count as calls. (languages.ts.)
- **22.3 Interface → implementation.** Read each class's parent types (`implements` / `extends` in Java, `: Repo` in Swift and Kotlin, base list in C#, `extends`/`with` in Scala, `impl Trait for` in Rust). For a method `C.m` whose parent `P` (visible from C's file) has `P.m`, add an "implements" link. The walk and the page already handle these links (dashed arrows), as with SCIP.
- **22.4 Return types.** Remember each method's declared return type (`Order find()`, `func find() -> Order`, `fun find(): Order`). Then `var o = repo.find(); o.total()` and chains like `a.getB().run()` resolve, at most 3 steps deep. Generic wrappers are left as they are (`List<Order>` stays `List`).
- **22.5 Overloads by argument count.** When several classes have a method with the same name, keep the ones whose parameter count fits the call (lenient for default and variadic parameters). Overloads within one class stay one symbol, as today.
- **22.6 Same-name classes.** When two `Order` classes are both reachable, prefer the one matching the full import (`import com.x.Order` → `com/x/Order.java`). Java, Kotlin, Scala.

After each step, the "Planned" column in the README languages table is updated.

### 4. `type` aliases are not symbols (rest of item 4)
- Interfaces and enums are symbols now; TypeScript `type X = ...` still falls into `top-level`.

### 16. "Viewed" resets when a function changes again
- Today a function stays marked as viewed even if a later push changes it. GitLab resets its own "viewed" in that case; diffmap should too.

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

Then the real tests above. Then 22 (in step order), then 4 → 16 → 17, which make day-to-day reviews more accurate. 19, 7, 9 and 20 after that, in any order.
