'use strict';
// Process identity layer. A process is identified by (pid, createTime) where
// createTime comes from ONE source per platform (Win32_Process.CreationDate
// via scripts/ps/Get-ProcessSnapshot.ps1, /proc/<pid>/stat starttime on
// Linux). Identity is compared by exact string equality; a missing
// createTime means identity is unknown and nothing may be killed.
//
// Two APIs, deliberately:
//   * snapshotAsync / getProcessAsync / listenersAsync / descendantsOfAsync
//     - asynchronous, bounded, deadline-aware; used on every startup and
//       verification path so a slow helper can never block liveness checks,
//       readiness polling or cancellation (see scripts/lib/ps.js).
//   * snapshot / getProcess
//     - synchronous, kept only for the registry lock and for callers that are
//       themselves short-lived (lock owner checks). They are bounded, and they
//       report operation + call site + stderr instead of throwing a bare
//       "spawnSync ... ETIMEDOUT".
// Narrow by default: ask for the PIDs / subtree / port you need. A full
// Win32_Process enumeration is opt-in because it is the expensive query.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { redact } = require('./redact');
const ps = require('./ps');

const IS_WIN = process.platform === 'win32';
// Test hook: force the PowerShell-backed code path on any platform so the
// helper timeout / guard behaviour can be regression-tested off Windows (the
// real Windows coverage still runs in the self-hosted client job). Not used by
// the live workflow.
const usePowerShell = () => IS_WIN || process.env.LAB_PROC_FORCE_POWERSHELL === '1';
const PS_SNAPSHOT = path.join(__dirname, '..', 'ps', 'Get-ProcessSnapshot.ps1');
const SYNC_TIMEOUT_MS = Number(process.env.LAB_PS_SYNC_TIMEOUT_MS || 20000);

// ---------- Linux (/proc) ----------
let bootTimeSec = null;
function linuxBootTime() {
  if (bootTimeSec !== null) return bootTimeSec;
  const m = fs.readFileSync('/proc/stat', 'utf8').match(/^btime\s+(\d+)/m);
  bootTimeSec = m ? Number(m[1]) : 0;
  return bootTimeSec;
}
const CLK_TCK = 100;

function linuxProc(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rp = stat.lastIndexOf(')');
    const name = stat.slice(stat.indexOf('(') + 1, rp);
    const fields = stat.slice(rp + 2).split(' ');
    const ppid = Number(fields[1]);
    const startTicks = fields[19];
    const state = fields[0];
    if (state === 'Z') return null; // zombies have exited; treat as gone
    let exe = ''; let cwd = ''; let cmdline = '';
    try { exe = fs.readlinkSync(`/proc/${pid}/exe`); } catch (e) { /* permission */ }
    try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch (e) { /* permission */ }
    try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' '); } catch (e) { /* gone */ }
    const createIso = new Date((linuxBootTime() + Number(startTicks) / CLK_TCK) * 1000).toISOString();
    return {
      pid: Number(pid), ppid, name, exe, cwd, cmdline,
      // exact identity token; ISO string kept separately for humans
      createTime: `linux:${linuxBootTime()}:${startTicks}`,
      createTimeIso: createIso,
      sessionId: null
    };
  } catch (e) {
    return null;
  }
}

function linuxListeners(port) {
  const inodes = new Map();
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let txt = '';
    try { txt = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    for (const line of txt.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10) continue;
      const [addrHex, portHex] = cols[1].split(':');
      if (cols[3] !== '0A') continue; // LISTEN
      if (parseInt(portHex, 16) !== port) continue;
      inodes.set(cols[9], addrHex);
    }
  }
  const listeners = [];
  if (!inodes.size) return listeners;
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    let fds;
    try { fds = fs.readdirSync(`/proc/${d}/fd`); } catch (e) { continue; }
    for (const fd of fds) {
      let link;
      try { link = fs.readlinkSync(`/proc/${d}/fd/${fd}`); } catch (e) { continue; }
      const m = link.match(/^socket:\[(\d+)\]$/);
      if (m && inodes.has(m[1])) listeners.push({ port, address: inodes.get(m[1]), pid: Number(d) });
    }
  }
  return listeners;
}

function linuxAllPids() { return fs.readdirSync('/proc').filter(d => /^\d+$/.test(d)).map(Number); }

