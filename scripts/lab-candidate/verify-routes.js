#!/usr/bin/env node
'use strict';
// LAB-CANDIDATE route probe (real Windows, real payloads/ghrdp-server.ps1).
//
// Reproduces the two measured backend defects against a lab-staged application
// backend that is started the way PRODUCTION starts it (F92 GHRDP-Server
// Scheduled Task: no GHRDP_BUILD_SHA, no GITHUB_SHA in the environment), with
// the dashboard token written AFTER the process is already listening - the
// boot-before-token ordering of main.yml ("F92 register user-session server"
// at ~908 runs long before "Stage files + write config.json" at ~2554).
//
//   P001  POST /api/rdp-token must authorize the CURRENT token and refuse a
//         superseded one.
//   P002  GET /api/version must report the identity main.yml wrote to
//         config.json buildSha, and still answer "dev" when nothing was written.
//
// Tokens are never printed: only their sha256 prefix and length.
//
// usage: node verify-routes.js --root C:\ghrdp-base --port 7331 --variant baseline --out base.json
//        node verify-routes.js --root C:\ghrdp-base --port 7331 --variant baseline --phase no-metadata

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { request } = require('../lib/http');

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const ROOT = arg('root');
const PORT = Number(arg('port', '7331'));
const VARIANT = arg('variant', 'baseline');   // baseline | candidate
const PHASE = arg('phase', 'boot-order');     // boot-order | no-metadata
const OUT = arg('out', path.join(process.cwd(), 'route-probe.json'));
const BUILD_SHA = arg('build-sha', '');
const WAIT_MS = Number(arg('wait-ms', '240000'));

if (!ROOT) { console.error('MISSING --root'); process.exit(2); }

const TOKEN_OLD = 'labprev' + crypto.randomBytes(16).toString('hex'); // a previous run's token
const TOKEN_NEW = 'labcurr' + crypto.randomBytes(16).toString('hex'); // this run's token
const TOKEN_FORGED = 'labforged' + crypto.randomBytes(16).toString('hex');

const fp = t => ({
  sha256_8: crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 8),
  len: String(t).length,
});

function writeConfig(cfg) {
  fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
}
function readConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch (e) { return {}; }
}

// A production-shaped config. dnsName follows main.yml's MagicDNS shape
// (<host>.<something>.ts.net); the lab value is deliberately not a real node.
const baseCfg = () => ({
  dnsName: 'slab-srv-lab.example.ts.net',
  rdpUser: 'slabrdp',
  rdpPass: 'not-a-real-password-lab-only',
  dashToken: TOKEN_OLD,
  buildSha: BUILD_SHA,
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitListening(okFile, child) {
  const t0 = Date.now();
  while (Date.now() - t0 < WAIT_MS) {
    if (child.exitCode !== null) return { ok: false, code: 'BACKEND_EXITED', exit: child.exitCode, ms: Date.now() - t0 };
    try {
      const t = fs.readFileSync(okFile, 'utf8');
      if (t.startsWith('LISTENING')) return { ok: true, text: t.trim(), ms: Date.now() - t0 };
      if (t.startsWith('LISTEN_FAIL')) return { ok: false, code: 'LISTEN_FAIL', text: t.trim(), ms: Date.now() - t0 };
    } catch (e) { /* not yet */ }
    await sleep(500);
  }
  return { ok: false, code: 'LISTEN_TIMEOUT', ms: Date.now() - t0 };
}

function startServer() {
  // The payload writes `$Root\server-ok.txt` (payloads/ghrdp-server.ps1:419/9416)
  // and does NOT read OK_FILE - watching an env-named path made every probe
  // report LISTEN_TIMEOUT against a server that was listening and working
  // (run 39934941144: logon/conn scans ticking, no marker where we looked).
  const okFile = path.join(ROOT, 'server-ok.txt');
  try { fs.unlinkSync(okFile); } catch (e) { /* absent */ }
  // PRODUCTION SHAPE: a Scheduled Task does not inherit the workflow's build
  // environment, so the identity is not in the environment - it is on disk.
  const env = { ...process.env, OK_FILE: okFile, PORT: String(PORT) };
  delete env.GHRDP_BUILD_SHA;
  delete env.GITHUB_SHA;
  const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'ghrdp-server.ps1'), '-Port', String(PORT), '-Root', ROOT], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const logs = [];
  child.stdout.on('data', d => logs.push(d.toString()));
  child.stderr.on('data', d => logs.push(d.toString()));
  return { child, okFile, logs };
}

function stopServer(s) {
  try { s.child.kill(); } catch (e) { /* gone */ }
  return new Promise(r => setTimeout(r, 1500));
}

