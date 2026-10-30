#!/usr/bin/env bash
# Pre-commit guard: make sure .env is ignored and nothing that looks like a
# real credential is in the staged diff. Prints file names only, never values.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if ! git check-ignore -q .env; then
  echo "check-secrets: .env is NOT ignored - refusing to commit" >&2
  exit 1
fi

diff_file="$(mktemp)"
trap 'rm -f "$diff_file"' EXIT
git diff --cached -U0 --no-color | grep '^+' | grep -v '^+++' > "$diff_file" || true

fail=0
# 1. any non-empty value from .env appearing verbatim in the staged diff
if [ -f .env ]; then
  while IFS='=' read -r key value; do
    [[ -z "${key// }" || "$key" =~ ^# ]] && continue
    value="${value%\"}"; value="${value#\"}"
    if [ ${#value} -ge 8 ] && grep -qF -- "$value" "$diff_file"; then
      echo "check-secrets: staged diff contains the value of $key from .env" >&2
      fail=1
    fi
  done < .env
fi

# 2. shapes of real keys (Anthropic keys, PayPal REST client id / secret, bearer tokens)
if grep -qE 'sk-ant-[A-Za-z0-9_-]{20,}' "$diff_file"; then
  echo "check-secrets: looks like an Anthropic API key in the staged diff" >&2; fail=1
fi
if grep -qE '\bA[A-Za-z0-9_-]{70,}\b|\bE[A-Za-z0-9_-]{70,}\b' "$diff_file"; then
  echo "check-secrets: looks like a PayPal client id/secret in the staged diff" >&2; fail=1
fi
if grep -qE 'A21AA[A-Za-z0-9_-]{40,}' "$diff_file"; then
  echo "check-secrets: looks like a PayPal access token in the staged diff" >&2; fail=1
fi

if [ "$fail" -ne 0 ]; then exit 1; fi
echo "check-secrets: ok (.env ignored, no key-shaped strings staged)"
