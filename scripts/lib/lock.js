'use strict';
// Exclusive cross-process lock based on atomic, NON-recursive directory
// creation (mkdir fails with EEXIST if another process holds the lock).
//
// Stale-lock recovery only happens when the recorded owner is demonstrably
// gone: its (pid, createTime) identity no longer exists, or the owner itself
// declared (with its own random token) that it is done with the lock. Recovery
// is serialised with a claim directory named after the dead owner's token and
// the token is re-verified before the stale directory is renamed away, so two
// recoverers can never steal a live lock.
//
// Two properties this module must keep, because run 39555536075 attempt 1
// failed the Windows concurrency regression while a *live* worker still owned
// the lock directory:
//   1. A live owner is never evicted. Its (pid, createTime) is checked, not the
//      age of the directory.
//   2. An owner that cannot finish the release must never be able to keep
//      running as if it had released, silently orphaning a lock that every peer
//      then waits on until its own deadline. Release is retried, and if the
//      directory still cannot be moved aside the owner writes an
//      owner-authorized `relinquish.json` (bound to the same random token that
//      is already in owner.json) so peers can take over without weakening the
//      identity check. The caller is told that the release did not complete.
//
// Diagnostics: every acquisition keeps a bounded event timeline. When
// LAB_LOCK_EVENTS=<file> is set, the timeline is appended to that file as JSONL
// so a test harness can merge several worker processes into one ordered view
// (pid + createTime + exit state + per-poll verdict + elapsed times). The same
// timeline (bounded) is attached to LOCK_ACQUISITION_FAILED as `e.timeline`, so
// a timeout reports what the holder actually was instead of only `role=unknown`.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const proc = require('./proc');

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) { Atomics.wait(SLEEP_CELL, 0, 0, ms); }

// Test hooks. They are inert unless LAB_LOCK_TEST_HOOKS=1, so the live
// workflow never changes behaviour; the regression suite uses them to make the
// Windows-only costs and transient filesystem errors reproducible on any OS.
const HOOKS = process.env.LAB_LOCK_TEST_HOOKS === '1';
const IDENTITY_DELAY_MS = HOOKS ? Math.max(0, Number(process.env.LAB_LOCK_TEST_IDENTITY_DELAY_MS || 0)) : 0;
let forcedReleaseRenameFailures = HOOKS ? Math.max(0, Number(process.env.LAB_LOCK_TEST_RELEASE_RENAME_FAILS || 0)) : 0;

// Minimum age before spawning a full OS process-identity helper against a
// currently-alive holder PID to check for PID wraparound/reuse. On Windows each
// proc.getProcess() spawns powershell.exe + CIM (~700ms-3s under contention), so
// polling it on every 5ms spin-iteration starved 4 concurrent contenders past
// 60s on rdp-lab-client (run 39555536075 attempt 1).
//
// Safety invariant:
//   1. `pidExists(owner.pid)` (`process.kill(pid, 0)`) runs on every iteration
//      with zero subprocesses; libuv reports ESRCH as soon as the process exits,
//      so dead owners are still detected immediately.
//   2. `owner.pid === process.pid` compares against `selfIdentity()` in memory.
//   3. Missing/unparseable `acquiredAt` (or age >= PID_REUSE_CHECK_AFTER_MS)
//      runs the full `(pid, createTime)` query and caches verified live tokens
//      for `PID_REUSE_RECHECK_MS`.
const PID_REUSE_CHECK_AFTER_MS = 2000;
const PID_REUSE_RECHECK_MS = 2000;
const MAX_TIMELINE_EVENTS = 400;
const RELEASE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);

const verifiedLiveTokens = new Map();
// Tokens this process currently holds. A lock directory whose owner.json names
// this process but whose token is not in this set is an orphan of THIS process
// (e.g. a release that silently failed) and may be reclaimed at once.
const heldTokens = new Set();

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

function readRelinquish(lockDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, 'relinquish.json'), 'utf8'));
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

// ---------- bounded event timeline ----------

function timelineFile() { return process.env.LAB_LOCK_EVENTS || null; }

function makeTimeline(role) {
  const file = timelineFile();
  const buf = [];
  let written = 0;
  const base = { pid: process.pid, role: role || null };
  function record(event, extra) {
    const rec = { t: Date.now(), ...base, event, ...(extra || {}) };
    if (buf.length < MAX_TIMELINE_EVENTS) buf.push(rec);
    if (file && written < MAX_TIMELINE_EVENTS) {
      written += 1;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
      } catch (e) { /* diagnostics must never break the lock */ }
    }
    return rec;
  }
  return { record, buf, file };
}

function ownerSummary(owner) {
  if (!owner) return null;
  return {
    pid: owner.pid, createTime: owner.createTime || null, role: owner.role || null,
    runId: owner.runId || null, runAttempt: owner.runAttempt || null,
    host: owner.host || null, acquiredAt: owner.acquiredAt || null
  };
}