const auth = t => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });
const ticket = () => request(`http://127.0.0.1:${PORT}/api/rdp-token`, { method: 'POST', timeoutMs: 20000, headers: {}, body: '{}' });

async function probeToken(tok) {
  const r = await request(`http://127.0.0.1:${PORT}/api/rdp-token`, {
    method: 'POST', timeoutMs: 20000, headers: tok ? auth(tok) : { 'Content-Type': 'application/json' }, body: '{}',
  });
  // The route order is: credential gate (401) -> tailnet source (403) ->
  // MagicDNS (409) -> mint (200). So a 403/409 is POSITIVE proof that the
  // credential passed the gate; only 401 means the credential was refused.
  const accepted = r.transport === 'ok' && (r.status === 200 || r.status === 403 || r.status === 409);
  return {
    status: r.status, transport: r.transport, accepted,
    minted: r.transport === 'ok' && r.status === 200 && !!(r.json && r.json.rid),
    body: r.transport === 'ok' ? String(r.text || '').slice(0, 120) : r.transport,
    discriminator: r.transport !== 'ok' ? 'NO_RESPONSE' : (r.status === 401 ? 'REFUSED_401' : (r.status === 200 ? 'MINTED_200' : `PASSED_GATE_${r.status}`)),
  };
}

// /api/purge-stale-creds: a credential-DELETING command route with the same
// strict gate. Acceptance here is 200 (no tailnet check on this route); a 401
// means the credential was refused. The response body is never executed - it is
// a command string the operator would run on their own PC.
async function probePurge(tok) {
  const r = await request(`http://127.0.0.1:${PORT}/api/purge-stale-creds`, {
    timeoutMs: 20000, headers: tok ? { Authorization: `Bearer ${tok}` } : {},
  });
  return {
    status: r.status, transport: r.transport,
    accepted: r.transport === 'ok' && r.status === 200,
    hasCommand: !!(r.json && typeof r.json.command === 'string' && r.json.command.length > 0),
    discriminator: r.transport !== 'ok' ? 'NO_RESPONSE' : (r.status === 401 ? 'REFUSED_401' : `ACCEPTED_${r.status}`),
  };
}

function versionFacts(r) {
  return {
    status: r.status, transport: r.transport,
    sha: r.json && typeof r.json.sha === 'string' ? r.json.sha : null,
    sha7: r.json && typeof r.json.sha7 === 'string' ? r.json.sha7 : null,
    is40Hex: !!(r.json && typeof r.json.sha === 'string' && /^[0-9a-f]{40}$/.test(r.json.sha)),
    isDev: !!(r.json && r.json.sha === 'dev'),
  };
}

