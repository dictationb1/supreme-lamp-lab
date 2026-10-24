#!/usr/bin/env bash
# Verify this bundle WITHOUT trusting the working tree: check the recorded
# artifact digests, re-download the pinned application base, and confirm every
# patch in series.txt applies cleanly at the application root. Optionally run
# the full clean replay (REPLAY=1). Safe to run from a fresh download.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

echo "== 1. artifact checksums =="
sha256sum -c SHA256SUMS

echo "== 2. manifest + series JSON sanity =="
python3 -c "import json;json.load(open('manifest.json'));print('manifest.json valid')"
grep -q 'app-patches/0001-F201-probe-honesty.patch' series.txt
grep -q 'app-patches/0002-R1-server-startup-readiness.patch' series.txt
echo "series.txt lists both ordered patches"

APP_SHA=4a91c5c2eadc12e5b071bc46bae7683087f56fbd
APP_ZIP_SHA=dadee74430ca5ee1645d3631f033f17d7d04ae4a8bebadafd39c07c2c44aa378
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mc-verify.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "== 3. pinned application base =="
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
  git -C "$APP_DIR" -c core.autocrlf=false -c core.eol=lf apply "$HERE/$relative"
  echo "applied: $relative"
done
echo "all patches applied cleanly at the application root"

if [[ "${REPLAY:-0}" == 1 ]]; then
  echo "== 5. full clean replay (baseline fail -> candidate pass -> build) =="
  bash replay-candidate.sh
fi
echo "PASS: bundle checksums + pinned base + ordered patches verified."
