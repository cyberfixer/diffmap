# gitmap

Review code changes as a map. gitmap finds which functions a change touches
and where they are used, and shows it all on one page: changed files, the
functions that call them, and arrows between them.

It understands TypeScript, JavaScript, Python, Java, Go, C#, PHP, Ruby, Rust,
Kotlin, Swift, Scala, C and C++. Other changed files (YAML, SQL, Markdown…)
still show up, just without functions and arrows. There are two ways to use it:

- **Command line**: make a report for any two branches or commits in a local repo.
- **GitLab service**: open any merge request from your self-hosted GitLab as a map,
  comment on lines and approve, signed in with your GitLab account.

---

## 1. Command line

### Build

You need Node.js 20 or newer and git.

```bash
npm install
npm run build
```

### Use

Run it inside the git repository you want to review:

```bash
node /path/to/gitmap/bin/git-map.js main --format html > report.html
```

Open `report.html` in your browser. To type `git-map` from any folder, run
`npm link` once in the gitmap folder.

```
git-map <base>[..<head>] [--format json|html] [--depth N]
```

| Option | Meaning | Default |
|---|---|---|
| `<base>` | Branch or commit to compare against, e.g. `main` | required |
| `..<head>` | Branch or commit to review | `HEAD` |
| `--format` | `json` (raw data) or `html` (review page) | `json` |
| `--depth` | Levels of callers and callees to include | `1` |

```bash
git-map main --format html > report.html           # your branch vs main
git-map main..feature/login --format html > r.html  # another branch vs main
git-map HEAD~1 --format html > last.html            # just the last commit
```

---

## 2. GitLab service (Docker)

People open a merge request link and see it as a map. They sign in with your
GitLab, so they only see projects they can already see there. Comments and
approvals go straight to GitLab.

### Step 1: create an application in GitLab

In GitLab go to **Admin Area → Applications → Add new application** (for
the whole instance), or **User settings → Applications** (just for testing).

- **Name:** gitmap
- **Redirect URI:** `<PUBLIC_URL>/auth/callback`, e.g. `https://gitmap.company.com/auth/callback`
- **Confidential:** yes
- **Scopes:** `api`

Save it and copy the **Application ID** and **Secret**.

### Step 2: run it

Copy the example settings and fill them in:

```bash
cp .env.example .env     # then edit .env
docker compose up -d --build
```

`.env` holds your secret, so it is in `.gitignore` and never committed.

Or with plain Docker:

```bash
docker build -t gitmap .
docker run -d --name gitmap -p 8080:8080 -v gitmap-data:/data \
  -e GITLAB_URL=https://gitlab.company.com \
  -e GITLAB_CLIENT_ID=<application id> \
  -e GITLAB_CLIENT_SECRET=<secret> \
  -e PUBLIC_URL=https://gitmap.company.com \
  gitmap
```

| Setting | Meaning |
|---|---|
| `GITLAB_URL` | Address of your GitLab, e.g. `https://gitlab.company.com` |
| `GITLAB_CLIENT_ID` | Application ID from step 1 |
| `GITLAB_CLIENT_SECRET` | Secret from step 1 |
| `PUBLIC_URL` | Address people use to open gitmap (must match the redirect URI) |
| `PORT` | Port inside the container (default `8080`) |
| `DATA_DIR` | Where gitmap keeps its files (default `/data`, keep it on a volume) |
| `CACHE_DIR` | Where project code is kept (default `$DATA_DIR/repos`) |
| `ANALYSIS_WORKERS` | How many merge requests can be analysed at the same time (default `2`) |
| `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO` | Path to your CA file if GitLab uses an internal certificate |

Check it's running: `curl http://localhost:8080/healthz` prints `ok`.

### Using the official gitlab.com

It works the same way. To try it on your own machine:

1. On gitlab.com open **Edit profile → Applications → Add new application**.
   Redirect URI `http://localhost:8080/auth/callback`, **Confidential** on, scope `api`.
2. In `.env` set `GITLAB_URL=https://gitlab.com`, `PUBLIC_URL=http://localhost:8080`
   and the application ID and secret.
3. `docker compose up -d --build`, then open `http://localhost:8080`.

You can open merge requests in any project your gitlab.com account can see.

### Step 3: use it

- Take any merge request URL and change only the host:
  `https://gitlab.company.com/team/api/-/merge_requests/42` →
  `https://gitmap.company.com/team/api/-/merge_requests/42`
- Or open gitmap's start page and paste the MR link.

The first time, you are sent to GitLab to sign in. If the MR's code isn't
ready yet, you see a progress screen (download, then analysis) that opens the
map by itself when it's done.

On the map:

- **Click a line number** to comment on that line. The comment appears in GitLab
  as a normal diff comment. Lines in files that are not part of the MR are posted
  as a general MR comment that quotes the line, because GitLab can't attach a
  comment there.
- Existing comments show under their lines. Click **Reply** to answer.
- **Approve** / **Revoke approval** in the top bar works like GitLab's button.
- Files over 500 lines (HTML files over 300) start collapsed; click **Show** to
  open one. They also open by themselves when you select something inside them.
- **Mark as viewed** tracks your own progress. It is saved on the server for your
  GitLab user, so it is still there after closing the browser or on another computer.

Good to know:

- The first open of a project downloads its code, which can take a while for big
  repos. After that only new commits are fetched, and each MR version is analysed once.
- Analysis runs in background threads, so one big MR does not slow down the pages
  of other people.
- Sign-ins are kept in memory on purpose: restarting the container signs everyone
  out, and GitLab tokens are never written to disk.
- Run it behind HTTPS (a reverse proxy) in real use, and set `PUBLIC_URL` to the
  `https://` address.

---

## The review page

- **Left:** changed files and the functions changed in each, and your "viewed" progress.
- **Middle:** each changed file, green for added lines and red for removed ones.
  Click "⋯ unchanged lines" or **Whole file** to see more. Select a function to
  see the functions that call it from outside the change, with arrows to each call.
- **Right:** what changed in the selected function, and every place it is used.

Drag or scroll to move the map, Ctrl+scroll to zoom, Esc to clear the selection.

---

## Development

```bash
npm test           # all tests
npm run typecheck  # type errors only
npm run build      # compile to dist/
npm start          # run the service from dist/ (needs the settings above)
```

The code is split into layers. Inner layers never import outer ones.

| Folder | What lives there |
|---|---|
| `src/domain/` | Plain data types: changed symbols, file views, the call graph |
| `src/application/` | Use cases (`analyze-range`, `review-merge-request`) and the ports (interfaces) they need |
| `src/infrastructure/` | Real implementations: git, TypeScript parsing (ts-morph), GitLab API and sign-in |
| `src/interfaces/` | Entry points: the CLI, the HTML report, the web server |

How languages work:

- **TypeScript** uses the TypeScript compiler, so calls are resolved exactly.
- **Everything else** uses [tree-sitter](https://tree-sitter.github.io/). Each language is
  a few lines in `src/infrastructure/parsers/tree-sitter/languages.ts` saying which
  syntax nodes are definitions and which are calls. Calls are matched by name, so two
  unrelated methods with the same name can both be linked.

To add a language that tree-sitter has a grammar for, add an entry to that file
(and to the grammar list in the `Dockerfile`), plus a test in `tests/tree-sitter.test.ts`.

GitHub Actions runs the typecheck, the tests and a Docker build on every push
(`.github/workflows/ci.yml`).
