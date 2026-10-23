#!/usr/bin/env bash
# Replay the application patch queue onto a FRESH checkout and verify it.
#
#   ./apply-and-verify.sh <path-to-supreme-lamp-checkout>
#
# Refuses to run on an unexpected base, refuses a checksum mismatch, and stops at
# the first conflict. The real-Windows runtime verification is
# .github/workflows/app-candidate.yml (lab-owned runner); the checks below are the
# portable, dependency-free part that must pass anywhere.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # .../app-candidate
APP="${1:-}"
BASE="$(tr -d '[:space:]' < "$HERE/baseline/base-commit.txt")"

die() { echo "REPLAY_FAILED: $*" >&2; exit 1; }

[ -n "$APP" ] || die "usage: apply-and-verify.sh <checkout>"
[ -d "$APP/.git" ] || die "not a git checkout: $APP"

HEAD_SHA="$(git -C "$APP" rev-parse HEAD)"
if [ "$HEAD_SHA" != "$BASE" ]; then
  # A moved base is not automatically fatal, but the queue must then be
  # RE-VERIFIED by a human: applying blind is exactly what this script forbids.
  die "unexpected base: HEAD=$HEAD_SHA expected=$BASE (compare, resolve, rerun the affected tests before applying)"
fi

mapfile -t NAMES < <(grep -v '^\s*#' "$HERE/patches/series.txt" | grep -v '^\s*$')
[ "${#NAMES[@]}" -gt 0 ] || die "empty series"

for n in "${NAMES[@]}"; do
  p="$HERE/patches/$n"
  [ -f "$p" ] || die "missing patch $n"
  want="$(awk -v n="$n" '$2==n {print $1}' "$HERE/patches/SHA256SUMS")"
  got="$(sha256sum "$p" | awk '{print $1}')"
  [ "$want" = "$got" ] || die "checksum mismatch for $n: want=$want got=$got"
  git -C "$APP" apply --check --whitespace=nowarn "$p" \
    || git -C "$APP" apply --check --ignore-whitespace --whitespace=nowarn "$p" \
    || die "does not apply: $n"
  git -C "$APP" apply --whitespace=nowarn "$p" \
    || git -C "$APP" apply --ignore-whitespace --whitespace=nowarn "$p" \
    || die "apply failed: $n"
  echo "applied $n"
done

echo "--- pinned tests (node >= 20) ---"
( cd "$APP" && node --test tests/p001-p002-ticket-and-version-identity.test.js )

echo "--- changed files (must be payloads/ghrdp-server.ps1 + the new test only) ---"
git -C "$APP" status --porcelain

echo "REPLAY_OK base=$BASE patches=${#NAMES[@]}"
echo "next: the real-Windows runtime proof is .github/workflows/app-candidate.yml"
