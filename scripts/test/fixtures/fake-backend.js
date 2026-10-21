#!/usr/bin/env node
'use strict';
// Out-of-process fake of the supreme-lamp backend HTTP contract, used ONLY by
// scripts/run-regressions.js. Never used by the live workflow.
//
// env: MODE, PORT (0 = ephemeral), EXPECT_SHA, OK_FILE (optional), CRASH_AFTER_MS (crash modes)
// stdout: "FAKE_LISTENING port=<n> pid=<pid>" once listening.

const http = require('http');
const fs = require('fs');

const MODE = process.env.MODE || 'ok';
const SHA = process.env.EXPECT_SHA || 'a'.repeat(40);
const started = Date.now();

if (MODE === 'exit-early') {
  setTimeout(() => { process.stderr.write('fake backend: simulated startup crash\n'); process.exit(3); }, 300);
  return;
}

function readiness() {
  const ready = { ok: true, status: 'ok', phase: 'ready', liveness: true, apiReadiness: true, dependencyHealth: { explorerFx: true, mirrorHost: true }, desktopConnectivity: { rdpListener: true }, port: server.address().port, pid: process.pid, serverTs: new Date().toISOString().replace(/\.\d+Z$/, 'Z') };
  const init = { ...ready, ok: false, status: 'initializing', phase: 'payloads', apiReadiness: false };
  switch (MODE) {
    case 'initializing': return init;
    case 'crash-before-ready': return init;
    case 'slow-ready': return Date.now() - started > 2500 ? ready : init;
    case 'contradictory': return { ...ready, status: 'initializing' };
    case 'missing-fields': return { ok: true, status: 'ok' };
    case 'wrong-listener': return { ...ready, pid: process.pid + 100000 };
    case 'string-booleans': return { ...ready, ok: 'true' };
    default: return ready;
  }
}

const DASH = sha => `<!doctype html><html><head><meta charset="utf-8"><meta id="ghrdpBuild" name="ghrdp-build" content="${sha}"><title>RDP Mission Control</title></head><body><div id="topbar">Mission Control</div></body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/api/readiness') {
    if (MODE === 'http-500') return json(500, { error: 'boom' });
    if (MODE === 'invalid-json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok": tru'); }
    return json(200, readiness());
  }
  if (url.pathname === '/api/version') {
    const sha = MODE === 'wrong-sha' ? 'b'.repeat(40) : MODE === 'dev-sha' ? 'dev' : SHA;
    return json(200, { ok: true, server: 'ghrdp', sha, sha7: String(sha).slice(0, 7) });
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(MODE === 'ui-missing' ? '<h1>Mission Control UI file missing</h1>' : DASH(SHA));
  }
  res.writeHead(404); res.end('not found');
});

server.listen(Number(process.env.FAKE_LISTEN_PORT || process.env.PORT || 0), '127.0.0.1', () => {
  const { port } = server.address();
  if (process.env.OK_FILE) fs.writeFileSync(process.env.OK_FILE, `LISTENING pid=${process.pid} port=${port}`);
  process.stdout.write(`FAKE_LISTENING port=${port} pid=${process.pid}\n`);
  // CRASH_AFTER_MS: Windows identity/listener checks spawn PowerShell (seconds), so the
// suite scales the crash point to land in the phase under test on every platform.
if (MODE === 'crash-after-ready' || MODE === 'crash-before-ready') setTimeout(() => process.exit(1), Number(process.env.CRASH_AFTER_MS || 1500));
});
