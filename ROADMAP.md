# gitmap Roadmap

**Goal:** make code review feel as close as possible to working in an IDE, but focused on the changes, so the reviewer never gets lost.

**What gitmap does today:** you give it two git refs (CLI) or open a GitLab merge request (service). It finds the changed lines, works out which function, method, class or template each line belongs to, finds who uses them, and shows it all as an interactive map: changed files as cards, callers outside the change shown in full, arrows to the exact lines. On GitLab you can comment, reply, approve and mark functions as viewed.

---

## Done

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
- SCIP indexes (scip-typescript, scip-java incl. Kotlin, scip-clang) from a `gitmap-index` CI job or `--scip`. Files the index covers get exact calls and "implements" links; the header says whether calls are exact.

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

- **License:** no license file yet; without one others can't reuse the code. Choose one (e.g. MIT, Apache-2.0).
- **Commit author:** commits are signed `wefc <wefc@localhost>`, which GitHub won't link to an account. Rewrite to the real GitHub email before pushing, if wanted (changes history).
- **Build error:** a `npm run build` error was reported but couldn't be reproduced; needs the error text.

## Needs a real test

- The service against a real GitLab (sign-in, comments, approve, progress screen on a big project).
- `ci/gitmap-index.gitlab-ci.yml` in a real pipeline.
- Real `scip-java` (Java, Kotlin) and `scip-clang` indexes; so far only scip-typescript was run for real.

---

## Next

### 15. Better name matching (no CI needed)
- **Problem:** without an index, a call to `update()` links to every function called `update`.
- **Fix:** only link to what the calling file can see (its own file, what it imports, its own package in Go/Java/C#), and read `self.x()` / `this.x()` as "this class". Removes most wrong arrows with no setup.

### 4. `type` aliases are not symbols (rest of item 4)
- Interfaces and enums are symbols now; TypeScript `type X = ...` still falls into `top-level`.

### 3. Arrow functions as class properties are missed
- `handler = () => {...}` inside a class is not recognised (only `const x = () =>` is).

### 16. "Viewed" resets when a function changes again
- Today a function stays marked as viewed even if a later push changes it. GitLab resets its own "viewed" in that case; gitmap should too.

### 17. Clearer waiting and capacity
- Show "waiting for N other merge requests" on the progress screen when all analysis slots are busy (today it already says "Analysing").
- Default `ANALYSIS_WORKERS` to the number of CPU cores instead of 2.
- Keep more than the last 20 analysed MR versions, or save them to disk so they survive a restart.

### 18. Compiler errors at call sites
- The design shows errors like "TS2554: Expected 2 arguments" next to callers that break. Possible for TypeScript with the type checker, and for other languages from CI.

### 19. Finding your way in big changes
- Search for a file or function; a minimap of the canvas.

### 7. Impact analysis
- Follow callers of callers to get the full blast radius, ranked by distance.

### 9. Nx support
- Understand Nx monorepo project boundaries, so callers are labelled by project.

### 20. Swift exact calls
- No SCIP indexer exists for Swift yet. Possible later through Swift's own index store, or if an indexer appears.

### 5. Small polish
- `npm install` should build `dist/`, so `git-map` works right away. (A `prepare` script would break the Docker build as it is; needs `npm ci --ignore-scripts` there.)
- A test that runs the real `git-map` command end to end.

---

## Suggested order

Before pushing: license and author. Then the real tests above. Then 15 → 4 → 3 → 16 → 17, which make day-to-day reviews more accurate. 18, 19, 7, 9 and 20 after that, in any order.
