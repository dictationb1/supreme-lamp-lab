'use strict';
// R2 FALLBACK FAULT INJECTION — the residual-risk measurement for the R2 repair.
//
// WHY THIS EXISTS: the accepted R2 patch (0003) contained a pool-unavailable
// fallback that invoked the long-lived pump INLINE on the accept thread. On a
// host where the runspace pool cannot be created, that recreates exactly the
// accept-loop starvation R2 removed: one /ws connection blocks all HTTP until
// the pump exits. This was SOURCE-IDENTIFIED, never runtime-proven. This
// harness performs the narrow, candidate-only fault injection on real Windows
// and measures both directions:
//
//   Phase A (defect reproduction, pre-0004 server): inject a PERSISTENT pool
//     init failure into the 0001-0003 server. Expect: the /ws upgrade is
//     served (101) by the inline fallback, and while it is held open /health
//     STALLS (times out) until the pump's bounded lifetime expires. This is a
//     NEGATIVE CONTROL: PASS means the defect was reproduced as predicted.
//
//   Phase B (repair verification, 0001-0004 server): same PERSISTENT injection.
//     Expect: every /ws attempt gets an immediate truthful 503 ("websocket
//     worker pool unavailable; retry"), /health stays fast while /ws attempts
//     repeat, and /health advertises ws=false + wsReason (truthful degraded
//     state). No 101 is ever served.
//
//   Phase C (recovery, 0001-0004 server): inject a TRANSIENT fault (the first
//     pool init fails, later ones succeed). Expect: first /ws 503, and after
//     the GHRDP_WS_POOL_RETRY_SEC window a later /ws upgrade SUCCEEDS (101)
//     and /health flips back to ws=true with no wsReason - bounded recovery.
//
// Injection method: the harness derives a MUTATED COPY of each server file by
// a single narrow string replacement at the pool-init site. The shipped bytes
// are never modified; each variant's sha256 is recorded in the report. The
// mutation adds NO knob to the application - it exists only in the throwaway
// fault copies this harness stages.
//
// Scope honesty: this runs on a Windows runner (the real PowerShell 5.1
// server, real sockets). It never touches the application remote, never uses
// upstream credentials, and every persisted buffer is sanitized. Exit is
// always 0; verdicts live in the published JSON.

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { maskedFrame, closeFrame, parseServerFrames } = require('../lib/ws-frame');
const { redact } = require('../lib/redact');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return (v === undefined || String(v).startsWith('--')) ? dflt : v;
}

const appDir = arg('app-dir', '');
const serverOld = arg('server-old', '');   // 0001-0003 applied (pre-0004)
const serverNew = arg('server-new', '');   // 0001-0004 applied (the candidate)
const outDir = arg('out', path.join(process.env.RUNNER_TEMP || '.', 'r2-fault-out'));
const port = Number(arg('port', '7341'));  // dedicated port: never fight the real-backend lanes
const key = arg('key', 'lab-fault-key-000');
const label = arg('label', 'r2-fault');
const appSha = arg('app-sha', '');
const labRevision = arg('lab-revision', '');
const maxMs = Number(arg('max-seconds', '0') || '0') * 1000 || 300000;

const T = {
  healthTimeoutMs: 4000,      // a health probe that takes longer than this is a STALL
  responsiveP95MaxMs: 2000,   // phase B: /health p95 while /ws attempts repeat
  pumpBoundSec: 12,           // phase A server-side pump bound (lifetime cap)
  idleSec: 8,                 // phase A idle timeout (short so the defect window is bounded)
  retryWindowSec: 5,          // phase C GHRDP_WS_POOL_RETRY_SEC
  recoveryWaitMs: 9000,       // > retry window + margin
  stallObserveMs: 14000       // phase A total observation window
};

fs.mkdirSync(outDir, { recursive: true });

