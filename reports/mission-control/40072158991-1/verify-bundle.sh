#!/usr/bin/env bash
# Verify this bundle WITHOUT trusting the working tree: check the recorded
# artifact digests, re-download the pinned application base, and confirm every
# patch in series.txt applies cleanly at the application root. Optionally run
# the full clean replay (REPLAY=1) which also builds the frontend. Safe to run
# from a fresh download of the lab repository (or just this bundle folder).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

echo "== 1. artifact checksums =="
sha256sum -c SHA256SUMS

echo "== 2. manifest + series sanity =="
python3 -c "import json;json.load(open('manifest.json'));print('manifest.json valid')"
grep -q 'app-patches/0001-F201-probe-honesty.patch' series.txt
grep -q 'app-patches/0002-R1-server-startup-readiness.patch' series.txt
grep -q 'app-patches/0003-R2-websocket-worker-runspace.patch' series.txt
echo "series.txt lists the three ordered patches"

APP_SHA=832a82eb7c29613b0b101585c56b5011ea008a06
APP_ZIP_SHA=c0de6455046c896d8cd61e8671d566a29c2aaa4aa946fd4cd4c791d1ca2d2393
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mc-verify.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "== 3. pinned application base ($APP_SHA) =="
curl -fsSL "https://codeload.github.com/dictationb1/supreme-lamp/zip/${APP_SHA}" -o "$WORK/app.zip"
printf '%s  %s\n' "$APP_ZIP_SHA" "$WORK/app.zip" | sha256sum -c -
( command -v unzip >/dev/null && unzip -q "$WORK/app.zip" -d "$WORK" ) || \
  python3 -c "import zipfile,sys;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$WORK/app.zip" "$WORK"
APP_DIR="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d -name 'supreme-lamp-*' -print -quit)"
[[ -n "$APP_DIR" ]]

echo "== 4. ordered patch applicability (at application root) =="
mapfile -t PATCHES < <(sed -e 's/^[[:space:]]*//' -e '/^#/d' -e '/^$/d' series.txt)
for relative in "${PATCHES[@]}"; do
  git -C "$APP_DIR" -c core.autocrlf=false -c core.eol=lf apply --check "$HERE/$relative"
  git -C "$APP_DIR" -c core.autocrlf=false -c core.eol=lf apply --whitespace=nowarn "$HERE/$relative"
  echo "applied: $relative"
done
echo "all patches applied cleanly at the application root"

echo "== 5. R2 structural smoke (no PowerShell needed) =="
grep -q 'Invoke-R2DispatchWebSocket' "$APP_DIR/payloads/ghrdp-server.ps1"
grep -q 'CreateRunspacePool' "$APP_DIR/payloads/ghrdp-server.ps1"
grep -q 'SemaphoreSlim' "$APP_DIR/payloads/ghrdp-server.ps1"
test -f "$APP_DIR/src/tests/smoke/r2-websocket-worker.test.ts"
echo "R2 runspace repair and its static regression are present"

if [[ "${REPLAY:-0}" == "1" ]]; then
  echo "== 6. optional full replay (pnpm install + smoke tests + build) =="
  ( cd "$APP_DIR" \
    && npx --yes pnpm@9.15.9 install --frozen-lockfile \
    && npx vitest run src/tests/smoke/f201-probe-honesty.test.tsx \
         src/tests/smoke/r1-server-readiness.test.ts \
         src/tests/smoke/r2-websocket-worker.test.ts --reporter=dot \
    && VITE_BUILD_SHA=cand-replay npx pnpm run build )
  echo "full replay OK; bundle at $APP_DIR/ui/dist/index.html"
fi
echo "VERIFY OK"
