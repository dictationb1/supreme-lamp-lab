#!/usr/bin/env bash
# Clean-clone replay of the FULL patched candidate. Downloads the pinned
# application revision into an isolated workspace, applies the ordered patch
# series, runs the three smoke tests and builds the production single-file UI.
# It never touches the application remote and never uses the live origin's
# credentials. Mirrors what .github/workflows/real-backend.yml does on Windows,
# minus the interactive browser/VM phases (those need the self-hosted client).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_SHA=832a82eb7c29613b0b101585c56b5011ea008a06
APP_ZIP_SHA=c0de6455046c896d8cd61e8671d566a29c2aaa4aa946fd4cd4c791d1ca2d2393
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mc-candidate.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "== download pinned application $APP_SHA =="
curl -fsSL "https://codeload.github.com/dictationb1/supreme-lamp/zip/${APP_SHA}" -o "$WORK/app.zip"
printf '%s  %s\n' "$APP_ZIP_SHA" "$WORK/app.zip" | sha256sum -c -
unzip -q "$WORK/app.zip" -d "$WORK"
APP_DIR="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d -name 'supreme-lamp-*' -print -quit)"
cd "$APP_DIR"
git init -q && git add -A && git -c user.email=lab@local -c user.name=lab commit -q -m base

echo "== apply ordered patch series =="
mapfile -t PATCHES < <(sed -e 's/^[[:space:]]*//' -e '/^#/d' -e '/^$/d' "$HERE/series.txt")
for relative in "${PATCHES[@]}"; do
  git -c core.autocrlf=false -c core.eol=lf apply --whitespace=nowarn "$HERE/$relative"
  echo "applied: $relative"
done

echo "== install + smoke tests (F201, R1, R2) =="
npx --yes pnpm@9.15.9 install --frozen-lockfile
npx vitest run src/tests/smoke/f201-probe-honesty.test.tsx \
  src/tests/smoke/r1-server-readiness.test.ts \
  src/tests/smoke/r2-websocket-worker.test.ts --reporter=dot

echo "== full smoke suite + production build =="
npx vitest run --reporter=dot
VITE_BUILD_SHA=cand-replay npx pnpm run build
echo "CANDIDATE REPLAY OK: $APP_DIR/ui/dist/index.html"