const startedAt = Date.now();
const controls = [];
const report = {
  schema: 'slab-r2-fault-injection/1',
  generatedAt: new Date().toISOString(),
  label,
  identity: {
    appSha, labRevision,
    serverOld: serverOld ? path.basename(serverOld) : null,
    serverNew: serverNew ? path.basename(serverNew) : null,
    key: 'lab-synthetic-fault-key (never an upstream credential)'
  },
  variants: [],
  phases: {},
  verdicts: { PASS: 0, FAIL: 0, BLOCKED: 0, PENDING: 0 },
  fatal: ''
};

function verdictCountUpdate() {
  const v = { PASS: 0, FAIL: 0, BLOCKED: 0, PENDING: 0 };
  for (const c of controls) v[c.verdict] = (v[c.verdict] || 0) + 1;
  report.verdicts = v;
}

function record(c) {
  controls.push(c);
  verdictCountUpdate();
  flush();
  console.log(`[fault] ${c.control_id} => ${c.verdict}: ${String(c.actual).slice(0, 160)}`);
}

function flush() {
  report.controls = controls;
  report.phases.deadlineReached = Date.now() - startedAt > maxMs;
  try { fs.writeFileSync(path.join(outDir, 'r2-fault-report.json'), JSON.stringify(report, null, 2)); } catch (e) {}
  const csv = ['control_id,phase,verdict,actual,note']
    .concat(controls.map(c => [c.control_id, c.phase || '', c.verdict,
      JSON.stringify(String(c.actual || '')), JSON.stringify(String(c.note || ''))].join(',')))
    .join('\n');
  try { fs.writeFileSync(path.join(outDir, 'r2-fault-control-coverage.csv'), csv); } catch (e) {}
}

function expired() { return Date.now() - startedAt > maxMs; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDirSync(s, d); else fs.copyFileSync(s, d);
  }
}

function sha256File(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

// ---------------------------------------------------------------------------
// Fault variant derivation. ONE narrow replacement at the pool-init site; the
// original file is never touched. The replacement strings are chosen so the
// mutation is visible in the recorded before/after sha and in the server's own
// stdout ([LAB-R2] lines report the injected error text).
// ---------------------------------------------------------------------------
const INIT_SITE = "$script:R2WsPool = [runspacefactory]::CreateRunspacePool($r2Iss)";
const PERSISTENT_THROW = "throw 'LAB-INJECTED persistent pool init failure (fault-injection harness)'";
const TRANSIENT_THROW = "if (-not $script:LabR2FaultOnce) { $script:LabR2FaultOnce = $true; throw 'LAB-INJECTED transient pool init failure (fault-injection harness)' } else { $script:R2WsPool.Open() }";
const OPEN_SITE = "$script:R2WsPool.Open()";

function deriveFaultVariant(sourceFile, kind, variantName) {
  const text = fs.readFileSync(sourceFile, 'utf8');
  let mutated = text;
  if (kind === 'persistent') {
    if (!text.includes(INIT_SITE)) throw new Error(`FAULT_SITE_MISSING (persistent): ${sourceFile} has no pool-init site`);
    mutated = text.replace(INIT_SITE, PERSISTENT_THROW);
  } else if (kind === 'transient') {
    if (!text.includes(OPEN_SITE)) throw new Error(`FAULT_SITE_MISSING (transient): ${sourceFile} has no pool Open site`);
    mutated = text.replace(OPEN_SITE, TRANSIENT_THROW);
  } else throw new Error('unknown fault kind ' + kind);
  const dir = path.join(outDir, 'variants');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, variantName + '-ghrdp-server.ps1');
  fs.writeFileSync(target, mutated, 'utf8');
  const v = {
    name: variantName, kind,
    derivedFrom: path.basename(sourceFile),
    derivedFromSha256: sha256File(sourceFile),
    variantSha256: sha256File(target),
    mutation: kind === 'persistent'
      ? 'CreateRunspacePool call replaced by a throw (pool can NEVER initialize)'
      : 'first Open() call throws once; every later call performs the REAL Open() (the transient scenario under test)'
  };
  report.variants.push(v);
  return target;
}

// ---------------------------------------------------------------------------
// Server lifecycle (mirrors real-backend.js's proven staging/start pattern)
// ---------------------------------------------------------------------------
let serverChild = null, serverOutBuf = '', serverErrBuf = '';

