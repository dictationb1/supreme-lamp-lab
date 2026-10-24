'use strict';
// REAL-BACKEND VERIFICATION — starts the ACTUAL application PowerShell server
// (payloads/ghrdp-server.ps1), measures the startup response stall, and drives
// a real browser against the real endpoints. This is deliberately different
// from scripts/candidate/stub-server.js: no endpoint is faked here.
//
// Scope honesty:
//   * Runs on a Windows runner (self-hosted interactive client preferred).
//   * Stages a LAB-ONLY Root (fresh synthetic dash key, synthetic credentials,
//     lab identity). It is NEVER the live origin and never borrows an upstream
//     MC-SIGNAL, address or credential.
//   * Steps that require a real RDP session, a real signed launcher, real
//     external mirror hosts or a real logon event are recorded BLOCKED with the
//     exact prerequisite. A refused/absent probe is never described as a pass.
//   * All captured text is sanitized before it is written. No raw passwords,
//     tokens, cookies or authenticated URLs are persisted.
//
// Measurement (the §7 backend-stall question), for BOTH --label baseline and
// --label patched, apples-to-apples from the same first successful TCP connect:
//   tMarker        server-ok.txt (LISTENING marker) appears
//   tConnect       first TCP connect to 127.0.0.1:<port> succeeds
//   tFirstHealth   first HTTP 200 from GET /health
//   stallMs        = tFirstHealth - tConnect   (baseline: the synchronous
//                    startup Get-WinEvent scans run before the accept loop)
//   tReady         server-ready.txt appears (LAB-R1 patched only; null on base)
//   healthSamples  repeated GET /health latency over --measure-seconds, so a
//                  periodic inline scan shows up as a latency spike
//   concurrent     GET /api/diag/comprehensive (inline event scan) fired at the
//                  same instant as a GET /health; /health latency is recorded.
//
// Exit is always 0; the verdict lives in the published JSON, never in a shell
// code that a workflow could misread. The workflow's evaluate step reads the
// JSON and fails loudly on FAIL/BLOCKED-as-acceptance.

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
let chromium = null;
try { chromium = require('playwright').chromium; } catch (e) { /* recorded as BLOCKED in driveBrowser */ }
let desktopLock = null, lockApi = null;

function acquireDesktopLock() {
  // On the shared interactive VM this cross-workflow lock is the ONLY thing
  // that keeps two jobs from owning the desktop at once. On a hosted runner it
  // simply acquires a free lock. A failure to acquire is recorded as BLOCKED,
  // never bypassed.
  try {
    lockApi = require('../lib/lock');
    const registry = require('../lib/registry');
    const lockT0 = Date.now();
    try {
      desktopLock = lockApi.acquireLock({
        lockDir: registry.sessionLockDir(),
        runId: process.env.GITHUB_RUN_ID || 'local',
        runAttempt: process.env.GITHUB_RUN_ATTEMPT || '1',
        role: 'real-backend-verification',
        timeoutMs: 300000
      });
      report.timings.desktopLockMs = Date.now() - lockT0;
      report.desktopLock = 'acquired';
    } catch (e) {
      report.desktopLock = 'FAILED: ' + String(e.message || e).slice(0, 200);
      report.timings.desktopLockMs = Date.now() - lockT0;
    }
  } catch (e) { report.desktopLock = 'lock module unavailable: ' + String(e.message || e).slice(0, 120); }
}
function releaseDesktopLock() {
  if (desktopLock && lockApi) { try { lockApi.releaseLock(desktopLock); } catch (e) { report.desktopLockReleaseWarning = String(e.message || e).slice(0, 120); } desktopLock = null; }
}

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
}
function sanitize(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/([?&](?:key|token|dash-token|dash_token|access-token|password|code)=)[^&\s"']+/gi, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1***')
    .replace(/(rdpPass|vncPass|telegraphToken|rentryEditCode|rentryEditCookie|editKey|editCode|dashToken|mirrorKey)\s*[:=]\s*"?[^",}\s]+"?/gi, '$1=***');
}

const serverPath = arg('server', '');          // (legacy) explicit server file to run
const appDir = arg('app-dir', '');             // full app tree; its payloads/* are staged
const serverSource = arg('server-source', ''); // baseline pristine OR patched ghrdp-server.ps1 copied into Root
const root = arg('root', '');
const out = arg('out', path.resolve('real-backend-out'));
const label = arg('label', 'baseline');           // baseline | patched
const bundlePath = arg('bundle', '');             // built single-file ui/dist/index.html
const port = parseInt(arg('port', '7331'), 10);
const key = arg('key', 'lab-synthetic-key-000');
const measureSeconds = parseInt(arg('measure-seconds', '38'), 10);
const appSha = arg('app-sha', '');
const labRevision = arg('lab-revision', '');
const runsOn = arg('runner', process.env.RUNNER_NAME || 'unknown');
const headless = process.env.CANDIDATE_HEADLESS === '1';

const shotsDir = path.join(out, 'shots');
fs.mkdirSync(shotsDir, { recursive: true });
fs.mkdirSync(root, { recursive: true });

// MEASURED (lab run 40063545799): the real server is single-threaded and one
// hanging endpoint (e.g. /diag mirror probes with PS 5.1's infinite default
// web timeout, or a long inline scan) blocks every later request, so a naive
// step can run 25+ minutes. Bound the WHOLE harness and publish incrementally.
const GLOBAL_DEADLINE_MS = parseInt(arg('max-seconds', '420'), 10) * 1000;
const globalT0 = Date.now();
let deadlineHit = false;
function expired() {
  if (Date.now() - globalT0 > GLOBAL_DEADLINE_MS) { deadlineHit = true; return true; }
  return false;
}

