# PR-Reviewer

GitHub Action that reviews pull requests with lint, tests, and Anthropic LLM feedback.

The action package lives in [`my-pr-reviewer/`](./my-pr-reviewer/). Live workflows are in [`.github/workflows/`](./.github/workflows/).

## End-to-end test on this repo

1. Add the Anthropic secret (one-time):
   - Repo → **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `ANTHROPIC_API_KEY`
   - Value: your key from [console.anthropic.com](https://console.anthropic.com/)
2. Open a pull request into `main` (e.g. from branch `texting`).
3. Check the **Actions** tab for the **PR Review** workflow.
4. On the PR, look for the bot review (`APPROVE` / `REQUEST_CHANGES`) and inline comments.

`GITHUB_TOKEN` is provided automatically; the workflow already requests `pull-requests: write`.

## Development

```bash
cd my-pr-reviewer
npm install
npm test
npm run build
```

See [`my-pr-reviewer/README.md`](./my-pr-reviewer/README.md) for inputs, languages, and limitations.