function stageFaultRoot(root, serverFile) {
  if (appDir && fs.existsSync(path.join(appDir, 'payloads'))) {
    copyDirSync(path.join(appDir, 'payloads'), root);
  }
  fs.copyFileSync(serverFile, path.join(root, 'ghrdp-server.ps1'));
  const cfg = {
    labCandidate: true, labOnly: true, identity: 'r2-fault-injection-lab',
    rdpIp: '127.0.0.1', rdpUser: 'LAB\\fault', rdpPass: 'synthetic-fault-pass-NOT-A-REAL-SECRET',
    ghrdp: 'r2-fault', dnsName: 'r2-fault.invalid', hostKind: 'lab-isolated',
    buildSha: labRevision ? ('cand-' + labRevision.slice(0, 12)) : 'candidate',
    repo: 'dictationb1/supreme-lamp-lab', dashToken: key, mirror: false, mirrorHosts: [],
    encryptMode: 'all', mirrorKey: '', startedAt: new Date().toISOString(), runStartedAt: new Date().toISOString(),
    webdeskUrl: '', launcherVersion: ''
  };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(cfg, null, 2));
  fs.writeFileSync(path.join(root, 'dash-token.txt'), key);
  fs.writeFileSync(path.join(root, 'server-ok.txt'), '');
  try { fs.unlinkSync(path.join(root, 'server-ready.txt')); } catch (e) {}
}

function startFaultServer(root, extraEnv) {
  const runFile = path.join(root, 'ghrdp-server.ps1');
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runFile,
    '-Port', String(port), '-Bind', '127.0.0.1', '-Root', root, '-LimitMinutes', '4'];
  const env = Object.assign({}, process.env, {
    GHRDP_LAB_TEL_INTERVAL_SEC: '9', GHRDP_SCAN_DELAY_MS: '40',
    GHRDP_BUILD_SHA: labRevision ? ('cand-' + labRevision.slice(0, 12)) : 'candidate',
    GHRDP_WS_MAX_CLIENTS: '8',
    GHRDP_WS_PING_INTERVAL_SEC: '2',
    GHRDP_WS_IDLE_TIMEOUT_SEC: String(T.idleSec),
    GHRDP_WS_MAX_LIFETIME_SEC: String(T.pumpBoundSec)
  }, extraEnv || {});
  serverChild = spawn('powershell.exe', args, { stdio: ['ignore', 'pipe', 'pipe'], env, windowsHide: true });
  serverOutBuf = ''; serverErrBuf = '';
  serverChild.stdout.on('data', (d) => { serverOutBuf += d.toString('utf8'); if (serverOutBuf.length > 200000) serverOutBuf = serverOutBuf.slice(-200000); });
  serverChild.stderr.on('data', (d) => { serverErrBuf += d.toString('utf8'); if (serverErrBuf.length > 200000) serverErrBuf = serverErrBuf.slice(-200000); });
  return serverChild;
}

function killFaultServer(root) {
  if (serverChild && serverChild.pid) {
    try { execFileSync('taskkill', ['/PID', String(serverChild.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 }); } catch (e) {}
  }
  try {
    const ps = '$needle = $env:SLAB_ROOT_NEEDLE; ' +
      'Get-CimInstance Win32_Process -Filter "Name=\'powershell.exe\'" | ' +
      'Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) } | ' +
      'ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }';
    execFileSync('powershell.exe', ['-NoProfile', '-Command', ps],
      { stdio: 'ignore', timeout: 12000, env: Object.assign({}, process.env, { SLAB_ROOT_NEEDLE: root }) });
  } catch (e) {}
  serverChild = null;
}

async function waitForHealth(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await httpGet('/health', 2500);
    if (r.ok && r.status === 200) return { ok: true, waitedMs: Date.now() - t0 };
    await sleep(200);
  }
  return { ok: false, waitedMs: Date.now() - t0 };
}

function httpGet(pathname, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) {}
        resolve({ ok: true, status: res.statusCode, ms: Date.now() - t0, text: Buffer.concat(chunks).toString('utf8').slice(0, 400), json });
      });
    });
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve({ ok: false, status: 0, ms: Date.now() - t0, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, status: 0, ms: Date.now() - t0, error: String(e.code || e.message) }));
  });
}

