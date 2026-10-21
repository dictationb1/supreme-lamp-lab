#!/usr/bin/env node
'use strict';
// Supervises the REAL supreme-lamp backend on the ephemeral hosted server job.
//
//  1. spawns  <pwsh|powershell> -File <root>/ghrdp-server.ps1  with
//     GHRDP_BUILD_SHA=<sha> (so /api/version reports the exact commit) and
//     registers its (pid, createTime) in the lab registry;
//  2. waits for the server's OkFile (LISTENING pid=N | LISTEN_FAIL), verifies N
//     is the supervised pid and that the port listener belongs to it;
//  3. waits for strict readiness (while monitoring that the process is alive);
//  4. runs mission-control-check.js --scope server-local (async child);
//  5. optionally HOLDS the backend alive until the client job of this run
//     attempt completes (jobs API, bounded), failing loudly if it dies;
//  6. stops the backend and its verified descendants; unregisters.
//
// Failure taxonomy (run 39548093609 attempt 2 conflated these)
// -----------------------------------------------------------------
//   * NEW: start-order/identity problems that come from a *diagnostic helper*
//     (PowerShell) are recorded as degraded GUARDS, never as a backend crash.
//     A guard timeout used to abort startup verification and kill a backend
//     that was healthy; it now records the helper's own evidence and lets the
//     authoritative HTTP readiness check decide.
//   * BACKEND_EXITED_*          the supervised process really exited.
//   * BACKEND_NO_OKFILE         still alive but never reported listening.
//   * READINESS_*               the backend answered but is not ready/wrong.
//   * GUARD_*                   a guard could not be evaluated (UNVERIFIED,
//                               explicitly not PASS and not a crash).
// Every phase records { ok, code, detail, severity, at } and the helper
// diagnostics (call site, exe, timeout, elapsed, stderr) are persisted even when
// everything fails, and uploaded as evidence.
//
// Test hooks: --server-cmd '<json array>' --ok-file <path> --no-mc
//             --identity-timeout-ms --listener-timeout-ms --startup-budget-ms

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const proc = require('./lib/proc');
const ps = require('./lib/ps');
const registry = require('./lib/registry');
const { waitForReady } = require('./lib/readiness');
const { request } = require('./lib/http');
const annotate = require('./lib/annotate');
const { artifactDir, writeCapabilities } = require('./lib/results');
const { STATUS, CapabilitySet } = require('./lib/status');
const { redact } = require('./lib/redact');

function parseArgs(argv) {
  const a = {
    root: 'C:\\ghrdp', sha: null, port: 7331, hold: false, holdMaxMs: 20 * 60000, clientJob: 'client',
    holdPollMs: 15000, serverCmd: null, okFile: null, noMc: false, readyTimeoutMs: 180000,
    identityTimeoutMs: 20000, listenerTimeoutMs: 20000, startupBudgetMs: 360000
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--root') a.root = argv[++i];
    else if (k === '--sha') a.sha = argv[++i];
    else if (k === '--port') a.port = Number(argv[++i]);
    else if (k === '--hold') a.hold = argv[++i] === 'true';
    else if (k === '--hold-max-ms') a.holdMaxMs = Number(argv[++i]);
    else if (k === '--client-job') a.clientJob = argv[++i];
    else if (k === '--hold-poll-ms') a.holdPollMs = Number(argv[++i]);
    else if (k === '--server-cmd') a.serverCmd = JSON.parse(argv[++i]);
    else if (k === '--ok-file') a.okFile = argv[++i];
    else if (k === '--no-mc') a.noMc = true;
    else if (k === '--ready-timeout-ms') a.readyTimeoutMs = Number(argv[++i]);
    else if (k === '--identity-timeout-ms') a.identityTimeoutMs = Number(argv[++i]);
    else if (k === '--listener-timeout-ms') a.listenerTimeoutMs = Number(argv[++i]);
    else if (k === '--startup-budget-ms') a.startupBudgetMs = Number(argv[++i]);
  }
  return a;
}

