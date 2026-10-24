#!/usr/bin/env bash
# Clean-download replay of the ordered application patch series on the exact base.
# Hosted/source evidence only: this does not claim a Windows server, live origin,
# native RDP, Web Desktop, or upstream deployment.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_SHA=4a91c5c2eadc12e5b071bc46bae7683087f56fbd
APP_ZIP_SHA=dadee74430ca5ee1645d3631f033f17d7d04ae4a8bebadafd39c07c2c44aa378
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mc-40051974454-replay.XXXXXX")"
KEEP_WORK="${KEEP_WORK:-0}"
cleanup() { if [[ "$KEEP_WORK" != 1 ]]; then rm -rf "$WORK"; else printf 'Replay tree retained at %s\n' "$WORK"; fi; }
trap cleanup EXIT

curl -fsSL "https://codeload.github.com/dictationb1/supreme-lamp/zip/${APP_SHA}" -o "$WORK/app.zip"
printf '%s  %s\n' "$APP_ZIP_SHA" "$WORK/app.zip" | sha256sum -c -
unzip -q "$WORK/app.zip" -d "$WORK"
APP_DIR="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d -name 'supreme-lamp-*' -print -quit)"
[[ -n "$APP_DIR" && -f "$APP_DIR/package.json" ]]
cd "$APP_DIR"
git init -q
npx --yes pnpm@9.15.9 install --frozen-lockfile

mapfile -t PATCHES < <(sed -e 's/^[[:space:]]*//' -e '/^#/d' -e '/^$/d' "$HERE/series.txt")
[[ "${#PATCHES[@]}" -gt 0 ]]

# Extract the regression from the patched tree, reverse to the true baseline,
# and require that regression to fail there. No result is inferred from a
# wording-only assertion or from a non-empty response body.
git -c core.autocrlf=false -c core.eol=lf apply "$HERE/${PATCHES[0]}"
cp src/tests/smoke/f201-probe-honesty.test.tsx "$WORK/f201-probe-honesty.test.tsx"
git -c core.autocrlf=false -c core.eol=lf apply -R "$HERE/${PATCHES[0]}"
cp "$WORK/f201-probe-honesty.test.tsx" src/tests/smoke/f201-probe-honesty.test.tsx
set +e
npx --yes pnpm@9.15.9 exec vitest run src/tests/smoke/f201-probe-honesty.test.tsx --reporter=dot
BASELINE_RC=$?
set -e
if [[ "$BASELINE_RC" -eq 0 ]]; then
  echo 'ERROR: F201 regression unexpectedly passed on the unpatched baseline.' >&2
  exit 1
fi
rm -f src/tests/smoke/f201-probe-honesty.test.tsx
printf 'Expected baseline reproduction: F201 regression failed (rc=%s).\n' "$BASELINE_RC"

# Apply every prefix exactly once, in series order, then test the final assembly.
for relative in "${PATCHES[@]}"; do
  [[ "$relative" == app-patches/*.patch ]] || { echo "Unsafe patch path: $relative" >&2; exit 64; }
  git -c core.autocrlf=false -c core.eol=lf apply --check "$HERE/$relative"
  git -c core.autocrlf=false -c core.eol=lf apply "$HERE/$relative"
done

# Prove that the ordered bundle reconstructs the reviewed local-only candidate,
# including the regression at its real test path. Ignored dependencies/build
# output do not enter the tree.
git add -A
REPLAY_TREE="$(git write-tree)"
EXPECTED_TREE=06dce4388261f272ef2e45644bfb13f9b619a34b
if [[ "$REPLAY_TREE" != "$EXPECTED_TREE" ]]; then
  echo "ERROR: replay tree $REPLAY_TREE does not match reviewed candidate $EXPECTED_TREE" >&2
  exit 1
fi
printf 'Candidate tree verified: %s\n' "$REPLAY_TREE"

npx --yes pnpm@9.15.9 exec vitest run src/tests/smoke/f201-probe-honesty.test.tsx --reporter=dot
npx --yes pnpm@9.15.9 test:smoke
VITE_BUILD_SHA="candidate-${APP_SHA:0:12}-40051974454-1" npx --yes pnpm@9.15.9 build
sha256sum ui/dist/index.html
wc -c ui/dist/index.html
printf 'PASS: clean archive, baseline failure, ordered patches, regressions, full smoke suite, production build.\n'
printf 'NOT_RUN: real Windows production backend, interactive client controls, native RDP, Web Desktop, upstream deployment.\n'
