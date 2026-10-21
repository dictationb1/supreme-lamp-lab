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
//  * bounded by --deadline-ms; the registry is updated under its lock.

const fs = require('fs');
const path = require('path');
const proc = require('./lib/proc');
const registry = require('./lib/registry');
const { sleepSync } = require('./lib/lock');

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

function terminateTree(rec, snap, deadline) {
  const tree = proc.descendants(snap, rec.pid, rec.createTime);
  const order = tree.slice().reverse().concat([snap.byPid.get(Number(rec.pid))]);
  const killed = [];
  for (const p of order) {
    if (!p || CRITICAL.test(p.name || '')) continue;
    proc.terminate(p.pid);
    killed.push({ pid: p.pid, name: p.name, createTime: p.createTime });
  }
  // verify by identity, bounded
  let survivors = [];
  do {
    const after = proc.snapshot({ pids: killed.map(k => k.pid) });
    survivors = killed.filter(k => {
      const l = after.byPid.get(k.pid);
      return l && l.createTime === k.createTime;
    });
    if (!survivors.length) break;
    sleepSync(250);
  } while (Date.now() < deadline);
  return { killed, survivors };
}

function run(args) {
  const started = Date.now();
  const deadline = started + args.deadlineMs;
  const { runId, runAttempt } = registry.currentRun();
  const summary = { mode: args.mode, runId, runAttempt, registry: registry.registryPath(), startedAt: new Date(started).toISOString(), decisions: [], terminated: 0, survivors: [], errors: [], limitations: [] };
  if (!fs.existsSync(registry.registryPath())) {
    summary.note = 'NO_REGISTRY';
    return summary;
  }
  const snap = proc.snapshot({});
  const me = snap.byPid.get(process.pid);
  const protectedPids = new Set([process.pid, ...proc.ancestors(snap, process.pid)]);
  const ctx = { mode: args.mode, protectedPids, sessionId: me && me.sessionId !== undefined ? me.sessionId : null };

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
        if (args.dryRun) { entry.action = 'would-terminate'; keep.push(rec); }
        else {
          const res = terminateTree(rec, snap, deadline);
          entry.killed = res.killed;
          if (res.survivors.length) {
            entry.survivors = res.survivors;
            summary.survivors.push(...res.survivors);
            keep.push(rec);
          } else {
            summary.terminated += res.killed.length;
          }
        }
      } else if (d.action === 'keep') {
        keep.push(rec);
      }
      summary.decisions.push(entry);
    }
    return keep;
  });
  summary.durationMs = Date.now() - started;
  return summary;
}

function main() {
  const args = parseArgs(process.argv);
  let summary;
  let code = 0;
  try {
    summary = run(args);
    if (summary.survivors.length) code = 2;
  } catch (err) {
    summary = { mode: args.mode, error: err.message };
    code = /REGISTRY_CORRUPT|LOCK_ACQUISITION_FAILED/.test(err.message) ? 3 : 1;
  }
  const json = JSON.stringify(summary, null, 2);
  console.log(json);
  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, json);
  }
  process.exit(code);
}

if (require.main === module) main();
module.exports = { decide, run, parseArgs, CRITICAL };
