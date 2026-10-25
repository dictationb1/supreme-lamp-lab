#!/usr/bin/env node
'use strict';
/*
 * Postflight cleanup of staged lab candidate artifacts.
 *
 * Removes .lab-stage/<sha> contents produced by stage-lab-candidate.js and
 * any temp checkouts left under the OS temp dir by build/replay scripts.
 * Evidence under docs/reports/.../evidence/ is intentionally preserved (it is
 * the committed record). The committed bundle itself is never modified here.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LAB_ROOT = path.resolve(__dirname, '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(LAB_ROOT, 'config', 'app-source.json'), 'utf8'));
const STAGE_ROOT = path.join(LAB_ROOT, '.lab-stage');
const TMP_PREFIX = path.join(require('os').tmpdir(), 'slab-');

function removeTree(dir) {
  if (!fs.existsSync(dir)) return { removed: false, reason: 'absent' };
  fs.rmSync(dir, { recursive: true, force: true });
  return { removed: true };
}

async function main() {
  const report = { staged: [], temp: [] };
  if (fs.existsSync(STAGE_ROOT)) {
    for (const entry of fs.readdirSync(STAGE_ROOT)) {
      const full = path.join(STAGE_ROOT, entry);
      report.staged.push({ path: full, ...removeTree(full) });
    }
  }
  const tmpDir = require('os').tmpdir();
  for (const entry of fs.readdirSync(tmpDir)) {
    if (entry.startsWith('slab-')) {
      report.temp.push({ path: path.join(tmpDir, entry), ...removeTree(path.join(tmpDir, entry)) });
    }
  }
  console.log(JSON.stringify({ cleanedAt: new Date().toISOString(), ...report }, null, 2));
}

main().catch(e => { console.error(e.message); process.exit(1); });
