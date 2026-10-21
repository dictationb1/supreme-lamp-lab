'use strict';
// Exclusive cross-process lock based on atomic, NON-recursive directory
// creation (mkdir fails with EEXIST if another process holds the lock).
//
// Stale-lock recovery only happens when the recorded owner is demonstrably
// gone: its (pid, createTime) identity no longer exists. Recovery is
// serialised with a claim directory named after the dead owner's token and the
// token is re-verified before the stale directory is renamed away, so two
// recoverers can never steal a live lock.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const proc = require('./proc');

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) { Atomics.wait(SLEEP_CELL, 0, 0, ms); }

// Minimum age before spawning a full OS process-identity helper against a
// currently-alive holder PID to check for PID wraparound/reuse. On Windows each
// proc.getProcess() spawns powershell.exe + CIM (~700ms-3s under contention), so
// polling it on every 5ms spin-iteration starved 4 concurrent contenders past
// 60s on rdp-lab-client.
//
// Safety invariant:
//   1. `pidExists(owner.pid)` (`process.kill(pid, 0)`) runs in ~2 microseconds
//      on every iteration with zero subprocesses; on both POSIX and Windows
//      libuv checks GetExitCodeProcess != STILL_ACTIVE and throws ESRCH as soon
//      as the process exits, so dead owners are still detected immediately.
//   2. `owner.pid === process.pid` compares against `selfIdentity()` in memory.
//   3. Missing/unparseable `acquiredAt` (or age >= PID_REUSE_CHECK_AFTER_MS)
//      runs the full `(pid, createTime)` query and caches verified live tokens
//      for `PID_REUSE_RECHECK_MS`.
const PID_REUSE_CHECK_AFTER_MS = 2000;
const PID_REUSE_RECHECK_MS = 2000;
const verifiedLiveTokens = new Map();

function pidExists(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return Boolean(e && e.code === 'EPERM');
  }
}

function readOwner(lockDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
  } catch (e) {
    return null;
  }
}

let selfCache = null;
function selfIdentity() {
  if (selfCache) return selfCache;
  const me = proc.getProcess(process.pid);
  if (!me || !me.createTime) {
    throw new Error(`LOCK_IDENTITY_UNAVAILABLE: cannot establish creation identity of PID ${process.pid}`);
  }
  selfCache = me;
  return me;
}

function ownerIsDead(owner) {
  if (!owner || !owner.pid || !owner.createTime) return { dead: false, reason: 'OWNER_IDENTITY_INCOMPLETE' };
  const pid = Number(owner.pid);
  if (!pidExists(pid)) return { dead: true, reason: 'OWNER_PROCESS_GONE' };
  if (pid === process.pid) {
    const me = selfIdentity();
    return me.createTime !== owner.createTime
      ? { dead: true, reason: 'OWNER_PID_REUSED' }
      : { dead: false, reason: 'OWNER_ALIVE' };
  }
  const now = Date.now();
  const acquiredMs = owner.acquiredAt ? Date.parse(owner.acquiredAt) : NaN;
  if (Number.isFinite(acquiredMs) && now - acquiredMs >= 0 && now - acquiredMs < PID_REUSE_CHECK_AFTER_MS) {
    return { dead: false, reason: 'OWNER_ALIVE' };
  }
  if (owner.token) {
    const lastVerified = verifiedLiveTokens.get(owner.token);
    if (lastVerified && now - lastVerified < PID_REUSE_RECHECK_MS) {
      return { dead: false, reason: 'OWNER_ALIVE' };
    }
  }
  let live;
  try { live = proc.getProcess(pid); } catch (e) { return { dead: false, reason: `IDENTITY_QUERY_FAILED: ${e.message}` }; }
  if (!live) return { dead: true, reason: 'OWNER_PROCESS_GONE' };
  if (!live.createTime) return { dead: false, reason: 'LIVE_IDENTITY_UNKNOWN' };
  if (live.createTime !== owner.createTime) return { dead: true, reason: 'OWNER_PID_REUSED' };
  if (owner.token) {
    if (verifiedLiveTokens.size > 256) verifiedLiveTokens.clear();
    verifiedLiveTokens.set(owner.token, Date.now());
  }
  return { dead: false, reason: 'OWNER_ALIVE' };
}

