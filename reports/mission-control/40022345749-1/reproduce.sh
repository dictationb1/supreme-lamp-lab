#!/usr/bin/env bash
# Rebuild the patched application tree from the pinned base, offline-safe.
# usage: bash reproduce.sh [outdir]
set -euo pipefail
BASE=e432d3df4cf00a8528d574f8410f6a76e590db31
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HERE/out}"
mkdir -p "$OUT"
echo "[1/4] downloading application base $BASE"
curl -fsSL -o "$OUT/app.zip" "https://codeload.github.com/dictationb1/supreme-lamp/zip/$BASE"
echo "[2/4] sha256 of the archive: $(sha256sum "$OUT/app.zip" | cut -d' ' -f1)"
unzip -q -o "$OUT/app.zip" -d "$OUT"
APP="$OUT/supreme-lamp-$BASE"
echo "[3/4] applying the patch series"
while read -r patch sha; do
  case "$patch" in \#*|"") continue;; esac
  echo "  - $patch"
  echo "$sha  $HERE/$patch" | sha256sum -c -
  ( cd "$APP" && git apply --whitespace=nowarn "$HERE/$patch" )
done < "$HERE/series.txt"
echo "[4/4] patched tree at $APP"
echo "  next: cd $APP && npm ci && npx vitest run"
