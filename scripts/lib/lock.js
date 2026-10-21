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
  let live;
  try { live = proc.getProcess(owner.pid); } catch (e) { return { dead: false, reason: `IDENTITY_QUERY_FAILED: ${e.message}` }; }
  if (!live) return { dead: true, reason: 'OWNER_PROCESS_GONE' };
  if (!live.createTime) return { dead: false, reason: 'LIVE_IDENTITY_UNKNOWN' };
  if (live.createTime !== owner.createTime) return { dead: true, reason: 'OWNER_PID_REUSED' };
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
    sleepSync(pollMs);
  }
}

/** Release only if this handle still owns the lock (token match). */
function releaseLock(handle) {
  if (!handle || !handle.lockDir) return false;
  const owner = readOwner(handle.lockDir);
  if (!owner || owner.token !== handle.token) return false;
  const graveyard = `${handle.lockDir}.released-${handle.token}`;
  try {
    fs.renameSync(handle.lockDir, graveyard);
  } catch (e) {
    return false;
  }
  fs.rmSync(graveyard, { recursive: true, force: true });
  return true;
}

function withLock(opts, fn) {
  const h = acquireLock(opts);
  try { return fn(h); } finally { releaseLock(h); }
}

module.exports = { acquireLock, releaseLock, withLock, readOwner, ownerIsDead, sleepSync, tryRecover };