function ownerAgeMs(owner) {
  const ms = owner && owner.acquiredAt ? Date.parse(owner.acquiredAt) : NaN;
  return Number.isFinite(ms) ? Date.now() - ms : null;
}

/**
 * Owner liveness for a specific lock directory: adds the owner-authorized
 * relinquish marker and the throttled (pid, createTime) query.
 */
function ownerIsDeadForDir(owner, lockDir, onQuery) {
  if (!owner || !owner.pid || !owner.createTime) return { dead: false, reason: 'OWNER_IDENTITY_INCOMPLETE' };
  const pid = Number(owner.pid);
  if (!pidExists(pid)) return { dead: true, reason: 'OWNER_PROCESS_GONE' };
  if (pid === process.pid) {
    const me = selfIdentity();
    if (me.createTime !== owner.createTime) return { dead: true, reason: 'OWNER_PID_REUSED' };
    if (owner.token && heldTokens.has(owner.token)) return { dead: false, reason: 'OWNER_ALIVE_SELF' };
    return { dead: true, reason: 'OWNER_IS_SELF_ORPHAN' };
  }
  if (lockDir) {
    const rel = readRelinquish(lockDir);
    if (rel && owner.token && rel.token === owner.token) {
      // The owner itself wrote this marker with the random token it had put in
      // owner.json. The process is still alive but no longer owns the lock.
      return { dead: true, reason: 'OWNER_RELINQUISHED' };
    }
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
  const startedQuery = Date.now();
  try {
    if (IDENTITY_DELAY_MS) sleepSync(IDENTITY_DELAY_MS);
    live = proc.getProcess(pid);
  } catch (e) {
    if (onQuery) onQuery(pid, Date.now() - startedQuery, 'IDENTITY_QUERY_FAILED');
    return { dead: false, reason: `IDENTITY_QUERY_FAILED: ${e.message}`, queryMs: Date.now() - startedQuery };
  }
  if (onQuery) onQuery(pid, Date.now() - startedQuery, live ? 'OK' : 'GONE');
  if (!live) return { dead: true, reason: 'OWNER_PROCESS_GONE', queryMs: Date.now() - startedQuery };
  if (!live.createTime) return { dead: false, reason: 'LIVE_IDENTITY_UNKNOWN', queryMs: Date.now() - startedQuery };
  if (live.createTime !== owner.createTime) return { dead: true, reason: 'OWNER_PID_REUSED', queryMs: Date.now() - startedQuery };
  if (owner.token) {
    if (verifiedLiveTokens.size > 256) verifiedLiveTokens.clear();
    verifiedLiveTokens.set(owner.token, Date.now());
  }
  return { dead: false, reason: 'OWNER_ALIVE', queryMs: Date.now() - startedQuery };
}

/**
 * Remove the lock directory after the caller has PROVEN it may do so (owner
 * dead / owner-authorized relinquish / self-orphan with token re-verified).
 * The fast path is one atomic rename; transient Windows sharing violations are
 * retried, and the last resort removes only the two files this module creates
 * and then the empty directory. Nothing outside `lockDir` is ever touched.
 */
function clearLockDir(lockDir, { attempts = 5, baseDelayMs = 10, removeDirs = [] } = {}) {
  const graveyard = `${lockDir}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      fs.renameSync(lockDir, graveyard);
      try { fs.rmSync(graveyard, { recursive: true, force: true }); } catch (e) { /* freed already */ }
      return { ok: true, attempts: attempt };
    } catch (e) {
      lastErr = e;
      if (e.code === 'ENOENT') return { ok: true, attempts: attempt, alreadyGone: true };
      if (!RELEASE_RENAME_CODES.has(e.code)) break;
      if (attempt < attempts) sleepSync(baseDelayMs * attempt);
    }
  }
  // Last resort: the directory itself may be held. Remove only our own files.
  try {
    for (const f of ['relinquish.json', 'owner.json']) {
      try { fs.rmSync(path.join(lockDir, f), { force: true }); } catch (e) { /* retried by rmdir below */ }
    }
    // Only the caller's own claim marker may be removed here; anything else
    // means the directory is not ours to delete.
    for (const d of removeDirs) {
      if (!String(d).startsWith('claim-')) continue;
      try { fs.rmdirSync(path.join(lockDir, d)); } catch (e) { /* best effort */ }
    }
    const leftovers = fs.readdirSync(lockDir);
    if (leftovers.length === 0) {
      fs.rmdirSync(lockDir);
      return { ok: true, attempts: attempts + 1, fallback: true };
    }
  } catch (e) {
    lastErr = e;
  }
  return { ok: false, attempts, errorCode: lastErr && lastErr.code ? lastErr.code : null, error: lastErr ? lastErr.message : null };
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
  const cleared = clearLockDir(lockDir, { removeDirs: [claimName] });
  if (!cleared.ok) {
    try { fs.rmdirSync(claimDir); } catch (e) { /* ignore */ }
    if (events) events.push({ at: new Date().toISOString(), event: 'RECOVERY_BLOCKED', errorCode: cleared.errorCode || null, previousOwner: owner || null });
    return false;
  }
  events.push({ at: new Date().toISOString(), event: 'STALE_LOCK_RECOVERED', previousOwner: owner || null });
  return true;
}

/**
 * Acquire an exclusive lock. Throws LOCK_ACQUISITION_FAILED on timeout.
 * Returns a handle { lockDir, token, owner, events, timeline }.
 */
function acquireLock({ lockDir, runId, runAttempt, role = 'unknown', timeoutMs = 10000, pollMs = 250, noOwnerGraceMs = 30000 } = {}) {
  if (!lockDir) throw new Error('LOCK_DIR_REQUIRED');
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const me = selfIdentity();
  const token = crypto.randomBytes(12).toString('hex');
  const deadline = Date.now() + timeoutMs;
  const events = [];
  const timeline = makeTimeline(role);
  const startedAt = Date.now();
  let lastHolder = null;
  let lastVerdict = null;
  let lastVerdictReason = null;
  let polls = 0;
  let identityQueries = 0;
  let identityMs = 0;
  let lastReportedPoll = 0;
  timeline.record('ACQUIRE_START', {
    lockDir, timeoutMs, pollMs, createTime: me.createTime,
    runId: String(runId || process.env.GITHUB_RUN_ID || 'local'),
    runAttempt: String(runAttempt || process.env.GITHUB_RUN_ATTEMPT || '1')
  });
  for (;;) {
    polls += 1;
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
      heldTokens.add(token);
      timeline.record('LOCK_ACQUIRED', { tokenPrefix: token.slice(0, 8), polls, elapsedMs: Date.now() - startedAt });
      return { lockDir, token, owner, events, timeline: timeline.buf, record: timeline.record };
    }
    const owner = readOwner(lockDir);
    lastHolder = owner;
    if (owner) {
      const verdict = ownerIsDeadForDir(owner, lockDir, (qPid, qMs, qState) => {
        identityQueries += 1;
        identityMs += qMs;
        timeline.record('IDENTITY_QUERY', { targetPid: qPid, elapsedMs: qMs, result: qState, polls });
      });
      lastVerdict = verdict;
      if (verdict.reason !== lastVerdictReason || polls <= 3 || polls - lastReportedPoll >= 25) {
        lastVerdictReason = verdict.reason;
        lastReportedPoll = polls;
        timeline.record('CONTENTION', {
          polls, holder: ownerSummary(owner), holderAgeMs: ownerAgeMs(owner),
          verdict: verdict.reason, dead: Boolean(verdict.dead), queryMs: verdict.queryMs || 0
        });
      }
      if (verdict.dead) {
        if (tryRecover(lockDir, owner, events)) {
          timeline.record('RECOVERED', { reason: verdict.reason, previousOwner: ownerSummary(owner), polls });
          continue;
        }
        timeline.record('RECOVERY_BLOCKED', { reason: verdict.reason, previousOwner: ownerSummary(owner), polls });
      }
    } else {
      let ageMs = 0;
      try { ageMs = Date.now() - fs.statSync(lockDir).mtimeMs; } catch (e) { continue; }
      if (ageMs > noOwnerGraceMs && tryRecover(lockDir, null, events)) {
        timeline.record('RECOVERED', { reason: 'OWNER_FILE_MISSING_PAST_GRACE', dirAgeMs: ageMs, polls });
        continue;
      }
    }
    if (Date.now() >= deadline) {
      const holder = owner
        ? `run ${owner.runId}/${owner.runAttempt} role=${owner.role} pid=${owner.pid}`
        : 'unknown (owner file missing)';
      const metrics = {
        polls, elapsedMs: Date.now() - startedAt, identityQueries, identityMs,
        lastVerdict: lastVerdict ? lastVerdict.reason : null,
        holder: ownerSummary(owner), holderAgeMs: ownerAgeMs(owner)
      };
      timeline.record('ACQUIRE_TIMEOUT', metrics);
      const e = new Error(
        `LOCK_ACQUISITION_FAILED: ${lockDir} held by ${holder} createTime=${owner && owner.createTime ? owner.createTime : 'unknown'} ` +
        `state=${metrics.lastVerdict || 'unknown'} age=${metrics.holderAgeMs === null ? 'unknown' : `${metrics.holderAgeMs}ms`} ` +
        `after ${timeoutMs}ms (polls=${polls} identityQueries=${identityQueries} identityMs=${identityMs})`
      );
      e.holder = lastHolder;
      e.holderState = lastVerdict;
      e.metrics = metrics;
      e.timeline = timeline.buf.slice();
      e.lockDir = lockDir;
      throw e;
    }
    const jitter = pollMs > 1 ? Math.floor(Math.random() * Math.min(pollMs, 5)) : 0;
    sleepSync(pollMs + jitter);
  }
}

/**
 * Release, with bounded retries for the transient Windows sharing violations
 * that make a directory rename fail while a peer is momentarily reading
 * owner.json. Returns a structured result; never throws for a filesystem error.
 */
function releaseLockEx(handle, { retries = 5 } = {}) {
  if (!handle || !handle.lockDir) return { released: false, reason: 'NO_HANDLE' };
  const timeline = { record: typeof handle.record === 'function' ? handle.record : () => null };
  const started = Date.now();
  const owner = readOwner(handle.lockDir);
  if (!owner || owner.token !== handle.token) {
    heldTokens.delete(handle.token);
    return { released: false, reason: 'NOT_OWNER', elapsedMs: Date.now() - started };
  }
  const graveyard = `${handle.lockDir}.released-${handle.token}`;
  let lastErr = null;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      if (forcedReleaseRenameFailures > 0) {
        forcedReleaseRenameFailures -= 1;
        const injected = new Error('EPERM: injected release rename failure (test hook)');
        injected.code = 'EPERM';
        throw injected;
      }
      fs.renameSync(handle.lockDir, graveyard);
      heldTokens.delete(handle.token);
      try { fs.rmSync(graveyard, { recursive: true, force: true }); } catch (e) { /* already free */ }
      const res = { released: true, attempts: attempt, elapsedMs: Date.now() - started };
      timeline.record('RELEASE_OK', res);
      return res;
    } catch (e) {
      lastErr = e;
      if (e.code === 'ENOENT') {
        heldTokens.delete(handle.token);
        const res = { released: true, alreadyGone: true, attempts: attempt, elapsedMs: Date.now() - started };
        timeline.record('RELEASE_OK', res);
        return res;
      }
      if (!RELEASE_RENAME_CODES.has(e.code)) break;
      timeline.record('RELEASE_RETRY', { attempt, code: e.code, elapsedMs: Date.now() - started });
      if (attempt <= retries) sleepSync(10 * attempt);
    }
  }
  // The directory cannot be moved aside. Do NOT let the caller continue as if
  // the lock were released: write a marker bound to this owner's random token
  // so peers can take over, and report failure.
  const rel = {
    token: handle.token, pid: process.pid, createTime: handle.owner ? handle.owner.createTime : null,
    releasedAt: new Date().toISOString(), errorCode: lastErr && lastErr.code ? lastErr.code : null,
    error: lastErr ? String(lastErr.message).slice(0, 300) : null
  };
  try {
    const tmp = path.join(handle.lockDir, `.relinquish.${handle.token}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(rel, null, 2));
    fs.renameSync(tmp, path.join(handle.lockDir, 'relinquish.json'));
    heldTokens.delete(handle.token);
    const res = {
      released: false, relinquished: true, errorCode: rel.errorCode, attempts: retries + 1,
      elapsedMs: Date.now() - started, lockDir: handle.lockDir
    };
    timeline.record('RELEASE_RELINQUISHED', res);
    return res;
  } catch (e2) {
    const res = {
      released: false, relinquished: false, reason: 'RELEASE_FAILED', errorCode: rel.errorCode,
      error: rel.error, markerError: e2 && e2.code ? e2.code : String(e2 && e2.message).slice(0, 120),
      attempts: retries + 1, elapsedMs: Date.now() - started, lockDir: handle.lockDir
    };
    timeline.record('RELEASE_FAILED', res);
    return res;
  }
}

/** Release only if this handle still owns the lock (token match). */
function releaseLock(handle) {
  return releaseLockEx(handle).released;
}

function withLock(opts, fn) {
  const h = acquireLock(opts);
  let err = null;
  let result;
  try {
    result = fn(h);
  } catch (e) {
    err = e;
    throw e;
  } finally {
    const rel = releaseLockEx(h);
    if (!rel.released && !err) {
      const e = new Error(`LOCK_RELEASE_FAILED: ${h.lockDir} not released (code=${rel.errorCode || 'unknown'}${rel.relinquished ? ', relinquished for peers' : ''})`);
      e.code = 'LOCK_RELEASE_FAILED';
      e.release = rel;
      throw e;
    }
    if (!rel.released && err) err.lockRelease = rel;
  }
  return result;
}

module.exports = {
  acquireLock, releaseLock, releaseLockEx, withLock, readOwner, readRelinquish,
  ownerIsDead: (owner) => ownerIsDeadForDir(owner, null), ownerIsDeadForDir,
  pidExists, sleepSync, tryRecover, clearLockDir
};
