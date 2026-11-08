# diffmap

Review code changes as a map. diffmap finds which functions a change touches and
where they are used, and shows everything on one page: the changed files, the
code that calls them, and arrows between them. It feels like an editor, but
focused on the change, so reviewers don't get lost.

There are two ways to use it:

1. **[Command line](#1-command-line)**: make a review page for any two branches or
   commits in a repo on your machine. The quickest way to try it.
2. **[GitLab service (Docker)](#2-gitlab-service-docker)**: open any merge request as
   a map, comment on lines, approve, and track what you have viewed. Works with
   self-hosted GitLab and gitlab.com.

## Languages

| Language | Functions & classes | Calls between them |
|---|---|---|
| TypeScript | ✅ | **exact** (TypeScript compiler) |
| JavaScript, Java, Kotlin, C, C++ | ✅ | matched by name, **exact** with a [CI index](#exact-calls-from-ci) |
| Python, Go, C#, PHP, Ruby, Rust, Swift, Scala | ✅ | matched by name |
| Angular templates | ✅ | components, directives, pipes and methods [linked from templates](#angular) |
| Anything else (YAML, SQL, Markdown…) | shown as plain diff cards | — |

"Matched by name" means a call to `update()` links to a function called `update`
that the calling code can reach: `self.update()` / `this.update()` → the same
class; `Svc.update()` or a variable whose type is written down → that class;
otherwise the same file, then files it imports or shares a folder with. It is
usually right, but not compiler-exact. The page header always says which
applies: *Calls: exact* or *Calls: matched by name*.

---

## 1. Command line

### Install (once)

You need Node.js 20 or newer and git.

```bash
git clone https://github.com/cyberfixer/diffmap.git
cd diffmap
npm install
npm run build
npm link        # makes the `diffmap` command available everywhere
```

`npm link` puts `diffmap` on your PATH, pointing at this folder. After pulling
new changes, run `npm run build` again; no need to link again. To remove it:
`npm unlink -g diffmap`.

### Use

Go to any git repository and run:

```bash
cd /path/to/your/repo
diffmap main --format html > report.html
```

Open `report.html` in your browser. More examples:

```bash
diffmap main --format html > report.html              # your branch vs main
diffmap main..feature/login --format html > r.html     # another branch vs main
diffmap HEAD~1 --format html > last.html               # just the last commit
diffmap main --scip index.scip --format html > r.html  # with exact calls
diffmap main > result.json                             # raw data instead of a page
```

### Options

```
diffmap <base>[..<head>] [--format json|html] [--depth N] [--scip FILE]...
```

| Option | Meaning | Default |
|---|---|---|
| `<base>` | Branch or commit to compare against, e.g. `main` | required |
| `..<head>` | Branch or commit to review | `HEAD` |
| `--format` | `html` (review page) or `json` (raw data) | `json` |
| `--depth` | Levels of callers and callees to include | `1` |
| `--scip` | A SCIP index for exact calls (see [Exact calls](#exact-calls-from-ci)); can be repeated | none |

<details>
<summary>Without npm link</summary>

Run the script directly: `node /path/to/diffmap/bin/diffmap.js main --format html > report.html`
</details>

## 2. GitLab service (Docker)

People open a merge request and see it as a map. They only ever see projects
they can already see in GitLab. There are two modes:

| Mode | Setup | People sign in with | Comment & approve |
|---|---|---|---|
| **Full** | a GitLab application (ID + secret), [step 1](#step-1-create-an-application-in-gitlab) | "Sign in with GitLab" | ✅ goes straight to GitLab |
| **View-only** | nothing in GitLab; leave `GITLAB_CLIENT_ID` and `GITLAB_CLIENT_SECRET` out | their own GitLab access token (scopes `read_api`, `read_repository`) | ❌ (existing comments are shown) |

View-only mode is the quickest start: skip step 1. On the sign-in page each
person follows a link that opens GitLab's token page already filled in, creates
a token and pastes it. The token stays in diffmap's memory only and is
forgotten on sign-out.

### Step 1: create an application in GitLab

*(Full mode only. For view-only mode skip this step.)*

| GitLab | Where |
|---|---|
| Self-hosted, for everyone | **Admin Area → Applications → Add new application** |
| gitlab.com, or just for you | **Edit profile → Applications → Add new application** |

- **Name:** diffmap
- **Redirect URI:** `<PUBLIC_URL>/auth/callback`
  (e.g. `https://diffmap.company.com/auth/callback`, or `http://localhost:8080/auth/callback` to try it locally)
- **Confidential:** yes
- **Scopes:** `api`

Save it and copy the **Application ID** and **Secret**.

### Step 2: run it

In the `diffmap` folder (clone it as in [Install](#install-once) if you haven't):

```bash
cp .env.example .env     # fill in GITLAB_URL, the ID, the secret and PUBLIC_URL
docker compose up -d --build
```

`.env` holds your secret, so it is in `.gitignore` and never committed.
Check it's running: `curl http://localhost:8080/healthz` prints `ok`.

<details>
<summary>Plain Docker instead of compose</summary>

```bash
docker build -t diffmap .
docker run -d --name diffmap -p 8080:8080 -v diffmap-data:/data \
  -e GITLAB_URL=https://gitlab.company.com \
  -e GITLAB_CLIENT_ID=<application id> \
  -e GITLAB_CLIENT_SECRET=<secret> \
  -e PUBLIC_URL=https://diffmap.company.com \
  diffmap
```
</details>

| Setting | Meaning |
|---|---|
| `GITLAB_URL` | Your GitLab, e.g. `https://gitlab.company.com` or `https://gitlab.com` |
| `GITLAB_CLIENT_ID` | Application ID from step 1 (leave out for view-only mode) |
| `GITLAB_CLIENT_SECRET` | Secret from step 1 (leave out for view-only mode) |
| `PUBLIC_URL` | Address people use to open diffmap (must match the redirect URI) |
| `PORT` | Port inside the container (default `8080`) |
| `DATA_DIR` | Where diffmap keeps its files (default `/data`; keep it on a volume) |
| `CACHE_DIR` | Where project code is kept (default `$DATA_DIR/repos`) |
| `ANALYSIS_WORKERS` | Merge requests analysed at the same time (default `2`; about one per CPU core is fine if memory allows) |
| `INDEX_JOB`, `INDEX_ARTIFACT` | CI job and file with the exact index (default `diffmap-index`, `index.scip`) |
| `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO` | Path to your CA file if GitLab uses an internal certificate |

### Step 3: open a merge request

- Take any merge request URL and change only the host:
  `https://gitlab.company.com/team/api/-/merge_requests/42` →
  `https://diffmap.company.com/team/api/-/merge_requests/42`
- Or open diffmap's start page and paste the MR link.

The first time, GitLab asks you to sign in. If the MR isn't ready yet, a
progress screen shows the steps (download the code, analyse the changes) with
git's real download progress, and opens the map when it's done.

On the map you can:

- **Comment:** click a line number. The comment appears in GitLab as a normal
  diff comment. A line in a file that isn't part of the MR (a caller somewhere
  else) is posted as a general MR comment that quotes the line, because GitLab
  can't attach a comment there.
- **Reply:** existing comments show under their lines; click **Reply**.
- **Approve:** **Approve** / **Revoke approval** in the top bar works like GitLab's button.
- **Mark as viewed:** tracks your progress per function. It is saved on the
  server for your GitLab user, so it stays after closing the browser.

Good to know:

- The first open of a project downloads its code. After that only new commits
  are fetched, and each MR version is analysed once, then cached.
- Analysis runs in background threads: a big MR doesn't slow down anyone else.
  Any number of people can view maps at the same time.
- Sign-ins are kept in memory on purpose: restarting the container signs everyone
  out, and GitLab tokens are never written to disk.
- In real use, run it behind HTTPS (a reverse proxy) and set `PUBLIC_URL` to the
  `https://` address.

---

## The review page

| Part | What it shows |
|---|---|
| **Top bar** | Title (the MR title, or the first commit), branches, commit count, lines added/removed, whether calls are exact. On the service also Approve, comment count and a link to GitLab. |
| **Left** | Changed files, the functions changed in each with how often they are used, and your "viewed" progress. |
| **Middle** | The map. Each changed file as a card, green for added lines and red for removed ones, unchanged lines folded. Click "⋯ unchanged lines" or **Whole file** to see more. Files over 500 lines (HTML over 300) start collapsed; click **Show**. |
| **Right** | The selected function: what changed (before/after), and every place it is used. Click a place to jump to it. |

Select a function (in the list, or by clicking its line) and the map adds the
code that uses it **from outside the change**, each caller shown in full, with
arrows to the exact lines. With nothing selected you see just the change.

| Arrow | Meaning |
|---|---|
| solid | used by (called, created, referenced) |
| dashed | implemented by (a class implementing an interface; needs an exact index or TypeScript interfaces) |
| red dashed | still calls code this change removes |

Drag or scroll to move the map, Ctrl+scroll to zoom, Esc to clear the selection.
The button in the top bar switches the colours between **Auto** (follows your
system), **Light** and **Dark**; your choice is remembered in the browser.

---

## Exact calls from CI

For exact calls outside TypeScript, let CI build an index with the language's own
compiler. Copy the jobs you need from
[`ci/diffmap-index.gitlab-ci.yml`](ci/diffmap-index.gitlab-ci.yml) into your project's
`.gitlab-ci.yml`. The job must be called `diffmap-index` and save `index.scip`.

| Language | Indexer | Notes |
|---|---|---|
| TypeScript, JavaScript | [scip-typescript](https://github.com/sourcegraph/scip-typescript) | uses your `tsconfig.json`; `--infer-tsconfig` for plain JS |
| Java, Kotlin | [scip-java](https://github.com/sourcegraph/scip-java) | Maven, Gradle or sbt |
| C, C++ | [scip-clang](https://github.com/sourcegraph/scip-clang) | needs `compile_commands.json` from your build |
| Swift | none available yet | stays on name matching |

- **Service:** diffmap finds the `diffmap-index` job for the MR's head commit by
  itself. If the job is still running, the map opens with name matching (the
  header says *exact index still building*) and switches to exact calls on a later visit.
- **CLI:** `--scip index.scip`. Several index files can be passed, or joined with
  `cat a.scip b.scip > index.scip`.
- An index also says which classes implement which interfaces: the dashed arrows.

### Angular

Angular templates are part of the map without any setup:

| In a template | Points at |
|---|---|
| `<app-user-card>` | the `UserCardComponent` class |
| `<p appHighlight>` | the `HighlightDirective` class |
| `(click)="save()"`, `{{ total() }}` | that component's `save()` / `total()` |
| `{{ name \| initials }}` | the `InitialsPipe` class and its `transform()` |

A changed `*.component.html` counts as a change of its own and shows what it uses.

---

## Development

New to the code? Start with [ARCHITECTURE.md](ARCHITECTURE.md): how a change
flows from the diff to the map, the layers, and which file to open for what.

```bash
npm test           # all tests
npm run typecheck  # type errors only
npm run build      # compile to dist/
npm start          # run the service from dist/ (needs the settings above)
```

GitHub Actions runs the typecheck, the tests and a Docker build on every push
(`.github/workflows/ci.yml`).

### Code layout

The code is split into layers; inner layers never import outer ones.

| Folder | What lives there |
|---|---|
| `src/domain/` | Plain data types: changed symbols, file views, the call graph |
| `src/application/` | Use cases (`analyze-range`, `review-merge-request`), the ports (interfaces) they need, and language-neutral logic (mapping changed lines to symbols, walking the call graph) |
| `src/infrastructure/` | Real implementations: git, languages (`parsers/typescript`, `parsers/tree-sitter`, `parsers/angular`), SCIP indexes (`scip/`), GitLab API and sign-in (`gitlab/`), worker threads, file storage |
| `src/interfaces/` | Entry points: the CLI, the HTML page, the web server |
| `ci/` | The CI job teams copy to get exact indexes |

### How languages work

- **TypeScript** uses the TypeScript compiler (ts-morph), so calls are exact.
- **Other languages** use [tree-sitter](https://tree-sitter.github.io/). Each one is a
  few lines in `src/infrastructure/parsers/tree-sitter/languages.ts` saying which
  syntax nodes are definitions and which are calls. Calls are matched by name and
  narrowed to what the caller can reach (`tree-sitter-call-graph.ts`, `visibility.ts`).
- **A SCIP index**, when present, replaces name matching for the files it covers
  (`src/infrastructure/scip/`). Everything it doesn't cover keeps the usual rules.
- **Angular** is an extra graph that reads decorators and templates
  (`src/infrastructure/parsers/angular/`); it runs next to the others.

To add a language tree-sitter has a grammar for, add an entry to `languages.ts`
and to the grammar list in the `Dockerfile`, plus a test in `tests/tree-sitter.test.ts`.

---

## License

[MIT](LICENSE) © 2026 A.Aloleqi
