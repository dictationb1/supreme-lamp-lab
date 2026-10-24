#!/usr/bin/env bash
# Rebuild/test the isolated F201 UI candidate from the exact pinned app archive.
# This does NOT stage a Windows server, attach to the live origin, or claim RDP/Web Desktop proof.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_SHA=e432d3df4cf00a8528d574f8410f6a76e590db31
APP_ZIP_SHA=811a5154f16208877405b18becd31b4a24cd949dfafcd30b35ae2f9908124ea5
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mc-f201-replay.XXXXXX")"
KEEP_WORK="${KEEP_WORK:-0}"
cleanup() { if [[ "$KEEP_WORK" != 1 ]]; then rm -rf "$WORK"; else printf 'Replay tree retained at %s\n' "$WORK"; fi; }
trap cleanup EXIT
mkdir -p "$WORK"

curl -fsSL "https://codeload.github.com/dictationb1/supreme-lamp/zip/${APP_SHA}" -o "$WORK/app.zip"
printf '%s  %s\n' "$APP_ZIP_SHA" "$WORK/app.zip" | sha256sum -c -
unzip -q "$WORK/app.zip" -d "$WORK"
APP_DIR="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d -name 'supreme-lamp-*' -print -quit)"
[[ -n "$APP_DIR" && -f "$APP_DIR/package.json" ]]

cd "$APP_DIR"
git init -q
npx --yes pnpm@9.15.9 install --frozen-lockfile

# Demonstrate the baseline defect, then require the same fixture to reject the
# obsolete misleading copy after the patch. The fixture is never left in the app tree.
mkdir -p src/tests/smoke
cp "$HERE/evidence/repro-f201.test.tsx" src/tests/smoke/repro-f201.test.tsx
npx --yes pnpm@9.15.9 exec vitest run src/tests/smoke/repro-f201.test.tsx --reporter=dot
rm src/tests/smoke/repro-f201.test.tsx

git -c core.autocrlf=false -c core.eol=lf apply --check "$HERE/app-patches/0001-F201-probe-honesty.patch"
git -c core.autocrlf=false -c core.eol=lf apply "$HERE/app-patches/0001-F201-probe-honesty.patch"
cp "$HERE/evidence/repro-f201.test.tsx" src/tests/smoke/repro-f201.test.tsx
if npx --yes pnpm@9.15.9 exec vitest run src/tests/smoke/repro-f201.test.tsx --reporter=dot > "$WORK/obsolete-assertion.log" 2>&1; then
  echo 'ERROR: obsolete baseline assertion still passed after the repair.' >&2
  exit 1
fi
if ! grep -q 'FQDN' "$WORK/obsolete-assertion.log" || ! grep -q 'pair failed validation' "$WORK/obsolete-assertion.log"; then
  echo 'ERROR: patched baseline fixture failed for an unexpected reason; inspect obsolete-assertion.log.' >&2
  cat "$WORK/obsolete-assertion.log" >&2
  exit 1
fi
rm src/tests/smoke/repro-f201.test.tsx

echo '=== F201 regression suite ==='
npx --yes pnpm@9.15.9 exec vitest run src/tests/smoke/f201-probe-honesty.test.tsx --reporter=dot
echo '=== Full application smoke suite ==='
npx --yes pnpm@9.15.9 test:smoke
echo '=== Production single-file build ==='
VITE_BUILD_SHA="candidate-${APP_SHA:0:12}-f201" npx --yes pnpm@9.15.9 build
sha256sum ui/dist/index.html
wc -c ui/dist/index.html

echo 'PASS: isolated pinned-source patch, regression, full smoke suite, and production build.'
echo 'BLOCKED: no Windows server, live origin, authenticated backend, native RDP, or Web Desktop proof was produced.'