const report = {
  schema: 'slab-real-backend/1',
  generatedAt: new Date().toISOString(),
  scope: 'REAL_APPLICATION_POWERSHELL_SERVER_ON_WINDOWS; not the live origin, not native RDP/Web Desktop acceptance',
  identity: {
    label, appSha, labRevision, runner: runsOn,
    port, headless: !headless,
    bundlePath: bundlePath ? path.basename(bundlePath) : '',
    syntheticKeyFingerprint: crypto.createHash('sha256').update(key).digest('hex').slice(0, 12),
    note: 'fresh lab-only synthetic dash key; never an upstream credential'
  },
  timings: {},
  endpoints: {},
  socketOwner: '',
  controls: [],
  consoleErrors: [],
  failedRequests: [],
  verdicts: {},
  fatal: ''
};

const rows = [];
function record(c) {
  report.controls.push(c);
  rows.push([
    c.control_id, c.area, (c.pre || '').replace(/[\r\n]+/g, ' '),
    (c.action || '').replace(/[\r\n]+/g, ' '),
    (c.expect_ui || '').replace(/[\r\n]+/g, ' '),
    (c.expect_req || '').replace(/[\r\n]+/g, ' '),
    sanitize(String(c.actual === undefined ? '' : c.actual)).replace(/\s+/g, ' ').slice(0, 400),
    c.evidence || '', c.verdict, (c.note || '').replace(/[\r\n]+/g, ' ')
  ]);
}