const log = (...m) => console.log(`[supervisor ${new Date().toISOString()}]`, ...m);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function setOutput(k, v) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${String(v).replace(/\n/g, ' ')}\n`);
}

function backendPowerShellExe() {
  // The backend is a PowerShell script; prefer pwsh.exe when present. This is
  // recorded so a mismatch with the helpers' interpreter is never invisible.
  const r = ps.resolvePowerShell();
  return r.exe;
}

function tail(file, n = 40) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-n).join('\n'); } catch (e) { return ''; }
}

/** Compact, sanitized diagnostic retained from a thrown helper error. */
function helperDiagnostic(err) {
  return {
    message: redact(String(err && err.message)),
    errorCode: (err && err.code) || null,
    operation: (err && err.operation) || null,
    callSite: (err && err.callSite) || null,
    elapsedMs: err && err.elapsedMs !== undefined ? err.elapsedMs : null,
    timeoutMs: err && err.timeoutMs !== undefined ? err.timeoutMs : null,
    ...(err && err.diagnostic ? { helper: err.diagnostic } : {})
  };
}

class Backend {
  constructor(args, outDir) {
    this.args = args; this.outDir = outDir;
    this.exit = null; this.child = null; this.identity = null; this.identityState = 'UNVERIFIED';
    this.stdoutFile = path.join(outDir, 'backend.stdout.log');
    this.stderrFile = path.join(outDir, 'backend.stderr.log');
  }
  start() {
    const a = this.args;
    const cmd = a.serverCmd || [backendPowerShellExe(), '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(a.root, 'ghrdp-server.ps1')];
    this.cmd = cmd;
    this.okFile = a.okFile || path.join(a.root, 'server-ok.txt');
    try { fs.unlinkSync(this.okFile); } catch (e) { /* absent */ }
    const out = fs.openSync(this.stdoutFile, 'a');
    const err = fs.openSync(this.stderrFile, 'a');
    this.stdoutFd = out; this.stderrFd = err;
    this.child = spawn(cmd[0], cmd.slice(1), {
      cwd: fs.existsSync(a.root) ? a.root : process.cwd(),
      env: { ...process.env, GHRDP_BUILD_SHA: a.sha || '', OK_FILE: this.okFile, PORT: String(a.port) },
      stdio: ['ignore', out, err], windowsHide: true
    });
    this.child.on('exit', (code, signal) => { this.exit = { code, signal, at: new Date().toISOString() }; log(`backend exited code=${code} signal=${signal}`); });
    this.child.on('error', e => { this.exit = { code: null, signal: null, error: e.message, at: new Date().toISOString() }; });
    log(`spawned backend pid=${this.child.pid}: ${cmd.map(x => redact(x)).join(' ')}`);
  }
  alive() { return this.exit === null; }
  liveness() {
    return {
      at: new Date().toISOString(),
      pid: this.child ? this.child.pid : null,
      alive: this.alive(),
      exit: this.exit,
      identityState: this.identityState,
      stdoutTail: tail(this.stdoutFile, 12),
      stderrTail: tail(this.stderrFile, 12)
    };
  }
  async waitOkFile(timeoutMs, deadlineAt) {
    const deadline = Math.min(Date.now() + timeoutMs, deadlineAt || Infinity);
    while (Date.now() < deadline) {
      if (!this.alive()) return { ok: false, code: 'BACKEND_EXITED_BEFORE_LISTENING', detail: `exit=${JSON.stringify(this.exit)}; stderr tail: ${tail(this.stderrFile, 15)}` };
      let txt = '';
      try { txt = fs.readFileSync(this.okFile, 'utf8').trim(); } catch (e) { /* not yet */ }
      if (txt.startsWith('LISTEN_FAIL')) return { ok: false, code: 'BACKEND_LISTEN_FAIL', detail: txt.slice(0, 500) };
      const m = txt.match(/^LISTENING\b.*?pid=(\d+)/);
      if (m) {
        const pid = Number(m[1]);
        if (pid !== this.child.pid) return { ok: false, code: 'BACKEND_OKFILE_FOREIGN_PID', detail: `OkFile pid ${pid} != supervised ${this.child.pid}` };
        return { ok: true, detail: txt };
      }
      await sleep(500);
    }
    if (!this.alive()) return { ok: false, code: 'BACKEND_EXITED_BEFORE_LISTENING', detail: `exit=${JSON.stringify(this.exit)}; stderr tail: ${tail(this.stderrFile, 15)}` };
    return { ok: false, code: 'BACKEND_NO_OKFILE', detail: `no LISTENING in ${this.okFile} within ${timeoutMs}ms (backend still alive pid=${this.child.pid})` };
  }
  /**
   * Verify the port belongs to the supervised process or its subtree.
   * Resolves { ok, code, detail, severity } - a helper failure is
   * GUARD_UNVERIFIED (degraded), never BACKEND_NOT_LISTENING.
   */
  async verifyListener(deadlineAt) {
    const port = this.args.port;
    let listeners;
    try {
      listeners = await proc.listenersAsync(port, { timeoutMs: this.args.listenerTimeoutMs, deadlineAt, operation: 'listener-query' });
    } catch (e) {
      return { ok: false, degraded: true, code: 'GUARD_LISTENER_UNVERIFIED', detail: redact(e.message), diagnostic: helperDiagnostic(e) };
    }
    const owners = [...new Set(listeners.map(l => l.pid))];
    if (!owners.length) return { ok: false, code: 'BACKEND_NOT_LISTENING', detail: `no listener on ${port} (query succeeded, backend pid=${this.child.pid} alive=${this.alive()})` };
    let subtree = [];
    try {
      subtree = await proc.descendantsOfAsync(this.child.pid, { timeoutMs: this.args.listenerTimeoutMs, deadlineAt, operation: 'process-subtree' });
    } catch (e) {
      // We cannot prove ownership of the listener. Report UNVERIFIED, and still
      // report the observed owners so the evidence is not lost.
      return { ok: false, degraded: true, code: 'GUARD_OWNERSHIP_UNVERIFIED', detail: `${redact(e.message)}; observed listener pid(s) ${owners.join(',')}`, diagnostic: helperDiagnostic(e) };
    }
    const mine = new Set([this.child.pid, ...subtree.map(p => p.pid)]);
    const foreign = owners.filter(p => !mine.has(p));
    if (foreign.length) return { ok: false, code: 'BACKEND_PORT_OWNED_BY_OTHER', detail: `port ${port} listeners ${owners.join(',')} include non-supervised pid(s) ${foreign.join(',')}` };
    return { ok: true, detail: `listener pid(s) ${owners.join(',')} within supervised subtree (${mine.size} pid(s))` };
  }
  /**
   * Safe stop. Only lab-owned processes with verified identity are signalled;
   * when identity is unknown we fall back to the direct child handle (which is
   * strictly safer than a pid lookup). Never a name-wide kill. Never throws:
   * cleanup failure must not mask the startup verdict.
   */
  /**
   * Async stop used by the normal path: bounded by the caller's deadline and
   * skipped entirely when no identity was verified (the direct child handle is
   * both faster and strictly safer than a synchronous pid lookup).
   */
  async stopAsync(deadlineAt) {
    if (!this.child) return { stopped: [], method: 'none', errors: [] };
    if (!this.identity) {
      const out = { stopped: [], method: 'none', errors: [] };
      if (this.alive()) {
        out.method = 'child-handle';
        try { this.child.kill(); out.stopped.push({ pid: this.child.pid, name: 'child-handle' }); } catch (e) { out.errors.push({ message: redact(e.message) }); }
      }
      this.closeFds();
      this.stopped = out;
      return out;
    }
    const out = { stopped: [], method: 'identity-verified-tree', errors: [] };
    let snap = null;
    try {
      snap = await proc.snapshotAsync({ timeoutMs: Math.min(10000, Math.max(500, (deadlineAt || Date.now() + 10000) - Date.now())), deadlineAt, operation: 'cleanup-snapshot' });
    } catch (e) {
      out.errors.push(helperDiagnostic(e));
      out.method = 'child-handle-fallback-after-helper-failure';
    }
    const root = snap ? snap.byPid.get(this.child.pid) : null;
    if (root && this.identity && root.createTime === this.identity.createTime) {
      const tree = proc.descendants(snap, root.pid, root.createTime).reverse();
      for (const p of tree.concat([root])) { proc.terminate(p.pid); out.stopped.push({ pid: p.pid, name: p.name }); }
    } else if (this.alive()) {
      out.method = out.method === 'identity-verified-tree' ? 'child-handle-identity-not-found' : out.method;
      try { this.child.kill(); out.stopped.push({ pid: this.child.pid, name: 'child-handle' }); } catch (e) { out.errors.push({ message: redact(e.message) }); }
    }
    try { registry.unregisterProcess({ pid: this.identity.pid, createTime: this.identity.createTime }); } catch (e) { annotate.warning('registry', redact(e.message)); }
    this.closeFds();
    this.stopped = out;
    return out;
  }
  closeFds() {
    for (const fd of [this.stdoutFd, this.stderrFd]) { try { if (fd !== undefined) fs.closeSync(fd); } catch (e) { /* ignore */ } }
  }
  stop() {
    if (!this.child) return { stopped: [], method: 'none', errors: [] };
    if (!this.identity) {
      // no verified identity: never take an expensive snapshot just to look up
      const out = { stopped: [], method: 'none', errors: [] };
      if (this.alive()) {
        out.method = 'child-handle';
        try { this.child.kill(); out.stopped.push({ pid: this.child.pid, name: 'child-handle' }); } catch (e) { out.errors.push({ message: redact(e.message) }); }
      }
      this.closeFds();
      this.stopped = out;
      return out;
    }
    const out = { stopped: [], method: 'none', errors: [] };
    let snap = null;
    try { snap = proc.snapshot({ operation: 'cleanup-snapshot' }); } catch (e) { out.errors.push(helperDiagnostic(e)); }
    try {
      const root = snap && this.identity ? snap.byPid.get(this.child.pid) : null;
      if (root && this.identity && root.createTime === this.identity.createTime) {
        out.method = 'identity-verified-tree';
        const tree = proc.descendants(snap, root.pid, root.createTime).reverse();
        for (const p of tree.concat([root])) { proc.terminate(p.pid); out.stopped.push({ pid: p.pid, name: p.name }); }
      } else if (this.alive()) {
        out.method = 'child-handle';
        try { this.child.kill(); out.stopped.push({ pid: this.child.pid, name: 'child-handle' }); } catch (e) { out.errors.push({ message: redact(e.message) }); }
      }
    } catch (e) {
      out.errors.push({ message: redact(e.message) });
    }
    if (this.identity) {
      try { registry.unregisterProcess({ pid: this.identity.pid, createTime: this.identity.createTime }); } catch (e) { annotate.warning('registry', e.message); }
    }
    for (const fd of [this.stdoutFd, this.stderrFd]) { try { if (fd !== undefined) fs.closeSync(fd); } catch (e) { /* ignore */ } }
    this.stopped = out;
    return out;
  }
}

function runChild(cmd, args, env) {
  return new Promise(resolve => {
    const c = spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
    c.on('exit', code => resolve(code));
    c.on('error', e => { log(`child error: ${e.message}`); resolve(127); });
  });
}

async function findJob(name) {
  const repo = process.env.GITHUB_REPOSITORY; const runId = process.env.GITHUB_RUN_ID; const attempt = process.env.GITHUB_RUN_ATTEMPT || '1';
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!repo || !runId || !token) return { error: 'JOBS_API_UNCONFIGURED' };
  const r = await request(`${process.env.GITHUB_API_URL || 'https://api.github.com'}/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`, {
    timeoutMs: 15000, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'supreme-lamp-lab' }
  });
  if (!r.json || !Array.isArray(r.json.jobs)) return { error: `JOBS_API_${r.status || r.transport}` };
  const job = r.json.jobs.find(j => j.name === name || j.name.startsWith(`${name} `));
  return job ? { status: job.status, conclusion: job.conclusion, runner: job.runner_name, id: job.id } : { status: 'absent' };
}

async function hold(backend, args) {
  const deadline = Date.now() + args.holdMaxMs;
  let last = null;
  while (Date.now() < deadline) {
    if (!backend.alive()) return { ok: false, code: 'BACKEND_DIED_DURING_HOLD', detail: `exit=${JSON.stringify(backend.exit)}; stderr: ${tail(backend.stderrFile, 10)}` };
    const j = await findJob(args.clientJob);
    if (!last || last.status !== j.status) log(`client job: ${JSON.stringify(j)}`);
    last = j;
    if (j.status === 'completed') return { ok: true, detail: `client job completed (${j.conclusion}) on ${j.runner}` };
    await sleep(args.holdPollMs);
  }
  return { ok: true, code: 'HOLD_DEADLINE', detail: `client job not completed within ${args.holdMaxMs}ms (last: ${JSON.stringify(last)})` };
}

async function main() {
  const args = parseArgs(process.argv);
  const outDir = artifactDir();
  const startupDeadline = Date.now() + args.startupBudgetMs;
  const resolve = ps.resolvePowerShell();
  const summary = {
    sha: args.sha, port: args.port, startedAt: new Date().toISOString(), phases: [],
    config: { readyTimeoutMs: args.readyTimeoutMs, startupBudgetMs: args.startupBudgetMs, identityTimeoutMs: args.identityTimeoutMs, listenerTimeoutMs: args.listenerTimeoutMs, hold: args.hold, holdMaxMs: args.holdMaxMs },
    powershell: (() => {
      const helperBase = path.basename(resolve.exe).toLowerCase();
      const backendExe = args.serverCmd ? args.serverCmd[0] : resolve.exe;
      const backendBase = path.basename(String(backendExe)).toLowerCase();
      return {
        helperExe: resolve.exe, helperExeSource: resolve.source, backendExe,
        sameInterpreter: helperBase === backendBase,
        note: helperBase === backendBase ? null : 'backend and helpers use different PowerShell interpreters'
      };
    })(),
    guards: [], helperFailures: []
  };
  const phase = (name, res, { fatal = true } = {}) => {
    const entry = { name, ...res, severity: res.ok ? 'OK' : (fatal ? 'FATAL' : 'DEGRADED'), at: new Date().toISOString() };
    summary.phases.push(entry);
    if (!res.ok && !fatal) summary.guards.push(entry);
    if (!res.ok && res.diagnostic) summary.helperFailures.push({ phase: name, ...res.diagnostic });
    log(`${name}: ${res.ok ? 'OK' : res.code}${fatal ? '' : ' (degraded guard)'} ${res.detail || ''}`);
    // Return the boolean outcome: callers do `if (!phase(...)) throw`.
    // (Returning the result object made every failing phase look successful.)
    return res.ok === true;
  };
  const backend = new Backend(args, outDir);
  let code = 1;
  let mcRan = false;
  const onSignal = sig => { log(`received ${sig}; stopping backend`); try { backend.stop(); } catch (e) { /* ignore */ } process.exit(130); };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  try {
    if (!args.serverCmd && !/^[0-9a-f]{40}$/.test(args.sha || '')) throw new Error(`MISSING_CONFIG: --sha must be a 40-char commit (got ${args.sha})`);
    const psVersion = await ps.runPowerShell({ args: ['-Command', '$PSVersionTable.PSVersion.ToString()'], timeoutMs: Math.min(args.identityTimeoutMs, 15000), deadlineAt: startupDeadline, operation: 'helper-version', site: 'backend-supervisor.js:main' });
    summary.powershell.helperVersion = psVersion.ok ? psVersion.stdout.trim() : null;
    summary.powershell.helperVersionDiagnostic = psVersion.ok ? null : ps.describe(psVersion);
    backend.start();
    await sleep(800);

    if (backend.alive()) {
      // Async, deadline-aware identity check. On failure the backend is NOT
      // declared dead: we record an UNVERIFIED guard and keep verifying.
      try {
        const live = await proc.getProcessAsync(backend.child.pid, { timeoutMs: args.identityTimeoutMs, deadlineAt: startupDeadline, operation: 'process-identity' });
        if (live && live.createTime) {
          backend.identity = { pid: live.pid, createTime: live.createTime };
          backend.identityState = 'VERIFIED';
          try { registry.registerProcess({ pid: live.pid, role: 'backend' }); } catch (e) { annotate.warning('registry', `backend registration failed: ${redact(e.message)}`); }
          phase('identity', { ok: true, detail: `pid=${live.pid} createTime=${live.createTime}`, evidence: { pid: live.pid, createTime: live.createTime } });
        } else {
          phase('identity', { ok: false, code: 'GUARD_IDENTITY_UNVERIFIED', detail: `process ${backend.child.pid} not found by the identity query (alive=${backend.alive()})`, evidence: backend.liveness() }, { fatal: false });
        }
      } catch (e) {
        // The helper failed, not the backend. Keep the diagnostic and continue.
        phase('identity', { ok: false, degraded: true, code: 'GUARD_IDENTITY_UNVERIFIED', detail: redact(e.message), diagnostic: helperDiagnostic(e), evidence: backend.liveness() }, { fatal: false });
      }
    }
    // (when the process is already gone we do not add an identity phase: the
    // okfile phase below reports the established BACKEND_EXITED_BEFORE_LISTENING
    // cause with the backend's own stderr)
    summary.backend = backend.identity;
    summary.backendIdentityState = backend.identityState;

    if (!backend.alive()) {
      phase('okfile', { ok: false, code: 'BACKEND_EXITED_BEFORE_LISTENING', detail: `exit=${JSON.stringify(backend.exit)}; stderr tail: ${tail(backend.stderrFile, 15)}` });
      throw new Error('phase okfile');
    }
    if (!phase('okfile', await backend.waitOkFile(args.readyTimeoutMs, startupDeadline))) throw new Error('phase okfile');

    const listener = await backend.verifyListener(startupDeadline);
    // A degraded guard means "ownership could not be proven", which must not
    // abort startup verification (that was the original defect); a genuine
    // ownership/not-listening failure must.
    if (!phase('listener', listener, { fatal: !listener.degraded }) && !listener.degraded) throw new Error('phase listener');

    const target = `http://127.0.0.1:${args.port}`;
    const ready = await waitForReady(target, { timeoutMs: Math.max(1000, Math.min(args.readyTimeoutMs, startupDeadline - Date.now())), expectPid: backend.child.pid, expectPort: args.port, isAlive: () => backend.alive(), log: m => log(`readiness ${m}`) });
    if (!phase('readiness', { ok: ready.ready, code: ready.code, detail: ready.detail, history: ready.history })) throw new Error('phase readiness');
    setOutput('backend_pid', backend.child.pid);
    setOutput('backend_create_time', backend.identity ? backend.identity.createTime : '');
    setOutput('backend_identity_state', backend.identityState);

    let mcCode = 0;
    if (!args.noMc) {
      mcRan = true;
      mcCode = await runChild(process.execPath, [path.join(__dirname, 'mission-control-check.js'), '--scope', 'server-local', '--target', target, '--expect-sha', args.sha, '--expect-pid', String(backend.child.pid), '--expect-port', String(args.port), '--headless', '--ready-timeout-ms', '30000']);
      phase('server-local-checks', { ok: mcCode === 0, code: mcCode === 0 ? 'OK' : `MC_EXIT_${mcCode}`, detail: 'mission-control-check --scope server-local' });
    }
    if (!backend.alive()) throw Object.assign(new Error('backend died after checks'), { phaseResult: phase('alive-after-checks', { ok: false, code: 'BACKEND_DIED', detail: JSON.stringify(backend.exit) }) });

    if (args.hold) {
      const h = await hold(backend, args);
      phase('hold', h);
      if (!h.ok) mcCode = mcCode || 1;
    }
    code = mcCode === 0 ? 0 : 1;
  } catch (e) {
    if (!/^phase /.test(e.message) && !e.phaseResult) phase('fatal', { ok: false, code: 'SUPERVISOR_ERROR', detail: redact(e.message) });
    code = 1;
  } finally {
    // Evidence BEFORE bounded cleanup, so a cleanup failure cannot erase it.
    summary.livenessAtExit = backend.liveness();
    let st;
    try { st = await backend.stopAsync(Date.now() + 15000); } catch (e) { st = { stopped: [], method: 'error', errors: [{ message: redact(e.message) }] }; }
    summary.stopped = st.stopped;
    summary.stopMethod = st.method;
    summary.stopErrors = st.errors;
    summary.exit = backend.exit;
    summary.finishedAt = new Date().toISOString();
    summary.stdoutTail = tail(backend.stdoutFile, 30);
    summary.stderrTail = tail(backend.stderrFile, 30);
    try {
      fs.writeFileSync(path.join(outDir, 'backend-supervisor.json'), JSON.stringify(summary, null, 2));
    } catch (e) { log(`could not write backend-supervisor.json: ${e.message}`); }
    const failed = summary.phases.find(p => !p.ok && p.severity === 'FATAL');
    const degraded = summary.phases.filter(p => !p.ok && p.severity === 'DEGRADED');
    if (degraded.length) {
      for (const d of degraded) annotate.warning(`guard ${d.name}`, `${d.code}: ${d.detail}`);
    }
    if (!mcRan && !args.noMc) {
      // the checker never ran: record the causal supervisor failure instead of NOT_RUN
      const caps = new CapabilitySet({ backend_readiness_server_local: { required: true }, dashboard_server_local: { required: true } });
      const why = failed ? `SUPERVISOR_${failed.name.toUpperCase()}: ${failed.code}: ${String(failed.detail || '').slice(0, 400)}` : 'SUPERVISOR_ABORTED';
      caps.set('backend_readiness_server_local', STATUS.FAIL, why, {
        backend: summary.backend, backendIdentityState: summary.backendIdentityState,
        liveness: summary.livenessAtExit, guards: degraded.map(d => ({ name: d.name, code: d.code, detail: d.detail })),
        stderrTail: String(summary.stderrTail || '').slice(-1500)
      });
      caps.set('dashboard_server_local', STATUS.BLOCKED, `DEPENDS_ON_BACKEND: ${why}`);
      writeCapabilities('server-local', caps, { source: 'backend-supervisor', supervisor: { phases: summary.phases.map(p => ({ name: p.name, ok: p.ok, code: p.code || null, severity: p.severity })), powershell: summary.powershell, stopMethod: summary.stopMethod } });
    }
    if (failed) annotate.error(`backend ${failed.name}`, `${failed.code}: ${failed.detail || ''}`);
    else annotate.notice('backend supervised', `pid=${summary.backend && summary.backend.pid} identity=${summary.backendIdentityState} helper=${summary.powershell && summary.powershell.exe} (${summary.powershell && summary.powershell.source}) guards=${degraded.length} phases=${summary.phases.map(p => p.name).join(',')}`);
    setOutput('supervisor_first_failure', failed ? `${failed.name}:${failed.code}` : 'none');
    setOutput('supervisor_degraded_guards', degraded.map(d => `${d.name}:${d.code}`).join(',') || 'none');
  }
  process.exit(code);
}

if (require.main === module) main().catch(e => { annotate.error('backend supervisor', redact(e.message)); process.exit(1); });
module.exports = { parseArgs, helperDiagnostic };
