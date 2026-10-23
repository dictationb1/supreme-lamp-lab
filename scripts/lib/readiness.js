'use strict';
// Contract for the supreme-lamp backend (payloads/ghrdp-server.ps1):
//   GET /api/readiness -> { ok, status: 'ok'|'initializing', phase, liveness,
//                           apiReadiness, dependencyHealth, desktopConnectivity,
//                           port, pid, serverTs }
//   GET /api/version   -> { ok, server: 'ghrdp', sha, sha7 }
// Every field we rely on is checked for presence AND type AND consistency.
// A partial or contradictory payload is NOT ready. There is no OR-chain of
// "good enough" signals.

const { request, summarize } = require('./http');
const { sleepSync } = require('./lock');

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

/** Returns { ready, terminal, code, detail } */
function evaluateReadiness(body, { expectPid = null, expectPort = null } = {}) {
  if (!isObj(body)) return { ready: false, terminal: false, code: 'READINESS_SCHEMA_INVALID', detail: 'body is not a JSON object' };
  const missing = ['ok', 'status', 'phase', 'apiReadiness', 'pid', 'port'].filter(k => body[k] === undefined || body[k] === null);
  if (missing.length) return { ready: false, terminal: false, code: 'READINESS_SCHEMA_INVALID', detail: `missing fields: ${missing.join(',')}` };
  if (typeof body.ok !== 'boolean' || typeof body.apiReadiness !== 'boolean') return { ready: false, terminal: false, code: 'READINESS_SCHEMA_INVALID', detail: 'ok/apiReadiness must be booleans' };
  if (!Number.isInteger(body.pid) || body.pid <= 0) return { ready: false, terminal: false, code: 'READINESS_SCHEMA_INVALID', detail: `pid not a positive integer: ${JSON.stringify(body.pid)}` };
  const okSignals = [body.ok === true, body.status === 'ok', body.phase === 'ready', body.apiReadiness === true];
  const anyReady = okSignals.some(Boolean);
  const allReady = okSignals.every(Boolean);
  if (anyReady && !allReady && !(body.status === 'initializing' && body.ok === false)) {
    return { ready: false, terminal: false, code: 'READINESS_CONTRADICTORY', detail: `ok=${body.ok} status=${body.status} phase=${body.phase} apiReadiness=${body.apiReadiness}` };
  }
  if (!allReady) return { ready: false, terminal: false, code: 'READINESS_NOT_READY', detail: `status=${body.status} phase=${body.phase}` };
  if (expectPid !== null && body.pid !== Number(expectPid)) return { ready: false, terminal: true, code: 'READINESS_WRONG_PROCESS', detail: `pid ${body.pid} != supervised backend pid ${expectPid}` };
  if (expectPort !== null && Number(body.port) !== Number(expectPort)) return { ready: false, terminal: true, code: 'READINESS_WRONG_PORT', detail: `port ${body.port} != ${expectPort}` };
  return { ready: true, terminal: true, code: 'READY', detail: `pid=${body.pid} port=${body.port} phase=${body.phase}` };
}

function evaluateVersion(body, expectSha) {
  if (!isObj(body)) return { ok: false, code: 'VERSION_SCHEMA_INVALID', detail: 'body is not a JSON object' };
  if (body.ok !== true || body.server !== 'ghrdp') return { ok: false, code: 'VERSION_IDENTITY_MISMATCH', detail: `ok=${body.ok} server=${body.server}` };
  if (typeof body.sha !== 'string' || !/^[0-9a-f]{40}$/.test(body.sha)) return { ok: false, code: 'VERSION_SHA_INVALID', detail: `sha=${JSON.stringify(body.sha)} (GHRDP_BUILD_SHA not propagated?)` };
  if (expectSha && body.sha !== expectSha) return { ok: false, code: 'VERSION_SHA_MISMATCH', detail: `backend sha ${body.sha} != expected ${expectSha}` };
  if (body.sha7 !== undefined && body.sha7 !== body.sha.slice(0, 7)) return { ok: false, code: 'VERSION_CONTRADICTORY', detail: `sha7 ${body.sha7} != ${body.sha.slice(0, 7)}` };
  return { ok: true, code: 'VERSION_OK', detail: body.sha };
}

/**
 * Poll readiness until ready, a terminal mismatch, a live-process failure
 * (isAlive() returns false) or the deadline. Async so it never blocks a
 * same-process server.
 */
async function waitForReady(baseUrl, { timeoutMs = 120000, intervalMs = 2000, expectPid = null, expectPort = null, isAlive = null, log = () => {} } = {}) {
  const deadline = Date.now() + timeoutMs;
  const history = [];
  let last = null;
  for (;;) {
    if (isAlive && !isAlive()) {
      return { ready: false, code: 'BACKEND_EXITED', detail: 'supervised backend process exited before readiness', history, last };
    }
    const r = await request(`${baseUrl}/api/readiness`, { timeoutMs: 5000 });
    let verdict;
    if (r.transport !== 'ok') verdict = { ready: false, terminal: false, code: r.transport === 'timeout' ? 'READINESS_TIMEOUT' : 'READINESS_UNREACHABLE', detail: summarize(r) };
    else if (r.status !== 200) verdict = { ready: false, terminal: false, code: 'READINESS_HTTP_ERROR', detail: `HTTP ${r.status}` };
    else if (r.json === null) verdict = { ready: false, terminal: false, code: 'READINESS_SCHEMA_INVALID', detail: `invalid JSON: ${r.jsonError}` };
    else verdict = evaluateReadiness(r.json, { expectPid, expectPort });
    last = { at: new Date().toISOString(), code: verdict.code, detail: verdict.detail, body: r.json, transport: r.transport, status: r.status };
    // Record EVERY DISTINCT OBSERVATION, not every distinct code: the detail
    // carries the address/errno, so 'READINESS_TIMEOUT' four times is four
    // different failures and the evidence must say which one (measured
    // 2026-10-23: the run reported only the last code and the address that was
    // actually contacted was unrecoverable from the annotations).
    const prev = history[history.length - 1];
    const key = `${verdict.code}|${verdict.detail}`;
    if (!prev || prev.key !== key) {
      history.push({ at: last.at, key, code: verdict.code, detail: verdict.detail, transport: r.transport, status: r.status });
      log(`${verdict.code}: ${verdict.detail}`);
    }
    if (verdict.ready || verdict.terminal) return { ...verdict, history, last };
    if (Date.now() + intervalMs > deadline) return { ...verdict, ready: false, code: verdict.code, detail: `deadline ${timeoutMs}ms reached; last: ${verdict.detail}`, history, last };
    await new Promise(res => setTimeout(res, intervalMs));
  }
}

async function checkVersion(baseUrl, expectSha) {
  const r = await request(`${baseUrl}/api/version`, { timeoutMs: 5000 });
  if (r.transport !== 'ok') return { ok: false, code: 'VERSION_UNREACHABLE', detail: summarize(r) };
  if (r.status !== 200) return { ok: false, code: 'VERSION_HTTP_ERROR', detail: `HTTP ${r.status}` };
  return { ...evaluateVersion(r.json, expectSha), body: r.json };
}

module.exports = { evaluateReadiness, evaluateVersion, waitForReady, checkVersion, sleepSync };
