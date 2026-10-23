#!/usr/bin/env bash
# Publish Smart Dictation Player v2.4.0 (ver 16) to dictationb1/dictationb1.github.io.
#
# The release commit (205ff0a) was produced in the Arena sandbox, whose GitHub
# integration is read-only on the app repository. Run this where you have push
# access. It applies the exact patch, re-runs every gate, and only then pushes.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${REPO:-https://github.com/dictationb1/dictationb1.github.io.git}"
BRANCH="${BRANCH:-main}"
BASE="b2a605d"
MSG="Release v2.4.0 (v16): Animated Swan Credit Badge, Liquid Glass Hero Title Font, Settings Material Mixer & Zero-Lag 60 FPS UI"

WORK="${WORK:-$(mktemp -d)}"
echo "workdir: $WORK"
git clone "$REPO" "$WORK/app"
cd "$WORK/app"

git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

if git log --format=%s "origin/$BRANCH" | grep -qx "$MSG"; then
  echo "the release commit is already on origin/$BRANCH - nothing to do"
  exit 0
fi

if ! git merge-base --is-ancestor "$BASE" HEAD; then
  echo "note: $BASE is not an ancestor of $BRANCH; continuing with a 3-way apply"
fi

if ! git am --3way "$HERE/0001-release-v2.4.0.patch"; then
  git am --abort || true
  git apply --3way "$HERE/v2.4.0.diff"
  git add -A
  git commit -m "$MSG"
fi

# every gate the release claims, re-run on the real clone
node tests/check.cjs
node tests/upgrade.test.cjs
node tests/phase1.cjs

git log --oneline -2
git push origin "$BRANCH"
echo "published v2.4.0 (ver 16) to $BRANCH"

# the real-engine suite needs a Chromium; it skips with an explicit message when
# the machine has none, so run it separately:
#   cd "$WORK/app" && node tests/upgrade-browser.cjs
