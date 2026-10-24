'use strict';
// Lab process registry: the list of processes this lab started, with their
// creation identity and the GitHub run/attempt + runner job anchor that owns
// them. Every read-modify-write happens under the registry lock and is
// committed with an atomic rename (no non-atomic copy fallback).

const fs = require('fs');
const path = require('path');
const os = require('os');
const proc = require('./proc');
const { withLock, sleepSync } = require('./lock');

const SCHEMA = 2;

function stateDir() {
  if (process.env.LAB_STATE_DIR) return path.resolve(process.env.LAB_STATE_DIR);
  const base = process.env.RUNNER_TOOL_CACHE || process.env.TEMP || os.tmpdir();
  return path.join(base, 'supreme-lamp-lab-state');
}
function registryPath() { return process.env.REGISTRY_PATH ? path.resolve(process.env.REGISTRY_PATH) : path.join(stateDir(), 'process-registry.json'); }
function registryLockDir(regPath = registryPath()) { return `${regPath}.lock.d`; }
function sessionLockDir() {
  // Production uses ONE cross-workflow desktop lock. Tests that provide an
  // isolated LAB_STATE_DIR retain their own lock path and never touch the VM's.
  if (process.env.LAB_STATE_DIR) return path.join(stateDir(), 'desktop-session.lock.d');
  const root = process.env.LAB_LOCK_DIR ? path.resolve(process.env.LAB_LOCK_DIR) : path.join(os.tmpdir(), 'slab-locks');
  return path.join(root, 'rdp-lab-desktop');
}

function currentRun() {
  return {
    runId: String(process.env.GITHUB_RUN_ID || 'local'),
    runAttempt: String(process.env.GITHUB_RUN_ATTEMPT || '1')
  };
}

function readRegistry(regPath = registryPath()) {
  if (!fs.existsSync(regPath)) return [];
  const raw = fs.readFileSync(regPath, 'utf8').replace(/^\uFEFF/, '').trim();
  if (!raw) return [];
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    const backup = `${regPath}.corrupt.${Date.now()}`;
    try { fs.copyFileSync(regPath, backup); } catch (e) { /* ignore */ }
    throw new Error(`REGISTRY_CORRUPT: ${regPath} is not valid JSON (${err.message}); preserved copy at ${backup}; refusing to overwrite`);
  }
  const records = Array.isArray(data) ? data : (data && Array.isArray(data.records) ? data.records : null);
  if (!records) throw new Error(`REGISTRY_CORRUPT: ${regPath} has no records array`);
  return records;
}

function atomicWriteJson(file, value, { retries = 20, retryMs = 100 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      // Windows: AV scanners / indexers can briefly hold the destination open
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) break;
      sleepSync(retryMs);
    }
  }
  try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
  throw new Error(`REGISTRY_WRITE_FAILED: atomic rename to ${file} failed: ${lastErr && lastErr.code} ${lastErr && lastErr.message}`);
}

function updateRegistry(mutator, { regPath = registryPath(), timeoutMs = 30000 } = {}) {
  const { runId, runAttempt } = currentRun();
  return withLock({ lockDir: registryLockDir(regPath), runId, runAttempt, role: 'registry-rmw', timeoutMs }, () => {
    const records = readRegistry(regPath);
    const result = mutator(records);
    const next = Array.isArray(result) ? result : records;
    atomicWriteJson(regPath, { schema: SCHEMA, updatedAt: new Date().toISOString(), records: next });
    return next;
  });
}

/** The GitHub runner job (Runner.Worker) that owns the calling process, if any. */
function findJobAnchor(snap, pid = process.pid) {
  for (const a of proc.ancestors(snap, pid)) {
    const p = snap.byPid.get(a);
    if (p && /^Runner\.Worker(\.exe)?$/i.test(p.name || '')) return { pid: p.pid, createTime: p.createTime, name: p.name };
  }
  return null;
}

function registerProcess({ pid, role, runId, runAttempt, regPath = registryPath(), anchor } = {}) {
  if (!pid) throw new Error('REGISTER_PID_REQUIRED');
  const snap = proc.snapshot({});
  const live = snap.byPid.get(Number(pid));
  if (!live) throw new Error(`REGISTER_FAILED: PID ${pid} is not running`);
  if (!live.createTime) throw new Error(`REGISTER_FAILED: creation identity of PID ${pid} unavailable`);
  const run = currentRun();
  const record = {
    schema: SCHEMA,
    runId: String(runId || run.runId),
    runAttempt: String(runAttempt || run.runAttempt),
    pid: live.pid,
    createTime: live.createTime,
    name: live.name,
    exe: live.exe || null,
    sessionId: live.sessionId === undefined ? null : live.sessionId,
    role: role || 'unknown',
    owner: process.env.USERNAME || process.env.USER || null,
    anchor: anchor !== undefined ? anchor : findJobAnchor(snap),
    registeredAt: new Date().toISOString()
  };
  updateRegistry(records => records.filter(r => !(Number(r.pid) === record.pid && r.createTime === record.createTime)).concat([record]), { regPath });
  return record;
}

function unregisterProcess({ pid, createTime, regPath = registryPath() }) {
  return updateRegistry(records => records.filter(r => !(Number(r.pid) === Number(pid) && (!createTime || r.createTime === createTime))), { regPath });
}

module.exports = {
  SCHEMA, stateDir, registryPath, registryLockDir, sessionLockDir, currentRun,
  readRegistry, atomicWriteJson, updateRegistry, registerProcess, unregisterProcess, findJobAnchor
};
