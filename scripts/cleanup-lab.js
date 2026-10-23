#!/usr/bin/env node
'use strict';
// Owned-process cleanup for the lab.
//
//   node scripts/cleanup-lab.js --mode postflight   # this run+attempt only
//   node scripts/cleanup-lab.js --mode preflight    # demonstrably abandoned records of OTHER run/attempts
//
// Safety rules (each enforced in code and covered by run-regressions.js):
//  * a process is only terminated when its live (pid, createTime) equals the
//    registered identity exactly; unknown identity => never killed;
//  * run AND attempt must match in postflight; preflight only touches other
//    run/attempts whose runner job anchor (Runner.Worker pid+createTime) is no
//    longer alive (=> the owning job is gone, the process is abandoned);
//  * ancestors of this process, runner/system processes and processes in a
//    different Windows session are never terminated;
//  * descendants are terminated child-first, only if created after their parent;
//  * bounded by --deadline-ms; the registry is updated under its lock;
//  * the process snapshot is taken ASYNCHRONOUSLY with a deadline derived from
//    --deadline-ms. If the snapshot cannot be taken (e.g. a wedged PowerShell
//    helper), NO process is touched and the run fails with
//    CLEANUP_SNAPSHOT_FAILED (exit 4) plus the helper diagnostic - a cleanup
//    that cannot see the process table must never guess.

const fs = require('fs');
const path = require('path');
const proc = require('./lib/proc');
const registry = require('./lib/registry');

const CRITICAL = /^(system|idle|registry|smss|csrss|wininit|winlogon|services|lsass|lsaiso|svchost|fontdrvhost|dwm|explorer|runner\.listener|runner\.worker|runsvc|memory compression|init|systemd)(\.exe)?$/i;

function parseArgs(argv) {
  const a = { mode: 'postflight', deadlineMs: 60000, out: null, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--mode') a.mode = argv[++i];
    else if (argv[i] === '--deadline-ms') a.deadlineMs = Number(argv[++i]);
    else if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--dry-run') a.dryRun = true;
  }
  if (!['preflight', 'postflight'].includes(a.mode)) throw new Error(`INVALID_MODE: ${a.mode}`);
  return a;
}

function decide(rec, snap, ctx) {
  const live = snap.byPid.get(Number(rec.pid));
  if (!rec.createTime) return { action: 'keep', reason: 'IDENTITY_UNKNOWN_RECORD_HAS_NO_CREATETIME' };
  if (!live) return { action: 'drop', reason: 'PROCESS_GONE' };
  if (!live.createTime) return { action: 'keep', reason: 'LIVE_IDENTITY_UNAVAILABLE' };
  if (live.createTime !== rec.createTime) return { action: 'drop', reason: 'PID_REUSED_BY_OTHER_PROCESS' };
  if (ctx.protectedPids.has(live.pid)) return { action: 'keep', reason: 'PROTECTED_ANCESTOR' };
  if (CRITICAL.test(live.name || '')) return { action: 'keep', reason: `PROTECTED_SYSTEM_PROCESS:${live.name}` };
  if (ctx.sessionId !== null && live.sessionId !== null && live.sessionId !== undefined && live.sessionId !== ctx.sessionId) {
    return { action: 'keep', reason: `OTHER_SESSION:${live.sessionId}` };
  }
  if (ctx.mode === 'preflight') {
    if (!rec.anchor || !rec.anchor.pid || !rec.anchor.createTime) return { action: 'keep', reason: 'ABANDONMENT_UNPROVEN_NO_JOB_ANCHOR' };
    const anchorLive = snap.byPid.get(Number(rec.anchor.pid));
    if (anchorLive && anchorLive.createTime === rec.anchor.createTime) return { action: 'keep', reason: 'OWNING_JOB_STILL_ACTIVE' };
  }
  return { action: 'terminate', reason: ctx.mode === 'preflight' ? 'ABANDONED_OWNING_JOB_GONE' : 'OWNED_BY_THIS_RUN_ATTEMPT', live };
}

/**
 * Tree kill using an already-taken snapshot (no helper call inside the lock).
 * Child-first, identity-verified root, system/runner processes excluded.
 */
function terminateTreeSync(rec, snap) {
  const tree = proc.descendants(snap, rec.pid, rec.createTime);
  const order = tree.slice().reverse().concat([snap.byPid.get(Number(rec.pid))]);
  const killed = [];
  for (const p of order) {
    if (!p || CRITICAL.test(p.name || '')) continue;
    proc.terminate(p.pid);
    killed.push({ pid: p.pid, name: p.name, createTime: p.createTime });
  }
  return { killed };
}