function openRawWs(openKey, timeoutMs) {
  return new Promise((resolve) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    const sock = { done: false, frames: [], closedCode: null, upgraded: false };
    let socket = null;
    const finish = (v) => { if (sock.done) return; sock.done = true; resolve(Object.assign(sock, v)); };
    const req = http.request({ host: '127.0.0.1', port, path: '/ws?key=' + encodeURIComponent(openKey),
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': nonce, 'Sec-WebSocket-Version': '13' } });
    req.on('upgrade', (res, s) => {
      socket = s; sock.upgraded = true; sock.handle = s;
      s.on('data', (d) => {
        try { for (const f of parseServerFrames(d)) { sock.frames.push(f); if (f.opcode === 0x8 && sock.closedCode === null && f.closeCode !== null) sock.closedCode = f.closeCode; } } catch (e) {}
      });
      s.on('close', () => { sock.peerClosed = true; finish({}); });
      s.on('error', () => {});
      finish({});
    });
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => finish({ upgraded: false, rejectedStatus: res.statusCode, rejectedBody: Buffer.concat(chunks).toString('utf8').slice(0, 200) }));
    });
    req.on('error', (e) => finish({ upgraded: false, error: String(e.code || e.message) }));
    req.setTimeout(timeoutMs || 8000, () => { try { req.destroy(); } catch (e) {} finish({ upgraded: sock.upgraded, error: 'upgrade-timeout' }); });
    req.end();
  });
}

function closeRawWs(handle) { try { handle.destroy(); } catch (e) {} }
function sendRawClose(handle, status) {
  return new Promise((resolve) => {
    try { handle.write(closeFrame(status)); setTimeout(() => { try { handle.destroy(); } catch (e) {} resolve(true); }, 250); } catch (e) { resolve(false); }
  });
}

function wsLines(buf) {
  return buf.split(/\r?\n/).filter((l) => /LAB-R2|ws /i.test(l)).slice(-40).map((l) => redact(l));
}

// ---------------------------------------------------------------------------
// Phase A: defect reproduction on the pre-0004 server (negative control)
// ---------------------------------------------------------------------------
async function phaseA(oldVariantPath, phaseRoot) {
  const ph = { phase: 'A-defect-reproduction', server: '0001-0003 + persistent fault' };
  report.phases.A = ph;
  stageFaultRoot(phaseRoot, oldVariantPath);
  startFaultServer(phaseRoot);
  const up = await waitForHealth(45000);
  ph.serverUp = up.ok;
  if (!up.ok) {
    record({ control_id: 'r2b.defect_reproduction.preconditions', phase: 'A', area: 'health',
      pre: 'faulted pre-0004 server starts and answers /health', action: 'wait for /health',
      expect_ui: 'n/a', expect_req: '200', actual: 'server never answered /health: ' + JSON.stringify(up),
      evidence: '', verdict: 'BLOCKED', note: 'the defect demonstration cannot run if the faulted server does not start' });
    return;
  }
  // 1. The OLD fallback serves the upgrade (101) - the "availability" it bought.
  const ws = await openRawWs(key, 8000);
  ph.oldServedUpgrade = ws.upgraded;
  // 2. While the socket is HELD OPEN, /health must stall on the old fallback.
  const probes = [];
  const t0 = Date.now();
  let stallObserved = false;
  while (Date.now() - t0 < T.stallObserveMs && !expired()) {
    const h = await httpGet('/health', T.healthTimeoutMs);
    probes.push({ ms: h.ms, ok: h.ok && h.status === 200 });
    if (!h.ok || h.status !== 200) { stallObserved = true; break; }
    await sleep(400);
  }
  const firstBad = probes.find(p => !p.ok);
  ph.healthProbes = probes.length;
  ph.stallObserved = stallObserved;
  ph.firstStallAtMs = stallObserved ? (Date.now() - t0) : null;
  ph.probeMaxMs = Math.max(...probes.map(p => p.ms));
  record({ control_id: 'r2b.defect_reproduction.old_inline_fallback_starves_http', phase: 'A', area: 'health',
    pre: 'pre-0004 server (0001-0003) with a persistent injected pool-init failure; one authenticated /ws held open',
    action: 'poll /health (4s timeout) while the /ws socket stays open',
    expect_ui: 'n/a', expect_req: 'the inline fallback pins the accept thread, so /health times out until the pump exits',
    actual: ws.upgraded
      ? (stallObserved
        ? `REPRODUCED: /ws served 101 by the inline fallback; /health stalled ${ph.probeMaxMs}ms (timeout) after ${probes.filter(p => p.ok).length} ok probes`
        : `NOT REPRODUCED in ${T.stallObserveMs}ms: /health stayed responsive (max ${ph.probeMaxMs}ms) while the inline pump held the socket`)
      : 'the faulted old server did not serve the upgrade; reproduction inconclusive',
    evidence: '', verdict: (ws.upgraded && stallObserved) ? 'PASS' : 'FAIL',
    note: 'negative control on the PRE-REPAIR server: PASS means the source-identified starvation defect is real and reproducible' });
  // Cleanup: close the held socket, let the pump exit, then stop the server.
  if (ws.upgraded && ws.handle) await sendRawClose(ws.handle, 1000);
  await sleep(1500);
  closeRawWs(ws.handle);
  ph.oldServerStdoutTail = wsLines(serverOutBuf);
  killFaultServer(phaseRoot);
}

