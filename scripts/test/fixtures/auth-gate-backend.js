#!/usr/bin/env node
'use strict';
// Out-of-process emulator of the APPLICATION's authorization contract, used
// ONLY by scripts/test/live-auth-gate-regressions.js. Never used live.
//
// It is deliberately a faithful copy of payloads/ghrdp-server.ps1
// @24ddaa9904c92dbbba39e3cc7aba458769e6bbe4 rather than a convenient stub, so a
// classifier that passes here is passing against the real route semantics:
//
//   POST /api/rdp-token   401 'dashboard authorization required'   (bearer)
//                         403 'direct tailnet source required'     (source)
//                         409 'MagicDNS FQDN missing'              (prereq)
//                         200 {rid:<32 hex>, ttl:<n>}              (issuance)
//   POST /api/rdp-creds   403 'tailnet POST required' / 401 'ticket invalid or
//                         expired' / 409 'credential config unavailable' /
//                         200 {fqdn,user,pass}
//   GET  /api/config      always creds:{fqdn,user,ip} (Remove-CredKeys rebuilds
//                         it with NO secret); password siblings only when
//                         Test-CredsAllowed (matching ?key= OR a tailnet source)
//   GET  /api/search/status  refresh-aware X-Dash-Token gate; 403 body carries
//                         details.detail + presentedHash/expectedHash; 404
//                         UNKNOWN_SOURCE for an unknown id AFTER auth
//   GET  /api/diag/comprehensive  token-comparison ring (hashes, never values)
//
// env:
//   PORT=0 (ephemeral)  TOKEN=<the current-run credential>
//   SOURCE_POLICY=accept|reject          (403 even for a valid bearer)
//   PREREQ=ok|missing                    (409 after bearer+source pass)
//   NEGATIVE_MODE=refuse|accept|timeout  (what anonymous/forged bearers get)
//   ISSUE_MODE=ok|malformed|no-rid|bad-ttl
//   CONFIG_POLICY=key-only|tailnet-trust|leak|masked|none
//   SEARCH_LANE=current|refuse|no-token|absent
//   STRICT_TOKEN=<value>                 (the strict route's own credential)
//   STALL=none|all|ours|negatives|config
//   TICKET_TTL=60
// stdout: "AUTH_GATE_LISTENING port=<n> pid=<pid>" once listening.

const http = require('http');
const crypto = require('crypto');

const TOKEN = process.env.TOKEN || 'run-token-fixture-value';
// The application has TWO comparators: the STRICT /api/rdp-token resolver
// (dash-token.txt authoritative) and the refresh-aware union used by the search
// lane. STRICT_TOKEN models a divergence between them.
const STRICT_TOKEN = process.env.STRICT_TOKEN || TOKEN;
// The refresh-aware lane's own credential. SEARCH_LANE=no-token empties it, so
// the lane reproduces the application's exact reason strings:
//   presented empty + server token empty -> 'server-has-no-dash-token'
//   presented empty + server token set   -> 'token-not-presented'
//   presented set   + mismatch           -> 'token-mismatch-after-refresh-aware-compare'
const SEARCH_TOKEN = process.env.SEARCH_LANE === 'no-token' ? '' : (process.env.SEARCH_TOKEN || TOKEN);
const SOURCE_POLICY = process.env.SOURCE_POLICY || 'accept';
const PREREQ = process.env.PREREQ || 'ok';
const NEGATIVE_MODE = process.env.NEGATIVE_MODE || 'refuse';
const ISSUE_MODE = process.env.ISSUE_MODE || 'ok';
const CONFIG_POLICY = process.env.CONFIG_POLICY || 'key-only';
const SEARCH_LANE = process.env.SEARCH_LANE || 'current';
const STALL = process.env.STALL || 'none';
const TICKET_TTL = Number(process.env.TICKET_TTL || 60);

const tickets = new Map();          // rid -> {created, source, redeemed}
const tokenRing = [];               // {route, presentedHash, expectedHash, valid}
const hash8 = v => crypto.createHash('sha256').update(String(v || ''), 'utf8').digest('hex').slice(0, 8);

function recordToken(route, presented, valid) {
  tokenRing.push({ route, presentedHash: hash8(presented), expectedHash: hash8(TOKEN), presentedLen: String(presented || '').length, expectedLen: String(TOKEN).length, valid: Boolean(valid), ts: new Date().toISOString() });
  if (tokenRing.length > 40) tokenRing.shift();
}

function stall(kind) {
  if (STALL === 'all' || STALL === kind) return true;
  return false;
}

function send(res, code, body, ctype) {
  const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, { 'Content-Type': ctype || (typeof body === 'string' ? 'text/plain' : 'application/json; charset=utf-8'), 'Content-Length': buf.length, 'Connection': 'close' });
  res.end(buf);
}

function bearerOf(req) {
  const h = String(req.headers['authorization'] || '');
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : '';
}

function queryOf(url) {
  const out = {};
  const q = url.indexOf('?');
  if (q < 0) return out;
  // the server lowercases keys (Get-RequestParts) - do the same
  for (const kv of url.slice(q + 1).split('&')) {
    const eq = kv.indexOf('=');
    if (eq > 0) out[decodeURIComponent(kv.slice(0, eq)).toLowerCase()] = decodeURIComponent(kv.slice(eq + 1));
  }
  return out;
}

