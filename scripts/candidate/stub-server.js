'use strict';
// LAB CANDIDATE BACKEND — a bounded, honest STUB, not the application server.
//
// Why a stub: the live origin's dashboard (100.99.208.107:7331) accepted TCP and
// then answered nothing (measured 2026-10-23 21:20Z, curl exit 28, HTTP code 000,
// twice, both ports silent). No test of THIS lab's browser can be run against a
// listener that never answers, and the lab must not pretend otherwise.
//
// What the stub does prove: the CANDIDATE UI BUILD, served to a real browser on
// the real Windows client VM, reacts correctly to each of the three backend
// states that matter:
//
//   refuse  - /api/config and /api/native-status answer 401 (the live origin's
//             "the read was refused" class);
//   empty   - both answer 200 with an EMPTY object (a server with nothing
//             configured: measurements exist and are empty);
//   healthy - both answer 200 with a complete, self-consistent snapshot whose
//             listener gates are green (proves the gates CAN open).
//
// Every response is synthetic and labelled as such in the evidence
// (`backend: "lab-candidate-stub"`). Nothing here is claimed to be the
// application's PowerShell/Rust server.
//
// usage: node stub-server.js --port 7331 --fault refuse --ui <path to index.html>

const fs = require('fs');
const http = require('http');
const path = require('path');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
}

const port = Number(arg('port', '7331'));
const fault = arg('fault', 'refuse');
const uiPath = arg('ui', '');
const buildSha = arg('sha', 'candidate');

if (!['refuse', 'empty', 'healthy'].includes(fault)) {
  console.error('unknown --fault ' + fault);
  process.exit(64);
}
if (!uiPath || !fs.existsSync(uiPath)) {
  console.error('--ui must point at the built single-file index.html');
  process.exit(64);
}
const UI = fs.readFileSync(uiPath);

const HEALTHY_CONFIG = {
  schema: 'lab-candidate-stub/1',
  backend: 'lab-candidate-stub',
  buildSha,
  creds: {
    fqdn: 'lab-candidate-1.tail-lab.ts.net',
    user: 'labuser',
    ip: '100.99.208.107',
    windowsPassMask: '************cret',
    vncPassMask: '********ncap'
  }
};

const HEALTHY_NATIVE = {
  schema: 'lab-candidate-stub/1',
  backend: 'lab-candidate-stub',
  fqdn: 'lab-candidate-1.tail-lab.ts.net',
  runnerResolvedIP: '100.99.208.107',
  creds: { ip: '100.99.208.107', user: 'labuser' },
  certBound: true,
  nlaOn: true,
  certNotAfter: new Date(Date.now() + 60 * 864e5).toISOString(),
  rdpListener: {
    listening: true,
    fwRule: true,
    certOk: true,
    nla: true,
    credsspLive: 'ok',
    authLast: { result: 'success', eventTs: new Date(Date.now() - 60000).toISOString(), logonType: '10', logonKind: 'RemoteInteractive' }
  },
  webdeskUrl: 'http://100.99.208.107:6080/vnc.html',
  webdeskReason: '',
  handlerChain: []
};

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  if (p === '/health') return json(res, 200, { ok: true, ws: false, backend: 'lab-candidate-stub', fault, port, ts: new Date().toISOString() });
  if (p === '/api/ping') return json(res, 200, { ok: true, backend: 'lab-candidate-stub' });
  if (p === '/diag') return json(res, 200, { searchEnabled: true, searchInput: '', backend: 'lab-candidate-stub' });
  if (p === '/api/progress') return json(res, 200, { serverTs: new Date().toISOString(), runnerEgressIp: '100.93.94.15', backend: 'lab-candidate-stub' });
  if (p === '/api/version') return json(res, 200, { sha: buildSha, backend: 'lab-candidate-stub' });

  if (p === '/api/config' || p === '/api/native-status') {
    if (fault === 'refuse') return json(res, 401, { error: 'unauthorized', backend: 'lab-candidate-stub' });
    if (fault === 'empty') return json(res, 200, { backend: 'lab-candidate-stub' });
    return json(res, 200, p === '/api/config' ? HEALTHY_CONFIG : HEALTHY_NATIVE);
  }

  if (p === '/api/rdp-token') {
    if (fault !== 'healthy') return json(res, 401, { error: 'unauthorized', backend: 'lab-candidate-stub' });
    return json(res, 200, { rid: '0123456789abcdef0123456789abcdef', backend: 'lab-candidate-stub' });
  }

  // The dashboard's own UI routes.
  if (p === '/' || p === '/v2' || p === '/ui' || p === '/index.html' || p === '/v2/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(UI);
  }

  // Everything else is an explicit, visible 404 (never an empty 200).
  return json(res, 404, { error: 'not_found', path: p, backend: 'lab-candidate-stub' });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[candidate-stub] listening on 127.0.0.1:${port} fault=${fault} ui=${path.basename(uiPath)} bytes=${UI.length} sha=${buildSha}`);
});
