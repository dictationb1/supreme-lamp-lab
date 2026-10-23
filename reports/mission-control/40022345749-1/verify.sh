#!/usr/bin/env bash
# Verify the bundle without executing any application code.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
echo "== checksums =="
sha256sum -c SHA256SUMS
echo "== series consistency =="
while read -r patch sha; do
  case "$patch" in \#*|"") continue;; esac
  actual=$(sha256sum "$patch" | cut -d' ' -f1)
  [ "$actual" = "$sha" ] || { echo "MISMATCH $patch"; exit 1; }
  echo "ok $patch"
done < series.txt
echo "== required bundle files =="
for f in README-si.md manifest.json control-coverage.csv data-lineage.csv series.txt MAIN-REPOSITORY-HANDOFF.md; do
  [ -s "$f" ] || { echo "MISSING $f"; exit 1; }
done
echo "bundle verified"