/** Narrow subtree walk on Linux (mirrors -DescendantsOf for Windows). */
function linuxDescendants(rootPid) {
  const all = linuxAllPids().map(linuxProc).filter(Boolean);
  const byPid = new Map(all.map(p => [p.pid, p]));
  const root = byPid.get(Number(rootPid));
  if (!root) return [];
  const out = []; const seen = new Set([root.pid]); const queue = [root.pid];
  while (queue.length) {
    const parent = queue.shift();
    for (const p of all) {
      if (p.ppid === parent && !seen.has(p.pid)) { seen.add(p.pid); out.push(p); queue.push(p.pid); }
    }
  }
  return out;
}

function linuxSnapshot({ pids = [], listenPort = 0, descendantsOf = 0, noProcesses = false } = {}) {
  // Same narrow-query contract as the Windows helper: ask only for what you
  // need. (Returning every process here previously made listener-ownership
  // checks pass trivially on Linux.)
  let processes;
  if (pids.length) processes = pids.map(linuxProc).filter(Boolean);
  else if (descendantsOf) processes = linuxDescendants(descendantsOf);
  else if (noProcesses) processes = [];
  else processes = linuxAllPids().map(linuxProc).filter(Boolean);
  return { platform: 'linux', currentPid: process.pid, currentSessionId: null, processes, listeners: listenPort ? linuxListeners(listenPort) : [], listenersError: null, processQueryError: null };
}

// ---------- Windows (PowerShell + CIM) ----------
function normalizeDoc(data) {
  const doc = data && typeof data === 'object' ? data : {};
  doc.processes = (Array.isArray(doc.processes) ? doc.processes : [doc.processes]).filter(Boolean);
  doc.listeners = (Array.isArray(doc.listeners) ? doc.listeners : [doc.listeners]).filter(Boolean);
  doc.listenersError = doc.listenersError || null;
  doc.processQueryError = doc.processQueryError || null;
  doc.byPid = new Map(doc.processes.map(p => [Number(p.pid), p]));
  return doc;
}

function psArgsFor(opts) {
  const args = [];
  if (opts.pids && opts.pids.length) args.push('-ProcessIds', opts.pids.map(Number).join(','));
  if (opts.listenPort) args.push('-ListenPort', String(opts.listenPort));
  if (opts.descendantsOf) args.push('-DescendantsOf', String(opts.descendantsOf));
  if (opts.noProcesses) args.push('-NoProcesses');
  return args;
}

/** Structured, sanitized failure so the caller can record evidence. */
function helperFailure(result, operation) {
  const e = new Error(`POWERSHELL_HELPER_FAILED: ${ps.describe(result)}`);
  e.code = result.errorCode || 'POWERSHELL_HELPER_FAILED';
  e.operation = operation || result.operation;
  e.callSite = result.callSite;
  e.elapsedMs = result.elapsedMs;
  e.timeoutMs = result.effectiveTimeoutMs;
  e.stdout = result.stdout;
  e.stderr = result.stderr;
  e.diagnostic = {
    errorCode: result.errorCode, operation: result.operation, callSite: result.callSite,
    exe: result.exe, exeSource: result.exeSource, args: result.args,
    timeoutMs: result.effectiveTimeoutMs, elapsedMs: result.elapsedMs,
    code: result.code, signal: result.signal, timedOut: Boolean(result.timedOut),
    budgetClamped: Boolean(result.budgetClamped),
    stderr: redact(ps.tail((result.stderr || '').trim(), 1200)),
    stdout: redact(ps.tail((result.stdout || '').trim(), 600))
  };
  return e;
}

/**
 * Async Windows snapshot. op options:
 *   pids[] | listenPort | descendantsOf | noProcesses
 *   timeoutMs, deadlineAt, operation
 */