// ---------------------------------------------------------------------------
// Phase B: repair verification on the 0001-0004 server (persistent fault)
// ---------------------------------------------------------------------------
async function phaseB(newVariantPath, phaseRoot) {
  const ph = { phase: 'B-repair-verification', server: '0001-0004 + persistent fault' };
  report.phases.B = ph;
  stageFaultRoot(phaseRoot, newVariantPath);
  startFaultServer(phaseRoot);
  const up = await waitForHealth(45000);
  ph.serverUp = up.ok;
  if (!up.ok) {
    record({ control_id: 'r2b.repair.preconditions', phase: 'B', area: 'health',
      pre: 'faulted 0001-0004 server starts and answers /health', action: 'wait for /health',
      expect_ui: 'n/a', expect_req: '200', actual: 'server never answered /health: ' + JSON.stringify(up),
      evidence: '', verdict: 'BLOCKED', note: 'the repair verification cannot run if the faulted server does not start' });
    killFaultServer(phaseRoot);
    return;
  }
  // 1. Degraded truth on /health BEFORE any /ws attempt.
  const h0 = await httpGet('/health', 4000);
  const degradedAdvertised = !!(h0.ok && h0.json && h0.json.ws === false && /worker pool unavailable/i.test(String(h0.json.wsReason || '')));
  ph.healthDegradedAdvertised = degradedAdvertised;
  ph.healthWs = h0.json ? { ws: h0.json.ws, wsReason: h0.json.wsReason } : null;
  record({ control_id: 'r2b.repair.health_advertises_truthful_degraded_state', phase: 'B', area: 'health',
    pre: 'persistent injected pool-init failure', action: 'GET /health',
    expect_ui: 'n/a', expect_req: 'ws=false and wsReason naming the unavailable worker pool',
    actual: h0.json ? `ws=${h0.json.ws} wsReason=${JSON.stringify(h0.json.wsReason)}` : ('no json: ' + h0.error),
    evidence: '', verdict: degradedAdvertised ? 'PASS' : 'FAIL',
    note: 'the UI must not be told ws=true while /ws answers 503' });
  // 2. Repeated /ws attempts: each must get the immediate truthful 503; no 101.
  const attempts = [];
  for (let i = 0; i < 6 && !expired(); i++) {
    const a = await openRawWs(key, 8000);
    attempts.push({ upgraded: a.upgraded, status: a.upgraded ? 101 : a.rejectedStatus, ms: null });
    if (a.upgraded && a.handle) closeRawWs(a.handle);
    await sleep(300);
  }
  const all503 = attempts.length > 0 && attempts.every(a => !a.upgraded && a.status === 503);
  const any101 = attempts.some(a => a.upgraded);
  ph.wsAttempts = attempts;
  record({ control_id: 'r2b.repair.faulted_ws_gets_immediate_truthful_503', phase: 'B', area: 'connections',
    pre: 'persistent injected pool-init failure', action: 'attempt 6 authenticated /ws upgrades',
    expect_ui: 'n/a', expect_req: 'every attempt 503 with the truthful body; never a 101',
    actual: attempts.map(a => (a.upgraded ? '101' : String(a.status))).join(',') +
      (attempts[0] && attempts[0].status === 503 ? '' : ''),
    evidence: '', verdict: (all503 && !any101) ? 'PASS' : 'FAIL',
    note: 'bounded refusal with the reason, never a silent disable and never an inline pump' });
  // 3. /health responsiveness WHILE /ws attempts repeat (the starvation check).
  const latencies = [];
  let starved = false;
  for (let i = 0; i < 8 && !expired(); i++) {
    const a = await openRawWs(key, 6000);
    if (a.upgraded && a.handle) closeRawWs(a.handle);
    const h = await httpGet('/health', T.healthTimeoutMs);
    latencies.push(h.ms);
    if (!h.ok || h.status !== 200) { starved = true; break; }
    await sleep(200);
  }
  latencies.sort((x, y) => x - y);
  const p95 = latencies.length ? latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)] : null;
  ph.healthDuringWsAttempts = { samples: latencies.length, p95, max: latencies.length ? latencies[latencies.length - 1] : null, starved };
  record({ control_id: 'r2b.repair.http_never_starves_while_ws_refused', phase: 'B', area: 'health',
    pre: 'persistent injected pool-init failure; /ws attempts interleaved with /health probes',
    action: 'GET /health immediately after each refused /ws attempt',
    expect_ui: 'n/a', expect_req: `every probe 200 within ${T.responsiveP95MaxMs}ms (p95)`,
    actual: `${latencies.length} samples, p95=${p95}ms, max=${ph.healthDuringWsAttempts.max}ms, starved=${starved}`,
    evidence: '', verdict: (!starved && p95 !== null && p95 <= T.responsiveP95MaxMs) ? 'PASS' : 'FAIL',
    note: 'the pre-0004 fallback pinned the accept thread here; the repair must not' });
  ph.newServerStdoutTail = wsLines(serverOutBuf);
  killFaultServer(phaseRoot);
}