// Incremental persistence: the real server is single-threaded and can stall a
// request for a long time, so write the report + CSV after EVERY phase. A hard
// job-timeout kill then still leaves publishable partial evidence on disk.
function flush() {
  try {
    const counts = { PASS: 0, FAIL: 0, BLOCKED: 0, PENDING: 0 };
    for (const c of report.controls) counts[c.verdict] = (counts[c.verdict] || 0) + 1;
    report.verdicts = counts;
    if (deadlineHit) report.fatal = report.fatal || ('global harness deadline (' + (GLOBAL_DEADLINE_MS / 1000) + 's) reached; later phases skipped');
    fs.writeFileSync(path.join(out, 'real-backend-report.json'), JSON.stringify(report, null, 2));
    const header = 'control_id,area,preconditions,action,expected_ui,expected_request,actual,evidence,verdict,note\n';
    const esc = (v) => '"' + String(v).replace(/"/g, '""') + '"';
    fs.writeFileSync(path.join(out, 'real-backend-control-coverage.csv'),
      header + rows.map((r) => r.map(esc).join(',')).join('\n') + '\n');
  } catch (e) { /* best effort; finally writes again */ }
}

function httpGet(pathname, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = http.get({ host: '127.0.0.1', port, path: pathname, headers: { Connection: 'close' } }, (res) => {
      let n = 0; const chunks = [];
      res.on('data', (d) => { n += d.length; if (chunks.length < 64) chunks.push(d); });
      res.on('end', () => resolve({ ok: true, status: res.statusCode, ms: Date.now() - t0, bytes: n,
        ctype: res.headers['content-type'] || '',
        bodyHead: sanitize(Buffer.concat(chunks).toString('utf8')).slice(0, 800) }));
    });
    req.on('error', (e) => resolve({ ok: false, ms: Date.now() - t0, error: String(e.code || e.message) }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ ok: false, ms: Date.now() - t0, error: 'timeout' }); });
  });
}
function tcpConnect() {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect(port, '127.0.0.1');
    s.setTimeout(1500);
    s.on('connect', () => { const ms = Date.now() - t0; s.destroy(); resolve({ ok: true, ms }); });
    s.on('error', (e) => resolve({ ok: false, error: String(e.code || e.message) }));
    s.on('timeout', () => { s.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDirSync(s, d);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

function stageRoot() {
  // Stage the FULL payload set (the real server dot-sources ghrdp-fx.ps1,
  // ghrdp-mirror.ps1, rdp-telescope.ps1). Then overwrite the server with the
  // exact SOURCE under test (pristine baseline OR patched) so the two runs
  // differ in exactly one file and the measurement is apples-to-apples.
  let stagedPayloads = 0;
  if (appDir) {
    const pdir = path.join(appDir, 'payloads');
    if (fs.existsSync(pdir)) {
      copyDirSync(pdir, root);
      stagedPayloads = fs.readdirSync(pdir).length;
    }
  }
  const effectiveServer = serverSource || serverPath;
  if (effectiveServer && fs.existsSync(effectiveServer)) {
    fs.copyFileSync(effectiveServer, path.join(root, 'ghrdp-server.ps1'));
  }
  report.identity.stagedPayloadEntries = stagedPayloads;
  report.identity.serverSource = effectiveServer ? path.basename(effectiveServer) : '';
  // LAB-ONLY config. rdpIp is loopback + a clearly-lab DNS name; every value
  // is synthetic and marked. This config exists so /api/config and /api/native-
  // status exercise the REAL handlers against real (lab) data, not a stub.
  const cfg = {
    labCandidate: true,
    labOnly: true,
    identity: 'isolated-lab-candidate-not-live-origin',
    rdpIp: '127.0.0.1',
    rdpUser: 'LAB\\candidate',
    rdpPass: 'synthetic-lab-pass-NOT-A-REAL-SECRET',
    vncPass: 'synthetic-lab-vnc-NOT-A-REAL-SECRET',
    ghrdp: 'lab-candidate',
    dnsName: 'lab-candidate.invalid',
    hostKind: 'lab-isolated',
    buildSha: labRevision ? ('cand-' + labRevision.slice(0, 12)) : 'candidate',
    repo: 'dictationb1/supreme-lamp-lab',
    dashToken: key,
    mirror: false,
    mirrorHosts: [],
    encryptMode: 'all',
    mirrorKey: '',
    telegraphToken: '',
    telegraphPath: '',
    mirrorIndexUrl: '',
    serveUrl: '',
    funnelUrl: '',
    startedAt: new Date().toISOString(),
    runStartedAt: new Date().toISOString(),
    webdeskUrl: '',
    launcherVersion: ''
  };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(cfg, null, 2));
  fs.writeFileSync(path.join(root, 'dash-token.txt'), key);
  // Vite single-file bundle -> ui-v2.html (the default served UI). Also provide
  // ui.html (Classic UI escape target) as an explicit, honest marker page.
  if (bundlePath && fs.existsSync(bundlePath)) {
    fs.copyFileSync(bundlePath, path.join(root, 'ui-v2.html'));
    fs.copyFileSync(bundlePath, path.join(root, 'ui.html'));
  }
  fs.writeFileSync(path.join(root, 'server-ok.txt'), '');
  try { fs.unlinkSync(path.join(root, 'server-ready.txt')); } catch (e) {}
}

let serverChild = null;
let serverOutBuf = '';
let serverErrBuf = '';
function startServer() {
  const runFile = path.join(root, 'ghrdp-server.ps1');
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runFile,
    '-Port', String(port), '-Bind', '127.0.0.1', '-Root', root, '-LimitMinutes', '6'];
  const env = Object.assign({}, process.env, {
    GHRDP_LAB_TEL_INTERVAL_SEC: '9', GHRDP_SCAN_DELAY_MS: '40',
    GHRDP_BUILD_SHA: labRevision ? ('cand-' + labRevision.slice(0, 12)) : 'candidate',
    GITHUB_SHA: appSha || ''
  });
  report.startupDiag = { command: 'powershell.exe ' + args.join(' '), runFile, root, resolvedRunFileExists: fs.existsSync(runFile) };
  // MEASURED (lab run 40062592553): a `detached:true` spawn with stdio bound to
  // a numeric fs fd produced NO output and never bound on the client VM. Use
  // real pipes captured in-process instead; the harness owns the whole lifetime.
  serverChild = spawn('powershell.exe', args, { stdio: ['ignore', 'pipe', 'pipe'], env, windowsHide: true });
  report.identity.serverPid = serverChild.pid || null;
  serverChild.on('error', (e) => { report.startupDiag.spawnError = String(e.message || e); });
  serverChild.on('exit', (code, signal) => {
    report.startupDiag.exit = { code, signal: signal || null, at: new Date().toISOString() };
  });
  serverChild.stdout.on('data', (d) => { serverOutBuf += d.toString('utf8'); if (serverOutBuf.length > 300000) serverOutBuf = serverOutBuf.slice(-300000); });
  serverChild.stderr.on('data', (d) => { serverErrBuf += d.toString('utf8'); if (serverErrBuf.length > 300000) serverErrBuf = serverErrBuf.slice(-300000); });
}
function killOwned() {
  if (serverChild && serverChild.pid) {
    try { execFileSync('taskkill', ['/PID', String(serverChild.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 }); } catch (e) {}
  }
  // Reap any detached helper loops that carry this Root in their command line
  // (rdp-usage.ps1 / conn-probe.ps1 / fx worker), only for OUR Root. The marker
  // is passed via an environment variable and matched literally in PowerShell
  // so backslashes in a Windows path never need shell escaping.
  try {
    const ps = '$needle = $env:SLAB_ROOT_NEEDLE; ' +
      'Get-CimInstance Win32_Process -Filter "Name=\'powershell.exe\'" | ' +
      'Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) } | ' +
      'ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }';
    execFileSync('powershell.exe', ['-NoProfile', '-Command', ps],
      { stdio: 'ignore', timeout: 12000, env: Object.assign({}, process.env, { SLAB_ROOT_NEEDLE: root }) });
  } catch (e) {}
}

async function waitForFile(file, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fs.existsSync(file)) {
      try { const c = fs.readFileSync(file, 'utf8').trim(); if (c) return { at: Date.now(), text: c }; } catch (e) {}
    }
    await sleep(60);
  }
  return null;
}