function tryRecover(lockDir, owner, events) {
  const claimName = owner && owner.token ? `claim-${owner.token}` : 'claim-noowner';
  const claimDir = path.join(lockDir, claimName);
  try { fs.mkdirSync(claimDir); } catch (e) { return false; } // someone else is recovering
  const again = readOwner(lockDir);
  const sameInstance = owner ? (again && again.token === owner.token) : !again;
  if (!sameInstance) {
    try { fs.rmdirSync(claimDir); } catch (e) { /* ignore */ }
    return false;
  }
  const graveyard = `${lockDir}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.renameSync(lockDir, graveyard);
  } catch (e) {
    try { fs.rmdirSync(claimDir); } catch (e2) { /* ignore */ }
    return false;
  }
  try { fs.rmSync(graveyard, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  events.push({ at: new Date().toISOString(), event: 'STALE_LOCK_RECOVERED', previousOwner: owner || null });
  return true;
}

/**
 * Acquire an exclusive lock. Throws LOCK_ACQUISITION_FAILED on timeout.
 * Returns a handle { lockDir, token, owner, events }.
 */
function acquireLock({ lockDir, runId, runAttempt, role = 'unknown', timeoutMs = 10000, pollMs = 250, noOwnerGraceMs = 30000 } = {}) {
  if (!lockDir) throw new Error('LOCK_DIR_REQUIRED');
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const me = selfIdentity();
  const token = crypto.randomBytes(12).toString('hex');
  const deadline = Date.now() + timeoutMs;
  const events = [];
  let lastHolder = null;
  for (;;) {
    let created = false;
    try {
      fs.mkdirSync(lockDir); // atomic, non-recursive
      created = true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw new Error(`LOCK_MKDIR_FAILED: ${err.code || ''} ${err.message}`);
    }
    if (created) {
      const owner = {
        token, pid: process.pid, createTime: me.createTime, host: os.hostname(),
        user: process.env.USERNAME || process.env.USER || null,
        runId: String(runId || process.env.GITHUB_RUN_ID || 'local'),
        runAttempt: String(runAttempt || process.env.GITHUB_RUN_ATTEMPT || '1'),
        role, acquiredAt: new Date().toISOString()
      };
      const tmp = path.join(lockDir, `.owner.${token}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(owner, null, 2));
      fs.renameSync(tmp, path.join(lockDir, 'owner.json'));
      return { lockDir, token, owner, events };
    }
    const owner = readOwner(lockDir);
    lastHolder = owner;
    if (owner) {
      const verdict = ownerIsDead(owner);
      if (verdict.dead) {
        if (tryRecover(lockDir, owner, events)) continue;
      }
    } else {
      let ageMs = 0;
      try { ageMs = Date.now() - fs.statSync(lockDir).mtimeMs; } catch (e) { continue; }
      if (ageMs > noOwnerGraceMs && tryRecover(lockDir, null, events)) continue;
    }
    if (Date.now() >= deadline) {
      const holder = owner ? `run ${owner.runId}/${owner.runAttempt} role=${owner.role} pid=${owner.pid}` : 'unknown (owner file missing)';
      const e = new Error(`LOCK_ACQUISITION_FAILED: ${lockDir} held by ${holder} after ${timeoutMs}ms`);
      e.holder = lastHolder;
      throw e;
    }
    const jitter = pollMs > 1 ? Math.floor(Math.random() * Math.min(pollMs, 5)) : 0;
    sleepSync(pollMs + jitter);
  }
}

/** Release only if this handle still owns the lock (token match). */
function releaseLock(handle) {
  if (!handle || !handle.lockDir) return false;
  const owner = readOwner(handle.lockDir);
  if (!owner || owner.token !== handle.token) return false;
  const graveyard = `${handle.lockDir}.released-${handle.token}`;
  try {
    fs.renameSync(lockDirFrom(handle), graveyard);
  } catch (e) {
    return false;
  }
  fs.rmSync(graveyard, { recursive: true, force: true });
  return true;
}

function lockDirFrom(handle) { return handle.lockDir; }

function withLock(opts, fn) {
  const h = acquireLock(opts);
  try { return fn(h); } finally { releaseLock(h); }
}

module.exports = { acquireLock, releaseLock, withLock, readOwner, ownerIsDead, pidExists, sleepSync, tryRecover };
