#!/usr/bin/env node
'use strict';
// Regression suite for the lab's verification machinery. Every test that
// involves a server uses an OUT-OF-PROCESS fixture (scripts/test/fixtures/
// fake-backend.js) and async child processes - nothing blocks the event loop,
// so a same-process server can never produce a fake pass.
//
//   node scripts/run-regressions.js            # all tests
//   REQUIRE_BROWSER_TESTS=1 ...                # browser e2e must run (CI)
//   ONLY=<substring> ...                       # filter

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const zlib = require('zlib');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const S = p => path.join(ROOT, 'scripts', p);
const FAKE = S('test/fixtures/fake-backend.js');
const SHA = '978a8375ee77b392ce11694ccee7722fd6ca4f71';
const IS_WIN = process.platform === 'win32';

const { STATUS, aggregate, CapabilitySet } = require('./lib/status');
const { evaluateReadiness, evaluateVersion, waitForReady, checkVersion } = require('./lib/readiness');
const { request, formatErrorChain } = require('./lib/http');
const { validatePngBuffer, validateJpegBuffer } = require('./lib/image');
const { redact } = require('./lib/redact');
const proc = require('./lib/proc');

const results = [];
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slab-reg-'));
let counter = 0;
function freshDirs() {
  const d = path.join(tmpRoot, `t${++counter}`);
  const dirs = { state: path.join(d, 'state'), art: path.join(d, 'art'), out: path.join(d, 'gh-output.txt') };
  fs.mkdirSync(dirs.state, { recursive: true }); fs.mkdirSync(dirs.art, { recursive: true });
  return dirs;
}
function childEnv(dirs, extra = {}) {
  const env = { ...process.env, LAB_STATE_DIR: dirs.state, ARTIFACT_DIR: dirs.art, GITHUB_OUTPUT: dirs.out, GITHUB_RUN_ID: 'reg-run', GITHUB_RUN_ATTEMPT: '1', ...extra };
  delete env.GITHUB_STEP_SUMMARY;
  delete env.REGISTRY_PATH;
  return env;
}
function readOutputs(file) {
  const o = {};
  if (!fs.existsSync(file)) return o;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) { const i = line.indexOf('='); if (i > 0) o[line.slice(0, i)] = line.slice(i + 1); }
  return o;
}

