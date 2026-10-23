'use strict';
// THE LIVE SIGNAL — a non-secret, run-scoped descriptor that the ORIGIN run
// publishes into a public check-run output while its server is alive.
//
// WHY THIS EXISTS (measured 2026-10-22, runs 39808737164 / 39808861040):
//   * run-level logs: HTTP 404 while the run is in progress;
//   * per-job logs:   302 -> productionresultssa*.blob.core.windows.net -> 404
//     for every attempt made while the job was queued or running (six
//     attempts, two transports, from INSIDE a GitHub runner) — the blob only
//     exists after the job completes, at which point the ephemeral host is
//     gone. Log scraping therefore cannot discover a LIVE run.
//   * check-run output: READABLE LIVE (visible ~36 s after publication).
//
// So the automatic link has to be a signal, not a log. The signal carries the
// run/attempt/app-sha identity in clear (all public facts) and the dashboard
// key ONLY as RSA-OAEP ciphertext under the lab's public key. The lab decrypts
// with a private key held in lab secrets; nothing secret is ever written to a
// public artifact, log, annotation or report.
//
// The publisher side is `patches/app-live-signal-check-run.snippet.yml`.

const crypto = require('crypto');

const SIGNAL_NAME = 'mission-control-live-signal';
const SIGNAL_PREFIX = 'MC-SIGNAL v1 ';
const MAX_TTL_MS = 6 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 2 * 60 * 1000;
const CGNAT_V4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/;

const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function keyFingerprint(publicKeyPem) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
}

/**
 * Build the signal text a publisher writes into `output.summary`.
 * `payload.key` is encrypted here and never leaves this function in clear.
 */
