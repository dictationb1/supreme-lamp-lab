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
// Test hooks: --server-cmd '<json array>' --ok-file <path> --no-mc

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const proc = require('./lib/proc');
const registry = require('./lib/registry');
const { waitForReady } = require('./lib/readiness');
const { request } = require('./lib/http');
const annotate = require('./lib/annotate');
const { artifactDir, writeCapabilities } = require('./lib/results');
const { STATUS, CapabilitySet } = require('./lib/status');

function parseArgs(argv) {
  const a = { root: 'C:\\ghrdp', sha: null, port: 7331, hold: false, holdMaxMs: 20 * 60000, clientJob: 'client', holdPollMs: 15000, serverCmd: null, okFile: null, noMc: false, readyTimeoutMs: 180000 };
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
  }
  return a;
}

const log = (...m) => console.log(`[supervisor ${new Date().toISOString()}]`, ...m);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function setOutput(k, v) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${String(v).replace(/\n/g, ' ')}\n`);
}

function powershellExe() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (fs.existsSync(path.join(dir, 'pwsh.exe'))) return path.join(dir, 'pwsh.exe');
  }
  return 'powershell.exe';
}

function tail(file, n = 40) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-n).join('\n'); } catch (e) { return ''; }
}

class Backend {
  constructor(args, outDir) {
    this.args = args; this.outDir = outDir;
    this.exit = null; this.child = null; this.identity = null;
    this.stdoutFile = path.join(outDir, 'backend.stdout.log');
    this.stderrFile = path.join(outDir, 'backend.stderr.log');
  }
  start() {
    const a = this.args;
    const cmd = a.serverCmd || [powershellExe(), '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(a.root, 'ghrdp-server.ps1')];
    this.okFile = a.okFile || path.join(a.root, 'server-ok.txt');
    try { fs.unlinkSync(this.okFile); } catch (e) { /* absent */ }
    const out = fs.openSync(this.stdoutFile, 'a');
    const err = fs.openSync(this.stderrFile, 'a');
    this.child = spawn(cmd[0], cmd.slice(1), {
      cwd: fs.existsSync(a.root) ? a.root : process.cwd(),
      env: { ...process.env, GHRDP_BUILD_SHA: a.sha || '', OK_FILE: this.okFile, PORT: String(a.port) },
      stdio: ['ignore', out, err], windowsHide: true
    });
    this.child.on('exit', (code, signal) => { this.exit = { code, signal, at: new Date().toISOString() }; log(`backend exited code=${code} signal=${signal}`); });
    this.child.on('error', e => { this.exit = { code: null, signal: null, error: e.message, at: new Date().toISOString() }; });
    log(`spawned backend pid=${this.child.pid}: ${cmd.join(' ')}`);
  }
  alive() { return this.exit === null; }
  async waitOkFile(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
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
    return { ok: false, code: 'BACKEND_NO_OKFILE', detail: `no LISTENING in ${this.okFile} within ${timeoutMs}ms` };
  }
  verifyListener() {
    const snap = proc.snapshot({ listenPort: this.args.port });
    const owners = [...new Set(snap.listeners.map(l => l.pid))];
    if (!owners.length) return { ok: false, code: 'BACKEND_NOT_LISTENING', detail: `no listener on ${this.args.port}` };
    const mine = new Set([this.child.pid, ...proc.descendants(snap, this.child.pid, this.identity && this.identity.createTime).map(p => p.pid)]);
    const foreign = owners.filter(p => !mine.has(p));
    if (foreign.length) return { ok: false, code: 'BACKEND_PORT_OWNED_BY_OTHER', detail: `port ${this.args.port} listeners ${owners.join(',')} include non-supervised pid(s) ${foreign.join(',')}` };
    return { ok: true, detail: `listener pid(s) ${owners.join(',')}` };
  }
  stop() {
    if (!this.child) return { stopped: [] };
    const snap = proc.snapshot({});
    const root = this.identity ? snap.byPid.get(this.child.pid) : null;
    const stopped = [];
    if (root && this.identity && root.createTime === this.identity.createTime) {
      const tree = proc.descendants(snap, root.pid, root.createTime).reverse();
      for (const p of tree.concat([root])) { proc.terminate(p.pid); stopped.push({ pid: p.pid, name: p.name }); }
    } else if (this.alive()) {
      try { this.child.kill(); stopped.push({ pid: this.child.pid, name: 'child-handle' }); } catch (e) { /* gone */ }
    }
    if (this.identity) { try { registry.unregisterProcess({ pid: this.identity.pid, createTime: this.identity.createTime }); } catch (e) { annotate.warning('registry', e.message); } }
    return { stopped };
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
  const summary = { sha: args.sha, port: args.port, startedAt: new Date().toISOString(), phases: [] };
  const phase = (name, res) => { summary.phases.push({ name, ...res, at: new Date().toISOString() }); log(`${name}: ${res.ok ? 'OK' : res.code} ${res.detail || ''}`); return res.ok; };
  const backend = new Backend(args, outDir);
  let code = 1;
  let mcRan = false;
  const onSignal = sig => { log(`received ${sig}; stopping backend`); backend.stop(); process.exit(130); };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  try {
    if (!args.serverCmd && !/^[0-9a-f]{40}$/.test(args.sha || '')) throw new Error(`MISSING_CONFIG: --sha must be a 40-char commit (got ${args.sha})`);
    backend.start();
    await sleep(800);
    if (backend.alive()) {
      const live = proc.getProcess(backend.child.pid);
      if (live && live.createTime) {
        backend.identity = { pid: live.pid, createTime: live.createTime };
        try { registry.registerProcess({ pid: live.pid, role: 'backend' }); } catch (e) { annotate.warning('registry', `backend registration failed: ${e.message}`); }
      }
    }
    summary.backend = backend.identity;
    if (!phase('okfile', await backend.waitOkFile(args.readyTimeoutMs))) throw new Error('phase okfile');
    if (!phase('listener', backend.verifyListener())) throw new Error('phase listener');
    const target = `http://127.0.0.1:${args.port}`;
    const ready = await waitForReady(target, { timeoutMs: args.readyTimeoutMs, expectPid: backend.child.pid, expectPort: args.port, isAlive: () => backend.alive(), log: m => log(`readiness ${m}`) });
    if (!phase('readiness', { ok: ready.ready, code: ready.code, detail: ready.detail, history: ready.history })) throw new Error('phase readiness');
    setOutput('backend_pid', backend.child.pid);
    setOutput('backend_create_time', backend.identity ? backend.identity.createTime : '');

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
    if (!/^phase /.test(e.message) && !e.phaseResult) phase('fatal', { ok: false, code: 'SUPERVISOR_ERROR', detail: e.message });
    code = 1;
  } finally {
    const st = backend.stop();
    summary.stopped = st.stopped;
    summary.exit = backend.exit;
    summary.finishedAt = new Date().toISOString();
    summary.stdoutTail = tail(backend.stdoutFile, 30);
    summary.stderrTail = tail(backend.stderrFile, 30);
    fs.writeFileSync(path.join(outDir, 'backend-supervisor.json'), JSON.stringify(summary, null, 2));
    const failed = summary.phases.find(p => !p.ok);
    if (!mcRan && !args.noMc) {
      // the checker never ran: record the causal supervisor failure instead of NOT_RUN
      const caps = new CapabilitySet({ backend_readiness_server_local: { required: true }, dashboard_server_local: { required: true } });
      const why = failed ? `SUPERVISOR_${failed.name.toUpperCase()}: ${failed.code}: ${String(failed.detail || '').slice(0, 400)}` : 'SUPERVISOR_ABORTED';
      caps.set('backend_readiness_server_local', STATUS.FAIL, why);
      caps.set('dashboard_server_local', STATUS.BLOCKED, `DEPENDS_ON_BACKEND: ${why}`);
      writeCapabilities('server-local', caps, { source: 'backend-supervisor' });
    }
    if (failed) annotate.error(`backend ${failed.name}`, `${failed.code}: ${failed.detail || ''}`);
    else annotate.notice('backend supervised', `pid=${summary.backend && summary.backend.pid} phases=${summary.phases.map(p => p.name).join(',')}`);
    setOutput('supervisor_first_failure', failed ? `${failed.name}:${failed.code}` : 'none');
  }
  process.exit(code);
}

if (require.main === module) main();
module.exports = { parseArgs };