async function main() {
  const out = {
    schema: 1, variant: VARIANT, phase: PHASE, root: ROOT, port: PORT,
    startedAt: new Date().toISOString(), buildShaArg: BUILD_SHA || null,
    buildEnvInherited: { GHRDP_BUILD_SHA: process.env.GHRDP_BUILD_SHA ? 'present' : 'absent-removed', GITHUB_SHA: process.env.GITHUB_SHA ? 'present-removed' : 'absent' },
    tokens: { previous: fp(TOKEN_OLD), current: fp(TOKEN_NEW), forged: fp(TOKEN_FORGED) },
    steps: {}, checks: [], verdicts: {},
  };

  // ---- phase: no-metadata (P002 negative case) -----------------------------
  if (PHASE === 'no-metadata') {
    const cfg = baseCfg();
    delete cfg.buildSha;
    delete cfg.dashToken;
    writeConfig(cfg);
    out.preconditions = { configKeys: Object.keys(cfg), dashTokenWritten: false, buildShaWritten: false };
    const s = startServer();
    const listen = await waitListening(s.okFile, s.child);
    out.steps.listen = listen;
    if (listen.ok) {
      const v = versionFacts(await request(`http://127.0.0.1:${PORT}/api/version`, { timeoutMs: 15000 }));
      out.steps.version_no_metadata = v;
      // A server with no written identity must say dev - never a guess.
      out.verdicts.versionDevWhenNoMetadata = v.isDev === true;
      out.checks.push({ id: 'P002.negative', pass: v.isDev === true, detail: v });
    } else {
      out.checks.push({ id: 'P002.negative', pass: false, detail: { listen } });
    }
    await stopServer(s);
    out.logTail = s.logs.join('').slice(-2000);
    out.finishedAt = new Date().toISOString();
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out.verdicts));
    process.exit(out.checks.every(c => c.pass) ? 0 : 1);
  }

  // ---- phase: boot-order (P001 both directions, P002 positive) -------------
  // 1. the PREVIOUS run's token is on disk when the process boots
  writeConfig(baseCfg());
  fs.writeFileSync(path.join(ROOT, 'dash-token.txt'), TOKEN_OLD, 'utf8');
  out.preconditions = { bootToken: fp(TOKEN_OLD), bootOrder: 'server started before the current token is written' };

  const s = startServer();
  const listen = await waitListening(s.okFile, s.child);
  out.steps.listen = listen;
  if (!listen.ok) {
    listen.logTail = s.logs.join('').replace(/[\r\n]+/g, ' ').slice(-1200);
    out.checks.push({ id: 'server.listening', pass: false, detail: listen });
    out.logTail = s.logs.join('').slice(-4000);
    out.finishedAt = new Date().toISOString();
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
    console.log(JSON.stringify({ fatal: 'server did not listen' }));
    process.exit(1);
  }
  out.checks.push({ id: 'server.listening', pass: true, detail: { ms: listen.ms } });

  // 2. main.yml "Stage files + write config.json": the CURRENT run's token
  //    arrives while the process is already running (config.json + token file).
  const cfg2 = { ...readConfig(), dashToken: TOKEN_NEW };
  writeConfig(cfg2);
  fs.writeFileSync(path.join(ROOT, 'dash-token.txt'), TOKEN_NEW, 'utf8');
  out.steps.tokenRotatedAt = new Date().toISOString();

  const anon = await request(`http://127.0.0.1:${PORT}/api/rdp-token`, { method: 'POST', timeoutMs: 20000, headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const forged = await probeToken(TOKEN_FORGED);
  const current = await probeToken(TOKEN_NEW);
  const superseded = await probeToken(TOKEN_OLD);
  const purgeCurrent = await probePurge(TOKEN_NEW);
  const purgeSuperseded = await probePurge(TOKEN_OLD);
  const version = versionFacts(await request(`http://127.0.0.1:${PORT}/api/version`, { timeoutMs: 15000 }));

  out.steps = {
    ...out.steps,
    anonymous: { status: anon.status, transport: anon.transport },
    forged, current, superseded, version,
    purge: { current: purgeCurrent, superseded: purgeSuperseded },
  };

  // ---- expectations --------------------------------------------------------
  // baseline: P001 refuses the current token and accepts the superseded one;
  //           P002 answers dev. Those are the reproductions we are looking for.
  // candidate: the opposite, with the negative cases intact.
  const expect = VARIANT === 'candidate'
    ? { anon401: true, forgedRefused: true, currentAccepted: true, supersededRefused: true, versionIsBuild: true, purgeCurrent: true, purgeSuperseded: false }
    : { anon401: true, forgedRefused: true, currentAccepted: false, supersededRefused: false, versionIsBuild: false, purgeCurrent: false, purgeSuperseded: true };

  const checks = [
    { id: 'P001.anonymous', pass: (anon.transport === 'ok' && anon.status === 401) === expect.anon401, detail: { status: anon.status, transport: anon.transport } },
    { id: 'P001.forged', pass: forged.accepted === !expect.forgedRefused, detail: forged },
    { id: 'P001.current_token', pass: current.accepted === expect.currentAccepted, detail: current },
    { id: 'P001.superseded_token', pass: superseded.accepted === !expect.supersededRefused, detail: superseded },
    { id: 'P001B.purge_current', pass: purgeCurrent.accepted === expect.purgeCurrent, detail: purgeCurrent },
    { id: 'P001B.purge_superseded', pass: purgeSuperseded.accepted === !expect.purgeSuperseded, detail: purgeSuperseded },
    { id: 'P002.version_identity', pass: expect.versionIsBuild ? (version.is40Hex && version.sha === BUILD_SHA) : version.isDev, detail: version },
  ];
  out.checks.push(...checks);
  out.verdicts = {
    reproduction: VARIANT === 'baseline',
    currentTokenAccepted: current.accepted,
    supersededTokenAccepted: superseded.accepted,
    purgeCurrentAccepted: purgeCurrent.accepted,
    purgeSupersededAccepted: purgeSuperseded.accepted,
    versionSha: version.sha,
    allExpectationsMet: checks.every(c => c.pass),
  };

  await stopServer(s);
  out.logTail = s.logs.join('').slice(-4000);
  out.finishedAt = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out.verdicts));
  process.exit(checks.every(c => c.pass) ? 0 : 1);
}

main().catch(e => { console.error('PROBE_ERROR: ' + (e && e.stack || e)); process.exit(3); });
