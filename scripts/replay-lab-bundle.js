#!/usr/bin/env node
'use strict';
/*
 * Replay acceptance from a FRESH DOWNLOAD of the committed bundle.
 *
 * Re-derives every identity from the committed repo (no reliance on prior
 * local state): fetches config/app-source.json's pinned SHA from the
 * application repository, confirms the expected repairs are present in source
 * at that commit, re-verifies the UI build sha/bytes against the committed
 * evidence, and re-runs the lab regression summary. Exits nonzero if any
 * recorded identity diverges — this is how a later session proves the bundle
 * is still reproducible.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const LAB_ROOT = path.resolve(__dirname, '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(LAB_ROOT, 'config', 'app-source.json'), 'utf8'));
const EXPECTED_SHA = CONFIG.sha;
const EVIDENCE_DIR = path.join(LAB_ROOT, 'docs', 'reports', '2026-10-25-ui-launch-search-repair', 'evidence');
const EXPECTED_UI_SHA = '9315cdc8fe7d4f3cf3fa5f81e84811ed98e01c1aec79f1c7f57cb7af56b123ff';
const EXPECTED_UI_BYTES = 1312534;

function sha256File(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

async function main() {
  const tmp = path.join(require('os').tmpdir(), `slab-replay-${EXPECTED_SHA.slice(0, 12)}`);
  spawnSync('rm', ['-rf', tmp]);
  const clone = spawnSync('git', ['clone', '--no-checkout', '-q', `https://github.com/${CONFIG.repository}.git`, tmp], { encoding: 'utf8' });
  if (clone.status !== 0) throw new Error(`clone failed: ${clone.stderr}`);
  const rev = spawnSync('git', ['-C', tmp, 'rev-parse', 'FETCH_HEAD'], { encoding: 'utf8' }).stdout.trim();
  spawnSync('git', ['-C', tmp, 'checkout', '--detach', '-q', rev]);
  check('application source resolves to pinned SHA', rev === EXPECTED_SHA, `${rev} vs ${EXPECTED_SHA}`);

  // Repair detection: every merged repair must still be present in source.
  const repairs = [
    ['src/lib/domain/dispatch.ts', 'LaunchDispatcher'],
    ['src/lib/domain/native.ts', 'recoveryDecision'],
    ['src/lib/api.ts', 'dispatchProtocolOnce'],
    ['src/stores/sessionStore.ts', 'getDispatcher'],
    ['src/lib/repoIdentity.ts', 'dictationb1/supreme-lamp'],
    ['payloads/ghrdp-server.ps1', '$ltM = [regex]::Match'],
  ];
  for (const [file, marker] of repairs) {
    const present = fs.existsSync(path.join(tmp, file)) && fs.readFileSync(path.join(tmp, file), 'utf8').includes(marker);
    check(`repair present: ${file} (${marker})`, present);
  }

  // UI build replay: rebuild from the downloaded source and compare to committed evidence.
  spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
  const build = spawnSync('npm', ['run', 'build'], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  const built = path.join(tmp, 'ui', 'dist', 'index.html');
  if (build.status === 0 && fs.existsSync(built)) {
    const sha = sha256File(built); const bytes = fs.statSync(built).size;
    check('rebuilt UI sha matches committed evidence', sha === EXPECTED_UI_SHA, `${sha} / ${bytes} bytes`);
  } else {
    check('rebuilt UI sha matches committed evidence', false, `build exit ${build.status}`);
  }

  // Lab regression summary (Linux-executable subset).
  const reg = spawnSync('node', ['scripts/run-regressions.js'], { cwd: LAB_ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  const regOk = reg.stdout.includes('162 passed') && reg.stdout.includes('0 failed');
  check('lab regressions replay', regOk, reg.stdout.slice(-200));

  console.log(failures === 0 ? '\nREPLAY: ALL IDENTITIES MATCH — bundle is reproducible' : `\nREPLAY: ${failures} MISMATCH(ES)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e.message); process.exit(1); });
