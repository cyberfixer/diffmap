# gitmap

Shows which functions a git diff touches, and where they are used.
It works on TypeScript (`.ts`, `.tsx`) code.

## Build

You need Node.js 20 or newer.

```bash
npm install
npm run build
```

Run the tests with `npm test`.

## Use

Run it inside the git repository you want to review.

```bash
# HTML review page: changes on your branch compared with main
node /path/to/gitmap/bin/git-map.js main --format html > report.html
```

Open `report.html` in your browser.

To run it as `git-map` from anywhere, link it once from the gitmap folder:

```bash
npm link
git-map main --format html > report.html
```

### Options

```
git-map <base>[..<head>] [--format json|html] [--depth N]
```

| Option | Meaning | Default |
|---|---|---|
| `<base>` | Branch or commit to compare against, e.g. `main` | required |
| `..<head>` | Branch or commit to review | `HEAD` |
| `--format` | `json` (raw data) or `html` (review page) | `json` |
| `--depth` | How many levels of callers and callees to include | `1` |

### Examples

```bash
git-map main --format html > report.html          # your branch vs main
git-map main..feature/login --format html > r.html # another branch vs main
git-map HEAD~1 --format html > last.html           # just the last commit
git-map main > result.json                         # raw data
```

## The review page

- **Left:** changed files and the functions changed in each. Click one to select it.
- **Middle:** each changed file, coloured green (added) and red (removed).
  Click "⋯ unchanged lines" or **Whole file** to see more.
  When a function is selected, the functions that call it from outside the diff
  appear on the right, with arrows to each call line.
- **Right:** what changed in the selected function and every place it is used.
  **Mark as viewed** tracks your progress (saved in your browser).

Drag or scroll to move the map, Ctrl+scroll to zoom, Esc to clear the selection.
