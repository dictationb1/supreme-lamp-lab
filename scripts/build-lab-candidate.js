#!/usr/bin/env node
'use strict';
/*
 * Build the Mission Control lab candidate from the application source.
 *
 * Reads the pinned application SHA from config/app-source.json (overridable
 * with SOURCE_SHA), downloads the source read-only (git clone; no push to the
 * application repository is ever attempted), installs dependencies, runs the
 * TypeScript check and the vitest suite, builds the single-file production UI,
 * and records sha256 + bytes into docs/reports/.../evidence/.
 *
 * Usage: SOURCE_SHA=<40-hex> node scripts/build-lab-candidate.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const LAB_ROOT = path.resolve(__dirname, '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(LAB_ROOT, 'config', 'app-source.json'), 'utf8'));
const REQUESTED_SHA = (process.env.SOURCE_SHA || '').trim() || CONFIG.sha;
const REPO = CONFIG.repository;
const APP_WORK = path.join(require('os').tmpdir(), `slab-candidate-build-${REQUESTED_SHA.slice(0, 12)}`);
const EVIDENCE_DIR = path.join(LAB_ROOT, 'docs', 'reports', '2026-10-25-ui-launch-search-repair', 'evidence');

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}\nstdout:${r.stdout}\nstderr:${r.stderr}`);
  }
  return r;
}

function sha256File(file) {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

async function main() {
  if (!/^[0-9a-f]{40}$/.test(REQUESTED_SHA)) throw new Error(`SOURCE_SHA invalid: ${REQUESTED_SHA}`);
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

  // 1. Download the application source read-only at the exact immutable SHA.
  //    Public read via git clone; we never push to dictationb1/supreme-lamp.
  if (!fs.existsSync(path.join(APP_WORK, '.git'))) {
    sh('rm', ['-rf', APP_WORK]);
    sh('git', ['clone', '--no-checkout', `-q`, `https://github.com/${REPO}.git`, APP_WORK]);
  }
  sh('git', ['-C', APP_WORK, 'fetch', '--no-tags', 'origin', REQUESTED_SHA]);
  const r = sh('git', ['-C', APP_WORK, 'rev-parse', 'FETCH_HEAD'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const resolved = r.stdout.trim();
  if (resolved !== REQUESTED_SHA) throw new Error(`SHA mismatch: requested ${REQUESTED_SHA} resolved ${resolved}`);
  sh('git', ['-C', APP_WORK, 'checkout', '--detach', '-q', resolved]); // intentional: exact commit
  sh('git', ['-C', APP_WORK, 'status', '--porcelain']); // must be clean: any output is an error condition
  const dirty = sh('git', ['-C', APP_WORK, 'status', '--porcelain'], { allowFail: true }).stdout.trim();
  if (dirty) throw new Error(`application checkout at ${REQUESTED_SHA} is dirty`);

  // 2. Install dependencies and run gates.
  process.chdir(APP_WORK);
  sh('npm', ['install', '--no-audit', '--no-fund']);
  sh('npx', ['tsc', '--noEmit', '-p', 'tsconfig.build.json']);
  const vt = sh('npx', ['vitest', 'run']);
  const vitestTail = vt.stdout.split('\n').slice(-12).join('\n');
  const vitestOk = vt.stdout.includes('Test Files') && vt.stdout.includes('passed') && !vt.stdout.includes('failed (');

  // 3. Build the single-file production UI.
  sh('npm', ['run', 'build']);
  const indexHtml = path.join(APP_WORK, 'ui', 'dist', 'index.html');
  if (!fs.existsSync(indexHtml)) throw new Error('ui/dist/index.html not produced');
  const sha256 = sha256File(indexHtml);
  const bytes = fs.statSync(indexHtml).size;

  // 4. Record evidence.
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'ui-build-sha256.txt'), [
    `sha256  ${sha256}  ui/dist/index.html`,
    `bytes   ${bytes}`,
    `builtAt ${new Date().toISOString()}`,
    `command npm run build`,
    `fromCommit ${REQUESTED_SHA}`,
    `repo ${REPO}`,
    `matchesHandoffArtifact ${sha256 === '9315cdc8fe7d4f3cf3fa5f81e84811ed98e01c1aec79f1c7f57cb7af56b123ff'}`,
  ].join('\n') + '\n');

  const result = {
    repository: REPO,
    sha: REQUESTED_SHA,
    resolved,
    uiBuild: { artifact: 'ui/dist/index.html', sha256, bytes, command: 'npm run build' },
    gates: { tsc: 'pass', vitest: vitestOk ? 'pass' : 'fail', vitestTail },
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'build-candidate-result.json'), JSON.stringify(result, null, 2) + '\n');
  process.chdir(LAB_ROOT);
  console.log(JSON.stringify(result, null, 2));
  if (!vitestOk) process.exit(1);
}

main().catch(e => { console.error(e.message); process.exit(1); });
