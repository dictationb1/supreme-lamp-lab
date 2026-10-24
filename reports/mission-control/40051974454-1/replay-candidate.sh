#!/usr/bin/env bash
# Clean-download replay of the ordered application patch series on the exact
# base. Hosted/source evidence only: this does NOT claim a Windows server, live
# origin, native RDP, Web Desktop or upstream deployment. Those are measured by
# .github/workflows/real-backend.yml on the client VM and reported separately.
#
# Proves, from a clean codeload download:
#   1. the archive SHA-256 matches the pinned origin;
#   2. each ordered patch applies at the application root with git apply --check;
#   3. BOTH regressions FAIL on the pristine baseline and PASS on the candidate
#      (F201 probe honesty; R1 server startup readiness);
#   4. the reconstructed candidate tree equals the reviewed tree;
#   5. the full smoke suite and the production frontend build pass.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_SHA=4a91c5c2eadc12e5b071bc46bae7683087f56fbd
APP_ZIP_SHA=dadee74430ca5ee1645d3631f033f17d7d04ae4a8bebadafd39c07c2c44aa378
EXPECTED_TREE=62679b8edfde8ba2180f8bb3ca86c03e00d02b31
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mc-40051974454-replay.XXXXXX")"
KEEP_WORK="${KEEP_WORK:-0}"
cleanup() { if [[ "$KEEP_WORK" != 1 ]]; then rm -rf "$WORK"; else printf 'Replay tree retained at %s\n' "$WORK"; fi; }
trap cleanup EXIT

command -v git >/dev/null || { echo 'git required' >&2; exit 64; }

printf 'Downloading pinned application base %s ...\n' "$APP_SHA"
curl -fsSL "https://codeload.github.com/dictationb1/supreme-lamp/zip/${APP_SHA}" -o "$WORK/app.zip"
printf '%s  %s\n' "$APP_ZIP_SHA" "$WORK/app.zip" | sha256sum -c -
( command -v unzip >/dev/null && unzip -q "$WORK/app.zip" -d "$WORK" ) || \
  python3 -c "import zipfile,sys;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$WORK/app.zip" "$WORK"
APP_DIR="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d -name 'supreme-lamp-*' -print -quit)"
[[ -n "$APP_DIR" && -f "$APP_DIR/package.json" ]]
cd "$APP_DIR"
git init -q
git -c user.email=lab@local -c user.name=lab add -A
git -c user.email=lab@local -c user.name=lab commit -qm "pinned base $APP_SHA"
printf 'Installing app dependencies (frozen lockfile) ...\n'
npx --yes pnpm@9.15.9 install --frozen-lockfile

mapfile -t PATCHES < <(sed -e 's/^[[:space:]]*//' -e '/^#/d' -e '/^$/d' "$HERE/series.txt")
[[ "${#PATCHES[@]}" -ge 2 ]]
for relative in "${PATCHES[@]}"; do
  [[ "$relative" == app-patches/*.patch ]] || { echo "Unsafe patch path: $relative" >&2; exit 64; }
  git -c core.autocrlf=false -c core.eol=lf apply --check "$HERE/$relative"
  git -c core.autocrlf=false -c core.eol=lf apply "$HERE/$relative"
done

# Copy both added regressions out, then reverse the WHOLE series to reconstruct
# the true pristine source. Restored tests must FAIL there - never inferred from
# a wording-only assertion or a non-empty body.
cp src/tests/smoke/f201-probe-honesty.test.tsx "$WORK/f201-probe-honesty.test.tsx"
cp src/tests/smoke/r1-server-readiness.test.ts "$WORK/r1-server-readiness.test.ts"
for (( i=${#PATCHES[@]}-1; i>=0; i-- )); do
  git -c core.autocrlf=false -c core.eol=lf apply -R "$HERE/${PATCHES[$i]}"
done
cp "$WORK/f201-probe-honesty.test.tsx" src/tests/smoke/f201-probe-honesty.test.tsx
cp "$WORK/r1-server-readiness.test.ts" src/tests/smoke/r1-server-readiness.test.ts
set +e
npx --yes vitest run src/tests/smoke/f201-probe-honesty.test.tsx src/tests/smoke/r1-server-readiness.test.ts --reporter=dot
BASELINE_RC=$?
set -e
if [[ "$BASELINE_RC" -eq 0 ]]; then
  echo 'ERROR: regressions unexpectedly passed on the unpatched baseline.' >&2
  exit 1
fi
printf 'Expected baseline reproduction: F201+R1 regressions FAILED (rc=%s).\n' "$BASELINE_RC"
rm -f src/tests/smoke/f201-probe-honesty.test.tsx src/tests/smoke/r1-server-readiness.test.ts

# Re-apply the ordered bundle exactly once, then verify the reconstructed tree.
for relative in "${PATCHES[@]}"; do
  git -c core.autocrlf=false -c core.eol=lf apply --check "$HERE/$relative"
  git -c core.autocrlf=false -c core.eol=lf apply "$HERE/$relative"
done
git add -A
REPLAY_TREE="$(git write-tree)"
if [[ "$REPLAY_TREE" != "$EXPECTED_TREE" ]]; then
  echo "ERROR: replay tree $REPLAY_TREE does not match reviewed candidate $EXPECTED_TREE" >&2
  exit 1
fi
printf 'Candidate tree verified: %s\n' "$REPLAY_TREE"

npx --yes vitest run src/tests/smoke/f201-probe-honesty.test.tsx src/tests/smoke/r1-server-readiness.test.ts --reporter=dot
npx --yes pnpm@9.15.9 test:smoke
VITE_BUILD_SHA="candidate-${APP_SHA:0:12}-40051974454-1" npx --yes pnpm@9.15.9 build
sha256sum ui/dist/index.html
wc -c ui/dist/index.html
printf 'PASS: clean archive, baseline failure, ordered patches (2), regressions, full smoke suite, production build.\n'
printf 'NOT_RUN here: real Windows production backend, interactive client controls, native RDP, Web Desktop, upstream deployment.\n'
printf 'Those are exercised by real-backend.yml on the client VM; see README-si.md and manifest.json.\n'