async function run(args) {
  const started = Date.now();
  const deadline = started + args.deadlineMs;
  const { runId, runAttempt } = registry.currentRun();
  const summary = {
    mode: args.mode, runId, runAttempt, registry: registry.registryPath(),
    startedAt: new Date(started).toISOString(), decisions: [], terminated: 0,
    survivors: [], errors: [], limitations: []
  };
  if (!fs.existsSync(registry.registryPath())) {
    summary.note = 'NO_REGISTRY';
    return summary;
  }

  // A snapshot failure must never be mistaken for "nothing to clean up".
  let snap;
  try {
    snap = await proc.snapshotAsync({
      timeoutMs: Math.max(250, Math.min(args.deadlineMs, deadline - Date.now())),
      deadlineAt: deadline,
      operation: 'cleanup-snapshot'
    });
  } catch (e) {
    summary.error = `CLEANUP_SNAPSHOT_FAILED: ${e.message}`;
    summary.helperDiagnostic = e.diagnostic || null;
    summary.aborted = 'NO_KILLS_PERFORMED';
    summary.durationMs = Date.now() - started;
    return summary;
  }

  const me = snap.byPid.get(process.pid);
  const protectedPids = new Set([process.pid, ...proc.ancestors(snap, process.pid)]);
  const ctx = { mode: args.mode, protectedPids, sessionId: me && me.sessionId !== undefined ? me.sessionId : null };
  const pending = [];

  registry.updateRegistry(records => {
    const keep = [];
    for (const rec of records) {
      const sameRun = String(rec.runId) === runId && String(rec.runAttempt) === runAttempt;
      const inScope = args.mode === 'postflight' ? sameRun : !sameRun;
      if (!inScope) { keep.push(rec); continue; }
      if (Date.now() > deadline) {
        keep.push(rec);
        summary.limitations.push(`DEADLINE_REACHED_BEFORE_PID_${rec.pid}`);
        continue;
      }
      const d = decide(rec, snap, ctx);
      const entry = { pid: rec.pid, name: rec.name, role: rec.role, runId: rec.runId, runAttempt: rec.runAttempt, action: d.action, reason: d.reason };
      if (d.action === 'terminate') {
        if (args.dryRun) {
          entry.action = 'would-terminate';
          keep.push(rec);
        } else {
          const res = terminateTreeSync(rec, snap);
          entry.killed = res.killed;
          if (!res.killed.length) keep.push(rec);
          else pending.push({ rec, entry, killed: res.killed });
        }
      } else if (d.action === 'keep') {
        keep.push(rec);
      }
      summary.decisions.push(entry);
    }
    return keep;
  });

  // Bounded identity re-verification of everything we signalled. Records with
  // survivors stay registered so a later cleanup can retry them.
  if (pending.length) {
    const killed = pending.flatMap(p => p.killed);
    let survivors = [];
    let verifyError = null;
    do {
      let after;
      try {
        after = await proc.snapshotAsync({
          pids: killed.map(k => k.pid),
          timeoutMs: Math.max(250, deadline - Date.now()),
          deadlineAt: deadline,
          operation: 'cleanup-verify'
        });
      } catch (e) {
        verifyError = { message: e.message, code: e.code || null, callSite: e.callSite || null, diagnostic: e.diagnostic || null };
        survivors = killed.slice();
        break;
      }
      survivors = killed.filter(k => { const l = after.byPid.get(k.pid); return l && l.createTime === k.createTime; });
      if (!survivors.length) break;
      await new Promise(r => setTimeout(r, 250));
    } while (Date.now() < deadline);
    if (verifyError) summary.errors.push(verifyError);
    const survivorPids = new Set(survivors.map(s => s.pid));
    for (const p of pending) {
      const alive = p.killed.filter(k => survivorPids.has(k.pid));
      if (alive.length) {
        p.entry.survivors = alive;
        summary.survivors.push(...alive);
        // re-register the survivor so the next run can still find it
        registry.updateRegistry(records => (records.some(r => Number(r.pid) === Number(p.rec.pid) && r.createTime === p.rec.createTime) ? records : records.concat([p.rec])));
      } else {
        summary.terminated += p.killed.length;
      }
    }
  }

  summary.durationMs = Date.now() - started;
  return summary;
}

async function main() {
  const args = parseArgs(process.argv);
  let summary;
  let code = 0;
  try {
    summary = await run(args);
    if (summary.error) code = 4;
    else if (summary.survivors.length) code = 2;
  } catch (err) {
    summary = { mode: args.mode, error: err.message };
    // 3 = registry bookkeeping (nothing was killed, the desktop is unchanged):
    // a corrupt registry, a lock we could not take, or an atomic rename the OS
    // refused. The workflow distinguishes this from 2 (survivors) and 4
    // (unreadable process table), which are the two that describe real danger.
    code = /REGISTRY_CORRUPT|REGISTRY_WRITE_FAILED|LOCK_ACQUISITION_FAILED/.test(err.message) ? 3 : 1;
  }
  const json = JSON.stringify(summary, null, 2);
  console.log(json);
  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, json);
  }
  process.exit(code);
}

if (require.main === module) main().catch(e => { console.error(JSON.stringify({ mode: 'unknown', error: e.message })); process.exit(1); });
module.exports = { decide, run, parseArgs, CRITICAL, terminateTreeSync };