const server = http.createServer((req, res) => {
  const url = String(req.url || '/');
  const path = url.split('?')[0];
  const q = queryOf(url);

  // A stalled listener accepts the TCP connection and then never answers - the
  // exact symptom measured on the client VM (curl exit 28 with the port open).
  if (stall('all')) return;

  if (path === '/api/ping') return send(res, 200, { ok: true, pong: true, ts: new Date().toISOString() });

  if (path === '/api/rdp-token' && req.method === 'POST') {
    const presented = bearerOf(req);
    const tokOk = Boolean(presented) && presented === STRICT_TOKEN;
    recordToken('/api/rdp-token', presented, tokOk);
    if (!tokOk) {
      if (NEGATIVE_MODE === 'timeout' && !presented) return;      // never answer
      if (NEGATIVE_MODE === 'timeout' && presented !== TOKEN) return;
      if (NEGATIVE_MODE === 'accept' && presented) {
        const rid = crypto.randomBytes(16).toString('hex');
        tickets.set(rid, { created: Date.now(), source: 'fixture', redeemed: false });
        return send(res, 200, { rid, ttl: TICKET_TTL });
      }
      return send(res, 401, 'dashboard authorization required');
    }
    if (stall('ours')) return;                                     // our request never answers
    if (SOURCE_POLICY === 'reject') return send(res, 403, 'direct tailnet source required');
    if (PREREQ === 'missing') return send(res, 409, 'MagicDNS FQDN missing');
    if (ISSUE_MODE === 'no-rid') return send(res, 200, { ttl: TICKET_TTL });
    if (ISSUE_MODE === 'malformed') return send(res, 200, { rid: 'NOT-A-HEX-TICKET', ttl: TICKET_TTL });
    if (ISSUE_MODE === 'bad-ttl') return send(res, 200, { rid: crypto.randomBytes(16).toString('hex'), ttl: 'soon' });
    const rid = crypto.randomBytes(16).toString('hex');
    tickets.set(rid, { created: Date.now(), source: 'fixture', redeemed: false });
    return send(res, 200, { rid, ttl: TICKET_TTL });
  }

  if (path === '/api/rdp-creds' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let tk = '';
      try { tk = String(JSON.parse(body || '{}').token || ''); } catch (e) { tk = ''; }
      const entry = tickets.get(tk);
      if (!/^[0-9a-f]{32}$/.test(tk) || !entry) return send(res, 401, 'ticket invalid or expired');
      tickets.delete(tk);                                          // consume before responding
      const ageSec = (Date.now() - entry.created) / 1000;
      if (ageSec >= TICKET_TTL) return send(res, 401, 'ticket invalid or expired');
      if (entry.redeemed) return send(res, 401, 'ticket invalid or expired');
      return send(res, 200, { fqdn: 'fixture.ts.net', user: 'fixtureUser', pass: 'fixture-secret-password' });
    });
    return;
  }

  if (path === '/api/config') {
    if (stall('config')) return;
    // Remove-CredKeys: creds is ALWAYS rebuilt as {fqdn,user,ip} - no secret.
    const out = { dnsName: 'fixture.ts.net', port: 7331, creds: { fqdn: 'fixture.ts.net', user: 'fixtureUser', ip: '100.64.0.9' } };
    const keyOk = Boolean(q.key) && q.key === TOKEN;
    // Test-CredsAllowed: a tailnet source is allowed WITHOUT a key. The fixture
    // models that with CONFIG_POLICY=tailnet-trust (what the real client VM sees).
    const sourceAllowed = CONFIG_POLICY === 'tailnet-trust' || CONFIG_POLICY === 'leak';
    const allowed = keyOk || sourceAllowed;
    if (CONFIG_POLICY === 'none') return send(res, 200, out);
    if (allowed) {
      if (CONFIG_POLICY === 'masked') {
        out.creds.windowsPassMask = '************cdef';
        out.creds.vncPassMask = '****wxyz';
      } else {
        out.creds.windowsPass = 'fixture-secret-password';
        out.creds.windowsPassMask = '************cdef';
        out.creds.vncPass = '';
        out.creds.vncPassMask = '';
      }
    }
    return send(res, 200, out);
  }

  if (path === '/api/search/status' && req.method === 'GET') {
    if (SEARCH_LANE === 'absent') return send(res, 404, 'not found');
    for (const qk of ['key', 'token', 'dash-token', 'dashtoken', 'password']) {
      if (qk in q) return send(res, 401, { code: 'VALIDATION_ERROR', details: { reason: 'query credential refused' } });
    }
    const presented = String(req.headers['x-dash-token'] || '') || bearerOf(req);
    let ok = Boolean(presented) && presented === SEARCH_TOKEN;
    if (SEARCH_LANE === 'refuse') ok = false;
    recordToken('/api/search/status', presented, ok);
    if (!ok) {
      let why = 'token-not-presented';
      if (presented) why = 'token-mismatch-after-refresh-aware-compare';
      if (!SEARCH_TOKEN && !presented) why = 'server-has-no-dash-token';
      return send(res, 403, { code: 'AUTH_REQUIRED', details: { reason: 'dash token required', detail: why, presentedHash: hash8(presented), expectedHash: hash8(SEARCH_TOKEN) } });
    }
    if (!q.searchid) return send(res, 400, { code: 'VALIDATION_ERROR', details: { reason: 'searchId required' } });
    // authenticated, then the sentinel id is unknown: a post-auth 404
    return send(res, 404, { code: 'UNKNOWN_SOURCE', details: { searchId: q.searchid } });
  }

  if (path === '/api/diag/comprehensive') {
    return send(res, 200, { generatedAt: new Date().toISOString(), f99: { dashToken: { comparisons: tokenRing.slice(-10) } } });
  }

  send(res, 404, 'not found');
});

server.listen(Number(process.env.PORT || 0), '127.0.0.1', () => {
  process.stdout.write(`AUTH_GATE_LISTENING port=${server.address().port} pid=${process.pid}\n`);
});
process.on('SIGTERM', () => { try { server.close(); } catch (e) { } process.exit(0); });
