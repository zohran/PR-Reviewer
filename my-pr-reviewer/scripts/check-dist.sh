#!/usr/bin/env bash
# Pre-commit / local / CI check: rebuild dist/ and fail if the working tree differs.
//
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "→ npm run build"
npm run build

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "⚠ Not a git repository — skipped dist/ sync check (build succeeded)."
  exit 0
fi

# Untracked dist/ also counts as out of sync (must be committed for the Action).
UNTRACKED="$(git ls-files --others --exclude-standard -- dist/ || true)"
if [[ -n "$UNTRACKED" ]]; then
  echo ""
  echo "ERROR: dist/ has untracked files that must be committed:"
  echo "$UNTRACKED"
  echo ""
  echo "  git add dist/ && git commit"
  exit 1
fi

if ! git diff --quiet -- dist/; then
  echo ""
  echo "ERROR: dist/ is out of sync with src/ after build."
  echo "Stage the updated dist/ files before committing:"
  echo "  git add dist/ && git commit"
  echo ""
  git --no-pager diff --stat -- dist/ || true
  exit 1
fi

echo "✓ dist/ is in sync with src/"