async function measureStartup() {
  const okFile = path.join(root, 'server-ok.txt');
  const readyFile = path.join(root, 'server-ready.txt');
  const tStart = Date.now();
  try { fs.writeFileSync(okFile, ''); } catch (e) {}
  try { fs.unlinkSync(readyFile); } catch (e) {}

  // Wait up to 120s for the marker, but watch the child: if it EXITED before
  // binding, stop early and record the exit + captured stderr (a parse error,
  // a missing module, or an ExecutionPolicy failure shows up there). A listener
  // can also appear even if the marker path is wrong, so probe the port too.
  const liveness = [];
  let marker = null, sawListener = false, tFirstListener = null;
  for (let i = 0; i < 240; i++) {
    if (fs.existsSync(okFile)) {
      try { const c = fs.readFileSync(okFile, 'utf8').trim(); if (c) { marker = { at: Date.now(), text: c }; } } catch (e) {}
    }
    if (!sawListener) {
      const tc = await tcpConnect();
      if (tc.ok) { sawListener = true; tFirstListener = Date.now(); }
    }
    if (i % 8 === 0) {
      liveness.push({ t: Date.now() - tStart, exited: !!(report.startupDiag && report.startupDiag.exit),
        spawnError: (report.startupDiag && report.startupDiag.spawnError) || '',
        stdoutBytes: serverOutBuf.length, stderrBytes: serverErrBuf.length, listener: sawListener });
    }
    if (marker) break;
    if (report.startupDiag && report.startupDiag.exit) break; // child died before binding
    if (report.startupDiag && report.startupDiag.spawnError) break; // spawn failed (e.g. no powershell)
    await sleep(500);
  }
  report.startupDiag = report.startupDiag || {};
  report.startupDiag.liveness = liveness;
  report.startupDiag.listenerAppeared = sawListener;
  report.timings.markerAppearedMs = marker ? marker.at - tStart : null;
  report.timings.markerText = marker ? sanitize(marker.text) : null;
  report.timings.listenerAppearedMs = tFirstListener ? tFirstListener - tStart : null;
  if (!marker) {
    const exit = report.startupDiag.exit;
    const spawnError = report.startupDiag.spawnError;
    report.fatal = spawnError
      ? ('powershell spawn failed: ' + sanitize(spawnError))
      : exit
        ? ('server process exited before binding (code=' + exit.code + ' signal=' + exit.signal + '); stderr: ' + sanitize(serverErrBuf.slice(-600)))
        : ('LISTENING marker never appeared within 120s; listenerOnPort=' + sawListener + '; stderr: ' + sanitize(serverErrBuf.slice(-600)) + '; stdout: ' + sanitize(serverOutBuf.slice(-300)));
    return false;
  }

  // First successful TCP connect (already probed above; reuse its timing).
  const connect = { at: tFirstListener || Date.now(), ms: 0 };
  report.timings.connectMs = connect.ms;
  const tConnect = connect.at;

  // First HTTP 200 from /health. Per-attempt timeout 8s; keep trying so a
  // mid-scan stall is measured as latency, not lost.
  let firstHealth = null;
  for (let i = 0; i < 20 && !firstHealth; i++) {
    const r = await httpGet('/health', 8000);
    if (r.ok && r.status === 200) firstHealth = { at: Date.now(), ms: r.ms, status: r.status };
    else await sleep(100);
  }
  if (firstHealth) {
    report.timings.firstHealthMs = firstHealth.ms;
    report.timings.stallMs = firstHealth.at - tConnect; // connect -> first byte/core response
    report.timings.firstHealthStatus = firstHealth.status;
  } else {
    report.timings.firstHealthMs = null;
    report.timings.stallMs = null;
    report.fatal = report.fatal || 'GET /health never returned 200 after TCP connect';
  }

  // server-ready.txt (LAB-R1). On the baseline this file never exists.
  const ready = await waitForFile(readyFile, 4000);
  report.timings.readyAppearedMs = ready ? ready.at - tStart : null;
  report.timings.readyText = ready ? sanitize(ready.text) : null;
  return true;
}

async function sampleTicks() {
  const samples = [];
  const t0 = Date.now();
  const windowMs = Math.min(measureSeconds, 22) * 1000; // hard cap regardless of input
  let firedConcurrent = false;
  let concurrent = null;
  while (Date.now() - t0 < windowMs && !expired()) {
    const elapsed = Date.now() - t0;
    if (!firedConcurrent && elapsed >= 5000) {
      firedConcurrent = true;
      // Fire /api/native-status (whose handler does an INLINE bounded Schannel
      // Get-WinEvent on a cache miss — the §7 secondary hypothesis) at the same
      // instant as /health, and time the /health that shares the single accept
      // thread. Avoids /api/diag/comprehensive, whose mirror probes can hang on
      // PS 5.1's infinite default web timeout (measured run 40063545799).
      const slow = httpGet('/api/native-status' + '?key=' + encodeURIComponent(key), 8000);
      const h = await httpGet('/health', 8000);
      concurrent = { healthMs: h.ms, healthStatus: h.status, slowFired: true, slowEndpoint: '/api/native-status' };
      const sr = await slow;
      concurrent.slowMs = sr.ms;
      concurrent.slowStatus = sr.status;
      concurrent.slowBytes = sr.bytes || 0;
    }
    const r = await httpGet('/health', 8000);
    samples.push({ t: Date.now() - t0, ms: r.ms, status: r.status, ok: r.ok });
    await sleep(220);
  }
  const okSamples = samples.filter((s) => s.ok && s.status === 200).map((s) => s.ms).sort((a, b) => a - b);
  const p95 = okSamples.length ? okSamples[Math.floor(okSamples.length * 0.95)] : null;
  const max = okSamples.length ? okSamples[okSamples.length - 1] : null;
  report.timings.healthSampleCount = samples.length;
  report.timings.healthLatencyP95Ms = p95;
  report.timings.healthLatencyMaxMs = max;
  report.timings.healthLatencySamples = samples.filter((s, i) => i % 8 === 0).map((s) => ({ t: s.t, ms: s.ms }));
  report.timings.concurrent = concurrent;
}

