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
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const S = p => path.join(ROOT, 'scripts', p);
const FAKE = S('test/fixtures/fake-backend.js');
const FIXTURE_PS = {
  hang: S('test/fixtures/hang-ps.js'),
  fail: S('test/fixtures/fail-ps.js'),
  ok: S('test/fixtures/ok-ps.js')
};
// Env that makes lib/ps.js spawn <node> <fixture> instead of PowerShell.
function fakePsEnv(fixture, extra = {}) {
  return { LAB_PS_EXE: process.execPath, LAB_PS_ARGV_PREFIX: JSON.stringify([FIXTURE_PS[fixture]]), ...extra };
}
const SHA = '978a8375ee77b392ce11694ccee7722fd6ca4f71';
const IS_WIN = process.platform === 'win32';

const { STATUS, aggregate, CapabilitySet } = require('./lib/status');
const { evaluateReadiness, evaluateVersion, waitForReady, checkVersion } = require('./lib/readiness');
const { request, formatErrorChain } = require('./lib/http');
const { validatePngBuffer, validateJpegBuffer } = require('./lib/image');
const { redact } = require('./lib/redact');
const proc = require('./lib/proc');
const annotate = require('./lib/annotate');
const { artifactDir } = require('./lib/results');
const psLib = require('./lib/ps');
const reportLib = require('./verification-report');
const tailnetDiag = require('./tailnet-token-exchange-diagnostic');
const logonLib = require('./lib/logon');
const mcCheck = require('./mission-control-check');

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
  // ===== lock: multi-process mutual exclusion with a merged event timeline =====
  // Run 39555536075 attempt 1 failed exactly here ("lock: 4 concurrent processes
  // x 5 increments = mutual exclusion (no lost update)", lock.js:120) on the
  // self-hosted Windows client. The failure carried only
  // `role=unknown pid=6712`, which is not enough to tell a live-but-slow holder
  // from an orphaned release, so every worker now writes a bounded JSONL
  // timeline (pid, createTime, exit state, per-poll verdict, query and
  // operation timings) and the parent merges the four files.
  const LOCK_WORKER = "const l=require(process.argv[1]);const fs=require('fs');" +
    "const lockDir=process.argv[2],counter=process.argv[3],ninc=Number(process.argv[4]),role=process.argv[5],timeoutMs=Number(process.argv[6]),pollMs=Number(process.argv[7]);" +
    "for(let i=0;i<ninc;i++){const h=l.acquireLock({lockDir,role,timeoutMs,pollMs});" +
    "const v=Number(fs.readFileSync(counter,'utf8'));l.sleepSync(2);fs.writeFileSync(counter,String(v+1));" +
    "const rel=l.releaseLockEx(h);if(!rel.released&&!rel.relinquished){console.error('RELEASE_INCOMPLETE '+JSON.stringify(rel));process.exit(3);}}";

  function readTimeline(files) {
    const ev = [];
    for (const [worker, file] of Object.entries(files)) {
      if (!fs.existsSync(file)) continue;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { ev.push({ worker, ...JSON.parse(line) }); } catch (e) { /* torn line */ }
      }
    }
    return ev.sort((a, b) => a.t - b.t);
  }
  function timelineText(events, limit = 60) {
    const interesting = events.length <= limit ? events : [...events.slice(0, limit / 2), ...events.slice(-limit / 2)];
    return interesting.map(e => {
      const bits = [`+${String(e.t - (events[0] ? events[0].t : e.t)).padStart(6)}ms`, `w${e.worker}`, `pid=${e.pid}`, e.event];
      if (e.role) bits.push(`role=${e.role}`);
      if (e.verdict) bits.push(`verdict=${e.verdict}`);
      if (e.holder) bits.push(`holder=${e.holder.pid}/${e.holder.role}`);
      if (e.elapsedMs !== undefined) bits.push(`${e.elapsedMs}ms`);
      if (e.queryMs) bits.push(`query=${e.queryMs}ms`);
      if (e.errorCode) bits.push(`err=${e.errorCode}`);
      if (e.reason) bits.push(`reason=${e.reason}`);
      return bits.join(' ');
    }).join('\n      ');
  }
  function persistTimeline(name, dirs, nproc, ninc, rounds, runs, events) {
    const doc = {
      test: name, platform: process.platform, node: process.version,
      testDir: dirs.state, lockDir: path.join(dirs.state, 'c.lock.d'),
      workers: runs.map((r, i) => ({ worker: i + 1, pid: r.pid, exitCode: r.code, signal: r.signal || null, endedAt: r.endedAt })),
      nproc, ninc, rounds, eventCount: events.length, events: events.slice(-400)
    };
    const file = path.join(artifactDir(), 'lock-timeline.json');
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    return file;
  }
  async function concurrentRound({ round, nproc, ninc, timeoutMs = 60000, pollMs = 5, env = {}, testName, dirs }) {
    const counterFile = path.join(dirs.state, `counter-${round}.txt`);
    fs.writeFileSync(counterFile, '0');
    const files = {};
    for (let k = 0; k < nproc; k++) files[k + 1] = path.join(dirs.state, `events-w${k + 1}-r${round}.jsonl`);
    const runs = await Promise.all(Array.from({ length: nproc }, (_, i) => {
      const k = i + 1;
      return run(process.execPath, ['-e', LOCK_WORKER, S('lib/lock.js'), path.join(dirs.state, 'c.lock.d'), counterFile,
        String(ninc), `worker-${k}`, String(timeoutMs), String(pollMs)],
      { timeoutMs: timeoutMs * 2, env: { ...process.env, LAB_LOCK_EVENTS: files[k], ...env } })
        .then(r => ({ ...r, endedAt: new Date().toISOString(), pid: (readTimeline({ [k]: files[k] })[0] || {}).pid || null }));
    }));
    const events = readTimeline(files);
    const acquired = events.filter(e => e.event === 'LOCK_ACQUIRED').length;
    const queries = events.filter(e => e.event === 'IDENTITY_QUERY').length;
    const fails = runs.filter(r => r.code !== 0);
    if (fails.length) {
      const file = persistTimeline(testName, dirs, nproc, ninc, round, runs, events);
      annotate.error('lock timeline', `round=${round} dirs=${dirs.state} timeline=${file} acquired=${acquired} identityQueries=${queries}\n${timelineText(events)}`);
      throw new Error(`round ${round}: worker(s) failed: ${fails.map(f => `code=${f.code} ${String(f.err).split('\n').slice(0, 4).join(' | ')}`).join(' ; ')}\n      timeline(${file}):\n      ${timelineText(events)}`);
    }
    return { events, acquired, queries, runs, counterFile, dirs };
  }

  const [NPROC, NINC] = IS_WIN ? [4, 5] : [6, 15]; // each Windows identity query spawns PowerShell
  await test(`lock: ${NPROC} concurrent processes x ${NINC} increments = mutual exclusion (no lost update)`, async () => {
    const dirs = freshDirs();
    const rounds = Number(process.env.LOCK_STRESS_ROUNDS || (IS_WIN ? 3 : 2));
    for (let round = 1; round <= rounds; round++) {
      const r = await concurrentRound({ round, nproc: NPROC, ninc: NINC, testName: `lock: ${NPROC}x${NINC} mutual exclusion`, dirs });
      assert.strictEqual(readFileText(r.counterFile), String(NPROC * NINC));
      assert.strictEqual(r.acquired, NPROC * NINC, `round ${round}: expected ${NPROC * NINC} acquisitions, saw ${r.acquired}`);
      assert.ok(!r.events.some(e => e.event === 'ACQUIRE_TIMEOUT'), `round ${round}: unexpected timeout\n${timelineText(r.events)}`);
      assert.ok(!r.events.some(e => e.event === 'RELEASE_RELINQUISHED'), `round ${round}: release had to be relinquished\n${timelineText(r.events)}`);
    }
  });
  function readFileText(file) { return fs.readFileSync(file, 'utf8'); }

  await test('lock: a live holder is never stolen, even when the lock looks old', async () => {
    const lock = require('./lib/lock');
    const dir = path.join(freshDirs().state, 'x.lock.d');
    const holder = await holdLock(dir, 2500);
    try {
      // age the directory and the owner metadata far past every grace period
      const old = (Date.now() - 600000) / 1000;
      fs.utimesSync(dir, old, old);
      const owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'));
      owner.acquiredAt = new Date(Date.now() - 600000).toISOString();
      fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify(owner));
      assert.throws(
        () => lock.acquireLock({ lockDir: dir, timeoutMs: 600, pollMs: 50 }),
        /LOCK_ACQUISITION_FAILED.*role=holder/
      );
      assert.ok(fs.existsSync(path.join(dir, 'owner.json')), 'live owner metadata must be untouched');
      assert.strictEqual(lock.readOwner(dir).token, owner.token, 'live owner token intact');
      assert.strictEqual(String(lock.readOwner(dir).pid), String(owner.pid), 'live owner pid intact');
    } finally { holder.kill('SIGKILL'); }
  });

  await test('lock: crashed owner is recovered and an unrelated live process is left alone', async () => {
    const lock = require('./lib/lock');
    const dir = path.join(freshDirs().state, 'x.lock.d');
    const bystander = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const holder = await holdLock(dir, 60000);
    try {
      holder.kill('SIGKILL');
      await new Promise(r => holder.once('exit', r));
      const h = lock.acquireLock({ lockDir: dir, timeoutMs: 5000, pollMs: 50 });
      assert.ok(h.events.some(e => e.event === 'STALE_LOCK_RECOVERED'), JSON.stringify(h.events));
      assert.strictEqual(lock.releaseLockEx(h).released, true);
      assert.ok(!fs.existsSync(dir), 'lock directory removed');
      // the unrelated process was never a lock owner and must survive
      process.kill(bystander.pid, 0);
    } finally {
      try { bystander.kill('SIGKILL'); } catch (e) { /* ignore */ }
      try { holder.kill('SIGKILL'); } catch (e) { /* ignore */ }
    }
  });

  await test('lock: a failed release is retried, relinquished, and the next worker takes over (no self-deadlock)', async () => {
    // Windows sharing violations (a peer reading owner.json, Defender scanning a
    // freshly written file) can make the directory rename fail. Before the fix,
    // releaseLock() returned false, the worker ignored it, and its NEXT
    // acquisition waited on its own orphaned lock until the 60s deadline, which
    // is exactly the run-39555536075 symptom (live pid in the holder field).
    const lock = require('./lib/lock');
    const dirs = freshDirs();
    const lockDir = path.join(dirs.state, 'c.lock.d');
    const blocker = spawn(process.execPath, ['-e',
      "const l=require(process.argv[1]);const h=l.acquireLock({lockDir:process.argv[2],role:'blocked-releaser',timeoutMs:5000});" +
      "const rel=l.releaseLockEx(h);console.log(JSON.stringify(rel));process.exit(rel.released?0:3);",
      S('lib/lock.js'), lockDir],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LAB_LOCK_TEST_HOOKS: '1', LAB_LOCK_TEST_RELEASE_RENAME_FAILS: '99' } });
    let out = ''; blocker.stdout.on('data', d => { out += d; });
    const code = await new Promise(r => blocker.once('exit', r));
    assert.strictEqual(code, 3, `release must report failure, got ${code}: ${out}`);
    const rel = JSON.parse(out.trim().split('\n').pop());
    assert.strictEqual(rel.released, false);
    assert.strictEqual(rel.relinquished, true);
    assert.ok(fs.existsSync(path.join(lockDir, 'relinquish.json')), 'owner-authorized relinquish marker written');
    const marker = JSON.parse(fs.readFileSync(path.join(lockDir, 'relinquish.json'), 'utf8'));
    assert.strictEqual(marker.token, lock.readOwner(lockDir).token, 'marker bound to the owner token');
    // A different process must now take over quickly instead of waiting out its deadline.
    const t0 = Date.now();
    const h = lock.acquireLock({ lockDir, role: 'next-worker', timeoutMs: 4000, pollMs: 25 });
    assert.ok(Date.now() - t0 < 4000, 'takeover happened before the deadline');
    assert.strictEqual(lock.releaseLockEx(h).released, true);
    assert.ok(!fs.existsSync(lockDir), 'lock directory freed');
  });

  await test('lock: a live holder with a slow identity query is not poll-stormed (bounded identity queries, bounded wall clock)', async () => {
    // Simulates the Windows cost that produced run 39555536075: each full
    // (pid, createTime) query is a PowerShell spawn. The lock must keep the
    // same identity guarantees without one spawn per 5ms poll.
    const dirs = freshDirs();
    const nproc = 4; const ninc = 5;
    const t0 = Date.now();
    const r = await concurrentRound({
      round: 1, nproc, ninc, timeoutMs: 30000, pollMs: 5,
      env: { LAB_LOCK_TEST_HOOKS: '1', LAB_LOCK_TEST_IDENTITY_DELAY_MS: '250' },
      testName: 'lock: slow identity query', dirs
    });
    const elapsed = Date.now() - t0;
    assert.strictEqual(readFileText(r.counterFile), String(nproc * ninc));
    assert.strictEqual(r.acquired, nproc * ninc);
    assert.ok(elapsed < 30000, `round finished in ${elapsed}ms`);
    // With a 250ms simulated spawn, an unthrottled loop would issue hundreds of
    // queries; the fix must keep this bounded per worker.
    assert.ok(r.queries <= nproc * 6, `identity queries=${r.queries} (expected <= ${nproc * 6})`);
    for (const res of r.runs) assert.strictEqual(res.code, 0, res.err);
    assert.strictEqual(readFileText(r.counterFile), String(nproc * ninc));
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
    const greenRegression = JSON.stringify({ platform: 'linux', total: 80, passed: 80, failed: 0, skipped: 0, requireBrowser: true, failures: [] });
    const needs = {
      static: { result: 'success', outputs: { caps_regressions: greenRegression } },
      server: { result: 'success', outputs: { caps_server_local: caps('server_local'), tailscale_outcome: 'success', backend_pid: '4242', rdp_configured: 'true' } },
      client: { result: 'success', outputs: { caps_client_local: caps('client_local'), caps_tailnet: caps('tailnet'), caps_remote: caps('remote'), backend_pid_remote: '4242', caps_regressions: greenRegression } }
    };
    assert.strictEqual(build(needs).verdict, 'VERIFIED');
    const n2 = JSON.parse(JSON.stringify(needs)); n2.client.outputs.backend_pid_remote = '999';
    const r2 = build(n2);
    assert.strictEqual(r2.verdict, 'NOT_VERIFIED');
    assert.match(r2.capabilities.backend_readiness_remote.reason, /IDENTITY_MISMATCH/);
    const n3 = JSON.parse(JSON.stringify(needs)); n3.server.outputs.tailscale_outcome = 'failure'; n3.server.outputs.oidc_sub = 'repo:o@1/r@2:pull_request';
    n3.client.outputs.caps_tailnet = JSON.stringify({ tailnet_connectivity: { s: 'BLOCKED', r: 'SERVER_NEVER_JOINED_TAILNET' } }); delete n3.client.outputs.caps_remote;
    const r3 = build(n3);
    // the reason reports the observed category; the OIDC subject is not used as
    // an inferred cause (it is recorded separately in diagnostics.oidcSubject)
    assert.match(r3.capabilities.tailnet_connectivity.reason, /EXTERNAL_TAILSCALE_JOIN_FAILED: category=JOIN_FAILED_UNCLASSIFIED/);
    assert.strictEqual(r3.diagnostics.oidcSubject, 'repo:o@1/r@2:pull_request');
    assert.doesNotMatch(r3.capabilities.tailnet_connectivity.reason, /subject must match|subject=repo/i);
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
    assert.deepStrictEqual(summary.phases.map(p => `${p.name}:${p.ok}`), ['identity:true', 'okfile:true', 'listener:true', 'readiness:true']);
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


  // ===== helper runner (the run 39548093609 ability 2 failure mode) =====
  // The original defect: execFileSync('powershell.exe', ..., {timeout:30000})
  // blocked the event loop, threw a bare "spawnSync powershell.exe ETIMEDOUT"
  // and lost the helper's own output. These tests pin the replacement contract.
  await test('ps: hanging helper reaches a bounded timeout, keeps stderr and reports its call site', async () => {
    const t0 = Date.now();
    const r = await psLib.runPowerShell({ script: '/nonexistent/Get-ProcessSnapshot.ps1', args: ['-ProcessIds', '1'], timeoutMs: 1200, operation: 'process-identity', env: fakePsEnv('hang') });
    const elapsed = Date.now() - t0;
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.errorCode, 'POWERSHELL_TIMEOUT');
    assert.ok(r.timedOut, 'timedOut flag must be set');
    assert.ok(elapsed >= 1000 && elapsed < 6000, `bounded: elapsed=${elapsed}ms`);
    assert.ok(r.effectiveTimeoutMs <= 1200, 'timeout clamped to the requested budget');
    assert.match(r.stderr, /HANGING_HELPER/, 'stderr captured before the timeout');
    assert.match(r.stdout, /partial-output-before-hang/, 'stdout captured before the timeout');
    assert.match(r.callSite, /run-regressions\.js:\d+/, `call site recorded: ${r.callSite}`);
    assert.strictEqual(r.operation, 'process-identity');
    const d = psLib.describe(r);
    assert.match(d, /POWERSHELL_TIMEOUT/);
    assert.match(d, /site=/);
    assert.match(d, /stderr=/);
  });

  await test('ps: the enclosing deadline clamps the helper budget (no overrun past the deadline)', async () => {
    const t0 = Date.now();
    const r = await psLib.runPowerShell({ script: '/nonexistent/x.ps1', timeoutMs: 30000, deadlineAt: Date.now() + 700, operation: 'deadline-clamp', env: fakePsEnv('hang') });
    const elapsed = Date.now() - t0;
    assert.strictEqual(r.errorCode, 'POWERSHELL_TIMEOUT');
    assert.ok(r.budgetClamped, 'must report that the budget was clamped');
    assert.ok(elapsed < 4000, `must not outlive the deadline: ${elapsed}ms`);
  });

  await test('ps: an exhausted budget never spawns a helper', async () => {
    const r = await psLib.runPowerShell({ script: '/nonexistent/x.ps1', timeoutMs: 5000, deadlineAt: Date.now() - 1, operation: 'exhausted', env: fakePsEnv('hang') });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.errorCode, 'BUDGET_EXHAUSTED');
    assert.strictEqual(r.elapsedMs < 500, true, `returned immediately: ${r.elapsedMs}ms`);
  });

  await test('ps: non-zero exit retains stderr, exit code and operation', async () => {
    const r = await psLib.runPowerShell({ script: '/nonexistent/x.ps1', timeoutMs: 5000, operation: 'failing-helper', env: fakePsEnv('fail') });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.errorCode, 'POWERSHELL_EXIT_NONZERO');
    assert.strictEqual(r.code, 7);
    assert.match(r.stderr, /SIMULATED_HELPER_FAILURE/);
    assert.match(psLib.describe(r), /exit=7/);
  });

  await test('ps: success keeps stdout and resolves the resolved executable', async () => {
    const r = await psLib.runPowerShell({ script: '/nonexistent/x.ps1', timeoutMs: 5000, operation: 'ok-helper', env: fakePsEnv('ok') });
    assert.strictEqual(r.ok, true, psLib.describe(r));
    assert.strictEqual(JSON.parse(r.stdout.trim()).platform, 'win32');
    assert.ok(r.exe, 'the executed helper binary is recorded');
  });

  await test('proc: a helper failure becomes a structured, sanitized diagnostic (not a bare ETIMEDOUT)', async () => {
    const env = fakePsEnv('hang');
    Object.assign(process.env, env);
    psLib.resetResolvedForTests();
    try {
      process.env.LAB_PROC_FORCE_POWERSHELL = '1';
      let err = null;
      try { await proc.getProcessAsync(1234, { timeoutMs: 900, operation: 'process-identity-timeout-test', env: fakePsEnv('hang') }); } catch (e) { err = e; }
      assert.ok(err, 'must throw a structured error');
      assert.match(err.message, /POWERSHELL_HELPER_FAILED/);
      assert.match(err.message, /POWERSHELL_TIMEOUT/);
      assert.match(err.message, /op=process-identity-timeout-test/);
      assert.match(err.message, /site=scripts\/lib\/proc\.js/);
      assert.strictEqual(err.code, 'POWERSHELL_TIMEOUT');
      assert.strictEqual(err.operation, 'process-identity-timeout-test');
      assert.ok(err.diagnostic.timeoutMs <= 900);
      assert.match(err.diagnostic.stderr, /HANGING_HELPER/);
    } finally {
      delete process.env.LAB_PS_EXE; delete process.env.LAB_PS_ARGV_PREFIX; delete process.env.LAB_PROC_FORCE_POWERSHELL;
      psLib.resetResolvedForTests();
    }
  });

  await test('supervisor: a helper timeout is an UNVERIFIED guard, never a backend crash', async () => {
    const dirs = freshDirs(); const port = await freePort();
    const r = await run(process.execPath, [S('backend-supervisor.js'), '--server-cmd', JSON.stringify([process.execPath, FAKE]),
      '--ok-file', path.join(dirs.art, 'ok.txt'), '--port', String(port), '--no-mc',
      '--identity-timeout-ms', '900', '--listener-timeout-ms', '900', '--ready-timeout-ms', '15000', '--startup-budget-ms', '30000'],
      { env: childEnv(dirs, { MODE: 'ok', EXPECT_SHA: SHA, LAB_PROC_FORCE_POWERSHELL: '1', ...fakePsEnv('hang') }), timeoutMs: 90000 });
    const summary = JSON.parse(fs.readFileSync(path.join(dirs.art, 'backend-supervisor.json'), 'utf8'));
    const byName = Object.fromEntries(summary.phases.map(p => [p.name, p]));
    // the backend is healthy: readiness must still be established
    assert.strictEqual(byName.readiness.ok, true, JSON.stringify(summary.phases));
    assert.strictEqual(byName.okfile.ok, true, JSON.stringify(summary.phases));
    assert.strictEqual(r.code, 0, r.out + r.err);
    // the helpers failed: recorded as degraded guards with their diagnostics
    assert.strictEqual(byName.identity.ok, false);
    assert.strictEqual(byName.identity.code, 'GUARD_IDENTITY_UNVERIFIED');
    assert.strictEqual(byName.identity.severity, 'DEGRADED');
    assert.strictEqual(byName.listener.code, 'GUARD_LISTENER_UNVERIFIED');
    assert.strictEqual(byName.listener.severity, 'DEGRADED');
    assert.ok(summary.helperFailures.length >= 2, JSON.stringify(summary.helperFailures));
    for (const h of summary.helperFailures) { assert.ok(h.callSite, 'call site retained'); assert.ok(h.timeoutMs, 'timeout retained'); }
    // never misreported as a crash, and identity is explicitly UNVERIFIED
    for (const p of summary.phases) assert.ok(!/^BACKEND_(EXITED|DIED)/.test(p.code || ''), `no crash claim: ${p.code}`);
    assert.strictEqual(summary.backendIdentityState, 'UNVERIFIED');
    assert.strictEqual(summary.livenessAtExit.alive, true, 'liveness evidence captured before cleanup');
    // safe cleanup without a verified identity: the direct child handle only
    assert.strictEqual(summary.stopMethod, 'child-handle');
    await new Promise(res => setTimeout(res, 400));
    assert.ok(!alive(Number(byName.okfile && (summary.backend && summary.backend.pid)) || 0) || !summary.backend, 'supervised backend stopped');
  });

  await test('supervisor: a crashed backend is still distinguished from an unverified one', async () => {
    const dirs = freshDirs(); const port = await freePort();
    await run(process.execPath, [S('backend-supervisor.js'), '--server-cmd', JSON.stringify([process.execPath, FAKE]),
      '--ok-file', path.join(dirs.art, 'ok.txt'), '--port', String(port), '--no-mc', '--identity-timeout-ms', '900', '--listener-timeout-ms', '900'],
      { env: childEnv(dirs, { MODE: 'exit-early', EXPECT_SHA: SHA, LAB_PROC_FORCE_POWERSHELL: '1', ...fakePsEnv('hang') }), timeoutMs: 90000 });
    const summary = JSON.parse(fs.readFileSync(path.join(dirs.art, 'backend-supervisor.json'), 'utf8'));
    const fatal = summary.phases.find(p => !p.ok && p.severity === 'FATAL');
    assert.ok(fatal, JSON.stringify(summary.phases));
    assert.match(fatal.code, /BACKEND_EXITED/);
    assert.strictEqual(summary.livenessAtExit.alive, false);
  });

  await test('cleanup: a helper timeout performs no kills and fails loudly', async () => {
    const dirs = freshDirs();
    // a real, unrelated-ish process owned by this run's record: it must survive
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 250));
    const rec = { schema: 2, runId: 'reg-run', runAttempt: '1', pid: sleeper.pid, createTime: 'win32:unused-for-this-test', name: 'node', role: 'backend', anchor: null };
    fs.mkdirSync(dirs.state, { recursive: true });
    fs.writeFileSync(path.join(dirs.state, 'process-registry.json'), JSON.stringify({ schema: 2, records: [rec] }, null, 2));
    try {
      const r = await run(process.execPath, [S('cleanup-lab.js'), '--mode', 'postflight', '--deadline-ms', '1200', '--out', path.join(dirs.art, 'cleanup.json')],
        { env: childEnv(dirs, { LAB_PROC_FORCE_POWERSHELL: '1', ...fakePsEnv('hang') }), timeoutMs: 60000 });
      const summary = JSON.parse(fs.readFileSync(path.join(dirs.art, 'cleanup.json'), 'utf8'));
      assert.strictEqual(r.code, 4, `cleanup must fail with its own code: ${r.code} ${r.out}${r.err}`);
      assert.match(String(summary.error), /CLEANUP_SNAPSHOT_FAILED/);
      assert.strictEqual(summary.aborted, 'NO_KILLS_PERFORMED');
      assert.strictEqual(summary.terminated, 0);
      assert.ok(summary.helperDiagnostic && summary.helperDiagnostic.callSite, 'helper diagnostic retained');
      assert.ok(alive(sleeper.pid), 'nothing may be killed when the identity snapshot is unavailable');
    } finally { try { sleeper.kill('SIGKILL'); } catch (e) { /* gone */ } }
  });

  // ===== tailnet failure classification =====
  await test('tailnet: the true category is retained (rejection is not inferred from a subject)', async () => {
    const base = { configured: true, oidcOk: true, joinOutcome: 'failure' };
    const rejected = tailnetDiag.classify({ ...base, exchange: { transport: 'ok', status: 403, tokenIssued: false, message: 'invalid subject token' } });
    assert.strictEqual(rejected.category, 'TRUST_CREDENTIAL_REJECTED');
    assert.match(rejected.detail, /HTTP 403/);
    assert.match(rejected.detail, /invalid subject token/);

    const accepted = tailnetDiag.classify({ ...base, exchange: { transport: 'ok', status: 200, tokenIssued: true } });
    assert.strictEqual(accepted.category, 'JOIN_FAILED_AFTER_SUCCESSFUL_EXCHANGE');
    assert.match(accepted.detail, /NOT a subject\/audience mismatch/);

    assert.strictEqual(tailnetDiag.classify({ ...base, joinOutcome: 'success', exchange: { transport: 'ok', status: 200, tokenIssued: true } }).category, 'JOIN_OK');
    assert.strictEqual(tailnetDiag.classify({ configured: false, oidcOk: false }).category, 'MISSING_CONFIG');
    assert.strictEqual(tailnetDiag.classify({ configured: true, oidcOk: false }).category, 'OIDC_UNAVAILABLE');
    assert.strictEqual(tailnetDiag.classify({ ...base, exchange: { transport: 'error', status: null, errorChain: 'ENOTFOUND' } }).category, 'TAILSCALE_API_UNREACHABLE');
    assert.strictEqual(tailnetDiag.classify({ ...base, exchange: { transport: 'ok', status: 503 } }).category, 'TAILSCALE_API_ERROR');

    // Post-exchange key-creation & local CLI sub-classifications
    const tagDenied = tailnetDiag.classify({
      ...base,
      exchange: { transport: 'ok', status: 200, tokenIssued: true },
      keyProbe: { transport: 'ok', status: 400, requestedTags: ['tag:ci'], message: 'requested tags [tag:ci] are invalid or not permitted' }
    });
    assert.strictEqual(tagDenied.category, 'TAG_NOT_PERMITTED');
    assert.match(tagDenied.detail, /NOT a subject\/audience mismatch/);
    assert.match(tagDenied.detail, /requested tags \[tag:ci\] are invalid or not permitted/);

    const keyDenied404 = tailnetDiag.classify({
      ...base,
      exchange: { transport: 'ok', status: 200, tokenIssued: true },
      credential: { requestedTags: ['tag:ci'], keysRead: { transport: 'ok', status: 404, message: 'not found' }, devicesRead: { transport: 'ok', status: 404, message: 'not found' } },
      cliProbe: { version: '1.94.2', serviceState: 'RUNNING', backendState: 'NeedsLogin', upProbe: { exitCode: 1, stderr: 'unexpected error while creating authkey: Status: 404, Message: "not found"' } }
    });
    assert.strictEqual(keyDenied404.category, 'CREDENTIAL_CANNOT_CREATE_AUTH_KEYS');
    assert.match(keyDenied404.detail, /POST \/api\/v2\/tailnet\/-\/keys/);
    assert.match(keyDenied404.detail, /404/);
    assert.match(keyDenied404.detail, /NOT a subject\/audience mismatch/);
    assert.strictEqual(tailnetDiag.firstErrorLine({ upProbe: { stderr: '\nunexpected error while creating authkey: Status: 404, Message: "not found"\nsecond' } }),
      'unexpected error while creating authkey: Status: 404, Message: "not found"');

    const scopeDenied = tailnetDiag.classify({
      ...base,
      exchange: { transport: 'ok', status: 200, tokenIssued: true },
      keyProbe: { transport: 'ok', status: 403, requestedTags: ['tag:ci'], message: 'API token does not grant access to perform this action' }
    });
    assert.strictEqual(scopeDenied.category, 'MISSING_AUTH_KEYS_PERMISSION');
    assert.match(scopeDenied.detail, /HTTP 403.*API token does not grant access/);

    const oldVer = tailnetDiag.classify({
      ...base,
      exchange: { transport: 'ok', status: 200, tokenIssued: true },
      cliProbe: { version: '1.88.4', serviceState: 'RUNNING', backendState: 'NeedsLogin', upProbe: { exitCode: 1, stderr: 'flag provided but not defined: -client-id' } }
    });
    assert.strictEqual(oldVer.category, 'CLIENT_VERSION_UNSUPPORTED');

    const svcDown = tailnetDiag.classify({
      ...base,
      exchange: { transport: 'ok', status: 200, tokenIssued: true },
      cliProbe: { version: '1.94.2', serviceState: 'STOPPED', backendState: null, upProbe: { exitCode: 1, stderr: 'failed to connect to local Tailscale service' } }
    });
    assert.strictEqual(svcDown.category, 'TAILSCALE_SERVICE_NOT_READY');
  });

  await test('lock: foreign live PID reuse (separate live child process, mismatched createTime) is recovered', async () => {
    const lock = require('./lib/lock');
    const dirs = freshDirs();
    const lockDir = path.join(dirs.state, 'foreign-reuse.lock.d');
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 150));
    try {
      fs.mkdirSync(lockDir);
      // Old lock > 5s ago whose PID happens to match a currently running unrelated process
      fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
        token: 'stale-foreign',
        pid: sleeper.pid,
        createTime: 'stale-create-time-from-dead-process',
        acquiredAt: new Date(Date.now() - 10000).toISOString()
      }));
      const h = lock.acquireLock({ lockDir, timeoutMs: 5000, pollMs: 50 });
      assert.ok(h.events.some(e => e.event === 'STALE_LOCK_RECOVERED'), JSON.stringify(h.events));
      assert.strictEqual(lock.releaseLock(h), true);
    } finally {
      try { sleeper.kill('SIGKILL'); } catch (e) { /* ignore */ }
    }
  });

  // ===== report: both failures preserved =====
  const reportNeeds = (over = {}) => ({
    static: {
      result: 'success',
      outputs: {
        caps_regressions: JSON.stringify({ platform: 'linux', total: 80, passed: 80, failed: 0, skipped: 0, requireBrowser: true, failures: [] })
      },
      ...(over.static || {})
    },
    server: {
      result: 'failure',
      outputs: {
        caps_server_local: JSON.stringify({
          backend_readiness_server_local: { s: 'FAIL', r: 'SUPERVISOR_IDENTITY: GUARD_IDENTITY_UNVERIFIED: POWERSHELL_HELPER_FAILED: POWERSHELL_TIMEOUT op=process-identity site=scripts/lib/proc.js:120' },
          dashboard_server_local: { s: 'BLOCKED', r: 'DEPENDS_ON_BACKEND: SUPERVISOR_IDENTITY' }
        }),
        tailscale_outcome: 'failure',
        ts_configured: 'true',
        tailnet_category: 'TRUST_CREDENTIAL_REJECTED',
        tailnet_detail: 'exchange rejected HTTP 403: invalid subject token',
        oidc_sub: 'repo:dictationb1@342137832/supreme-lamp-lab@1425092794:pull_request',
        supervisor_first_failure: 'identity:GUARD_IDENTITY_UNVERIFIED',
        supervisor_degraded_guards: 'identity:GUARD_IDENTITY_UNVERIFIED,listener:GUARD_LISTENER_UNVERIFIED',
        backend_identity_state: 'UNVERIFIED',
        rdp_configured: 'true'
      },
      ...(over.server || {})
    },
    client: {
      result: 'failure',
      outputs: {
        caps_client_local: JSON.stringify({ browser_synthetic: { s: 'PASS', r: null }, native_screenshot: { s: 'PASS', r: null } }),
        caps_tailnet: JSON.stringify({ tailnet_connectivity: { s: 'BLOCKED', r: 'SERVER_NEVER_JOINED_TAILNET' } }),
        caps_remote: JSON.stringify({
          backend_readiness_remote: { s: 'BLOCKED', r: 'DEPENDS_ON_TAILNET' }, dashboard_client: { s: 'BLOCKED', r: 'DEPENDS_ON_TAILNET' },
          web_desktop: { s: 'BLOCKED', r: 'DEPENDS_ON_TAILNET' }, rdp_auto_login: { s: 'BLOCKED', r: 'DEPENDS_ON_TAILNET' }
        }),
        caps_regressions: JSON.stringify({ platform: 'win32', total: 80, passed: 80, failed: 0, skipped: 0, requireBrowser: true, failures: [] })
      },
      ...(over.client || {})
    }
  });

  await test('report: a supervisor guard timeout and a tailnet rejection are BOTH preserved', async () => {
    const rep = reportLib.build(reportNeeds());
    assert.strictEqual(rep.verdict, 'NOT_VERIFIED');
    const caps = rep.independentCauses.map(c => c.capability);
    assert.ok(caps.includes('backend_readiness_server_local'), JSON.stringify(caps));
    assert.ok(caps.includes('tailnet_connectivity'), JSON.stringify(caps));
    // both subsystems visible, neither hidden behind a single first-cause field
    assert.ok(rep.bySubsystem.server_local && rep.bySubsystem.server_local.length, JSON.stringify(rep.bySubsystem));
    assert.ok(rep.bySubsystem.tailnet_or_remote && rep.bySubsystem.tailnet_or_remote.length, JSON.stringify(rep.bySubsystem));
    // the tailnet reason carries the observed category and does not assert a subject
    const tn = rep.capabilities.tailnet_connectivity;
    assert.match(tn.reason, /category=TRUST_CREDENTIAL_REJECTED/);
    assert.doesNotMatch(JSON.stringify(rep.capabilities), /subject must match/i);
    assert.strictEqual(rep.diagnostics.tailnetCategory, 'TRUST_CREDENTIAL_REJECTED');
  });

  await test('report: an unverified diagnostic is never labelled a proven backend crash', async () => {
    const rep = reportLib.build(reportNeeds());
    assert.strictEqual(rep.diagnostics.backendFailureClass, 'UNVERIFIED_DIAGNOSTIC_TIMEOUT');
    assert.strictEqual(rep.diagnostics.backendHealthProven, false);
    assert.strictEqual(reportLib.classifyBackendFailure('SUPERVISOR_OKFILE: BACKEND_EXITED_BEFORE_LISTENING: exit={"code":3}'), 'BACKEND_PROCESS_FAILED');
    assert.strictEqual(reportLib.classifyBackendFailure('READINESS_WRONG_PROCESS: pid 9 != 7'), 'BACKEND_UNHEALTHY');
  });

  await test('report: prerequisites (BLOCKED) are listed separately from the causal FAIL', async () => {
    const rep = reportLib.build(reportNeeds());
    assert.deepStrictEqual(rep.diagnostics.prerequisitesMissing.sort(),
      ['backend_readiness_remote', 'dashboard_client', 'dashboard_server_local', 'rdp_auto_login', 'tailnet_connectivity', 'web_desktop'].sort());
    assert.deepStrictEqual(rep.diagnostics.rootCauses.map(c => c.capability).sort(),
      ['backend_readiness_server_local', 'tailnet_connectivity'].sort());
    assert.deepStrictEqual(rep.diagnostics.downstreamBlocked.map(c => c.capability).sort(),
      ['backend_readiness_remote', 'dashboard_client', 'dashboard_server_local', 'rdp_auto_login', 'web_desktop'].sort());
    const causal = rep.independentCauses.filter(c => c.status === 'FAIL').map(c => c.capability);
    assert.ok(causal.includes('backend_readiness_server_local'), JSON.stringify(rep.independentCauses));
    assert.strictEqual(rep.independentCauses.find(c => c.capability === 'tailnet_connectivity').category, 'TRUST_CREDENTIAL_REJECTED');
  });

  await test('report: all nine capabilities PASS is NOT VERIFIED when a regression gate failed', async () => {
    const ok = reportNeeds();
    ok.static.outputs.caps_regressions = JSON.stringify({ platform: 'linux', total: 80, passed: 80, failed: 0, skipped: 0, requireBrowser: true, failures: [] });
    ok.server.outputs.caps_server_local = JSON.stringify({ backend_readiness_server_local: { s: 'PASS', r: null }, dashboard_server_local: { s: 'PASS', r: null } });
    ok.server.outputs.tailscale_outcome = 'success';
    ok.client.outputs.caps_tailnet = JSON.stringify({ tailnet_connectivity: { s: 'PASS', r: null } });
    ok.client.outputs.caps_remote = JSON.stringify({
      backend_readiness_remote: { s: 'PASS', r: null }, dashboard_client: { s: 'PASS', r: null }, web_desktop: { s: 'PASS', r: null }, rdp_auto_login: { s: 'PASS', r: null }
    });
    ok.server.outputs.backend_pid = '1000'; ok.client.outputs.backend_pid_remote = '1000';
    ok.client.outputs.caps_regressions = JSON.stringify({ platform: 'win32', total: 80, passed: 79, failed: 1, skipped: 0, requireBrowser: true, failures: [{ name: 'lock: 4 concurrent processes x 5 increments = mutual exclusion (no lost update)', detail: 'LOCK_ACQUISITION_FAILED' }] });
    const rep = reportLib.build(ok);
    assert.strictEqual(rep.verdict, 'NOT_VERIFIED');
    assert.strictEqual(rep.regressions.client.status, 'FAIL');
    assert.ok(rep.independentCauses.some(c => c.capability === 'regressions_client' && c.category === 'REGRESSION_GATE_FAILED'), JSON.stringify(rep.independentCauses));
    assert.match(rep.firstCause.reason, /REGRESSION_GATE_FAILED|regressions/);
    // a skipped required regression is also a gate failure
    ok.client.outputs.caps_regressions = JSON.stringify({ platform: 'win32', total: 80, passed: 72, failed: 0, skipped: 8, requireBrowser: true, failures: [] });
    assert.strictEqual(reportLib.build(ok).verdict, 'NOT_VERIFIED');
    // and a missing summary can never be treated as green
    delete ok.client.outputs.caps_regressions;
    assert.strictEqual(reportLib.build(ok).verdict, 'NOT_VERIFIED');
    assert.strictEqual(reportLib.build(ok).regressions.client.status, 'MISSING');
  });

  await test('report: VERIFIED is still impossible without every capability PASS', async () => {
    const needs = reportNeeds();
    const rep = reportLib.build(needs);
    assert.strictEqual(rep.verdict, 'NOT_VERIFIED');
    // a single failing required capability blocks the verdict
    const ok = reportNeeds();
    ok.server.outputs.caps_server_local = JSON.stringify({ backend_readiness_server_local: { s: 'PASS', r: null }, dashboard_server_local: { s: 'PASS', r: null } });
    ok.server.outputs.tailscale_outcome = 'success';
    ok.client.outputs.caps_tailnet = JSON.stringify({ tailnet_connectivity: { s: 'PASS', r: null } });
    ok.client.outputs.caps_remote = JSON.stringify({
      backend_readiness_remote: { s: 'PASS', r: null }, dashboard_client: { s: 'PASS', r: null }, web_desktop: { s: 'PASS', r: null }, rdp_auto_login: { s: 'PASS', r: null }
    });
    ok.server.outputs.backend_pid = '1000'; ok.client.outputs.backend_pid_remote = '1000';
    assert.strictEqual(reportLib.build(ok).verdict, 'VERIFIED');
    ok.client.outputs.caps_remote = JSON.stringify({ ...JSON.parse(ok.client.outputs.caps_remote), rdp_auto_login: { s: 'BLOCKED', r: 'DEPENDS_ON_RDP' } });
    assert.strictEqual(reportLib.build(ok).verdict, 'NOT_VERIFIED');
  });

  // ===== RDP logon evidence (observer vs login failure) =====
  await test('logon: type 10 is proven directly or by same-instant XML correlation, never inferred from a remote IP', async () => {
    const { evaluateLogonStatus, normalizeIp } = logonLib;
    const ctx = { baselineIso: '2026-10-21T07:59:45.000Z', clientIp: '100.93.94.15', expectedUser: 'slabrdp' };
    const fresh = '2026-10-21T08:00:10.250Z';
    // direct: a fixed app build reports the type it parsed -> candidate
    let v = evaluateLogonStatus({ connected: true, ts: fresh, sourceIp: '100.93.94.15', logonType: '10', checked: 3, user: 'slabrdp' }, ctx);
    assert.strictEqual(v.state, 'candidate'); assert.strictEqual(v.proof, 'direct');
    // the pinned app build answers logonType:'' when a user filter is
    // supplied (second -notmatch clobbers $Matches). A remote source IP is
    // NOT a logon type: this is 'needs-type-proof', never a candidate.
    v = evaluateLogonStatus({ connected: true, ts: fresh, sourceIp: '100.93.94.15', logonType: '', checked: 3, user: 'slabrdp' }, ctx);
    assert.strictEqual(v.state, 'needs-type-proof');
    v = evaluateLogonStatus({ connected: true, ts: fresh, sourceIp: '::ffff:100.93.94.15', logonType: '', checked: 1, user: 'slabrdp' }, ctx);
    assert.strictEqual(v.state, 'needs-type-proof');
    assert.strictEqual(normalizeIp('[::FFFF:100.93.94.15]'), '100.93.94.15');
    // stale event (before the baseline) can never pass, however it is labelled
    v = evaluateLogonStatus({ connected: true, ts: '2026-10-21T07:59:44.999Z', sourceIp: '100.93.94.15', logonType: '10', checked: 1, user: 'slabrdp' }, ctx);
    assert.strictEqual(v.state, 'not-observed');
    // a console/cached logon (type 2/11, no remote source) is not our RDP logon
    v = evaluateLogonStatus({ connected: true, ts: fresh, sourceIp: '-', logonType: '2', checked: 2, user: 'slabrdp' }, ctx);
    assert.strictEqual(v.state, 'not-observed');
    v = evaluateLogonStatus({ connected: true, ts: fresh, sourceIp: '', logonType: '', checked: 2, user: 'slabrdp' }, ctx);
    assert.strictEqual(v.state, 'not-observed');
    // another machine's type-10 is a terminal wrong-source, not "keep waiting"
    v = evaluateLogonStatus({ connected: true, ts: fresh, sourceIp: '100.64.0.99', logonType: '10', checked: 2, user: 'slabrdp' }, ctx);
    assert.strictEqual(v.state, 'wrong-source');
    // a reported non-10 type WITH our source address contradicts event semantics
    v = evaluateLogonStatus({ connected: true, ts: fresh, sourceIp: '100.93.94.15', logonType: '2', checked: 2, user: 'slabrdp' }, ctx);
    assert.strictEqual(v.state, 'type-mismatch');
    v = evaluateLogonStatus({ connected: true, ts: fresh, sourceIp: '100.93.94.15', logonType: '11', checked: 2, user: 'slabrdp' }, ctx);
    assert.strictEqual(v.state, 'type-mismatch');
    // the user echo must match the intended user when present
    v = evaluateLogonStatus({ connected: true, ts: fresh, sourceIp: '100.93.94.15', logonType: '10', user: 'other', checked: 2 }, ctx);
    assert.strictEqual(v.state, 'not-observed');
    // nothing observed yet / observer could not read the log (checked=0)
    v = evaluateLogonStatus({ connected: false, ts: '', sourceIp: '', logonType: '', checked: 0 }, ctx);
    assert.strictEqual(v.state, 'not-observed');
    v = evaluateLogonStatus(null, ctx);
    assert.strictEqual(v.state, 'not-observed');
  });

  await test('logon: stale type-2 / unrelated authLast records are rejected (run 39575343527 shape)', async () => {
    const { evaluateNativeCrossCheck, evaluateLogonStatus } = logonLib;
    const cand = '2026-10-21T10:39:10.250Z';
    const baseline = '2026-10-21T10:38:40.000Z';
    const opts = { baselineIso: baseline };
    // THE observed run: authLast=success type=2 at 10:32:32 (the runner's own
    // console logon), scanTs after everything. It must neither prove a fresh
    // RemoteInteractive logon nor stand in for one.
    const staleType2 = {
      result: 'success', logonType: '2', logonKind: 'interactive', sub: '', subMeaning: '', probeError: '',
      count4624: 8, count4625: 0, eventTs: '2026-10-21T10:32:32.2344973Z', scanTs: '2026-10-21T10:40:26.3404905Z'
    };
    let v = evaluateNativeCrossCheck(staleType2, cand, opts);
    assert.notStrictEqual(v.state, 'confirmed', JSON.stringify(v));
    assert.strictEqual(v.state, 'contradicted', JSON.stringify(v));
    assert.match(v.detail, /unrelated record from before the attempt baseline/);
    // and the body that produced the candidate gap is 'needs-type-proof'
    const body = { connected: true, ts: cand, sourceIp: '100.93.94.15', logonType: '', checked: 13, user: 'slabrdp' };
    assert.strictEqual(evaluateLogonStatus(body, { baselineIso: baseline, clientIp: '100.93.94.15', expectedUser: 'slabrdp' }).state, 'needs-type-proof');
    // a type-2 record AT the candidate instant contradicts it (XML-honest)
    v = evaluateNativeCrossCheck({ ...staleType2, eventTs: cand, logonType: '2', scanTs: '2026-10-21T10:39:31.000Z' }, cand, opts);
    assert.strictEqual(v.state, 'contradicted');
    assert.match(v.detail, /not 10/);
    // an unrelated later success supersedes but never proves OUR instant
    v = evaluateNativeCrossCheck({ ...staleType2, eventTs: '2026-10-21T10:41:00.000Z', logonType: '10', scanTs: '2026-10-21T10:41:31.000Z' }, cand, opts);
    assert.strictEqual(v.state, 'unavailable', JSON.stringify(v));
    // the same-instant XML type-10 record is the ONLY confirmable positive
    v = evaluateNativeCrossCheck({ ...staleType2, eventTs: '2026-10-21T10:39:10.251Z', logonType: '10', logonKind: 'remote-interactive', scanTs: '2026-10-21T10:39:31.000Z' }, cand, opts);
    assert.strictEqual(v.state, 'confirmed');
    // ...and even that is only accepted for the candidate whose own body
    // matched the intended user + client source (needs-type-proof above).
  });

  await test('logon: native-status cross-check confirms, contradicts, or stays unavailable', async () => {
    const { evaluateNativeCrossCheck } = logonLib;
    const cand = '2026-10-21T08:00:10.250Z';
    const base = { result: 'success', sub: '', subMeaning: '', probeError: '', count4624: 1, count4625: 0, scanTs: '2026-10-21T08:00:31.000Z' };
    // same event instant, XML-parsed type 10 -> confirmed
    let v = evaluateNativeCrossCheck({ ...base, eventTs: '2026-10-21T08:00:10.251Z', logonType: '10' }, cand);
    assert.strictEqual(v.state, 'confirmed');
    // same instant but the XML collector says interactive (2) -> contradiction
    v = evaluateNativeCrossCheck({ ...base, eventTs: cand, logonType: '2' }, cand);
    assert.strictEqual(v.state, 'contradicted');
    // scanned after the candidate and its latest success is OLDER -> contradiction
    v = evaluateNativeCrossCheck({ ...base, eventTs: '2026-10-21T07:58:00.000Z', logonType: '10' }, cand);
    assert.strictEqual(v.state, 'contradicted');
    // scanned after the candidate and saw nothing at all -> contradiction
    v = evaluateNativeCrossCheck({ ...base, result: 'none', eventTs: '', logonType: '', count4624: 0 }, cand);
    assert.strictEqual(v.state, 'contradicted');
    // not yet scanned since the event -> unavailable (collector ticks at 30s)
    v = evaluateNativeCrossCheck({ ...base, scanTs: '2026-10-21T08:00:05.000Z', eventTs: '', logonType: '' }, cand);
    assert.strictEqual(v.state, 'unavailable');
    // a later failed logon is the collector headline; it cannot veto ours
    v = evaluateNativeCrossCheck({ ...base, result: 'failed', sub: '0XC000006A', subMeaning: 'wrong-password', eventTs: '2026-10-21T08:00:41.000Z', logonType: '10' }, cand);
    assert.strictEqual(v.state, 'unavailable');
    // collector could not read the Security log -> unavailable, loudly noted
    v = evaluateNativeCrossCheck({ ...base, probeError: 'security-log-unreadable' }, cand);
    assert.strictEqual(v.state, 'unavailable');
    assert.match(v.detail, /security-log-unreadable/);
    v = evaluateNativeCrossCheck(null, cand);
    assert.strictEqual(v.state, 'unavailable');
  });

  await test('rdp file: utf8/no-BOM, CRLF, carries the target directives (production launcher shape)', async () => {
    const dirs = freshDirs();
    const f = path.join(dirs.art, 'slab-lab.rdp');
    const info = mcCheck.writeRdpFile(f, '100.72.174.44', 'slabrdp');
    const b = fs.readFileSync(f);
    assert.ok(info.bytes > 200 && info.bytes === b.length);
    assert.ok(!b.includes(0), 'utf16le NUL bytes must never reach mstsc again');
    assert.notDeepStrictEqual([...b.subarray(0, 2)], [0xff, 0xfe], 'no UTF-16 BOM');
    assert.notDeepStrictEqual([...b.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'no UTF-8 BOM');
    const t = b.toString('utf8');
    assert.ok(t.startsWith('full address:s:100.72.174.44\r\n'), t.slice(0, 60));
    assert.ok(t.includes('\r\nusername:s:slabrdp\r\n'));
    assert.ok(t.includes('prompt for credentials:i:0'));
    assert.ok(t.includes('enablecredsspsupport:i:1'), 'CredSSP/NLA stays on');
  });

  await test('tcp probe: listening loopback ok, closed port fails bounded', async () => {
    const srv = net.createServer(() => {});
    await new Promise(res => srv.listen(0, '127.0.0.1', res));
    const port = srv.address().port;
    const ok = await mcCheck.tcpProbe('127.0.0.1', port, 2000);
    assert.strictEqual(ok.ok, true);
    await new Promise(res => srv.close(res));
    const no = await mcCheck.tcpProbe('127.0.0.1', port, 2000);
    assert.strictEqual(no.ok, false);
    assert.ok(no.error && no.ms < 2000, JSON.stringify(no));
  });

  // ===== report: dependency chains =====
  await test('report: rdp FAIL is first cause; web_desktop BLOCKED is downstream of it (run 39560693766 shape)', async () => {
    const ok = reportNeeds();
    ok.server.outputs.caps_server_local = JSON.stringify({ backend_readiness_server_local: { s: 'PASS', r: null }, dashboard_server_local: { s: 'PASS', r: null } });
    ok.server.outputs.tailscale_outcome = 'success';
    ok.client.outputs.caps_tailnet = JSON.stringify({ tailnet_connectivity: { s: 'PASS', r: null } });
    ok.client.outputs.caps_remote = JSON.stringify({
      backend_readiness_remote: { s: 'PASS', r: null }, dashboard_client: { s: 'PASS', r: null },
      web_desktop: { s: 'BLOCKED', r: 'DEPENDS_ON_RDP_SESSION: capture engine runs at logon of the RDP user; rdp_auto_login=FAIL' },
      rdp_auto_login: { s: 'FAIL', r: 'RDP_LOGON_NOT_OBSERVED: no LogonType 10 for slabrdp from 100.93.94.15 since 2026-10-21T07:59:45.000Z within 90000ms' }
    });
    ok.server.outputs.backend_pid = '1000'; ok.client.outputs.backend_pid_remote = '1000';
    const rep = reportLib.build(ok);
    assert.strictEqual(rep.verdict, 'NOT_VERIFIED');
    assert.strictEqual(rep.firstCause.capability, 'rdp_auto_login', JSON.stringify(rep.firstCause));
    assert.deepStrictEqual(rep.diagnostics.rootCauses.map(c => c.capability), ['rdp_auto_login']);
    assert.deepStrictEqual(rep.diagnostics.downstreamBlocked.map(c => c.capability), ['web_desktop']);
    assert.strictEqual(rep.diagnostics.downstreamBlocked[0].dependsOn, 'rdp_auto_login');
    assert.strictEqual(rep.counts.pass, 7);
    assert.strictEqual(rep.counts.fail, 1);
    assert.strictEqual(rep.counts.blockedDownstream, 1);
  });

  await test('report: an independent web_desktop FAIL stays a root cause next to an rdp FAIL', async () => {
    const ok = reportNeeds();
    ok.server.outputs.caps_server_local = JSON.stringify({ backend_readiness_server_local: { s: 'PASS', r: null }, dashboard_server_local: { s: 'PASS', r: null } });
    ok.server.outputs.tailscale_outcome = 'success';
    ok.client.outputs.caps_tailnet = JSON.stringify({ tailnet_connectivity: { s: 'PASS', r: null } });
    ok.client.outputs.caps_remote = JSON.stringify({
      backend_readiness_remote: { s: 'PASS', r: null }, dashboard_client: { s: 'PASS', r: null },
      web_desktop: { s: 'FAIL', r: 'WEBDESK_NO_FRESH_FRAME: status={"ok":false} task=Ready session=no-session capture=NOT RUNNING' },
      rdp_auto_login: { s: 'FAIL', r: 'RDP_TCP_3389_UNREACHABLE: 100.72.174.44:3389 timeout' }
    });
    ok.server.outputs.backend_pid = '1000'; ok.client.outputs.backend_pid_remote = '1000';
    const rep = reportLib.build(ok);
    assert.deepStrictEqual(rep.diagnostics.rootCauses.map(c => c.capability).sort(), ['rdp_auto_login', 'web_desktop']);
    assert.deepStrictEqual(rep.diagnostics.downstreamBlocked, []);
    assert.strictEqual(rep.counts.fail, 2);
  });

  // ===== dialogs: the real blocking dialog, named =====
  await test('dialogs: an owned/modal RDP-file consent dialog with no main window is BLOCKED / RDP_FILE_CONSENT_REQUIRED', async () => {
    const { classifyRdpAttempt, classifyWindowRows } = require('./lib/dialogs');
    // Exactly the run 39575343527 attempt-2 shape: mstsc alive with
    // MainWindowHandle=0 (title="" hasWindow=false) while an OWNED dialog
    // titled "Remote Desktop Connection" carries the consent checkbox.
    const rows = [{
      hwnd: '0x50A1A', pid: 4672, process: 'mstsc', sessionId: 1,
      ownerPid: 4672, ownerHwnd: '0x30B2C', visible: true,
      className: '#32770', title: 'Remote Desktop Connection',
      controls: [
        { class: 'Static', text: 'Opening Remote Desktop Connection' },
        { class: 'Static', text: 'You are opening an RDP file which will establish a connection to another computer. Connecting to any remote system can expose your PC and data to security risks. Learn more.' },
        { class: 'Button', text: 'I understand and allow RDP files to open on this device for my account', state: 'unchecked' },
        { class: 'Button', text: 'OK', state: '' },
        { class: 'Button', text: 'Cancel', state: '' }
      ]
    }];
    // the main-window heuristic reported nothing - classification must not
    // depend on it (window ownership + control texts carry the evidence)
    assert.deepStrictEqual({ alive: true, title: '', hasWindow: false }.hasWindow, false);
    const g = classifyWindowRows(rows);
    assert.strictEqual(g.kind, 'rdp_file_consent');
    assert.strictEqual(g.seen[0].dialogLike, true, 'owned window must count as dialog-like');
    const cls = classifyRdpAttempt({ windows: rows, account: 'WIN-NFU1JG4VESE\\User', sessionId: 1 });
    assert.strictEqual(cls.status, 'BLOCKED');
    assert.strictEqual(cls.code, 'RDP_FILE_CONSENT_REQUIRED');
    assert.ok(cls.reason.startsWith('RDP_FILE_CONSENT_REQUIRED:'), cls.reason);
    assert.match(cls.reason, /WIN-NFU1JG4VESE\\User/);
    assert.match(cls.manualAction, /I understand and allow RDP files to open/);
    assert.match(cls.manualAction, /per-account/);
    assert.match(cls.manualAction, /do not automate this checkbox/i);
    assert.match(cls.manualAction, /RdpLaunchConsentAccepted/);
    assert.match(cls.manualAction, /do not disable the warning globally/i);
    // the checkbox is unchecked in the captured evidence
    assert.match(cls.evidenceDigest, /unchecked/);
    // Live shape from run 39594245349: the modern dialog's check-box label is
    // a XAML element WM_GETTEXT cannot read, so the captured controls carry
    // only the body static + OK/Cancel. The body sentence is unique to the
    // consent dialog and must classify it without the checkbox label.
    const liveShape = classifyRdpAttempt({
      windows: [{
        hwnd: '0x20B44', pid: 5128, process: 'mstsc', sessionId: 1,
        ownerPid: 5128, ownerHwnd: '0x20C22', visible: true,
        className: '#32770', title: 'Remote Desktop Connection',
        controls: [
          { class: 'Static', text: 'You are opening an RDP file which will establish a connection to another computer. Connecting to any remote system can expose your PC and data to security risks. Learn mo', state: '' },
          { class: 'Button', text: 'OK', state: '' },
          { class: 'Button', text: 'Cancel', state: '' }
        ]
      }]
    });
    assert.strictEqual(liveShape.kind, 'rdp_file_consent');
    assert.strictEqual(liveShape.status, 'BLOCKED');
    assert.strictEqual(liveShape.code, 'RDP_FILE_CONSENT_REQUIRED');
  });

  await test('dialogs: publisher review / certificate warning / credentials prompt / connection error are distinguished', async () => {
    const { classifyRdpAttempt } = require('./lib/dialogs');
    const pub = classifyRdpAttempt({
      windows: [{ pid: 4672, process: 'mstsc', sessionId: 1, className: '#32770', title: 'Remote Desktop Connection', ownerHwnd: '0x1', ownerPid: 4672, controls: [{ class: 'Static', text: 'Remote Desktop Connection Security warning' }, { class: 'Static', text: 'Caution: Unknown remote connection. This remote connection could harm the local or remote computer. Publisher: Unknown publisher' }, { class: 'Button', text: 'Connect' }] }]
    });
    assert.strictEqual(pub.code, 'RDP_FILE_SECURITY_REVIEW_BLOCKING');
    assert.strictEqual(pub.status, 'FAIL');
    const cert = classifyRdpAttempt({
      windows: [{ pid: 4672, process: 'mstsc', sessionId: 1, className: '#32770', title: 'Remote Desktop Connection', ownerHwnd: '0x1', ownerPid: 4672, controls: [{ class: 'Static', text: 'The identity of the remote computer cannot be verified. Do you want to connect anyway?' }, { class: 'Button', text: 'Yes' }] }]
    });
    assert.strictEqual(cert.code, 'RDP_CERT_WARNING_BLOCKING');
    const cred = classifyRdpAttempt({
      windows: [{ pid: 812, process: 'CredentialUIBroker', sessionId: 1, className: '#32770', title: 'Windows Security', ownerHwnd: '0x2', ownerPid: 812, controls: [{ class: 'Static', text: 'Enter your credentials' }, { class: 'Edit', text: '[has-text]' }, { class: 'Button', text: 'OK' }] }]
    });
    assert.strictEqual(cred.code, 'RDP_CREDENTIALS_PROMPT_UNATTENDED');
    const err = classifyRdpAttempt({
      windows: [{ pid: 4672, process: 'mstsc', sessionId: 1, className: '#32770', title: 'Remote Desktop Connection', ownerHwnd: '0x1', ownerPid: 4672, controls: [{ class: 'Static', text: "Remote Desktop Connection can't connect to the remote computer. Error code: 0x904" }] }]
    });
    assert.strictEqual(err.code, 'RDP_CONNECTION_ERROR_DIALOG');
    // consent outranks everything else when several are visible
    const both = classifyRdpAttempt({
      windows: [
        { pid: 4672, process: 'mstsc', sessionId: 1, className: '#32770', title: 'Remote Desktop Connection', controls: [{ class: 'Button', text: 'I understand and allow RDP files to open on this device for my account', state: 'unchecked' }] },
        { pid: 4672, process: 'mstsc', sessionId: 1, className: '#32770', title: 'Remote Desktop Connection', ownerHwnd: '0x1', ownerPid: 4672, controls: [{ class: 'Static', text: 'Caution: Unknown remote connection' }] }
      ]
    });
    assert.strictEqual(both.code, 'RDP_FILE_CONSENT_REQUIRED');
  });

  await test('dialogs: a live session window or the plain mstsc surface is never a blocking dialog', async () => {
    const { classifyRdpAttempt } = require('./lib/dialogs');
    const connected = classifyRdpAttempt({
      windows: [{ pid: 4672, process: 'mstsc', sessionId: 1, className: 'TscShellContainerClass', title: '100.111.132.118 - Remote Desktop Connection', ownerPid: 0, ownerHwnd: '0x0', controls: [] }]
    });
    assert.strictEqual(connected.kind, null);
    assert.strictEqual(connected.blocking, false);
    // the plain mstsc surface (start dialog, no identifiable blocking text) is
    // recorded as unclassified evidence - never a fabricated failure verdict
    const plain = classifyRdpAttempt({
      windows: [{ pid: 4672, process: 'mstsc', sessionId: 1, className: '#32770', title: 'Remote Desktop Connection', ownerPid: 0, ownerHwnd: '0x0', controls: [] }]
    });
    assert.strictEqual(plain.kind, 'unknown', JSON.stringify(plain));
    assert.strictEqual(plain.blocking, false);
    assert.strictEqual(plain.status, null);
    assert.strictEqual(plain.code, 'RDP_UNCLASSIFIED_DIALOG_VISIBLE');
    assert.strictEqual(classifyRdpAttempt({ windows: [] }).blocking, false);
  });

  // ===== event log: three different facts, never conflated =====
  await test('eventlog: zero matching events vs channel-missing vs access-denied vs query failure', async () => {
    const { classifyEventQuery, classifyWinEventError, digestRdpClientLog } = require('./lib/eventlog');
    // the exact run 39575343527 message (Get-WinEvent throws it on 0 rows)
    const zero = classifyEventQuery({
      listed: true,
      queryError: 'No events were found that match the specified selection criteria.',
      queryErrorId: 'NoMatchingLogsFound,Microsoft.PowerShell.Commands.GetWinEventCommand',
      queryExceptionType: 'System.Exception'
    });
    assert.deepStrictEqual(zero, { channelState: 'readable', eventsMatched: 0, zeroMatchingEvents: true, queryError: null });
    assert.match(digestRdpClientLog({ listed: true, queryError: 'No events were found that match the specified selection criteria.', queryErrorId: 'NoMatchingLogsFound' }), /zero matching events/);
    const missing = classifyEventQuery({
      listed: false,
      listLogError: 'There is not an event log on the localhost computer that matches "Microsoft-Windows-TerminalServices-RDPClient/Operational".',
      listLogErrorId: 'ContainerNotFound,Microsoft.PowerShell.Commands.GetWinEventCommand'
    });
    assert.strictEqual(missing.channelState, 'channel-missing');
    assert.strictEqual(missing.zeroMatchingEvents, false);
    assert.match(digestRdpClientLog({ listed: false, listLogError: missing.queryError }), /channel unavailable/);
    const denied = classifyEventQuery({
      listed: true,
      queryError: 'Attempted to perform an unauthorized operation.',
      queryErrorId: 'UnauthorizedAccess,Microsoft.PowerShell.Commands.GetWinEventCommand',
      queryExceptionType: 'System.UnauthorizedAccessException'
    });
    assert.strictEqual(denied.channelState, 'access-denied');
    assert.strictEqual(denied.zeroMatchingEvents, false);
    assert.match(digestRdpClientLog({ listed: true, queryError: denied.queryError, queryExceptionType: 'System.UnauthorizedAccessException' }), /access denied/);
    const failed = classifyEventQuery({ listed: true, queryError: 'Some unexpected failure', queryErrorId: 'Unknown' });
    assert.strictEqual(failed.channelState, 'query-error');
    const ok = classifyEventQuery({ listed: true, eventsMatched: 3 });
    assert.deepStrictEqual(ok, { channelState: 'readable', eventsMatched: 3, zeroMatchingEvents: false, queryError: null });
    // raw error classification is pinned separately too
    assert.strictEqual(classifyWinEventError('No events were found that match the specified selection criteria.'), 'zero-matches');
    assert.strictEqual(classifyWinEventError('Access is denied'), 'access-denied');
  });

  // ===== report: consent prerequisite keeps the stack honestly unmerged =====
  await test('report: RDP_FILE_CONSENT_REQUIRED is a BLOCKED root cause, web_desktop stays downstream, verdict NOT_VERIFIED', async () => {
    const ok = reportNeeds();
    ok.static.result = 'success';
    ok.server.result = 'success';
    ok.server.outputs.caps_server_local = JSON.stringify({ backend_readiness_server_local: { s: 'PASS', r: null }, dashboard_server_local: { s: 'PASS', r: null } });
    ok.server.outputs.tailscale_outcome = 'success';
    ok.client.result = 'failure';
    ok.client.outputs.caps_tailnet = JSON.stringify({ tailnet_connectivity: { s: 'PASS', r: null } });
    ok.client.outputs.caps_client_local = JSON.stringify({ browser_synthetic: { s: 'PASS', r: null }, native_screenshot: { s: 'PASS', r: null } });
    ok.client.outputs.caps_remote = JSON.stringify({
      backend_readiness_remote: { s: 'PASS', r: null }, dashboard_client: { s: 'PASS', r: null },
      web_desktop: { s: 'BLOCKED', r: 'DEPENDS_ON_RDP_SESSION: capture engine runs at logon of the RDP user; rdp_auto_login=BLOCKED' },
      rdp_auto_login: { s: 'BLOCKED', r: "RDP_FILE_CONSENT_REQUIRED: the one-time RDP-file consent dialog is open and ungranted for WIN-NFU1JG4VESE\\User (session 1): \"Opening Remote Desktop Connection\" / \"I understand and allow RDP files to open on this device for my account\"." }
    });
    ok.server.outputs.backend_pid = '1000'; ok.client.outputs.backend_pid_remote = '1000';
    const rep = reportLib.build(ok);
    assert.strictEqual(rep.verdict, 'NOT_VERIFIED');
    assert.strictEqual(rep.firstCause.capability, 'rdp_auto_login');
    assert.strictEqual(rep.firstCause.status, 'BLOCKED');
    assert.deepStrictEqual(rep.diagnostics.rootCauses.map(c => c.capability), ['rdp_auto_login']);
    assert.deepStrictEqual(rep.diagnostics.downstreamBlocked.map(c => c.capability), ['web_desktop']);
    assert.strictEqual(rep.diagnostics.downstreamBlocked[0].dependsOn, 'rdp_auto_login');
    assert.strictEqual(rep.counts.blockedDownstream, 1);
    assert.strictEqual(rep.counts.pass, 7);
    assert.strictEqual(reportLib.causeCategory(rep.firstCause.reason), 'RDP_FILE_CONSENT_REQUIRED');
  });

  // ===== one-time RDP-file consent: SETUP procedure, target validation =====
  await test('rdp target: placeholders, loopback, documentation and expired shapes are refused', async () => {
    const { validateTarget } = require('./lib/rdp-target');
    // The RUNBOOK placeholder copied literally (observed failure mode)
    for (const bad of ['<server-ip>', '<lab-server-ip>', '', '   ', 'server-ip', '${SERVER_IP}', '%SERVER_IP%', 'TODO']) {
      const v = validateTarget(bad);
      assert.strictEqual(v.ok, false, `placeholder accepted: ${JSON.stringify(bad)}`);
      assert.ok(v.error, `no reason given for ${JSON.stringify(bad)}`);
    }
    // Addresses that can never be the outbound lab target
    for (const bad of ['127.0.0.1', '127.1.2.3', '::1', 'localhost', '0.0.0.0', '192.0.2.10', '198.51.100.7', '169.254.3.3']) {
      assert.strictEqual(validateTarget(bad).ok, false, `accepted non-target ${bad}`);
    }
    assert.strictEqual(validateTarget('http://100.79.2.101:7331').ok, false);
    assert.strictEqual(validateTarget('100.79.2.101/32').ok, false);
    assert.strictEqual(validateTarget('barehost').ok, false);
    assert.strictEqual(validateTarget('box.invalid').ok, false);
    // Real lab shapes are accepted, ports normalised, tailnet kept intact
    let v = validateTarget('100.79.2.101');
    assert.strictEqual(v.ok, true); assert.strictEqual(v.kind, 'ipv4'); assert.deepStrictEqual(v.warnings, []);
    v = validateTarget(' 100.79.2.101 ');
    assert.strictEqual(v.host, '100.79.2.101');
    v = validateTarget('100.79.2.101:3389');
    assert.strictEqual(v.ok, true); assert.deepStrictEqual(v.warnings, []);
    v = validateTarget('100.79.2.101:7331');
    assert.strictEqual(v.ok, true); assert.match(v.warnings.join(' '), /ignored; RDP is 3389/);
    v = validateTarget('slab-srv-39598371464-1.tail7cf774.ts.net');
    assert.strictEqual(v.ok, true); assert.strictEqual(v.kind, 'hostname');
    // A public address is allowed but flagged: the operator must confirm it
    v = validateTarget('203.0.113.9');
    assert.strictEqual(v.ok, false, 'TEST-NET must be refused');
    v = validateTarget('8.8.8.8');
    assert.strictEqual(v.ok, true); assert.match(v.warnings.join(' '), /not a tailnet/);
    v = validateTarget('[fd7a:115c:a1e0::1]:3389');
    assert.strictEqual(v.ok, true); assert.strictEqual(v.kind, 'ipv6');
  });

  await test('consent bootstrap: unknown flags / placeholder hosts are refused instead of writing a useless .rdp', async () => {
    const boot = require('./rdp-consent-bootstrap');
    assert.deepStrictEqual(boot.parseArgs(['node', 'x', '--host', '100.79.2.101']).errors, []);
    assert.match(boot.parseArgs(['node', 'x', '--hots', '100.79.2.101']).errors.join(' '), /unknown argument/);
    assert.match(boot.parseArgs(['node', 'x', '--host']).errors.join(' '), /needs a value/);
    assert.ok(boot.parseArgs(['node', 'x']).host === null);
    // CLI: placeholder -> exit 64, nothing written
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'boot-'));
    const outDir = path.join(dir, 'out');
    let r = spawnSync(process.execPath, [S('rdp-consent-bootstrap.js'), '--host', '<server-ip>', '--out', outDir], { encoding: 'utf8' });
    assert.strictEqual(r.status, 64, `exit ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /refused/);
    assert.ok(!fs.existsSync(path.join(outDir, 'slab-consent-bootstrap.rdp')), 'a refused target must not write an .rdp');
    // CLI: unknown flag -> exit 64
    r = spawnSync(process.execPath, [S('rdp-consent-bootstrap.js'), '--host', '100.79.2.101', '--bogus'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 64);
    // CLI: a valid live-shaped target -> the production .rdp shape, and the
    // output names the account + checkout the operator must use
    r = spawnSync(process.execPath, [S('rdp-consent-bootstrap.js'), '--host', '100.79.2.101', '--out', outDir], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /412 bytes, 17 directives/);
    assert.match(r.stdout, /current account: .+\\/);
    assert.match(r.stdout, /checkout: .*supreme-lamp-lab/);
    assert.match(r.stdout, /I understand and allow RDP files to open on this device for my account/);
    assert.match(r.stdout, /Cancel closes the dialog exactly like OK/);
    const text = fs.readFileSync(path.join(outDir, 'slab-consent-bootstrap.rdp'), 'utf8');
    assert.match(text, /full address:s:100\.79\.2\.101/);
    assert.ok(!text.includes('<server-ip>'));
  });

  await test('consent setup: the state machine never turns "dialog closed" or "no dialog" into a consent claim', async () => {
    const { evaluateSamples, EXIT } = require('./lib/consent-state');
    const s = kind => ({ at: '2026-10-21T12:00:00Z', kind });
    // nothing yet
    assert.strictEqual(evaluateSamples([]).state, 'AWAITING_SAMPLES');
    // the observed live shape: owned/modal consent dialog, unchecked
    let v = evaluateSamples([s('rdp_file_consent')]);
    assert.strictEqual(v.state, 'PENDING_CONSENT'); assert.strictEqual(v.exitCode, EXIT.BLOCKED);
    // dialog answered (operator pressed OK) and mstsc lives on
    v = evaluateSamples([s('rdp_file_consent'), s(null), s(null)], { mstscAlive: true });
    assert.strictEqual(v.state, 'CONSENT_DIALOG_CLEARED');
    assert.match(v.detail, /only a fresh unattended run/i);
    // ...but CANCEL closes the same dialog: gone + process dead is NOT a grant
    v = evaluateSamples([s('rdp_file_consent'), s(null), s(null), s(null)], { mstscAlive: false });
    assert.strictEqual(v.state, 'CONSENT_DIALOG_CLOSED_UNCONFIRMED');
    assert.strictEqual(v.exitCode, EXIT.UNCONFIRMED);
    assert.match(v.detail, /Cancel/);
    // a session window proves the file got past the gate
    v = evaluateSamples([s('rdp_file_consent'), s('connected_session')]);
    assert.strictEqual(v.state, 'SESSION_CONNECTED');
    // no dialog at all in the window is ambiguous, never a grant
    v = evaluateSamples([s(null), s(null), s(null)], { mstscAlive: true });
    assert.strictEqual(v.state, 'NO_DIALOG_SEEN'); assert.strictEqual(v.exitCode, EXIT.NO_DIALOG);
    // the FOUR other Windows dialog families stay separate from the consent
    const fam = {
      rdp_file_security_review: 'BLOCKED_SECURITY_REVIEW',
      certificate_warning: 'BLOCKED_CERTIFICATE_WARNING',
      credentials_prompt: 'BLOCKED_CREDENTIALS_PROMPT',
      connection_error: 'BLOCKED_CONNECTION_ERROR'
    };
    for (const [kind, state] of Object.entries(fam)) {
      v = evaluateSamples([s('rdp_file_consent'), s(kind), s(kind)], { mstscAlive: true });
      assert.strictEqual(v.state, state, `${kind} -> ${v.state}`);
      assert.strictEqual(v.exitCode, EXIT.BLOCKED);
      assert.match(v.detail, new RegExp(kind));
      // also when no consent was ever seen
      assert.strictEqual(evaluateSamples([s(kind), s(kind), s(kind)]).state, state);
    }
    // one sample after consent is not "cleared" (needs 2)
    assert.strictEqual(evaluateSamples([s('rdp_file_consent'), s(null)]).state, 'AWAITING_SAMPLES');
  });

  await test('dialogs: the consent manual action names the SETUP procedure, not an unexplained placeholder', async () => {
    const { classifyRdpAttempt } = require('./lib/dialogs');
    const cls = classifyRdpAttempt({
      account: 'WIN-NFU1JG4VESE\\User',
      sessionId: 1,
      windows: [{
        pid: 8836, ownerPid: 8836, process: 'mstsc', sessionId: 1, className: '#32770',
        title: 'Remote Desktop Connection',
        controls: [{ class: 'Static', text: 'You are opening an RDP file which will establish a connection to another computer.' }]
      }]
    });
    assert.strictEqual(cls.code, 'RDP_FILE_CONSENT_REQUIRED');
    // The exact account + session the operator must be signed in as
    assert.match(cls.reason, /WIN-NFU1JG4VESE\\User/);
    assert.match(cls.manualAction, /WIN-NFU1JG4VESE\\User/);
    // No copy-pasteable placeholder and no expired address advice
    assert.ok(!/<[a-z-]*(ip|host|server)[a-z-]*>/i.test(cls.manualAction), cls.manualAction);
    assert.ok(!/--host\s*</.test(cls.manualAction));
    assert.match(cls.manualAction, /mode=consent-setup/);
    assert.match(cls.manualAction, /Never reuse an address from an older run/);
  });

  await test('consent setup CLI: bounded window enforced, placeholder target refused, non-Windows refused', async () => {
    const setup = require('./rdp-consent-setup');
    assert.strictEqual(setup.MAX_TIMEOUT_MS, 900000);
    let r = spawnSync(process.execPath, [S('rdp-consent-setup.js'), '--host', '<server-ip>'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 64, r.stderr); assert.match(r.stderr, /refused/);
    r = spawnSync(process.execPath, [S('rdp-consent-setup.js'), '--host', '100.79.2.101', '--timeout-ms', '9999999'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 64); assert.match(r.stderr, /bounded maximum/);
    r = spawnSync(process.execPath, [S('rdp-consent-setup.js'), '--host', '100.79.2.101', '--bogus'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 64);
    r = spawnSync(process.execPath, [S('rdp-consent-setup.js')], { encoding: 'utf8' });
    assert.strictEqual(r.status, 64); assert.match(r.stderr, /--host is required/);
    if (!IS_WIN) {
      r = spawnSync(process.execPath, [S('rdp-consent-setup.js'), '--host', '100.79.2.101'], { encoding: 'utf8' });
      assert.strictEqual(r.status, 69, r.stderr);
      assert.match(r.stderr, /must run on the Windows client runner/);
    }
  });

  await test('SETUP runs can never emit a verification verdict (setup-summary is explicitly verdict-free)', async () => {
    const dirs = freshDirs();
    const out = path.join(dirs.art, 'setup-summary.json');
    let r = spawnSync(process.execPath, [S('setup-summary.js')], {
      encoding: 'utf8',
      env: { ...process.env, MODE: 'consent-setup', SETUP_STATE: 'CONSENT_DIALOG_CLEARED', SETUP_DETAIL: 'dialog gone', LAB_SHA: 'a22353a', NEEDS_JSON: JSON.stringify({ static: { result: 'success' }, server: { result: 'success' }, client: { result: 'success' } }), SETUP_SUMMARY_PATH: out }
    });
    assert.strictEqual(r.status, 0, r.stderr);
    const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.strictEqual(doc.kind, 'SETUP');
    assert.strictEqual(doc.verdict, 'NO_VERDICT_SETUP_MODE');
    assert.match(doc.note, /not a verification run/i);
    // The ONLY verdict field is the explicit "no verdict" marker: a SETUP run
    // must not be representable as a passing verification.
    assert.ok(!doc.capabilities, 'a SETUP summary must not carry capability verdicts');
    assert.ok(!('verified' in doc));
    assert.ok(!/^VERIFIED$/.test(String(doc.verdict)));
    assert.strictEqual(doc.setupState, 'CONSENT_DIALOG_CLEARED');
    // a SETUP window with no live target is a real failure, not a pass
    r = spawnSync(process.execPath, [S('setup-summary.js')], {
      encoding: 'utf8',
      env: { ...process.env, MODE: 'consent-setup', SETUP_STATE: 'BLOCKED_NO_LIVE_TARGET', SETUP_SUMMARY_PATH: out }
    });
    assert.strictEqual(r.status, 1);
  });

  await test('logon: intended identity must be proven (empty/foreign user echo) and the attempt window is bounded at both ends', async () => {
    const { evaluateLogonStatus, evaluateNativeCrossCheck, DEFAULT_MAX_AFTER_BASELINE_MS } = logonLib;
    const ctx = { baselineIso: '2026-10-21T07:59:45.000Z', clientIp: '100.93.94.15', expectedUser: 'slabrdp' };
    const fresh = '2026-10-21T08:00:10.250Z';
    // no echo -> the app did not say which filter it applied -> not proven
    let v = evaluateLogonStatus({ connected: true, ts: fresh, sourceIp: '100.93.94.15', logonType: '10', checked: 3 }, ctx);
    assert.strictEqual(v.state, 'not-observed');
    assert.match(v.detail, /user echo is empty/);
    // a foreign echo -> someone else's event
    v = evaluateLogonStatus({ connected: true, ts: fresh, sourceIp: '100.93.94.15', logonType: '10', checked: 3, user: 'Administrator' }, ctx);
    assert.strictEqual(v.state, 'not-observed');
    assert.match(v.detail, /!= expected/);
    // exact echo (any case/space) is accepted
    v = evaluateLogonStatus({ connected: true, ts: fresh, sourceIp: '100.93.94.15', logonType: '10', checked: 3, user: ' SLABRDP ' }, ctx);
    assert.strictEqual(v.state, 'candidate');
    // upper bound: an event long after the attempt is not part of it
    const late = new Date(Date.parse(ctx.baselineIso) + DEFAULT_MAX_AFTER_BASELINE_MS + 60000).toISOString();
    v = evaluateLogonStatus({ connected: true, ts: late, sourceIp: '100.93.94.15', logonType: '10', checked: 3, user: 'slabrdp' }, ctx);
    assert.strictEqual(v.state, 'not-observed');
    assert.match(v.detail, /outside the 30-minute attempt window/);
    // cross-check can never confirm through another account's event
    const sameInstant = { result: 'success', sub: '', subMeaning: '', probeError: '', count4624: 1, count4625: 0, scanTs: '2026-10-21T08:00:31.000Z', eventTs: '2026-10-21T08:00:10.251Z', logonType: '10' };
    v = evaluateNativeCrossCheck({ ...sameInstant, targetUserName: 'someone-else' }, fresh, { expectedUser: 'slabrdp' });
    assert.strictEqual(v.state, 'contradicted');
    assert.match(v.detail, /not the intended/);
    // ...and confirms honestly when the collector does report the account
    v = evaluateNativeCrossCheck({ ...sameInstant, targetUserName: 'slabrdp' }, fresh, { expectedUser: 'slabrdp' });
    assert.strictEqual(v.state, 'confirmed');
    assert.match(v.detail, /"slabrdp"/);
    // the pinned app does not report it: confirmation says so instead of implying identity proof
    v = evaluateNativeCrossCheck(sameInstant, fresh, { expectedUser: 'slabrdp' });
    assert.strictEqual(v.state, 'confirmed');
    assert.match(v.detail, /does not report the account/);
  });

  // The application observer defect, exercised with REAL PowerShell. The pinned
  // app (978a837) reads $Matches[1] after a scalar -notmatch user filter; the
  // patch in patches/ saves the capture first. This test runs the two orders
  // side by side and requires the observed live symptom ('' type) for the
  // buggy order and '10' for the fixed one. It is SKIPPED where no PowerShell
  // exists - a skip is never a pass.
  await test('app defect: -notmatch clobbers $Matches before LogonType is read (real PowerShell)', async () => {
    const exe = process.env.LAB_PWSH || (IS_WIN ? (spawnSync('pwsh', ['-v'], { encoding: 'utf8' }).status === 0 ? 'pwsh' : 'powershell') : 'pwsh');
    // NOTE: the message is assembled from [char] codes on purpose. PowerShell
    // single-quoted strings do NOT interpret \r\n\t, and a double-quoted
    // string would need backtick escapes that collide with this JS template
    // literal. Real tabs/newlines matter: the app's regex relies on \s.
    const script = `
$nl = [string][char]13 + [char]10
$tab = [string][char]9
$msg = 'An account was successfully logged on.' + $nl + $tab + 'Logon Type:' + $tab + $tab + '10' + $nl + $tab + ` +
      `'Source Network Address:' + $tab + '100.93.94.15' + $nl + $tab + 'Target User Name:' + $tab + 'slabrdp'
$userQ = 'slabrdp'
# --- order at app 978a837 (payloads/ghrdp-server.ps1 /api/logon-status) ---
if ($msg -notmatch 'Logon Type:\\s+(2|10|11)\\b') { throw 'type regex did not match' }
if ($userQ -and $msg -notmatch [regex]::Escape($userQ)) { throw 'user regex did not match' }
$buggy = [string]$Matches[1]
$buggyKeys = ($Matches.Keys | Sort-Object) -join ','
# --- order after the patch: save the capture BEFORE the user filter ---
if ($msg -notmatch 'Logon Type:\\s+(2|10|11)\\b') { throw 'type regex did not match' }
$ltThis = [string]$Matches[1]
if ($userQ -and $msg -notmatch [regex]::Escape($userQ)) { throw 'user regex did not match' }
$fixed = $ltThis
$obj = [ordered]@{ ps = $PSVersionTable.PSVersion.ToString(); buggy = $buggy; buggyKeys = $buggyKeys; fixed = $fixed }
$obj | ConvertTo-Json -Compress
`;
    const r = spawnSync(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', timeout: 120000 });
    assert.strictEqual(r.status, 0, `powershell failed: ${r.stdout} ${r.stderr}`);
    const out = JSON.parse(String(r.stdout).trim().split('\n').pop());
    // The observed live symptom: the endpoint reported logonType='' for a real
    // type-10 event because the second -notmatch replaced $Matches.
    assert.strictEqual(out.buggy, '', `expected the clobber, got ${JSON.stringify(out)}`);
    assert.strictEqual(out.fixed, '10', `the patch must yield the real type, got ${JSON.stringify(out)}`);
    assert.ok(!out.buggyKeys.includes('1'), `user-filter $Matches has no group 1: ${out.buggyKeys}`);
  }, { skipIf: () => {
    const exe = process.env.LAB_PWSH || (IS_WIN ? 'powershell' : 'pwsh');
    const p = spawnSync(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { encoding: 'utf8', timeout: 30000 });
    return p.status === 0 ? null : `no PowerShell (${exe}) on this host - the real-PowerShell reproduction runs on the Windows client job`;
  } });

  // ===== live-run integration (descriptor, trust anchor, auth, inventory) =====
  {
    const register = require('./test/live-mode-regressions');
    await register({ test, assert, fs, path, os, crypto, tmpRoot });
  }

  // ===== zero-application-change discovery (GitHub evidence + server identity) =====
  {
    const register = require('./test/origin-discovery-regressions');
    await register({ test, assert, fs, path, os, crypto, tmpRoot });
  }

  // ===== merged application signal (mc-signal/v1) compatibility =====
  {
    const register = require('./test/app-signal-regressions');
    await register({ test, assert, fs, path, os, crypto, tmpRoot });
  }

  // ===== supported RDP-file signing / trust path =====
  {
    const register = require('./test/rdp-signing-regressions');
    await register({ test, assert, fs, path, os, crypto, tmpRoot });
  }

  // ===== summary =====
  const failed = results.filter(r => r.status === 'FAIL');
  const skipped = results.filter(r => r.status === 'SKIPPED');
  console.log(`\n${results.length} tests: ${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
  const outDir = artifactDir();
  const summary = {
    schema: 1,
    platform: process.platform,
    node: process.version,
    requireBrowser: process.env.REQUIRE_BROWSER_TESTS === '1',
    total: results.length,
    passed: results.length - failed.length - skipped.length,
    failed: failed.length,
    skipped: skipped.length,
    failures: failed.map(f => ({ name: f.name, detail: String(f.detail || '').split('\n').slice(0, 8).join(' | ').slice(0, 1200) })),
    skips: skipped.map(s => ({ name: s.name, detail: String(s.detail || '').slice(0, 200) })),
    finishedAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(outDir, `regressions-${process.platform}.json`), JSON.stringify({ ...summary, results }, null, 2));
  fs.writeFileSync(path.join(outDir, 'regressions-summary.json'), JSON.stringify(summary, null, 2));
  if (process.env.GITHUB_OUTPUT) {
    const compact = { ...summary };
    delete compact.skips;
    compact.failures = compact.failures.map(f => ({ name: f.name, detail: f.detail.slice(0, 300) }));
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `caps_regressions=${JSON.stringify(compact)}\n`);
  }
  annotate.notice('regression summary',
    `${summary.total} tests: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped ` +
    `(${process.platform}${summary.requireBrowser ? ', browser e2e required' : ', browser e2e optional'})`);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* */ }
  if (failed.length) {
    if (process.env.GITHUB_ACTIONS === 'true') for (const f of failed) console.log(`::error title=regression ${f.name}::${String(f.detail).split('\n').filter(Boolean).slice(0, 8).join(' | ').replace(/%/g, '%25').slice(0, 1800)}`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
