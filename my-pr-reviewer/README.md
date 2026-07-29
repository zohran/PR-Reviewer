# PR Reviewer

GitHub Action that reviews pull requests end-to-end: it detects the project language, runs the matching linter and test suite, asks Anthropic Claude to compare the PR’s stated intent (description + commits) against the diff, then posts a GitHub review (`APPROVE` or `REQUEST_CHANGES`) with inline comments where diff positions can be resolved. Lint/test crashes and LLM outages are isolated so one failure does not abort the rest of the pipeline; when the review requests changes, the Action itself fails so you can require it via branch protection.

## Required secrets

| Secret | Purpose |
| --- | --- |
| `GITHUB_TOKEN` | Provided automatically by Actions. Needs `pull-requests: write` (set in the workflow `permissions` block) to post reviews. |
| `ANTHROPIC_API_KEY` | Your Anthropic API key for Claude. **You must add this yourself.** |

### Adding `ANTHROPIC_API_KEY`

1. Create an API key at [console.anthropic.com](https://console.anthropic.com/).
2. In the consuming repo: **Settings → Secrets and variables → Actions → New repository secret**.
3. Name it `ANTHROPIC_API_KEY` and paste the key.
4. Reference it in the workflow as `${{ secrets.ANTHROPIC_API_KEY }}`.

Do not commit the key to the repo or to `action.yml`.

## Usage

Copy [`.github/workflows/pr-review.yml`](.github/workflows/pr-review.yml) into a consuming repo (and point `uses:` at this action’s published ref), or start from:

```yaml
name: PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: your-org/my-pr-reviewer@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `github-token` | yes | — | Token used to read the PR and post the review (`secrets.GITHUB_TOKEN` is typical). |
| `anthropic-api-key` | yes | — | Anthropic API key for LLM review. |
| `fail-on-lint-errors` | no | `true` | When `true`, lint `error` severity findings cause `REQUEST_CHANGES` and fail the check. |
| `fail-on-test-failure` | no | `true` | When `true`, a failed test run causes `REQUEST_CHANGES` and fail the check. |
| `custom-test-command` | no | _(empty)_ | Optional shell command that **replaces** language-default test commands (skips the config-file gate). |

## Supported languages

Language is auto-detected from changed-file extensions (majority vote), unless the PR description overrides it (see below). Extension map: `.py` → python, `.js`/`.jsx`/`.ts`/`.tsx` → node, `.go` → go, `.java` → java, `.rb` → ruby, `.rs` → rust, `.cs` → csharp. Ties or no matches → `unknown`.

| Language | Tests (when config present) | Lint |
| --- | --- | --- |
| **python** | `requirements.txt` or `pyproject.toml` → `pip install -r requirements.txt …` then `pytest --tb=short -q` | Ruff (`ruff.toml` / `.ruff.toml` / `[tool.ruff]` in `pyproject.toml`); otherwise Pylint JSON |
| **node** | `package.json` → `npm ci \|\| npm install` then `npm test --if-present` | ESLint JSON, only if `.eslintrc*` exists |
| **go** | `go.mod` → `go test ./...` | `golangci-lint run --out-format json`, only if a golangci config exists |
| **java** | `pom.xml` → `mvn -q -B test` | Not yet supported (empty lint result + note) |
| **ruby** | `Gemfile` → `bundle install` then `bundle exec rspec` | _(no dedicated linter yet)_ |
| **rust** / **csharp** / **unknown** | No default test plan (unless `custom-test-command` is set) | No default linter |

Missing linter binaries are installed once via the language package manager when possible (`pip install ruff`, `npm install eslint --no-save`, `go install …golangci-lint`, etc.); if install still fails, lint is skipped with a warning.

## Overriding language detection

Add an explicit tag anywhere in the PR description (case-insensitive; whitespace around `:` is fine):

```text
Language: python
```

or:

```text
lang: go
```

That value (lowercased) wins over extension majority voting. Useful for polyglot repos or when the diff is mostly docs/config.

## Limitations

- **LLM review is advisory.** Claude can miss bugs, hallucinate line numbers, or disagree with your standards. Blocking findings still fail the check when present, but humans should treat the summary as a signal, not ground truth.
- **Large diffs are truncated** (~12k characters of patch text). Whole files are kept until the budget is exhausted; omitted files are noted as `N files omitted for length`.
- **Binary / oversized file patches** are omitted by GitHub (`patch` missing) and cannot receive inline comments.
- **Inline comments need a mappable diff position.** Issues whose line is outside the changed hunks are folded into the top-level review body instead.
- **Lint/test require local toolchains** on the runner (Python/Node/Go/Maven/Ruby as applicable). The Action will try to install common linters, not full language runtimes.
- **Java linting is not implemented yet.**
- **If the Anthropic API is down or returns invalid JSON after one retry**, the Action continues with lint + test results only and posts a review without LLM issues.
- **`GITHUB_TOKEN` cannot approve PRs opened by workflows in some org setups**; if approval is blocked, switch the event behavior or use a PAT with appropriate permissions.

## Development

```bash
npm install
npm run lint      # tsc --noEmit
npm test          # Jest (NODE_OPTIONS=--experimental-vm-modules)
npm run build     # @vercel/ncc → dist/index.js
npm run check:dist  # rebuild + fail if committed dist/ is stale
```

**`dist/` must be committed** — GitHub Actions runs `dist/index.js` directly (see `action.yml`). Do not add `dist/` to `.gitignore`.

CI (`.github/workflows/build.yml`) runs lint, tests, and build on every PR/push. Pull requests **fail** if `dist/` is out of sync; pushes to `main` **rebuild and commit** `dist/` when needed.

Optional local pre-commit hook:

```bash
git config core.hooksPath .githooks
```

### Local runs with [`act`](https://github.com/nektos/act)

Useful for smoke-testing the workflow without pushing:

```bash
# Install act (macOS): brew install act

# Provide secrets via a .secrets file (never commit it):
#   GITHUB_TOKEN=ghp_...
#   ANTHROPIC_API_KEY=sk-ant-...

act pull_request \
  -W .github/workflows/pr-review.yml \
  --secret-file .secrets
```

Notes:

- `act` emulates runners imperfectly; language toolchains must exist in the chosen act image.
- Prefer a real PR on a fork/test repo for end-to-end validation of review posting and check failure behavior.
# PR-Reviewer