async function captureEndpoints() {
  // NOTE: /diag is deliberately NOT probed here. On PS 5.1 its F46 mirror-host
  // matrix uses outbound web calls with the platform's infinite default timeout,
  // which blocked the single-threaded server for the whole of run 40063545799.
  // /diag is exercised separately only via the bounded concurrent test below.
  const list = [
    ['/health', ''],
    ['/api/config', '?key=' + encodeURIComponent(key)],
    ['/api/native-status', '?key=' + encodeURIComponent(key)],
    ['/api/progress', ''],
    ['/api/version', ''],
    ['/ping', ''],
    ['/', '?ui=v2']
  ];
  for (const [p, q] of list) {
    if (expired()) break;
    const r = await httpGet(p + q, 6000);
    let keys = [];
    try {
      const parsed = JSON.parse(r.bodyHead.replace(/\s+$/, ''));
      if (parsed && typeof parsed === 'object') keys = Object.keys(parsed);
    } catch (e) {
      // HTML or truncated: record first tag only, never raw body
    }
    report.endpoints[p] = {
      status: r.status || null, ok: r.ok, ms: r.ms, bytes: r.bytes || 0,
      ctype: sanitize(r.ctype || ''),
      topLevelKeys: keys,
      bodyHead: r.ctype && r.ctype.indexOf('html') >= 0 ? (r.bodyHead.slice(0, 200).replace(/<[^>]*>/g, '').slice(0, 120)) : sanitize(r.bodyHead).slice(0, 400)
    };
  }
}

// [R2] Bounded proof of the WebSocket accept-loop stall. The application's
// Invoke-ClientRequest calls Invoke-F99WebSocketUpgrade INLINE on the single
// accept thread; one /ws connection occupies that thread for up to
// F99WsMaxLifetimeSec (1800s) / F99WsIdleTimeoutSec (90s), so unrelated
// lightweight requests (e.g. /health) cannot be served. Open ONE upgrade,
// measure /health during it, then destroy the socket so the server recovers.
// Entire probe is hard-bounded to a few seconds; it can never hang the harness.
async function measureWsBlock() {
  const nonce = crypto.randomBytes(16).toString('base64');
  const result = { wsUpgraded: false };
  await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; Object.assign(result, v); try { sock.destroy(); } catch (e) {} resolve(); };
    let sock = null;
    const req = http.request({ host: '127.0.0.1', port, path: '/ws?key=' + encodeURIComponent(key),
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': nonce, 'Sec-WebSocket-Version': '13' } });
    req.on('upgrade', (res, socket) => {
      sock = socket;
      socket.on('error', () => {});
      // Give the server a moment to enter its inline WS loop, then probe /health
      // on a SEPARATE connection; if the WS blocks the accept thread, this times out.
      setTimeout(async () => {
        const h = await httpGet('/health', 5000);
        finish({ wsUpgraded: true, healthDuringWsMs: h.ms, healthOk: h.ok, healthStatus: h.status, blocked: !(h.ok && h.status === 200) });
      }, 1500);
    });
    req.on('response', (res) => { res.resume(); finish({ wsUpgraded: false, httpStatus: res.statusCode }); });
    req.on('error', (e) => finish({ wsUpgraded: false, error: String(e.code || e.message) }));
    req.setTimeout(7000, () => finish({ wsUpgraded: false, error: 'upgrade-timeout' }));
    req.end();
  });
  report.timings.wsBlock = result;
  record({ control_id: 'backend.ws_accept_loop_block', area: 'health',
    pre: 'real PowerShell server, authenticated raw WebSocket upgrade',
    action: 'Open one /ws connection and concurrently GET /health.',
    expect_ui: 'an unrelated lightweight endpoint stays responsive while a long-lived WS is open',
    expect_req: 'GET /ws (101) + GET /health in parallel',
    actual: `wsUpgraded=${result.wsUpgraded} blocked=${result.blocked} healthDuringWsMs=${result.healthDuringWsMs} ${result.error || ''}`,
    evidence: '', verdict: (result.wsUpgraded && result.blocked) ? 'FAIL' : (result.wsUpgraded ? 'PASS' : 'BLOCKED'),
    note: 'FAIL here is a REAL application backend defect (R2): inline WS handling stalls the single-threaded accept loop; it is reported, never hidden' });
}

async function captureSocketOwner() {
  try {
    const outp = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      '$c = Get-NetTCPConnection -LocalPort ' + port + ' -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; ' +
      'if ($c) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; ' +
      '"pid=$($c.OwningProcess) name=$($p.ProcessName) start=$($p.StartTime.ToString(\'o\'))" } else { "no-listener" }'],
      { encoding: 'utf8', timeout: 12000 });
    report.socketOwner = sanitize(String(outp).trim()).slice(0, 300);
  } catch (e) { report.socketOwner = 'owner-probe-failed: ' + String(e.message).slice(0, 120); }
}

