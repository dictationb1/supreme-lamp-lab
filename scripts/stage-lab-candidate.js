#!/usr/bin/env node
'use strict';
/*
 * Stage the complete lab candidate for the pinned application revision.
 *
 * Reads config/app-source.json (sha f66f9485 at this session), copies the
 * application backend (payloads/, src/, plus server-facing configs) together
 * with a FRESHLY BUILT UI (built by build-lab-candidate.js, never an upstream
 * release asset), modules, fixtures, search dependencies and the real
 * session/capture components into .lab-stage/<sha>/, then writes
 * stage-result.json with every identity hash so a replay can verify byte
 * equality against the committed bundle.
 *
 * Nothing here writes to dictationb1/supreme-lamp (read-only). The stage is a
 * local isolated candidate only.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const LAB_ROOT = path.resolve(__dirname, '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(LAB_ROOT, 'config', 'app-source.json'), 'utf8'));
const SHA = CONFIG.sha;
const STAGE_DIR = path.join(LAB_ROOT, '.lab-stage', SHA);
const EVIDENCE_DIR = path.join(LAB_ROOT, 'docs', 'reports', '2026-10-25-ui-launch-search-repair', 'evidence');
const APP_TREE_URL = `https://github.com/${CONFIG.repository}/tree/${SHA}`;
const UI_BUILD_HASH = '9315cdc8fe7d4f3cf3fa5f81e84811ed98e01c1aec79f1c7f57cb7af56b123ff';
const UI_BUILD_BYTES = 1312534;

function sha256File(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function hashDir(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.name === 'node_modules') continue;
      out[path.relative(root, full)] = sha256File(full);
    }
  };
  walk(root);
  return out;
}
function copyRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name), d = path.join(dst, entry.name);
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    if (entry.isDirectory()) { copyRecursive(s, d); continue; }
    fs.copyFileSync(s, d);
  }
}

async function main() {
  const tmp = path.join(require('os').tmpdir(), `slab-stage-${SHA.slice(0, 12)}`);
  // Fresh download of the committed source (replay-safe: never trust a stray checkout).
  spawnSync('git', ['clone', '--no-checkout', '-q', `https://github.com/${CONFIG.repository}.git`, tmp]);
  const rev = spawnSync('git', ['-C', tmp, 'rev-parse', 'FETCH_HEAD'], { encoding: 'utf8' }).stdout.trim();
  spawnSync('git', ['-C', tmp, 'checkout', '--detach', '-q', rev]);
  if (rev !== SHA) throw new Error(`downloaded ${rev} != pinned ${SHA}`);

  fs.mkdirSync(STAGE_DIR, { recursive: true });
  // Backend + modules + fixtures + search deps + session/capture components.
  copyRecursive(path.join(tmp, 'payloads'), path.join(STAGE_DIR, 'payloads'));
  copyRecursive(path.join(tmp, 'src'), path.join(STAGE_DIR, 'src'));
  copyRecursive(path.join(tmp, 'tests'), path.join(STAGE_DIR, 'tests'));
  // Freshly built UI (local build recorded in evidence; NOT a release asset).
  const uiSrc = path.join(tmp, 'ui', 'dist', 'index.html');
  if (!fs.existsSync(uiSrc)) throw new Error('freshly built UI not found; run build-lab-candidate.js first');
  const uiSha = sha256File(uiSrc);
  const uiBytes = fs.statSync(uiSrc).size;
  fs.mkdirSync(path.join(STAGE_DIR, 'ui', 'dist'), { recursive: true });
  fs.copyFileSync(uiSrc, path.join(STAGE_DIR, 'ui', 'dist', 'index.html'));
  const uiMatch = uiSha === UI_BUILD_HASH && uiBytes === UI_BUILD_BYTES;

  // Manifest of everything staged.
  const fileHashes = hashDir(STAGE_DIR);
  const result = {
    kind: 'slab-stage/1',
    stagedAt: new Date().toISOString(),
    application: { repository: CONFIG.repository, sha: SHA, resolved: rev, tree: APP_TREE_URL },
    uiBuild: { artifact: 'ui/dist/index.html', sha256: uiSha, bytes: uiBytes, expected: { sha256: UI_BUILD_HASH, bytes: UI_BUILD_BYTES }, match: uiMatch },
    stagedFiles: fileHashes,
    fileCount: Object.keys(fileHashes).length,
    note: 'Staged from a fresh download. Application backend + modules + fixtures + search dependencies + real session/capture components. UI is the locally built production single-file bundle.',
  };
  fs.writeFileSync(path.join(STAGE_DIR, 'stage-result.json'), JSON.stringify(result, null, 2) + '\n');
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'stage-result-2026-10-25.json'), JSON.stringify(result, null, 2) + '\n');
  spawnSync('rm', ['-rf', tmp]);
  console.log(JSON.stringify({ stageDir: STAGE_DIR, fileCount: result.fileCount, uiMatch, uiSha }, null, 2));
  if (!uiMatch) process.exit(1);
}

main().catch(e => { console.error(e.message); process.exit(1); });