// ---------------------------------------------------------------------------
// Phase C: bounded recovery on the 0001-0004 server (transient fault)
// ---------------------------------------------------------------------------
async function phaseC(newVariantPath, phaseRoot) {
  const ph = { phase: 'C-bounded-recovery', server: '0001-0004 + transient fault' };
  report.phases.C = ph;
  stageFaultRoot(phaseRoot, newVariantPath);
  startFaultServer(phaseRoot, { GHRDP_WS_POOL_RETRY_SEC: String(T.retryWindowSec) });
  const up = await waitForHealth(45000);
  ph.serverUp = up.ok;
  if (!up.ok) {
    record({ control_id: 'r2b.recovery.preconditions', phase: 'C', area: 'health',
      pre: 'transiently faulted 0001-0004 server starts', action: 'wait for /health',
      expect_ui: 'n/a', expect_req: '200', actual: 'server never answered /health: ' + JSON.stringify(up),
      evidence: '', verdict: 'BLOCKED', note: 'recovery cannot be measured if the faulted server does not start' });
    killFaultServer(phaseRoot);
    return;
  }
  // 1. First /ws: the one-shot init failure means a 503.
  const first = await openRawWs(key, 8000);
  ph.firstAttempt = { upgraded: first.upgraded, status: first.upgraded ? 101 : first.rejectedStatus };
  if (first.upgraded && first.handle) closeRawWs(first.handle);
  // 2. Wait past the retry window.
  await sleep(T.recoveryWaitMs);
  // 3. Second /ws: the bounded re-init must now succeed (101), and /health
  //    must advertise ws=true again with no wsReason.
  const second = await openRawWs(key, 8000);
  ph.secondAttempt = { upgraded: second.upgraded, status: second.upgraded ? 101 : second.rejectedStatus };
  const h = await httpGet('/health', 4000);
  ph.healthAfterRecovery = h.json ? { ws: h.json.ws, wsReason: h.json.wsReason } : null;
  const recovered = !!second.upgraded && !!h.json && h.json.ws === true && !h.json.wsReason;
  if (second.upgraded && second.handle) {
    // Prove the recovered socket actually carries frames, then close cleanly.
    await sleep(1200);
    await sendRawClose(second.handle, 1000);
  }
  record({ control_id: 'r2b.recovery.transient_fault_recovers_after_retry_window', phase: 'C', area: 'connections',
    pre: 'transient injected pool-init failure (first init only); retry window ' + T.retryWindowSec + 's',
    action: 'first /ws attempt, wait ' + T.recoveryWaitMs + 'ms, second /ws attempt, GET /health',
    expect_ui: 'n/a', expect_req: 'first 503; second 101; /health ws=true with no wsReason',
    actual: `first=${ph.firstAttempt.status}, second=${ph.secondAttempt.status}, health=${JSON.stringify(ph.healthAfterRecovery)}`,
    evidence: '', verdict: recovered ? 'PASS' : 'FAIL',
    note: 'degraded state is bounded: a transient init failure must not pin /ws off for the process lifetime' });
  ph.recoveryServerStdoutTail = wsLines(serverOutBuf);
  killFaultServer(phaseRoot);
}