async function driveBrowser() {
  if (!chromium) {
    record({ control_id: 'real.browser_suite', area: 'browser',
      pre: 'playwright chromium must be installed (npm ci on the runner)',
      action: 'drive the real UI in a headed/headless browser',
      expect_ui: 'n/a', expect_req: 'n/a',
      actual: 'BLOCKED: playwright module unavailable on this host',
      evidence: '', verdict: 'BLOCKED',
      note: 'the workflow installs playwright via npm ci; a local run without deps cannot prove the UI' });
    return;
  }
  const base = 'http://127.0.0.1:' + port;
  const browser = await chromium.launch({ headless, args: ['--no-first-run', '--no-default-browser-check'] });
  try {
    // (1) unauthenticated gate. Stub WebSocket in THIS browser context only:
    // the real server handles /ws inline on its single accept thread (R2), so a
    // live socket would freeze every later request and prevent honest control
    // verification. The REAL WS stall is measured separately by measureWsBlock().
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => {
      class LabStubWS {
        constructor() { this.readyState = 1; this.bufferedAmount = 0; setTimeout(() => { if (this.onopen) this.onopen({}); }, 0); }
        send() {} close() { this.readyState = 3; if (this.onclose) this.onclose({ code: 1000 }); }
        addEventListener() {} removeEventListener() {}
      }
      LabStubWS.CONNECTING = 0; LabStubWS.OPEN = 1; LabStubWS.CLOSING = 2; LabStubWS.CLOSED = 3;
      try { Object.defineProperty(window, 'WebSocket', { value: LabStubWS, configurable: true, writable: true }); } catch (e) {}
    });
    report.browserWsStubbed = true;
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') report.consoleErrors.push(sanitize(m.text()).slice(0, 300)); });
    page.on('requestfailed', (r) => report.failedRequests.push({ url: sanitize(r.url()).slice(0, 200), why: sanitize((r.failure() && r.failure().errorText) || '').slice(0, 120) }));
    await page.goto(base + '/?ui=v2', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch((e) => { report.fatal = report.fatal || ('initial goto: ' + e.message.slice(0, 120)); });
    await sleep(1000);
    const gate = page.getByTestId('dash-token-gate');
    const gateVisible = await gate.isVisible().catch(() => false);
    let ev = '';
    try { ev = await screenshot(page, 'gate-' + label); } catch (e) {}
    record({ control_id: 'real.auth_gate', area: 'authentication',
      pre: 'real PowerShell server, fresh context, no key',
      action: 'Load /?ui=v2 without a dashboard key.',
      expect_ui: 'the token gate blocks the dashboard (or an explicit refusal is shown)',
      expect_req: 'GET / -> 200 real ui-v2.html',
      actual: `gateVisible=${gateVisible}`,
      evidence: ev, verdict: gateVisible ? 'PASS' : 'FAIL',
      note: 'a rendered UI behind a real gate is proof of real bootstrap, not a stub' });

    // (2) authenticate with the synthetic key that matches dash-token.txt
    await page.goto(base + '/?ui=v2&key=' + encodeURIComponent(key), { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    // The runner-served dashboard deliberately gates every other control until
    // a key is entered; a ?key in the URL is not always enough. Unlock the same
    // way the stub sweep does, so the routed controls are not blocked by the
    // modal and their assertions are meaningful (bounded, so a blocked server
    // cannot turn one control into a 25-minute stall).
    let unlocked = false;
    try {
      const gate2 = page.getByTestId('dash-token-gate');
      if (await gate2.isVisible().catch(() => false)) {
        await page.getByTestId('dash-token-enter').click({ timeout: 3000 });
        await page.getByTestId('dash-token-input').fill(key, { timeout: 3000 });
        await page.getByTestId('dash-token-save').click({ timeout: 3000 });
        await gate2.waitFor({ state: 'hidden', timeout: 4000 });
      }
      unlocked = true;
    } catch (e) { report.browserUnlockError = String(e.message || e).slice(0, 160); }
    let shell = false, topStatus = '', autoNote = '';
    try { await page.waitForSelector('[data-testid="app-topbar"]', { timeout: 8000 }); shell = true; } catch (e) {}
    try { topStatus = await page.getByTestId('topbar-status-summary').innerText({ timeout: 2500 }); } catch (e) {}
    try { autoNote = await page.getByTestId('overview-auto-login-note').innerText({ timeout: 2500 }); } catch (e) {}
    // document origin + served UI variant + build stamp
    const doc = await page.evaluate(() => ({
      origin: location.origin,
      uiV2MissingBanner: !!document.getElementById('uiV2MissingBanner'),
      build: (document.getElementById('ghrdpBuild') || {}).getAttribute
        ? document.getElementById('ghrdpBuild').getAttribute('data-build') || '' : '',
      title: document.title
    })).catch(() => ({}));
    ev = await screenshot(page, 'authenticated-' + label);
    record({ control_id: 'real.authenticated_shell', area: 'overview',
      pre: 'real server, valid synthetic key',
      action: 'Load with ?key, wait for the app shell.',
      expect_ui: 'app-topbar mounts against the real backend; served origin is this server',
      expect_req: 'GET /api/config, /api/native-status, /api/progress -> real responses',
      actual: `shell=${shell} unlocked=${unlocked} origin=${doc.origin} uiV2MissingBanner=${doc.uiV2MissingBanner} topStatus="${(topStatus || '').replace(/\s+/g, ' ').slice(0, 60)}"`,
      evidence: ev, verdict: shell ? 'PASS' : 'BLOCKED',
      note: shell ? '' : 'shell did not mount; inspect consoleErrors + endpoints + browserUnlockError' });
    record({ control_id: 'real.status_chip_semantics', area: 'overview',
      pre: 'real backend with lab synthetic data',
      action: 'Read the topbar status chip and the auto-login gate note.',
      expect_ui: 'the chip does not assert "Live" from an unmeasured state; the note names the actual probe result',
      expect_req: '200 /api/native-status consumed truthfully (F201)',
      actual: `chip="${sanitize((topStatus || '').replace(/\s+/g, ' ').slice(0, 90))}" note="${sanitize((autoNote || '').replace(/\s+/g, ' ').slice(0, 160))}"`,
      evidence: ev, verdict: (topStatus || autoNote) ? 'PASS' : 'BLOCKED',
      note: 'F201: a refused/empty probe must not become confirmed credential/DNS/listener failure' });

    // (3) navigate every route, assert the page's OWN component marker mounts
    const ROUTES = [
      ['nav.overview', '#/', 'overview-page'], ['nav.search', '#/search', 'search-page'],
      ['nav.sessions', '#/sessions', 'page-sessions'], ['nav.connections', '#/connections', 'page-connections'],
      ['nav.keys', '#/keys', 'page-keys'], ['nav.files', '#/files', 'file-explorer-page'],
      ['nav.mirror', '#/mirror', 'page-mirror'], ['nav.telemetry', '#/telemetry', 'page-telemetry'],
      ['nav.health', '#/health', 'health-page'], ['nav.collector', '#/collector', 'collector-page'],
      ['nav.settings', '#/settings', 'page-settings']
    ];
    for (const [cid, hash, marker] of ROUTES) {
      let visible = false, heading = '';
      if (!shell || expired()) {
        record({ control_id: 'real.' + cid, area: 'navigation',
          pre: 'authenticated real server',
          action: 'Navigate to ' + hash + ' and assert [' + marker + '] is visible.',
          expect_ui: 'the routed page component mounts (not merely a non-empty body)',
          expect_req: 'any page data comes from the real backend routes',
          actual: `marker=${marker} visible=false`, evidence: ev, verdict: 'BLOCKED',
          note: shell ? 'global deadline reached before this route' : 'app shell never mounted (blocked server or token gate); skipping to keep the run bounded' });
        continue;
      }
      try {
        await page.goto(base + '/?ui=v2&key=' + encodeURIComponent(key) + hash, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await page.waitForSelector('[data-testid="' + marker + '"]', { state: 'visible', timeout: 5000 });
        visible = true;
        heading = (await page.getByTestId(marker).innerText({ timeout: 2000 })).replace(/\s+/g, ' ').slice(0, 80);
      } catch (e) {}
      record({ control_id: 'real.' + cid, area: 'navigation',
        pre: 'authenticated real server',
        action: 'Navigate to ' + hash + ' and assert [' + marker + '] is visible.',
        expect_ui: 'the routed page component mounts (not merely a non-empty body)',
        expect_req: 'any page data comes from the real backend routes',
        actual: `marker=${marker} visible=${visible} heading="${sanitize(heading)}"`,
        evidence: ev, verdict: visible ? 'PASS' : 'FAIL',
        note: visible ? '' : 'routed component did not mount on the real server' });
    }

    // (4) global controls with real effect
    if (shell && !expired()) await page.goto(base + '/?ui=v2&key=' + encodeURIComponent(key) + '#/settings', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
    await sleep(500);
    const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme')).catch(() => null);
    let after = before, clicked = false;
    try { const b = await page.$('[data-testid="topbar-theme-toggle"], [data-testid="settings-theme-toggle"]'); if (b) { await b.click({ timeout: 4000 }); clicked = true; } } catch (e) {}
    await sleep(300);
    after = await page.evaluate(() => document.documentElement.getAttribute('data-theme')).catch(() => null);
    record({ control_id: 'real.settings_theme_toggle', area: 'settings',
      pre: 'authenticated real server',
      action: 'Click the theme toggle.',
      expect_ui: 'document data-theme changes and persists',
      expect_req: 'browser-local only (no backend)',
      actual: `before=${before} after=${after} clicked=${clicked}`,
      evidence: '', verdict: clicked && after !== before ? 'PASS' : (clicked ? 'FAIL' : 'BLOCKED'),
      note: 'real browser-local setting, not inferred from a unit test' });

    // (5) areas that need a REAL session / external service: exercise the real
    //     endpoint and record the actual verdict. Never fabricated.
    const areaChecks = [
      ['sessions.list', '/api/sessions', 'real session rows (needs a genuine logon)'],
      ['keys.reveal', '/api/config', 'masked creds in the authenticated config (reveal needs the real store)'],
      ['files.browse', '/api/fx/list', 'File Explorer index (needs the real staged filesystem index)'],
      ['mirror.start', '/api/mirror/status', 'mirror status (real start needs external hosts + opt-in)'],
      ['telemetry.samples', '/api/progress', 'real progress samples'],
      ['health.service_checks', '/health', 'real service health'],
      ['search.query', '/api/search/status', 'search lane status (a real query needs the search backend)']
    ];
    for (const [cid, ep, prereq] of areaChecks) {
      let r = { ok: false, status: null, ms: 0, bytes: 0, error: 'global-deadline' };
      if (!expired()) r = await httpGet(ep + (ep.indexOf('config') >= 0 ? '?key=' + encodeURIComponent(key) : ''), 6000);
      let keys = [];
      try { keys = Object.keys(JSON.parse(r.bodyHead.replace(/\s+$/, '')) || {}); } catch (e) {}
      const reachable = r.ok && r.status === 200;
      record({ control_id: 'real.' + cid, area: cid.split('.')[0],
        pre: 'real PowerShell server, lab synthetic data',
        action: 'GET ' + ep + ' on the real backend.',
        expect_ui: 'the page consumes a REAL response (or an honest unavailable state)',
        expect_req: 'GET ' + ep,
        actual: `status=${r.status || 'ERR'} ms=${r.ms} bytes=${r.bytes || 0} keys=[${keys.slice(0, 8).join(',')}]`,
        evidence: '', verdict: reachable ? 'PASS' : 'BLOCKED',
        note: reachable ? ('REAL endpoint responded; ' + prereq + ' is still separately required for full acceptance') : ('prerequisite: ' + prereq + ' (endpoint ' + (r.error || r.status) + ')') });
    }

    // (6) RDP / Web Desktop are NOT proven by a lab server
    record({ control_id: 'real.native_rdp_connect', area: 'connections',
      pre: 'requires a signed production launcher, a real run key and an RDP listener',
      action: 'not attempted on this lab-only server',
      expect_ui: 'n/a', expect_req: 'n/a',
      actual: 'BLOCKED: native RDP needs the origin signal chain + signed launcher + a real listener',
      evidence: '', verdict: 'BLOCKED',
      note: 'lab server is loopback with synthetic identity; a helper-only connect is NOT counted' });
    record({ control_id: 'real.web_desktop_frames', area: 'connections',
      pre: 'requires a real noVNC/TightVNC session on the tailnet',
      action: 'not attempted on this lab-only server',
      expect_ui: 'n/a', expect_req: 'n/a',
      actual: 'BLOCKED: web desktop needs a real captured interactive session',
      evidence: '', verdict: 'BLOCKED',
      note: 'no simulated frames are counted as proof' });

    report.consoleErrors = report.consoleErrors.slice(0, 40);
    report.failedRequests = report.failedRequests.slice(0, 40);
    await ctx.close();
  } finally {
    await browser.close().catch(() => {});
  }
}

async function screenshot(page, name) {
  const p = path.join(shotsDir, name + '.png');
  await page.screenshot({ path: p, fullPage: false }).catch(() => {});
  return path.relative(out, p);
}

async function main() {
  try {
    const effServer = serverSource || serverPath;
    if (!effServer || !fs.existsSync(effServer)) { report.fatal = 'server source missing: ' + effServer; return; }
    if (!root) { report.fatal = 'root missing'; return; }
    acquireDesktopLock();
    if (report.desktopLock && report.desktopLock.indexOf('FAILED') >= 0) {
      report.fatal = 'desktop lock not acquired: ' + report.desktopLock;
      return;
    }
    stageRoot();
    startServer();
    const ok = await measureStartup();
    flush(); // measurement (the key §7 number) is persisted BEFORE any slow phase
    await captureSocketOwner();
    if (ok && !expired()) { await sampleTicks(); flush(); }
    else if (ok) record({ control_id: 'real.tick_sampling', area: 'health', pre: 'real server', action: 'sample /health across a tick', expect_ui: 'n/a', expect_req: 'n/a', actual: 'skipped: global deadline', evidence: '', verdict: 'BLOCKED', note: 'bounded run' });
    if (ok && !expired()) { await captureEndpoints(); flush(); }
    // Bounded proof of the inline-WebSocket accept-loop stall (R2), BEFORE the
    // browser (which we stub below) can otherwise pin the server for 30 minutes.
    if (ok && !expired()) { await measureWsBlock(); flush(); }
    if (ok && !expired()) { await driveBrowser(); flush(); }
    else if (ok) record({ control_id: 'real.browser_suite_deferred', area: 'browser', pre: 'real server', action: 'drive the real UI', expect_ui: 'n/a', expect_req: 'n/a', actual: 'skipped: global deadline reached after measurement', evidence: '', verdict: 'BLOCKED', note: 'startup measurement already persisted; a hanging endpoint must not erase it' });
  } catch (e) {
    report.fatal = report.fatal || ('exception: ' + String(e.message || e).slice(0, 200));
  } finally {
    killOwned();
    releaseDesktopLock();
    // Write the pipe-captured stdout/stderr as sanitized evidence. These buffers
    // are the ONLY place a parse error / ExecutionPolicy failure can be seen —
    // run 40062592553 proved an fd-redirected detached child can go silent.
    try {
      const cleanOut = serverOutBuf.split(/\r?\n/).slice(-400).map((l) => sanitize(l)).join('\n');
      const cleanErr = serverErrBuf.split(/\r?\n/).slice(-400).map((l) => sanitize(l)).join('\n');
      fs.writeFileSync(path.join(out, 'server-stdout.log.sanitized'),
        '# sanitized server stdout (secrets redacted)\n' + cleanOut + '\n');
      fs.writeFileSync(path.join(out, 'server-stderr.log.sanitized'),
        '# sanitized server stderr (secrets redacted)\n' + cleanErr + '\n');
    } catch (e) {}
    // Startup-stall verdict for THIS label, then one final flush (a BLOCKED
    // acceptance item is NOT collapsed into PASS).
    if (report.timings.stallMs !== null && report.timings.stallMs !== undefined) {
      report._startupStallMs = report.timings.stallMs;
    }
    flush();
    // Sanitized copy of the marker/ready files for offline inspection.
    for (const f of ['server-ok.txt', 'server-ready.txt']) {
      try { fs.copyFileSync(path.join(root, f), path.join(out, f)); } catch (e) {}
    }
    process.stdout.write('REAL_BACKEND ' + label + ' fatal=' + (report.fatal || 'none') +
      ' stallMs=' + report.timings.stallMs + ' readyMs=' + report.timings.readyAppearedMs +
      ' healthP95Ms=' + report.timings.healthLatencyP95Ms + ' counts=' + JSON.stringify(report.verdicts) + '\n');
  }
}
main();
