#!/usr/bin/env bash
# ── Model-ID literal guard (SHA-153 N2) ──────────────────────────────────────
#
# Proves that every pinned provider model-ID string lives in EXACTLY one place,
# src/lib/models.ts. A stray literal anywhere else means a model swap could slip
# in without the gate's model-guard noticing (rule 13).
#
# SCOPE (source globs): src/**, scripts/**, evals/*.ts
# EXEMPT (committed provenance data — records the id that produced it, must NOT be
#   rewritten to an import): evals/results, evals/golden, evals/fixtures,
#   e2e/fixtures, persisted trace JSON, and the single source itself.
#
# Exit 0 = clean (no stray literal). Exit 1 = a literal escaped models.ts.

set -euo pipefail
cd "$(dirname "$0")/.."

# Canonical pinned ids (kept in sync with src/lib/models.ts). Matching the FULL id
# strings — not substrings like "claude-" — so prose/comments mentioning a family
# name don't trip the guard.
PATTERN='claude-haiku-4-5-20251001|claude-sonnet-4-6|voyage-3\.5'

# Search the source globs, excluding the single source and committed data.
matches=$(grep -REn "$PATTERN" \
  --include='*.ts' --include='*.tsx' \
  src scripts evals 2>/dev/null \
  | grep -v '^src/lib/models.ts:' \
  | grep -v '/evals/results/' \
  | grep -v '/evals/golden/' \
  | grep -v '/evals/fixtures/' \
  | grep -v '/e2e/fixtures/' \
  | { grep -vE '/(__tests__)/' || true; } \
  | { grep -vE '\.test\.(ts|tsx):' || true; } \
  || true)

if [ -n "$matches" ]; then
  echo "FAIL: model-ID literal(s) found outside src/lib/models.ts:" >&2
  echo "$matches" >&2
  exit 1
fi

echo "OK: no model-ID literal outside src/lib/models.ts (source globs, data exempt)."