function run(cmd, args, { env, timeoutMs = 60000 } = {}) {
  return new Promise(resolve => {
    const c = spawn(cmd, args, { env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { err += d; });
    const t = setTimeout(() => { c.kill('SIGKILL'); }, timeoutMs);
    c.on('exit', code => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

function startFake(mode, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [FAKE], { env: { ...process.env, MODE: mode, PORT: '0', EXPECT_SHA: SHA, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const t = setTimeout(() => reject(new Error(`fake ${mode} did not start`)), 10000);
    c.stdout.on('data', d => {
      buf += d;
      const m = buf.match(/FAKE_LISTENING port=(\d+) pid=(\d+)/);
      if (m) { clearTimeout(t); resolve({ child: c, port: Number(m[1]), pid: Number(m[2]), url: `http://127.0.0.1:${m[1]}` }); }
    });
    c.on('exit', code => { clearTimeout(t); reject(Object.assign(new Error(`fake ${mode} exited ${code}`), { exitCode: code })); });
  });
}
function stopFake(f) { if (f && f.child && f.child.exitCode === null) f.child.kill('SIGKILL'); }

function freePort() {
  return new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

async function test(name, fn, { skipIf } = {}) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
  if (skipIf) {
    const why = skipIf();
    if (why) { results.push({ name, status: 'SKIPPED', detail: why }); console.log(`SKIP  ${name} (${why})`); return; }
  }
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, status: 'PASS', ms: Date.now() - t0 });
    console.log(`PASS  ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    results.push({ name, status: 'FAIL', ms: Date.now() - t0, detail: e.stack || String(e) });
    console.log(`FAIL  ${name}\n      ${String(e.stack || e).split('\n').slice(0, 6).join('\n      ')}`);
  }
}

// ---------- helpers for image fixtures ----------
function crc32(buf) {
  let c; const table = [];
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makePng(w, h, uniform = false) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = uniform ? 7 : x % 256; raw[o + 1] = uniform ? 7 : y % 256; raw[o + 2] = uniform ? 7 : (x * y) % 256; }
  if (uniform) for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 7;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function makeJpeg(w, h, withEoi = true) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x01, 0x02]), Buffer.alloc(256)]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(64, 0x11), withEoi ? Buffer.from([0xff, 0xd9]) : Buffer.alloc(0)]);
}

// ---------- spawn a long-lived dummy process (for cleanup tests) ----------
function spawnSleeper({ withGrandchild = false } = {}) {
  const code = withGrandchild
    ? "const {spawn}=require('child_process');const g=spawn(process.execPath,['-e','setTimeout(()=>{},120000)'],{stdio:'ignore'});console.log('GC '+g.pid);setTimeout(()=>{},120000)"
    : "console.log('READY');setTimeout(()=>{},120000)";
  return new Promise(resolve => {
    const c = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'] });
    c.stdout.once('data', d => { const m = String(d).match(/GC (\d+)/); resolve({ child: c, pid: c.pid, grandchild: m ? Number(m[1]) : null }); });
  });
}
const alive = pid => proc.isAlive(pid) && Boolean(proc.getProcess(pid));

async function main() {
  console.log(`regressions on ${process.platform} node ${process.version}; tmp ${tmpRoot}`);

  // ===== status aggregation =====
  await test('status: only all-required-PASS is accepted', async () => {
    const P = { status: 'PASS', required: true };
    assert.strictEqual(aggregate({ a: P, b: P }).accepted, true);
    assert.strictEqual(aggregate({ a: P, b: { status: 'NOT_RUN', required: true } }).status, 'NOT_RUN');
    assert.strictEqual(aggregate({ a: P, b: { status: 'SIMULATED', required: true } }).accepted, false);
    assert.strictEqual(aggregate({ a: P, b: { status: 'SKIPPED', required: true } }).accepted, false);
    assert.strictEqual(aggregate({}).accepted, false, 'empty set must not be accepted');
    assert.strictEqual(aggregate({ a: { status: 'BLOCKED', required: true }, b: { status: 'FAIL', required: true } }).status, 'FAIL');
    assert.strictEqual(aggregate({ a: { status: 'BLOCKED', required: true, reason: 'x' }, b: { status: 'FAIL', required: true } }).firstCause.capability, 'a');
    assert.throws(() => aggregate({ a: { status: 'GREEN', required: true } }), /INVALID_STATUS/);
  });
  await test('status: a FAIL is never overwritten by a later PASS', async () => {
    const cs = new CapabilitySet({ x: { required: true } });
    cs.set('x', STATUS.FAIL, 'first cause');
    cs.set('x', STATUS.PASS, 'late pass');
    assert.strictEqual(cs.get('x').status, 'FAIL');
    assert.strictEqual(cs.get('x').reason, 'first cause');
  });

  // ===== readiness contract (pure) =====
  await test('readiness: strict contract table', async () => {
    const good = { ok: true, status: 'ok', phase: 'ready', apiReadiness: true, pid: 42, port: 7331 };
    assert.strictEqual(evaluateReadiness(good, { expectPid: 42, expectPort: 7331 }).ready, true);
    assert.strictEqual(evaluateReadiness({ ...good, ok: false, status: 'initializing', apiReadiness: false, phase: 'payloads' }).code, 'READINESS_NOT_READY');
    assert.strictEqual(evaluateReadiness({ ...good, ok: false, status: 'initializing', apiReadiness: false, phase: 'ready' }).code, 'READINESS_NOT_READY', 'real server init state (phase may read ready)');
    assert.strictEqual(evaluateReadiness({ ...good, status: 'initializing' }).code, 'READINESS_CONTRADICTORY');
    assert.strictEqual(evaluateReadiness({ ...good, apiReadiness: false }).code, 'READINESS_CONTRADICTORY');
    assert.strictEqual(evaluateReadiness({ ok: true, status: 'ok' }).code, 'READINESS_SCHEMA_INVALID');
    assert.strictEqual(evaluateReadiness({ ...good, ok: 'true' }).code, 'READINESS_SCHEMA_INVALID');
    assert.strictEqual(evaluateReadiness({ ...good, pid: '42' }).code, 'READINESS_SCHEMA_INVALID');
    assert.strictEqual(evaluateReadiness([]).code, 'READINESS_SCHEMA_INVALID');
    assert.strictEqual(evaluateReadiness(good, { expectPid: 43 }).code, 'READINESS_WRONG_PROCESS');
    assert.strictEqual(evaluateReadiness(good, { expectPort: 8080 }).code, 'READINESS_WRONG_PORT');
  });
  await test('version: exact sha, no dev/unknown fallback', async () => {
    assert.strictEqual(evaluateVersion({ ok: true, server: 'ghrdp', sha: SHA, sha7: SHA.slice(0, 7) }, SHA).ok, true);
    assert.strictEqual(evaluateVersion({ ok: true, server: 'ghrdp', sha: 'dev', sha7: 'dev' }, SHA).code, 'VERSION_SHA_INVALID');
    assert.strictEqual(evaluateVersion({ ok: true, server: 'ghrdp', sha: 'b'.repeat(40) }, SHA).code, 'VERSION_SHA_MISMATCH');
    assert.strictEqual(evaluateVersion({ ok: true, server: 'other', sha: SHA }, SHA).code, 'VERSION_IDENTITY_MISMATCH');
    assert.strictEqual(evaluateVersion({ ok: true, server: 'ghrdp', sha: SHA, sha7: 'abcdefg' }, SHA).code, 'VERSION_CONTRADICTORY');
  });

  // ===== readiness against out-of-process fixtures =====
  const readinessCases = [
    ['ok', { ready: true, code: 'READY' }],
    ['slow-ready', { ready: true, code: 'READY' }],
    ['initializing', { ready: false, code: 'READINESS_NOT_READY' }],
    ['contradictory', { ready: false, code: 'READINESS_CONTRADICTORY' }],
    ['missing-fields', { ready: false, code: 'READINESS_SCHEMA_INVALID' }],
    ['string-booleans', { ready: false, code: 'READINESS_SCHEMA_INVALID' }],
    ['http-500', { ready: false, code: 'READINESS_HTTP_ERROR' }],
    ['invalid-json', { ready: false, code: 'READINESS_SCHEMA_INVALID' }]
  ];
  for (const [mode, want] of readinessCases) {
    await test(`fixture readiness: ${mode}`, async () => {
      const f = await startFake(mode);
      try {
        const r = await waitForReady(f.url, { timeoutMs: 5000, intervalMs: 300, expectPid: f.pid });
        assert.strictEqual(r.ready, want.ready, JSON.stringify(r.history));
        assert.strictEqual(r.code, want.code, JSON.stringify(r.history));
      } finally { stopFake(f); }
    });
  }
  await test('fixture readiness: wrong-listener (pid of another process) is terminal', async () => {
    const f = await startFake('wrong-listener');
    try {
      const r = await waitForReady(f.url, { timeoutMs: 5000, intervalMs: 300, expectPid: f.pid });
      assert.strictEqual(r.code, 'READINESS_WRONG_PROCESS');
    } finally { stopFake(f); }
  });
  await test('fixture readiness: crash-after-ready becomes unreachable with full cause chain', async () => {
    const f = await startFake('crash-after-ready');
    const r1 = await waitForReady(f.url, { timeoutMs: 3000, intervalMs: 200 });
    assert.strictEqual(r1.ready, true);
    await new Promise(r => f.child.once('exit', r));
    const r2 = await waitForReady(f.url, { timeoutMs: 1500, intervalMs: 300 });
    assert.strictEqual(r2.ready, false);
    assert.strictEqual(r2.code, 'READINESS_UNREACHABLE');
    assert.match(r2.detail, /ECONNREFUSED/);
    assert.match(r2.detail, /caused by/);
  });
  await test('fixture readiness: exit-early fixture never listens', async () => {
    await assert.rejects(startFake('exit-early'), e => e.exitCode === 3);
  });
  await test('fixture readiness: isAlive=false aborts with BACKEND_EXITED', async () => {
    const port = await freePort();
    const r = await waitForReady(`http://127.0.0.1:${port}`, { timeoutMs: 5000, intervalMs: 200, isAlive: () => false });
    assert.strictEqual(r.code, 'BACKEND_EXITED');
  });
  for (const [mode, code] of [['ok', 'VERSION_OK'], ['wrong-sha', 'VERSION_SHA_MISMATCH'], ['dev-sha', 'VERSION_SHA_INVALID']]) {
    await test(`fixture version: ${mode}`, async () => {
      const f = await startFake(mode);
      try { assert.strictEqual((await checkVersion(f.url, SHA)).code, code); } finally { stopFake(f); }
    });
  }

  // ===== http diagnostics =====
  await test('http: connection refused keeps nested cause (not just "fetch failed")', async () => {
    const port = await freePort();
    const r = await request(`http://127.0.0.1:${port}/x`, { timeoutMs: 2000 });
    assert.strictEqual(r.transport, 'error');
    assert.match(r.errorChain, /fetch failed.*caused by.*ECONNREFUSED/);
    assert.ok(formatErrorChain(new Error('a', { cause: new Error('b') })).includes('caused by: Error: b'));
  });

  // ===== redaction =====
  await test('redact: tokens, auth headers, URL creds, cmdkey /pass', async () => {
    const s = redact('Authorization: Bearer abc.def ghp_' + 'x'.repeat(36) + ' https://u:p@host/ /pass:Secr3t! tskey-auth-abcdef123456 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ', ['Secr3t!']);
    for (const bad of ['abc.def', 'ghp_x', 'u:p@', 'Secr3t!', 'tskey-auth-abcdef', 'eyJhbGciOiJIUzI1NiJ9.eyJ']) assert.ok(!s.includes(bad), `${bad} leaked: ${s}`);
  });

  // ===== image validation =====
  await test('image: PNG validation rejects truncated/tiny, flags uniform', async () => {
    const good = makePng(64, 48);
    const v = validatePngBuffer(good, { minWidth: 32, minHeight: 32, minBytes: 50 });
    assert.strictEqual(v.valid, true, JSON.stringify(v));
    assert.strictEqual(v.nearUniform, false);
    assert.strictEqual(validatePngBuffer(good.subarray(0, good.length - 20), { minWidth: 32, minHeight: 32, minBytes: 50 }).valid, false);
    assert.strictEqual(validatePngBuffer(makePng(8, 8), { minWidth: 32, minHeight: 32, minBytes: 10 }).valid, false);
    assert.strictEqual(validatePngBuffer(Buffer.alloc(0)).valid, false);
    assert.strictEqual(validatePngBuffer(makePng(64, 48, true), { minWidth: 32, minHeight: 32, minBytes: 50 }).nearUniform, true);
  });
  await test('image: JPEG validation needs SOI, SOF dims and EOI', async () => {
    assert.strictEqual(validateJpegBuffer(makeJpeg(640, 480)).valid, true);
    assert.strictEqual(validateJpegBuffer(makeJpeg(640, 480)).width, 640);
    assert.strictEqual(validateJpegBuffer(makeJpeg(640, 480, false)).reason, 'MISSING_EOI');
    assert.strictEqual(validateJpegBuffer(Buffer.from('no frame yet'.padEnd(300))).reason, 'BAD_SIGNATURE');
  });

  // ===== process identity =====
  await test('proc: identity is stable and exact; createTime present', async () => {
    const a = proc.getProcess(process.pid); const b = proc.getProcess(process.pid);
    assert.ok(a && a.createTime, 'createTime must be available');
    assert.strictEqual(a.createTime, b.createTime);
    assert.strictEqual(proc.sameIdentity({ pid: a.pid, createTime: a.createTime }, b), true);
    assert.strictEqual(proc.sameIdentity({ pid: a.pid, createTime: 'other' }, b), false);
    assert.strictEqual(proc.sameIdentity({ pid: a.pid }, b), false, 'missing createTime is never a match');
  });
  await test('proc: descendants include grandchildren', async () => {
    const s = await spawnSleeper({ withGrandchild: true });
    try {
      const snap = proc.snapshot({});
      const d = proc.descendants(snap, s.pid, snap.byPid.get(s.pid).createTime).map(p => p.pid);
      assert.ok(d.includes(s.grandchild), `grandchild ${s.grandchild} not in ${d}`);
    } finally { try { process.kill(s.grandchild, 'SIGKILL'); } catch (e) { /* */ } s.child.kill('SIGKILL'); }
  });

  // ===== lock =====
  const LOCK_HOLDER = "const l=require(process.argv[1]);const h=l.acquireLock({lockDir:process.argv[2],role:'holder',timeoutMs:5000});console.log('HELD');setTimeout(()=>{l.releaseLock(h);process.exit(0)},Number(process.argv[3]))";
  function holdLock(lockDir, ms) {
    return new Promise(resolve => {
      const c = spawn(process.execPath, ['-e', LOCK_HOLDER, S('lib/lock.js'), lockDir, String(ms)], { stdio: ['ignore', 'pipe', 'inherit'] });
      c.stdout.once('data', () => resolve(c));
    });
  }
  await test('lock: live holder blocks; acquisition fails with holder info', async () => {
    const lock = require('./lib/lock');
    const dir = path.join(freshDirs().state, 'x.lock.d');
    const holder = await holdLock(dir, 4000);
    try {
      assert.throws(() => lock.acquireLock({ lockDir: dir, timeoutMs: 700, pollMs: 100 }), /LOCK_ACQUISITION_FAILED.*role=holder/);
    } finally { holder.kill('SIGKILL'); }
  });
  await test('lock: dead owner (process gone) is recovered', async () => {
    const lock = require('./lib/lock');
    const dir = path.join(freshDirs().state, 'x.lock.d');
    const holder = await holdLock(dir, 60000);
    holder.kill('SIGKILL');
    await new Promise(r => holder.once('exit', r));
    const h = lock.acquireLock({ lockDir: dir, timeoutMs: 3000, pollMs: 100 });
    assert.ok(h.events.some(e => e.event === 'STALE_LOCK_RECOVERED'));
    assert.strictEqual(lock.releaseLock(h), true);
    assert.ok(!fs.existsSync(dir));
  });
  await test('lock: PID reuse (live pid, different createTime) counts as dead owner', async () => {
    const lock = require('./lib/lock');
    const dir = path.join(freshDirs().state, 'x.lock.d');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ token: 'old', pid: process.pid, createTime: 'not-the-real-create-time' }));
    const h = lock.acquireLock({ lockDir: dir, timeoutMs: 3000, pollMs: 100 });
    assert.ok(h.events.some(e => e.event === 'STALE_LOCK_RECOVERED'));
    lock.releaseLock(h);
  });
  await test('lock: owner-less dir is only recovered after the grace period', async () => {
    const lock = require('./lib/lock');
    const dir = path.join(freshDirs().state, 'x.lock.d');
    fs.mkdirSync(dir);
    assert.throws(() => lock.acquireLock({ lockDir: dir, timeoutMs: 500, pollMs: 100, noOwnerGraceMs: 60000 }), /LOCK_ACQUISITION_FAILED/);
    const old = (Date.now() - 120000) / 1000; fs.utimesSync(dir, old, old);
    const h = lock.acquireLock({ lockDir: dir, timeoutMs: 2000, pollMs: 100, noOwnerGraceMs: 60000 });
    lock.releaseLock(h);
  });
  await test('lock: recovery race - a stale verdict never steals a re-acquired live lock', async () => {
    const lock = require('./lib/lock');
    const dir = path.join(freshDirs().state, 'x.lock.d');
    // recoverer B evaluated owner "old" as dead, but meanwhile A recovered and re-acquired
    const staleView = { token: 'old-dead-owner', pid: 999999, createTime: 'gone' };
    const live = lock.acquireLock({ lockDir: dir, timeoutMs: 1000 });
    const events = [];
    assert.strictEqual(lock.tryRecover(dir, staleView, events), false, 'must not steal');
    assert.strictEqual(lock.readOwner(dir).token, live.token, 'live owner intact');
    assert.deepStrictEqual(fs.readdirSync(dir).filter(f => f.startsWith('claim-')), [], 'claim marker removed');
    // and an owner-less view must not steal a lock that now has an owner
    assert.strictEqual(lock.tryRecover(dir, null, events), false);
    assert.strictEqual(lock.releaseLock(live), true);
  });
  await test('lock: release by a non-owner handle is refused', async () => {
    const lock = require('./lib/lock');
    const dir = path.join(freshDirs().state, 'x.lock.d');
    const h = lock.acquireLock({ lockDir: dir, timeoutMs: 1000 });
    assert.strictEqual(lock.releaseLock({ lockDir: dir, token: 'forged' }), false);
    assert.ok(fs.existsSync(dir));
    assert.strictEqual(lock.releaseLock(h), true);
  });
  const [NPROC, NINC] = IS_WIN ? [4, 5] : [6, 15]; // each Windows identity query spawns PowerShell
  await test(`lock: ${NPROC} concurrent processes x ${NINC} increments = mutual exclusion (no lost update)`, async () => {
    const dirs = freshDirs();
    const counterFile = path.join(dirs.state, 'counter.txt');
    fs.writeFileSync(counterFile, '0');
    const code = "const l=require(process.argv[1]);const fs=require('fs');for(let i=0;i<Number(process.argv[4]);i++){const h=l.acquireLock({lockDir:process.argv[2],timeoutMs:60000,pollMs:5});const v=Number(fs.readFileSync(process.argv[3],'utf8'));l.sleepSync(2);fs.writeFileSync(process.argv[3],String(v+1));l.releaseLock(h);}";
    const runs = await Promise.all(Array.from({ length: NPROC }, () => run(process.execPath, ['-e', code, S('lib/lock.js'), path.join(dirs.state, 'c.lock.d'), counterFile, String(NINC)], { timeoutMs: 300000 })));
    runs.forEach(r => assert.strictEqual(r.code, 0, r.err));
    assert.strictEqual(fs.readFileSync(counterFile, 'utf8'), String(NPROC * NINC));
  });

  // ===== registry =====
  await test('registry: 5 concurrent registrations, no lost update, no tmp leftovers', async () => {
    const dirs = freshDirs();
    const sleepers = await Promise.all(Array.from({ length: 5 }, () => spawnSleeper()));
    try {
      const code = "const r=require(process.argv[1]);r.registerProcess({pid:Number(process.argv[2]),role:'t'})";
      const runs = await Promise.all(sleepers.map(s => run(process.execPath, ['-e', code, S('lib/registry.js'), String(s.pid)], { env: childEnv(dirs) })));
      runs.forEach(r => assert.strictEqual(r.code, 0, r.err));
      const reg = JSON.parse(fs.readFileSync(path.join(dirs.state, 'process-registry.json'), 'utf8'));
      assert.strictEqual(reg.records.length, 5);
      assert.ok(reg.records.every(x => x.createTime && x.runId === 'reg-run' && x.runAttempt === '1'));
      assert.deepStrictEqual(fs.readdirSync(dirs.state).filter(f => f.includes('.tmp')), []);
    } finally { sleepers.forEach(s => s.child.kill('SIGKILL')); }
  });
  await test('registry: corrupt file is refused and preserved, never overwritten', async () => {
    const dirs = freshDirs();
    const reg = path.join(dirs.state, 'process-registry.json');
    fs.writeFileSync(reg, '{"records": [ {"pid": 1, ');
    const r = await run(process.execPath, ['-e', "require(process.argv[1]).registerProcess({pid:process.pid,role:'t'})", S('lib/registry.js')], { env: childEnv(dirs) });
    assert.notStrictEqual(r.code, 0);
    assert.match(r.err, /REGISTRY_CORRUPT/);
    assert.strictEqual(fs.readFileSync(reg, 'utf8'), '{"records": [ {"pid": 1, ');
  });

  // ===== cleanup policy (pure) =====
  await test('cleanup.decide: identity, protection, session and abandonment rules', async () => {
    const { decide } = require('./cleanup-lab');
    const live = { pid: 50, name: 'node', createTime: 'T1', sessionId: 1 };
    const snap = { byPid: new Map([[50, live], [60, { pid: 60, name: 'Runner.Worker', createTime: 'A1' }], [70, { pid: 70, name: 'svchost.exe', createTime: 'S1', sessionId: 1 }]]) };
    const ctx = { mode: 'postflight', protectedPids: new Set([1]), sessionId: 1 };
    assert.strictEqual(decide({ pid: 99, createTime: 'x' }, snap, ctx).reason, 'PROCESS_GONE');
    assert.strictEqual(decide({ pid: 50, createTime: 'T0' }, snap, ctx).reason, 'PID_REUSED_BY_OTHER_PROCESS');
    assert.strictEqual(decide({ pid: 50, createTime: 'T0' }, snap, ctx).action, 'drop');
    assert.strictEqual(decide({ pid: 50 }, snap, ctx).action, 'keep');
    assert.strictEqual(decide({ pid: 50, createTime: 'T1' }, snap, { ...ctx, protectedPids: new Set([50]) }).reason, 'PROTECTED_ANCESTOR');
    assert.match(decide({ pid: 70, createTime: 'S1' }, snap, ctx).reason, /PROTECTED_SYSTEM_PROCESS/);
    assert.match(decide({ pid: 50, createTime: 'T1' }, snap, { ...ctx, sessionId: 2 }).reason, /OTHER_SESSION/);
    assert.strictEqual(decide({ pid: 50, createTime: 'T1' }, snap, ctx).action, 'terminate');
    const pre = { ...ctx, mode: 'preflight' };
    assert.strictEqual(decide({ pid: 50, createTime: 'T1' }, snap, pre).reason, 'ABANDONMENT_UNPROVEN_NO_JOB_ANCHOR');
    assert.strictEqual(decide({ pid: 50, createTime: 'T1', anchor: { pid: 60, createTime: 'A1' } }, snap, pre).reason, 'OWNING_JOB_STILL_ACTIVE');
    assert.strictEqual(decide({ pid: 50, createTime: 'T1', anchor: { pid: 60, createTime: 'A0' } }, snap, pre).action, 'terminate');
    assert.strictEqual(decide({ pid: 50, createTime: 'T1', anchor: { pid: 61, createTime: 'A1' } }, snap, pre).action, 'terminate');
  });

  // ===== cleanup integration (real processes) =====
  await test('cleanup: postflight kills only this run+attempt (with descendants); preflight only abandoned', async () => {
    const dirs = freshDirs();
    const A = await spawnSleeper({ withGrandchild: true }); // run reg-run attempt 1
    const B = await spawnSleeper(); // run reg-run attempt 2 (other attempt, owning job alive)
    const C = await spawnSleeper(); // other run, owning job dead
    const D = await spawnSleeper(); // other run, owning job alive
    const deadAnchor = await spawnSleeper();
    const deadAnchorId = proc.getProcess(deadAnchor.pid);
    deadAnchor.child.kill('SIGKILL');
    await new Promise(r => deadAnchor.child.once('exit', r));
    const me = proc.getProcess(process.pid);
    const reg = code => run(process.execPath, ['-e', code, S('lib/registry.js')], { env: childEnv(dirs) });
    const regOne = (pid, runId, attempt, anchor) => reg(`require(process.argv[1]).registerProcess({pid:${pid},role:'t',runId:'${runId}',runAttempt:'${attempt}',anchor:${JSON.stringify(anchor)}})`);
    try {
      for (const [p, r, a, anc] of [[A.pid, 'reg-run', '1', null], [B.pid, 'reg-run', '2', { pid: me.pid, createTime: me.createTime }], [C.pid, 'old-run', '1', { pid: deadAnchorId.pid, createTime: deadAnchorId.createTime }], [D.pid, 'old-run2', '1', { pid: me.pid, createTime: me.createTime }]]) {
        const res = await regOne(p, r, a, anc);
        assert.strictEqual(res.code, 0, res.err);
      }
      const post = await run(process.execPath, [S('cleanup-lab.js'), '--mode', 'postflight', '--deadline-ms', '20000'], { env: childEnv(dirs) });
      assert.strictEqual(post.code, 0, post.out + post.err);
      await new Promise(r => setTimeout(r, 300));
      assert.ok(!alive(A.pid), 'A (this run+attempt) must be terminated');
      assert.ok(!alive(A.grandchild), 'A grandchild must be terminated');
      assert.ok(alive(B.pid) && alive(C.pid) && alive(D.pid), 'postflight must not touch other attempts/runs');
      const pre = await run(process.execPath, [S('cleanup-lab.js'), '--mode', 'preflight', '--deadline-ms', '20000'], { env: childEnv(dirs) });
      assert.strictEqual(pre.code, 0, pre.out + pre.err);
      await new Promise(r => setTimeout(r, 300));
      assert.ok(!alive(C.pid), 'C (owning job gone) must be terminated');
      assert.ok(alive(B.pid), 'B (owning job alive) must survive preflight');
      assert.ok(alive(D.pid), 'D (owning job alive) must survive preflight');
      const left = JSON.parse(fs.readFileSync(path.join(dirs.state, 'process-registry.json'), 'utf8')).records.map(r => r.pid).sort();
      assert.deepStrictEqual(left, [B.pid, D.pid].sort());
    } finally {
      for (const s of [A, B, C, D]) { try { s.child.kill('SIGKILL'); } catch (e) { /* */ } }
      try { process.kill(A.grandchild, 'SIGKILL'); } catch (e) { /* */ }
    }
  });
  await test('cleanup: PID-reuse record (wrong createTime) is dropped without killing', async () => {
    const dirs = freshDirs();
    const s = await spawnSleeper();
    try {
      fs.writeFileSync(path.join(dirs.state, 'process-registry.json'), JSON.stringify({ records: [{ pid: s.pid, createTime: 'stale-identity', runId: 'reg-run', runAttempt: '1', role: 't' }] }));
      const r = await run(process.execPath, [S('cleanup-lab.js'), '--mode', 'postflight'], { env: childEnv(dirs) });
      assert.strictEqual(r.code, 0, r.out + r.err);
      assert.ok(alive(s.pid), 'unrelated process with reused PID must survive');
      assert.match(r.out, /PID_REUSED_BY_OTHER_PROCESS/);
    } finally { s.child.kill('SIGKILL'); }
  });

  // ===== verification report =====
  await test('report: VERIFIED only when every capability PASS and static succeeded', async () => {
    const { build, REQUIRED } = require('./verification-report');
    const caps = scope => JSON.stringify(Object.fromEntries(Object.entries(REQUIRED).filter(([, v]) => v.scope === scope).map(([k]) => [k, { s: 'PASS', r: 'ok' }])));
    const needs = {
      static: { result: 'success', outputs: {} },
      server: { result: 'success', outputs: { caps_server_local: caps('server_local'), tailscale_outcome: 'success', backend_pid: '4242', rdp_configured: 'true' } },
      client: { result: 'success', outputs: { caps_client_local: caps('client_local'), caps_tailnet: caps('tailnet'), caps_remote: caps('remote'), backend_pid_remote: '4242' } }
    };
    assert.strictEqual(build(needs).verdict, 'VERIFIED');
    const n2 = JSON.parse(JSON.stringify(needs)); n2.client.outputs.backend_pid_remote = '999';
    const r2 = build(n2);
    assert.strictEqual(r2.verdict, 'NOT_VERIFIED');
    assert.match(r2.capabilities.backend_readiness_remote.reason, /IDENTITY_MISMATCH/);
    const n3 = JSON.parse(JSON.stringify(needs)); n3.server.outputs.tailscale_outcome = 'failure'; n3.server.outputs.oidc_sub = 'repo:o@1/r@2:pull_request';
    n3.client.outputs.caps_tailnet = JSON.stringify({ tailnet_connectivity: { s: 'BLOCKED', r: 'SERVER_NEVER_JOINED_TAILNET' } }); delete n3.client.outputs.caps_remote;
    const r3 = build(n3);
    assert.match(r3.capabilities.tailnet_connectivity.reason, /EXTERNAL_TAILSCALE_JOIN_FAILED.*repo:o@1/);
    assert.strictEqual(r3.capabilities.rdp_auto_login.status, 'BLOCKED');
    const n4 = JSON.parse(JSON.stringify(needs)); n4.static.result = 'failure';
    assert.strictEqual(build(n4).verdict, 'NOT_VERIFIED');
    const n5 = JSON.parse(JSON.stringify(needs)); delete n5.client;
    const r5 = build(n5);
    assert.strictEqual(r5.capabilities.browser_synthetic.status, 'NOT_RUN');
    assert.strictEqual(r5.verdict, 'NOT_VERIFIED');
    const n6 = JSON.parse(JSON.stringify(needs)); n6.server.outputs.caps_server_local = JSON.stringify({ backend_readiness_server_local: { s: 'SIMULATED' }, dashboard_server_local: { s: 'PASS' } });
    assert.strictEqual(build(n6).verdict, 'NOT_VERIFIED');
  });

  // ===== OIDC subject analysis =====
  await test('oidc: immutable subject cannot match documented name-only pattern', async () => {
    const { analyse } = require('./oidc-claims-diagnostic');
    const a = analyse({ sub: 'repo:dictationb1@342137832/supreme-lamp-lab@1425092794:pull_request', repository: 'dictationb1/supreme-lamp-lab', repository_owner: 'dictationb1', repository_owner_id: '342137832', repository_id: '1425092794' });
    assert.strictEqual(a.immutableSubjectFormat, true);
    assert.strictEqual(a.matchesDocumentedLegacyPattern, false);
    assert.strictEqual(a.recommendedSubjectPattern, 'repo:dictationb1@342137832/supreme-lamp-lab@1425092794:*');
    assert.strictEqual(a.matchesRecommendedPattern, true);
  });

  // ===== tailnet peer matching =====
  await test('peer: exact hostname / -N suffix, no prefix confusion between attempts', async () => {
    const { findPeer } = require('./wait-for-peer');
    const st = { Peer: {
      a: { HostName: 'slab-srv-12-10', DNSName: 'slab-srv-12-10.tail.ts.net.', Online: true, TailscaleIPs: ['100.1.1.10'] },
      b: { HostName: 'runnervm', DNSName: 'slab-srv-12-1-1.tail.ts.net.', Online: true, TailscaleIPs: ['100.1.1.1'] }
    } };
    assert.strictEqual(findPeer(st, 'slab-srv-12-1').TailscaleIPs[0], '100.1.1.1');
    assert.strictEqual(findPeer(st, 'slab-srv-12-10').TailscaleIPs[0], '100.1.1.10');
    assert.strictEqual(findPeer(st, 'slab-srv-12-2'), null);
  });

  // ===== CLI end-to-end (child processes, no browser needed) =====
  await test('mc-check CLI: contradictory backend -> FAIL, dashboard BLOCKED, outputs written', async () => {
    const dirs = freshDirs(); const f = await startFake('contradictory');
    try {
      const r = await run(process.execPath, [S('mission-control-check.js'), '--scope', 'server-local', '--target', f.url, '--expect-sha', SHA, '--expect-pid', String(f.pid), '--expect-port', String(f.port), '--headless', '--ready-timeout-ms', '3000'], { env: childEnv(dirs) });
      assert.strictEqual(r.code, 1, r.out + r.err);
      const doc = JSON.parse(fs.readFileSync(path.join(dirs.art, 'capabilities-server-local.json'), 'utf8'));
      assert.strictEqual(doc.capabilities.backend_readiness_server_local.status, 'FAIL');
      assert.match(doc.capabilities.backend_readiness_server_local.reason, /READINESS_CONTRADICTORY/);
      assert.strictEqual(doc.capabilities.dashboard_server_local.status, 'BLOCKED');
      const o = JSON.parse(readOutputs(dirs.out).caps_server_local);
      assert.strictEqual(o.backend_readiness_server_local.s, 'FAIL');
    } finally { stopFake(f); }
  });
  await test('mc-check CLI: --blocked-reason records the prerequisite cause on every capability', async () => {
    const dirs = freshDirs();
    const r = await run(process.execPath, [S('mission-control-check.js'), '--scope', 'remote', '--blocked-reason', 'DEPENDS_ON_TAILNET: peer absent'], { env: childEnv(dirs) });
    assert.strictEqual(r.code, 1);
    const doc = JSON.parse(fs.readFileSync(path.join(dirs.art, 'capabilities-remote.json'), 'utf8'));
    for (const c of Object.values(doc.capabilities)) { assert.strictEqual(c.status, 'BLOCKED'); assert.match(c.reason, /DEPENDS_ON_TAILNET/); }
  });
  await test('mc-check CLI: --fail-reason is a causal FAIL on backend readiness, dependants BLOCKED', async () => {
    const dirs = freshDirs();
    const r = await run(process.execPath, [S('mission-control-check.js'), '--scope', 'server-local', '--fail-reason', 'STAGING_FAILED: outcome=failure; boom @ x.ps1:3'], { env: childEnv(dirs) });
    assert.strictEqual(r.code, 1);
    const caps = JSON.parse(fs.readFileSync(path.join(dirs.art, 'capabilities-server-local.json'), 'utf8')).capabilities;
    assert.strictEqual(caps.backend_readiness_server_local.status, 'FAIL');
    assert.match(caps.backend_readiness_server_local.reason, /STAGING_FAILED: outcome=failure; boom/);
    assert.strictEqual(caps.dashboard_server_local.status, 'BLOCKED');
    assert.match(caps.dashboard_server_local.reason, /DEPENDS_ON_BACKEND: STAGING_FAILED/);
  });
  await test('mc-check CLI: missing --expect-sha is BLOCKED (never PASS/SKIPPED)', async () => {
    const dirs = freshDirs();
    const r = await run(process.execPath, [S('mission-control-check.js'), '--scope', 'remote', '--target', 'http://127.0.0.1:9'], { env: childEnv(dirs) });
    assert.strictEqual(r.code, 1);
    const doc = JSON.parse(fs.readFileSync(path.join(dirs.art, 'capabilities-remote.json'), 'utf8'));
    for (const c of Object.values(doc.capabilities)) assert.strictEqual(c.status, 'BLOCKED');
  });
  await test('mc-check CLI: unreachable backend reports the cause chain', async () => {
    const dirs = freshDirs(); const port = await freePort();
    const r = await run(process.execPath, [S('mission-control-check.js'), '--scope', 'server-local', '--target', `http://127.0.0.1:${port}`, '--expect-sha', SHA, '--ready-timeout-ms', '1500'], { env: childEnv(dirs) });
    assert.strictEqual(r.code, 1);
    const doc = JSON.parse(fs.readFileSync(path.join(dirs.art, 'capabilities-server-local.json'), 'utf8'));
    assert.match(doc.capabilities.backend_readiness_server_local.reason, /READINESS_UNREACHABLE.*ECONNREFUSED/);
  });
  await test('session lock held -> browser-check FAILs both capabilities (no warn-and-continue)', async () => {
    const dirs = freshDirs();
    const lockDir = path.join(dirs.state, 'desktop-session.lock.d');
    const holder = await holdLock(lockDir, 20000);
    try {
      const r = await run(process.execPath, [S('browser-check.js')], { env: childEnv(dirs, { SESSION_LOCK_TIMEOUT_MS: '800' }) });
      assert.strictEqual(r.code, 1, r.out + r.err);
      const doc = JSON.parse(fs.readFileSync(path.join(dirs.art, 'capabilities-client-local.json'), 'utf8'));
      for (const c of Object.values(doc.capabilities)) { assert.strictEqual(c.status, 'FAIL'); assert.match(c.reason, /LOCK_ACQUISITION_FAILED/); }
    } finally { holder.kill('SIGKILL'); }
  });

  // ===== backend supervisor (fixture as the server command) =====
  // crash point for supervisor tests: after the (PowerShell-backed on Windows) identity
  // and listener checks, so the asserted phase is the one actually exercised
  const CRASH_MS = IS_WIN ? 12000 : 1500;
  const sup = async (mode, extra = {}) => {
    const dirs = freshDirs(); const port = extra.port || await freePort();
    const okFile = path.join(dirs.art, 'server-ok.txt');
    const r = await run(process.execPath, [S('backend-supervisor.js'), '--server-cmd', JSON.stringify([process.execPath, FAKE]), '--ok-file', okFile, '--port', String(port), '--no-mc', '--ready-timeout-ms', String(extra.readyTimeoutMs || 5000)], { env: childEnv(dirs, { MODE: mode, EXPECT_SHA: SHA, ...(extra.env || {}) }) });
    const summary = JSON.parse(fs.readFileSync(path.join(dirs.art, 'backend-supervisor.json'), 'utf8'));
    return { r, summary, outputs: readOutputs(dirs.out) };
  };
  await test('supervisor: healthy fixture passes okfile+listener+readiness, then is stopped', async () => {
    const { r, summary, outputs } = await sup('ok');
    assert.strictEqual(r.code, 0, r.out + r.err);
    assert.deepStrictEqual(summary.phases.map(p => `${p.name}:${p.ok}`), ['okfile:true', 'listener:true', 'readiness:true']);
    assert.ok(outputs.backend_pid);
    await new Promise(res => setTimeout(res, 300));
    assert.ok(!alive(Number(outputs.backend_pid)), 'backend must be stopped by the supervisor');
  });
  await test('supervisor: startup crash -> BACKEND_EXITED_BEFORE_LISTENING with stderr', async () => {
    const { r, summary } = await sup('exit-early');
    assert.strictEqual(r.code, 1);
    const f = summary.phases.find(p => !p.ok);
    assert.strictEqual(f.code, 'BACKEND_EXITED_BEFORE_LISTENING');
    assert.match(f.detail, /simulated startup crash/);
  });
  await test('supervisor: readiness pid of another process -> READINESS_WRONG_PROCESS', async () => {
    const { r, summary } = await sup('wrong-listener');
    assert.strictEqual(r.code, 1);
    assert.strictEqual(summary.phases.find(p => !p.ok).code, 'READINESS_WRONG_PROCESS');
  });
  await test('supervisor: port owned by a foreign process -> BACKEND_PORT_OWNED_BY_OTHER', async () => {
    const port = await freePort();
    const squatter = net.createServer().listen(port, '127.0.0.1');
    await new Promise(r => squatter.once('listening', r));
    try {
      const { r, summary } = await sup('ok', { port, env: { FAKE_LISTEN_PORT: '0' } });
      assert.strictEqual(r.code, 1);
      assert.strictEqual(summary.phases.find(p => !p.ok).code, 'BACKEND_PORT_OWNED_BY_OTHER');
    } finally { squatter.close(); }
  }, { skipIf: () => (IS_WIN ? null : (fs.existsSync('/proc/net/tcp') ? null : 'no /proc/net/tcp')) });
  await test('supervisor: crash while initializing -> BACKEND_EXITED (liveness monitored)', async () => {
    const { r, summary } = await sup('crash-before-ready', { env: { CRASH_AFTER_MS: String(CRASH_MS) }, readyTimeoutMs: CRASH_MS + 15000 });
    assert.strictEqual(r.code, 1);
    assert.strictEqual(summary.phases.find(p => !p.ok).code, 'BACKEND_EXITED', JSON.stringify(summary.phases));
  });
  const http = require('http');
  const fakeJobsApi = statusFn => new Promise(res => {
    let calls = 0;
    const srv = http.createServer((req, rsp) => { calls++; rsp.writeHead(200, { 'Content-Type': 'application/json' }); rsp.end(JSON.stringify({ jobs: [{ id: 1, name: 'client', status: statusFn(calls), conclusion: null, runner_name: 'fake' }] })); });
    srv.listen(0, '127.0.0.1', () => res({ srv, url: `http://127.0.0.1:${srv.address().port}`, calls: () => calls }));
  });
  const supHold = async (mode, api) => {
    const dirs = freshDirs(); const port = await freePort();
    const r = await run(process.execPath, [S('backend-supervisor.js'), '--server-cmd', JSON.stringify([process.execPath, FAKE]), '--ok-file', path.join(dirs.art, 'ok.txt'), '--port', String(port), '--no-mc', '--hold', 'true', '--hold-poll-ms', '300', '--hold-max-ms', String(CRASH_MS + 20000), '--ready-timeout-ms', '5000'],
      { env: childEnv(dirs, { MODE: mode, CRASH_AFTER_MS: String(CRASH_MS), EXPECT_SHA: SHA, GITHUB_API_URL: api.url, GITHUB_REPOSITORY: 'o/r', GH_TOKEN: 'test-token' }) });
    return { r, summary: JSON.parse(fs.readFileSync(path.join(dirs.art, 'backend-supervisor.json'), 'utf8')) };
  };
  await test('supervisor hold: keeps backend alive until the client job completes', async () => {
    const api = await fakeJobsApi(n => (n < 4 ? 'in_progress' : 'completed'));
    try {
      const { r, summary } = await supHold('ok', api);
      assert.strictEqual(r.code, 0, r.out + r.err);
      const h = summary.phases.find(p => p.name === 'hold');
      assert.ok(h.ok && /client job completed/.test(h.detail), JSON.stringify(h));
      assert.ok(api.calls() >= 4);
    } finally { api.srv.close(); }
  });
  await test('supervisor hold: backend dying during hold is a failure', async () => {
    const api = await fakeJobsApi(() => 'in_progress');
    try {
      const { r, summary } = await supHold('crash-after-ready', api);
      assert.strictEqual(r.code, 1, r.out + r.err);
      assert.strictEqual(summary.phases.find(p => !p.ok).code, 'BACKEND_DIED_DURING_HOLD', JSON.stringify(summary.phases));
    } finally { api.srv.close(); }
  });

  // ===== browser e2e (CI static job installs chromium) =====
  const browserSkip = () => {
    try { require.resolve('playwright'); } catch (e) { return process.env.REQUIRE_BROWSER_TESTS === '1' ? null : 'playwright not installed'; }
    try { const { chromium } = require('playwright'); if (!fs.existsSync(chromium.executablePath())) return process.env.REQUIRE_BROWSER_TESTS === '1' ? null : 'chromium not installed'; } catch (e) { return process.env.REQUIRE_BROWSER_TESTS === '1' ? null : e.message; }
    return null;
  };
  for (const [mode, want] of [['ok', { code: 0, backend: 'PASS', dash: 'PASS' }], ['ui-missing', { code: 1, backend: 'PASS', dash: 'FAIL', reason: /UI_FILE_MISSING/ }], ['wrong-sha', { code: 1, backend: 'FAIL', dash: 'BLOCKED', reason: /VERSION_SHA_MISMATCH/ }],
    ['ui-v2', { code: 0, backend: 'PASS', dash: 'PASS', reason: /v2: title ok/ }],
    ['ui-v2-unmounted', { code: 1, backend: 'PASS', dash: 'FAIL', reason: /DASHBOARD_V2_NOT_MOUNTED/ }],
    ['ui-v2-stale', { code: 1, backend: 'PASS', dash: 'FAIL', reason: /DASHBOARD_BUILD_MISMATCH: v2 #ghrdpBuild\[data-build\]/ }],
    ['ui-v2-missing', { code: 1, backend: 'PASS', dash: 'FAIL', reason: /DASHBOARD_V2_NOT_STAGED/ }]]) {
    await test(`browser e2e mc-check server-local: ${mode}`, async () => {
      const dirs = freshDirs(); const f = await startFake(mode);
      try {
        const r = await run(process.execPath, [S('mission-control-check.js'), '--scope', 'server-local', '--target', f.url, '--expect-sha', SHA, '--expect-pid', String(f.pid), '--expect-port', String(f.port), '--headless', '--ready-timeout-ms', '5000'], { env: childEnv(dirs), timeoutMs: 120000 });
        const doc = JSON.parse(fs.readFileSync(path.join(dirs.art, 'capabilities-server-local.json'), 'utf8'));
        const c = doc.capabilities;
        assert.strictEqual(c.backend_readiness_server_local.status, want.backend, JSON.stringify(c));
        assert.strictEqual(c.dashboard_server_local.status, want.dash, JSON.stringify(c));
        if (want.reason) assert.match(JSON.stringify(c), want.reason);
        assert.strictEqual(r.code, want.code, r.out + r.err);
      } finally { stopFake(f); }
    }, { skipIf: browserSkip });
  }

  // ===== summary =====
  const failed = results.filter(r => r.status === 'FAIL');
  const skipped = results.filter(r => r.status === 'SKIPPED');
  console.log(`\n${results.length} tests: ${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
  const outDir = process.env.ARTIFACT_DIR || path.join(ROOT, 'artifacts');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `regressions-${process.platform}.json`), JSON.stringify({ platform: process.platform, node: process.version, results }, null, 2));
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* */ }
  if (failed.length) {
    if (process.env.GITHUB_ACTIONS === 'true') for (const f of failed) console.log(`::error title=regression ${f.name}::${String(f.detail).split('\n').filter(Boolean).slice(0, 8).join(' | ').replace(/%/g, '%25').slice(0, 1800)}`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