async function snapshotAsync(opts = {}) {
  if (!usePowerShell()) {
    const snap = linuxSnapshot(opts);
    snap.byPid = new Map(snap.processes.map(p => [Number(p.pid), p]));
    return snap;
  }
  const operation = opts.operation || 'process-snapshot';
  const result = await ps.runPowerShell({
    script: PS_SNAPSHOT,
    args: psArgsFor(opts),
    timeoutMs: opts.timeoutMs,
    deadlineAt: opts.deadlineAt,
    operation,
    env: opts.env,
    site: opts.site || ps.callSite(3)
  });
  if (!result.ok) throw helperFailure(result, operation);
  let data;
  try {
    data = JSON.parse(String(result.stdout).trim().replace(/^\uFEFF/, ''));
  } catch (err) {
    const e = new Error(`POWERSHELL_OUTPUT_UNPARSEABLE: operation=${operation} site=${result.callSite} ${err.message} stdout=${JSON.stringify(ps.tail(result.stdout, 300))}`);
    e.code = 'POWERSHELL_OUTPUT_UNPARSEABLE';
    e.operation = operation;
    e.callSite = result.callSite;
    e.diagnostic = { operation, callSite: result.callSite, stdout: redact(ps.tail(result.stdout, 600)), stderr: redact(ps.tail(result.stderr, 600)) };
    throw e;
  }
  const doc = normalizeDoc(data);
  doc.helper = { operation, elapsedMs: result.elapsedMs, timeoutMs: result.effectiveTimeoutMs, exe: result.exe, callSite: result.callSite };
  return doc;
}

/** Async identity lookup for one PID: the process record or null if gone. */
async function getProcessAsync(pid, opts = {}) {
  if (!pid || !Number.isInteger(Number(pid))) return null;
  const snap = await snapshotAsync({ ...opts, pids: [Number(pid)], operation: opts.operation || 'process-identity' });
  return snap.byPid.get(Number(pid)) || null;
}

/** Async listener owners for one port. Throws on helper failure (never "not listening"). */
async function listenersAsync(port, opts = {}) {
  const snap = await snapshotAsync({ ...opts, listenPort: Number(port), noProcesses: true, operation: opts.operation || 'listener-query' });
  if (snap.listenersError) {
    const e = new Error(`LISTENER_QUERY_FAILED: ${snap.listenersError}`);
    e.code = 'LISTENER_QUERY_FAILED';
    e.diagnostic = { operation: snap.helper && snap.helper.operation, listenersError: redact(snap.listenersError) };
    throw e;
  }
  return snap.listeners;
}

/** Async narrow subtree (ParentProcessId filters only, bounded depth). */
async function descendantsOfAsync(rootPid, opts = {}) {
  const snap = await snapshotAsync({ ...opts, descendantsOf: Number(rootPid), operation: opts.operation || 'process-subtree' });
  if (snap.processQueryError) {
    const e = new Error(`SUBTREE_QUERY_FAILED: ${snap.processQueryError}`);
    e.code = 'SUBTREE_QUERY_FAILED';
    e.diagnostic = { operation: snap.helper && snap.helper.operation, processQueryError: redact(snap.processQueryError) };
    throw e;
  }
  return snap.processes;
}

/**
 * Synchronous Windows snapshot, used only by the registry lock and short-lived
 * owner checks. Bounded, and failures carry operation/call-site/stderr.
 */
