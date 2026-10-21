'use strict';
// Process identity layer. A process is identified by (pid, createTime) where
// createTime comes from ONE source per platform (Win32_Process.CreationDate
// via scripts/ps/Get-ProcessSnapshot.ps1, /proc/<pid>/stat starttime on
// Linux). Identity is compared by exact string equality; a missing
// createTime means identity is unknown and nothing may be killed.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { redact } = require('./redact');

const IS_WIN = process.platform === 'win32';
const PS_SNAPSHOT = path.join(__dirname, '..', 'ps', 'Get-ProcessSnapshot.ps1');

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

function linuxSnapshot({ pids = [], listenPort = 0 } = {}) {
  const list = pids.length ? pids : fs.readdirSync('/proc').filter(d => /^\d+$/.test(d));
  const processes = list.map(linuxProc).filter(Boolean);
  return { platform: 'linux', currentPid: process.pid, currentSessionId: null, processes, listeners: listenPort ? linuxListeners(listenPort) : [] };
}

// ---------- Windows (PowerShell CIM) ----------
function winSnapshot({ pids = [], listenPort = 0 } = {}) {
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS_SNAPSHOT];
  if (pids.length) args.push('-ProcessIds', pids.map(Number).join(','));
  if (listenPort) args.push('-ListenPort', String(listenPort));
  const out = execFileSync('powershell.exe', args, { encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const data = JSON.parse(out.trim().replace(/^\uFEFF/, ''));
  data.processes = (Array.isArray(data.processes) ? data.processes : [data.processes]).filter(Boolean);
  data.listeners = (Array.isArray(data.listeners) ? data.listeners : [data.listeners]).filter(Boolean);
  return data;
}

function snapshot(opts = {}) {
  const snap = IS_WIN ? winSnapshot(opts) : linuxSnapshot(opts);
  snap.byPid = new Map(snap.processes.map(p => [Number(p.pid), p]));
  return snap;
}

function getProcess(pid) {
  if (!pid || !Number.isInteger(Number(pid))) return null;
  const snap = snapshot({ pids: [Number(pid)] });
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

module.exports = { snapshot, getProcess, sameIdentity, descendants, ancestors, sanitizeProcess, isAlive, terminate, IS_WIN };