function buildSignal(payload, publicKeyPem) {
  const p = payload || {};
  if (!p.key) throw new Error('buildSignal: key required');
  const ciphertext = crypto.publicEncrypt(
    { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(String(p.key), 'utf8')
  );
  const env = {
    v: 1,
    repo: p.repo,
    runId: Number(p.runId),
    attempt: Number(p.attempt || 1),
    appSha: p.appSha,
    uiBuild: p.uiBuild || null,
    endpoint: p.endpoint,
    correlation: p.correlation || null,
    issuedAt: p.issuedAt || new Date().toISOString(),
    expiresAt: p.expiresAt,
    enc: { alg: 'RSA-OAEP-256', keyId: keyFingerprint(publicKeyPem), ciphertext: ciphertext.toString('base64') }
  };
  return SIGNAL_PREFIX + b64u(JSON.stringify(env));
}

function parseSignal(text) {
  const raw = String(text || '').trim();
  const at = raw.indexOf(SIGNAL_PREFIX);
  if (at < 0) return { ok: false, code: 'SIGNAL_NOT_FOUND', detail: 'no MC-SIGNAL v1 block in the check-run output' };
  const token = raw.slice(at + SIGNAL_PREFIX.length).split(/\s/)[0];
  let env;
  try { env = JSON.parse(unb64u(token).toString('utf8')); }
  catch (e) { return { ok: false, code: 'SIGNAL_MALFORMED', detail: `base64/json: ${e.message}` }; }
  if (!env || env.v !== 1) return { ok: false, code: 'SIGNAL_VERSION', detail: `unsupported version ${env && env.v}` };
  if (!env.endpoint || !env.enc || !env.enc.ciphertext) return { ok: false, code: 'SIGNAL_INCOMPLETE', detail: 'endpoint or ciphertext missing' };
  return { ok: true, envelope: env };
}

/**
 * Identity validation. Everything here is compared against TRUSTED evidence
 * (the GitHub run API), never against another field of the same signal.
 */
function validateSignal(env, expect = {}) {
  const now = expect.now || Date.now();
  const host = (() => { try { return new URL(env.endpoint).hostname.replace(/^\[|\]$/g, ''); } catch (e) { return ''; } })();
  if (!host) return { ok: false, code: 'SIGNAL_ENDPOINT_INVALID', detail: `unparseable endpoint ${JSON.stringify(env.endpoint)}` };
  if (!CGNAT_V4.test(host) && !/\.ts\.net\.?$/i.test(host)) {
    return { ok: false, code: 'SIGNAL_ENDPOINT_NOT_TAILNET', detail: `endpoint host ${JSON.stringify(host)} is not tailnet-scoped` };
  }
  if (expect.repo && env.repo !== expect.repo) return { ok: false, code: 'SIGNAL_FOREIGN_REPO', detail: `${env.repo} != ${expect.repo}` };
  if (expect.runId && Number(env.runId) !== Number(expect.runId)) return { ok: false, code: 'SIGNAL_STALE_RUN', detail: `run ${env.runId} != ${expect.runId}` };
  if (expect.attempt && Number(env.attempt) !== Number(expect.attempt)) return { ok: false, code: 'SIGNAL_STALE_ATTEMPT', detail: `attempt ${env.attempt} != ${expect.attempt}` };
  if (expect.appSha && env.appSha !== expect.appSha) return { ok: false, code: 'SIGNAL_SHA_MISMATCH', detail: `${env.appSha} != ${expect.appSha}` };
  const issued = Date.parse(env.issuedAt);
  const expires = Date.parse(env.expiresAt);
  if (!Number.isFinite(expires)) return { ok: false, code: 'SIGNAL_NO_EXPIRY', detail: 'expiresAt missing' };
  if (expires <= now) return { ok: false, code: 'SIGNAL_EXPIRED', detail: `expired at ${env.expiresAt}` };
  if (expires - now > MAX_TTL_MS) return { ok: false, code: 'SIGNAL_TTL_TOO_LONG', detail: `ttl ${Math.round((expires - now) / 60000)} min` };
  if (Number.isFinite(issued) && issued - now > CLOCK_SKEW_MS) return { ok: false, code: 'SIGNAL_FROM_FUTURE', detail: `issuedAt ${env.issuedAt}` };
  if (expect.keyId && env.enc.keyId !== expect.keyId) return { ok: false, code: 'SIGNAL_UNKNOWN_KEY', detail: `keyId ${env.enc.keyId} != ${expect.keyId}` };
  return { ok: true, host, expiresAt: new Date(expires).toISOString() };
}

function decryptKey(env, privateKeyPem) {
  try {
    const key = crypto.privateDecrypt(
      { key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(env.enc.ciphertext, 'base64')
    ).toString('utf8');
    if (!key) return { ok: false, code: 'SIGNAL_KEY_EMPTY' };
    return { ok: true, key };
  } catch (e) {
    return { ok: false, code: 'SIGNAL_UNDECRYPTABLE', detail: String(e.message || e).slice(0, 120) };
  }
}

function pickCheckRun(checkRuns) {
  const rows = (Array.isArray(checkRuns) ? checkRuns : []).filter(c => c && c.name === SIGNAL_NAME);
  if (!rows.length) return null;
  rows.sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')));
  return rows[0];
}

/**
 * Full read: trusted identity comes from the caller (origin run API).
 * @returns {ok, code, detail, envelope, key, checkRun, fingerprint}
 */
function resolveSignal(text, expect = {}, privateKeyPem) {
  const parsed = parseSignal(text);
  if (!parsed.ok) return parsed;
  const valid = validateSignal(parsed.envelope, expect);
  if (!valid.ok) return { ...valid, envelope: parsed.envelope };
  if (!privateKeyPem) return { ok: false, code: 'SIGNAL_NO_PRIVATE_KEY', detail: 'the lab signal private key is not configured' };
  const dec = decryptKey(parsed.envelope, privateKeyPem);
  if (!dec.ok) return dec;
  return {
    ok: true,
    envelope: { ...parsed.envelope, enc: { alg: parsed.envelope.enc.alg, keyId: parsed.envelope.enc.keyId } },
    key: dec.key,
    host: valid.host,
    expiresAt: valid.expiresAt
  };
}

module.exports = {
  SIGNAL_NAME, SIGNAL_PREFIX, MAX_TTL_MS,
  buildSignal, parseSignal, validateSignal, decryptKey, resolveSignal, pickCheckRun, keyFingerprint
};
