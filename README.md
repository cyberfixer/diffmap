# diffmap

Review code changes as a map. diffmap finds which functions a change touches and
where they are used, and shows everything on one page: the changed files, the
code that calls them, and arrows between them. It feels like an editor, but
focused on the change, so reviewers don't get lost.

There are two ways to use it:

1. **[Command line](#1-command-line)**: make a review page for any two branches or
   commits in a repo on your machine. The quickest way to try it.
2. **[Service for GitLab and GitHub (Docker)](#2-service-for-gitlab-and-github-docker)**:
   open any merge request or pull request as a map, comment on lines, approve,
   and track what you have viewed. Works with self-hosted GitLab, gitlab.com,
   github.com and GitHub Enterprise.

## Languages

| Language | Finds | Calls | Exact with a [CI index](#exact-calls-from-ci) |
|---|---|---|---|
| TypeScript | everything | **exact** (TypeScript compiler) | — |
| JavaScript | functions, classes, methods, arrow functions | matched by name | ✅ scip-typescript |
| Java | classes, records, interfaces, enums, methods, constructors, method references | matched by name | ✅ scip-java |
| Kotlin | classes, interfaces, enums, objects, functions, constructors, properties with a getter | matched by name | ✅ scip-java |
| Swift | classes, structs, enums, actors, protocols and what they require, extensions, functions, `init`, subscripts, properties with code (computed, set up by a closure, with `didSet`) | matched by name and [argument labels](#swift-and-ios) | — |
| C# | classes, records, structs, interfaces, enums, methods, constructors, properties with code | matched by name | — |
| Scala | classes, objects, traits, functions | matched by name | — |
| Go | functions, methods, structs, interfaces | matched by name | — |
| Rust | functions, structs, enums, traits, impl blocks | matched by name | — |
| C++ | functions, classes, structs, namespaces | matched by name | ✅ scip-clang |
| C | functions, structs | matched by name | ✅ scip-clang |
| Python | functions, classes | matched by name | — |
| PHP | classes, interfaces, traits, enums, methods, functions | matched by name | — |
| Ruby | classes, modules, methods | matched by name | — |
| Angular templates | components, directives, pipes | [linked from templates](#angular) | — |
| Anything else (YAML, SQL, Markdown…) | shown as plain diff cards | — | — |

"Matched by name" means a call to `update()` links to a function called `update`
that the calling code can reach: `self.update()` / `this.update()` → the same
class; `Svc.update()` or a variable whose type is written down (in the method,
or on a field, property or constructor parameter of its class) → that class;
the same through calls and fields, using declared return types
(`var o = repo.find(id); o.total()`, `repo.find(id).total()`);
calls on a library type (`items.add()`) are left out;
when several same-named methods are left, those that accept the number of
arguments passed;
of same-named classes, the one the file imports;
a method the class inherits → the parent that declares it; otherwise the same
file, then files it imports or shares a folder with. A method that implements an
interface, protocol or trait method (or overrides a parent's) gets an
"implemented by" link, so changing it also shows who calls the interface. It is
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

## 2. Service for GitLab and GitHub (Docker)

People open a merge request (GitLab) or pull request (GitHub) and see it as a
map. They only ever see projects they can already see on that host.

One diffmap serves **one code host**: GitLab or GitHub, set by `CODE_HOST`.
To serve both, run two copies of the same image ([below](#both-gitlab-and-github)).

It runs in one of two modes:

| Mode | Setup | People sign in with | Comment & approve |
|---|---|---|---|
| **Full** | an OAuth application on the host (ID + secret), [step 1](#step-1-optional-create-an-oauth-application) | "Sign in with GitLab / GitHub" | ✅ goes straight to the host |
| **View-only** | nothing; leave the client ID and secret empty | their own access token | ❌ (existing comments are shown) |

View-only mode is the quickest start: skip step 1. The sign-in page links to
the host's token page; each person creates a token and pastes it. The token
stays in diffmap's memory only and is forgotten on sign-out.

### Step 1 (optional): create an OAuth application

*Full mode only. For view-only mode skip this step.*

**GitLab**

| GitLab | Where |
|---|---|
| Self-hosted, for everyone | **Admin Area → Applications → Add new application** |
| gitlab.com, or just for you | **Preferences → Applications → Add new application** (https://gitlab.com/-/user_settings/applications) |

- **Redirect URI:** `<PUBLIC_URL>/auth/callback`, e.g. `http://localhost:8080/auth/callback`
- **Confidential:** yes · **Scopes:** `api`

**GitHub**

| GitHub | Where |
|---|---|
| For your organization | **Organization settings → Developer settings → OAuth Apps → New OAuth App** |
| Just for you | **Settings → Developer settings → OAuth Apps → New OAuth App** (https://github.com/settings/developers) |

- **Homepage URL:** your `PUBLIC_URL`, e.g. `http://localhost:8080`
- **Authorization callback URL:** `<PUBLIC_URL>/auth/callback`, e.g. `http://localhost:8080/auth/callback`
- After creating it, click **Generate a new client secret**.

Copy the **ID** and **secret** of either one.

### Step 2: run it

In the `diffmap` folder (clone it as in [Install](#install-once) if you haven't):

```bash
cp .env.example .env     # set CODE_HOST (gitlab or github), PUBLIC_URL, GITLAB_URL for GitLab,
                         # and the client ID/secret for full mode
docker compose up -d --build
```

`.env` holds your secrets, so it is in `.gitignore` and never committed.
Check: `curl http://localhost:8080/healthz` prints `ok`.
The log says which host and mode it runs: `docker compose logs`.

#### Both GitLab and GitHub

Run a second copy with its own settings file, port and project name
(`-p` also gives it its own data volume):

```bash
cp .env.example .env.github     # CODE_HOST=github, PUBLIC_URL=http://localhost:8081, ...
DIFFMAP_ENV=.env.github DIFFMAP_PORT=8081 docker compose -p diffmap-github up -d
```

Stop it with `docker compose -p diffmap-github down`.

<details>
<summary>Plain Docker instead of compose</summary>

```bash
docker build -t diffmap .
docker run -d --name diffmap -p 8080:8080 -v diffmap-data:/data --env-file .env diffmap
```
For a second host, run it again with another name, port, volume and settings file.
</details>

| Setting | Meaning |
|---|---|
| `CODE_HOST` | `gitlab` (default) or `github` |
| `GITLAB_URL` | Your GitLab, e.g. `https://gitlab.company.com` or `https://gitlab.com` |
| `GITHUB_URL` | `https://github.com` (default) or your GitHub Enterprise address |
| `GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET` / `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | From step 1; leave both empty for view-only mode |
| `PUBLIC_URL` | Address people use to open this diffmap (must match the callback URL) |
| `PORT` | Port inside the container (default `8080`) |
| `DATA_DIR` | Where diffmap keeps its files (default `/data`; keep it on a volume) |
| `CACHE_DIR` | Where project code is kept (default `$DATA_DIR/repos`) |
| `CACHE_MAX_GB` | Disk limit for project code (default `15`, `0` = no limit). Above it, projects not opened for the longest time are removed; they download again when next opened |
| `ANALYSIS_WORKERS` | Reviews analysed at the same time (default `2`; about one per CPU core is fine if memory allows) |
| `ANALYSIS_MEMORY_MB` | Memory limit of each analysis (default `2048`). The container needs at most about `ANALYSIS_WORKERS` × this + 200 MB |
| `INDEX_JOB`, `INDEX_ARTIFACT` | CI job (GitLab) or Actions artifact (GitHub) with the exact index (default `diffmap-index`, `index.scip`) |
| `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO` | Path to your CA file if the host uses an internal certificate |

### Step 3: open a merge or pull request

Take its URL and change only the host to your diffmap:

| On the host | On diffmap |
|---|---|
| `https://gitlab.company.com/team/api/-/merge_requests/42` | `http://localhost:8080/team/api/-/merge_requests/42` |
| `https://github.com/acme/api/pull/42` | `http://localhost:8080/acme/api/pull/42` |

Or open diffmap's start page and paste the link.

The first time, you sign in. If the review isn't ready yet, a progress screen
shows the steps (download the code, analyse the changes) with git's real
download progress, and opens the map when it's done.

In full mode you can also:

- **Comment:** click a line number. The comment appears on the host as a normal
  line comment. A line in a file that isn't part of the review (a caller
  somewhere else) is posted as a general comment that quotes the line, because
  the host can't attach a comment there.
- **Reply:** existing comments show under their lines; click **Reply**.
- **Approve:** works like the host's button. On GitHub this submits an
  "Approve" review; GitHub has no "unapprove", so **Revoke approval** dismisses
  the review, which GitHub only allows for people with write access.

In both modes, **Mark as viewed** tracks your progress per function. It is
saved on the server for your user, so it stays after closing the browser.

Good to know:

- The first open of a project downloads its code. After that only new commits
  are fetched, and each review version is analysed once, then cached.
- Analysis runs in background threads: a big review doesn't slow down anyone else.
  Any number of people can view maps at the same time.
- Sign-ins are kept in memory on purpose: restarting a container signs everyone
  out, and tokens are never written to disk.
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
compiler:

- **GitLab:** copy the jobs you need from
  [`ci/diffmap-index.gitlab-ci.yml`](ci/diffmap-index.gitlab-ci.yml) into your project's
  `.gitlab-ci.yml`. The job must be called `diffmap-index` and save `index.scip`.
- **GitHub:** copy [`ci/diffmap-index.github-workflow.yml`](ci/diffmap-index.github-workflow.yml)
  to `.github/workflows/` in your repository. It uploads an artifact called
  `diffmap-index` holding `index.scip`.

| Language | Indexer | Notes |
|---|---|---|
| TypeScript, JavaScript | [scip-typescript](https://github.com/sourcegraph/scip-typescript) | uses your `tsconfig.json`; `--infer-tsconfig` for plain JS |
| Java, Kotlin | [scip-java](https://github.com/sourcegraph/scip-java) | Maven, Gradle or sbt |
| C, C++ | [scip-clang](https://github.com/sourcegraph/scip-clang) | needs `compile_commands.json` from your build |
| Swift | none available yet | stays on name matching |

- **Service:** diffmap finds the `diffmap-index` job (GitLab) or artifact (GitHub)
  for the review's head commit by itself. If the job is still running, the map opens with name matching (the
  header says *exact index still building*) and switches to exact calls on a later visit.
- **CLI:** `--scip index.scip`. Several index files can be passed, or joined with
  `cat a.scip b.scip > index.scip`.
- An index also says which classes implement which interfaces: the dashed arrows.

### Swift and iOS

Swift has no indexer to give exact calls, so name matching does more for it:

- **Methods are named with their argument labels**, the way Swift tells them apart:
  `tableView(_:cellForRowAt:)`, `init(frame:)`, `init(coder:)`. A change in one of a
  view controller's five `tableView(...)` methods marks that one. A call is linked
  only to methods that can take its labels (defaults and trailing closures count).
  A method whose signature changed shows as modified, under its new name.
- **Properties with code are symbols**: computed properties, `lazy var table: UITableView = { ... }()`,
  properties with `didSet`. Reading one is a use: a SwiftUI `body` that shows `header`
  is drawn as using it, and so is `viewModel.title` when `viewModel`'s type is written down.
- **Uses that are not calls** count too: `#selector(didTapSave)`, and a function passed
  by name (`Button("Save", action: save)`).
- `super.viewDidLoad()` is the parent's method; a plain `setup()` is the type's own
  first, also from an extension in another file; `Svc(a: 1)` links to the type and to
  `Svc.init(a:)`; `let tab: Tab = .init(1)` to `Tab.init(_:)`.
- **Files of one module see each other** without imports, in any folder. A module is a
  folder named after something the code imports (`import Networking`, `@testable import App`)
  or a folder right under `Sources/` or `Tests/`; everything else is the app. diffmap does
  not read `.xcodeproj` or `Package.swift`.
- A class built on a UIKit class reaches what the repo adds to UIKit's own parents
  (`class Cell: UITableViewCell` calling `pin()` from `extension UIView`).

Left out on purpose, because a name alone is not enough: a method called on something
whose type is not written down, when several types have one (`items.map { }`);
`.success(x)` and other members of a type only the compiler knows, unless the type is
written nearby. Objective-C files (`.m`) show as plain diff cards.

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
Grammars come from `tree-sitter-wasms`; Swift's is newer than that package has and
lives in [`grammars/`](grammars/README.md).

---

## License

[MIT](LICENSE) © 2026 A.Aloleqi