function winSnapshot({ pids = [], listenPort = 0, descendantsOf = 0, noProcesses = false, operation = 'process-snapshot(sync)', site } = {}) {
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS_SNAPSHOT, ...psArgsFor({ pids, listenPort, descendantsOf, noProcesses })];
  const where = site || ps.callSite(3);
  const resolveExe = ps.resolvePowerShell();
  const started = Date.now();
  let out;
  try {
    out = execFileSync(resolveExe.exe, [...resolveExe.prefixArgs, ...args], { encoding: 'utf8', timeout: SYNC_TIMEOUT_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const elapsed = Date.now() - started;
    const timedOut = err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM' || err.signal === 'SIGKILL';
    const stderr = String((err.stderr || '') + '').trim();
    const stdout = String((err.stdout || '') + '').trim();
    const code = timedOut ? 'POWERSHELL_TIMEOUT' : (err.code || 'POWERSHELL_EXIT_NONZERO');
    const e = new Error(`POWERSHELL_HELPER_FAILED: ${code} op=${operation} site=${where} exe=${resolveExe.exe} elapsed=${elapsed}ms/${SYNC_TIMEOUT_MS}ms${stderr ? ` stderr=${JSON.stringify(redact(ps.tail(stderr, 600)))}` : ''}`);
    e.code = code;
    e.operation = operation;
    e.callSite = where;
    e.elapsedMs = elapsed;
    e.timeoutMs = SYNC_TIMEOUT_MS;
    e.stderr = stderr;
    e.stdout = stdout;
    e.diagnostic = {
      errorCode: code, operation, callSite: where, exe: resolveExe.exe, exeSource: resolveExe.source,
      args: [...resolveExe.prefixArgs, ...args].map(a => redact(a)).join(' '),
      timeoutMs: SYNC_TIMEOUT_MS, elapsedMs: elapsed, timedOut,
      exitCode: err.status === undefined ? null : err.status, signal: err.signal || null,
      stderr: redact(ps.tail(stderr, 1200)), stdout: redact(ps.tail(stdout, 600))
    };
    throw e;
  }
  const doc = normalizeDoc(JSON.parse(String(out).trim().replace(/^\uFEFF/, '')));
  doc.helper = { operation, elapsedMs: Date.now() - started, timeoutMs: SYNC_TIMEOUT_MS, exe: resolveExe.exe, sync: true };
  return doc;
}

function snapshot(opts = {}) {
  const snap = usePowerShell() ? winSnapshot(opts) : linuxSnapshot(opts);
  snap.byPid = new Map(snap.processes.map(p => [Number(p.pid), p]));
  return snap;
}

function getProcess(pid) {
  if (!pid || !Number.isInteger(Number(pid))) return null;
  const snap = snapshot({ pids: [Number(pid)], operation: 'process-identity(sync)' });
  return snap.byPid.get(Number(pid)) || null;
}

/** Strict identity match: both createTime values must be present and equal. */
function sameIdentity(record, live) {
  if (!record || !live) return false;
  if (!record.createTime || !live.createTime) return false;
  return Number(record.pid) === Number(live.pid) && String(record.createTime) === String(live.createTime);
}

function createMs(p) {
  if (!p) return NaN;
  if (p.createTimeIso) return Date.parse(p.createTimeIso);
  return Date.parse(p.createTime);
}

/**
 * Descendants of (rootPid, rootCreateTime) in a snapshot. A child only counts
 * when it was created at/after its parent (guards against PID reuse of a
 * parent id by an unrelated older process).
 */
function descendants(snap, rootPid, rootCreateTime) {
  const root = snap.byPid.get(Number(rootPid));
  if (!root || (rootCreateTime && root.createTime !== rootCreateTime)) return [];
  const out = [];
  const queue = [root];
  const seen = new Set([root.pid]);
  while (queue.length) {
    const parent = queue.shift();
    for (const p of snap.processes) {
      if (p.ppid === parent.pid && !seen.has(p.pid)) {
        const pc = createMs(p); const pp = createMs(parent);
        if (!Number.isNaN(pc) && !Number.isNaN(pp) && pc + 1000 < pp) continue; // older than parent -> not a child
        seen.add(p.pid);
        out.push(p);
        queue.push(p);
      }
    }
  }
  return out;
}

function ancestors(snap, pid) {
  const out = [];
  let cur = snap.byPid.get(Number(pid));
  const seen = new Set();
  while (cur && cur.ppid && !seen.has(cur.ppid)) {
    seen.add(cur.ppid);
    out.push(cur.ppid);
    cur = snap.byPid.get(cur.ppid);
  }
  return out;
}

function sanitizeProcess(p) {
  if (!p) return null;
  return {
    pid: p.pid, ppid: p.ppid, name: p.name, exe: p.exe || null,
    cwd: p.cwd || null,
    cmdline: p.cmdline ? redact(p.cmdline) : null,
    createTime: p.createTime || null,
    createTimeIso: p.createTimeIso || p.createTime || null,
    sessionId: p.sessionId === undefined ? null : p.sessionId
  };
}

function isAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function terminate(pid) {
  try { process.kill(Number(pid), IS_WIN ? undefined : 'SIGKILL'); return true; } catch (e) { return e.code === 'ESRCH' ? 'gone' : false; }
}

module.exports = {
  snapshot, getProcess, sameIdentity, descendants, ancestors, sanitizeProcess, isAlive, terminate, IS_WIN,
  snapshotAsync, getProcessAsync, listenersAsync, descendantsOfAsync, helperFailure,
  SYNC_TIMEOUT_MS, PS_SNAPSHOT, usePowerShell
};