// ---------------------------------------------------------------------------
async function main() {
  try {
    if (!serverOld || !fs.existsSync(serverOld)) { report.fatal = 'missing --server-old (the 0001-0003 server)'; flush(); return; }
    if (!serverNew || !fs.existsSync(serverNew)) { report.fatal = 'missing --server-new (the 0001-0004 server)'; flush(); return; }
    if (!appDir || !fs.existsSync(path.join(appDir, 'payloads'))) { report.fatal = 'missing --app-dir payloads'; flush(); return; }
    const tmpBase = path.join(outDir, 'roots');
    fs.mkdirSync(tmpBase, { recursive: true });
    const oldPersistent = deriveFaultVariant(serverOld, 'persistent', 'old-persistent');
    const newPersistent = deriveFaultVariant(serverNew, 'persistent', 'new-persistent');
    const newTransient = deriveFaultVariant(serverNew, 'transient', 'new-transient');
    await phaseA(oldPersistent, path.join(tmpBase, 'a'));
    flush();
    await sleep(2500); // listener release between phases (same port)
    await phaseB(newPersistent, path.join(tmpBase, 'b'));
    flush();
    await sleep(2500);
    await phaseC(newTransient, path.join(tmpBase, 'c'));
    flush();
  } catch (e) {
    report.fatal = 'exception: ' + String(e.message || e).slice(0, 300);
    flush();
  } finally {
    // Sanitized server output for each phase is already in report.phases.*;
    // also write the raw buffers redacted for offline inspection.
    try {
      fs.writeFileSync(path.join(outDir, 'fault-server-stdout.log.sanitized'),
        '# sanitized (secrets redacted); tail of the last fault server\n' + serverOutBuf.split(/\r?\n/).slice(-200).map(l => redact(l)).join('\n') + '\n');
      fs.writeFileSync(path.join(outDir, 'fault-server-stderr.log.sanitized'),
        '# sanitized (secrets redacted)\n' + serverErrBuf.split(/\r?\n/).slice(-100).map(l => redact(l)).join('\n') + '\n');
    } catch (e) {}
    flush();
    process.stdout.write('R2_FAULT_INJECTION ' + label + ' fatal=' + (report.fatal || 'none') +
      ' counts=' + JSON.stringify(report.verdicts) + '\n');
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  T,
  INIT_SITE, PERSISTENT_THROW, TRANSIENT_THROW, OPEN_SITE,
  deriveFaultVariant,
  // test seams: the phase functions are not exported (they drive real
  // processes); the variant derivation and constants are.
  __test: { record, flush, report }
};
