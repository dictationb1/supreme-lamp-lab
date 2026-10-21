'use strict';
// HTTP helpers built on Node's fetch (undici). Network failures keep the full
// nested cause chain (e.g. TypeError: fetch failed -> Error: connect
// ECONNREFUSED 127.0.0.1:7331) instead of collapsing to "fetch failed".

function describeError(err, depth = 0) {
  if (!err) return { message: 'Unknown error' };
  const d = {
    name: err.name || (err.constructor && err.constructor.name) || 'Error',
    message: err.message !== undefined ? String(err.message) : String(err)
  };
  for (const k of ['code', 'errno', 'syscall', 'address', 'port', 'status']) {
    if (err[k] !== undefined) d[k] = err[k];
  }
  if (Array.isArray(err.errors) && err.errors.length && depth < 4) {
    d.errors = err.errors.map(e => describeError(e, depth + 1));
  }
  if (err.cause && depth < 6) d.cause = describeError(err.cause, depth + 1);
  return d;
}

function formatErrorChain(err) {
  const parts = [];
  let cur = describeError(err);
  while (cur) {
    const extras = ['code', 'syscall', 'address', 'port'].filter(k => cur[k] !== undefined).map(k => `${k}=${cur[k]}`);
    parts.push(`${cur.name}: ${cur.message}${extras.length ? ` (${extras.join(' ')})` : ''}`);
    if (cur.errors) parts.push(`[aggregate: ${cur.errors.map(e => `${e.name}: ${e.message}${e.code ? ' ' + e.code : ''}`).join('; ')}]`);
    cur = cur.cause;
  }
  return parts.join(' <- caused by: ');
}

/**
 * Fetch and classify. Never throws; returns
 * { ok, transport: 'ok'|'error'|'timeout', status, headers, text, json, jsonError, error, errorChain, durationMs }
 */
async function request(url, { timeoutMs = 5000, method = 'GET', headers = {}, body } = {}) {
  const started = Date.now();
  const out = { url, ok: false, transport: 'error', status: null, text: null, json: null, jsonError: null, error: null, errorChain: null, durationMs: 0 };
  try {
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    out.transport = 'ok';
    out.status = res.status;
    out.headers = Object.fromEntries(res.headers.entries());
    const buf = Buffer.from(await res.arrayBuffer());
    out.bytes = buf;
    out.text = buf.toString('utf8');
    const ct = (out.headers['content-type'] || '').toLowerCase();
    if (ct.includes('json') || /^\s*[{[]/.test(out.text)) {
      try { out.json = JSON.parse(out.text.replace(/^\uFEFF/, '')); } catch (e) { out.jsonError = e.message; }
    }
    out.ok = res.status >= 200 && res.status < 300;
  } catch (err) {
    out.transport = (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) ? 'timeout' : 'error';
    out.error = describeError(err);
    out.errorChain = formatErrorChain(err);
  }
  out.durationMs = Date.now() - started;
  return out;
}

function summarize(r) {
  if (!r) return 'no response';
  if (r.transport !== 'ok') return `${r.transport.toUpperCase()}: ${r.errorChain}`;
  return `HTTP ${r.status}${r.jsonError ? ` (invalid JSON: ${r.jsonError})` : ''}`;
}

module.exports = { request, describeError, formatErrorChain, summarize };
