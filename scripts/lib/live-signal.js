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


// ---------------------------------------------------------------------------
// APPLICATION-FORMAT SIGNAL (`mc-signal/v1`)
// ---------------------------------------------------------------------------
// The application repository's merged publisher (commit 10cd512a, deployed by
// run 39952421153) does NOT emit the base64url `MC-SIGNAL v1` token above. It
// publishes one fenced JSON object in the check run's **output text**
// (`schema: "mc-signal/v1"`, human summary in `output.summary`) and seals the
// credential with a HYBRID envelope:
//
//   rsa-oaep-sha256+aes-256-gcm :  RSA-OAEP(SHA-256) wraps a fresh CEK,
//                                  AES-256-GCM seals the plaintext.
//   x25519-hkdf-sha256+aes-256-gcm :  named below, refused by this reader
//                                  (the lab key is RSA; a refusal must be named,
//                                  never a silent "undecryptable").
//
// The envelope's AAD is published verbatim (`aadB64`) and must equal the
// run identity; every value is compared against the RUN API expectation, never
// against another field of the same document.
//
// Measured consequence of NOT supporting this: run 39952421153 published a
// correct, live signal at 12:31:37Z and the lab reader answered
// SIGNAL_NOT_FOUND (read-only check on the real check run, 2026-10-23).

const APP_SCHEMA = 'mc-signal/v1';
const APP_ALG_RSA = 'rsa-oaep-sha256+aes-256-gcm';
const APP_ALG_X25519 = 'x25519-hkdf-sha256+aes-256-gcm';

/** Pull the fenced JSON object out of a check-run output text. */
function extractFencedJson(text) {
  const raw = String(text || '');
  const fence = raw.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : (/^\s*\{/.test(raw) ? raw : '');
  if (!candidate) return null;
  try { return JSON.parse(candidate); } catch (e) { return null; }
}

/** Parse the application-format signal from a check run's output text. */
function parseAppSignal(text) {
  const sig = extractFencedJson(text);
  if (!sig) return { ok: false, code: 'APP_SIGNAL_NOT_FOUND', detail: 'no fenced JSON block in the check-run output text' };
  if (sig.schema !== APP_SCHEMA) return { ok: false, code: 'APP_SIGNAL_SCHEMA', detail: `schema ${JSON.stringify(sig.schema)} != ${APP_SCHEMA}` };
  const env = sig.credential && sig.credential.envelope;
  if (!env || !env.ct || !env.tag || !env.nonce) return { ok: false, code: 'APP_SIGNAL_INCOMPLETE', detail: 'credential.envelope is missing ct/nonce/tag' };
  return { ok: true, signal: sig };
}

/**
 * Identity + freshness validation. `expect` is built from the GitHub run API.
 * Endpoint must be tailnet-scoped, TTL is hard-capped at 6 h (same rule as the
 * base64 format), and a `state` other than `live` is refused by name.
 */
function validateAppSignal(sig, expect = {}) {
  const now = expect.now || Date.now();
  const endpoint = String((sig.endpoint && sig.endpoint.primary) || '');
  let host = '';
  try { host = new URL(endpoint).hostname.replace(/^\[|\]$/g, ''); } catch (e) { host = ''; }
  if (!host) return { ok: false, code: 'APP_SIGNAL_ENDPOINT_INVALID', detail: `unparseable endpoint ${JSON.stringify(endpoint)}` };
  if (!CGNAT_V4.test(host) && !/\.ts\.net\.?$/i.test(host)) {
    return { ok: false, code: 'APP_SIGNAL_ENDPOINT_NOT_TAILNET', detail: `endpoint host ${JSON.stringify(host)} is not tailnet-scoped` };
  }
  if (String(sig.state || '') !== 'live') return { ok: false, code: 'APP_SIGNAL_NOT_LIVE', detail: `state ${JSON.stringify(sig.state)}` };
  if (expect.repo && String(sig.repository) !== String(expect.repo)) return { ok: false, code: 'APP_SIGNAL_FOREIGN_REPO', detail: `${sig.repository} != ${expect.repo}` };
  if (expect.runId && String(sig.runId) !== String(expect.runId)) return { ok: false, code: 'APP_SIGNAL_STALE_RUN', detail: `run ${sig.runId} != ${expect.runId}` };
  if (expect.attempt && Number(sig.runAttempt) !== Number(expect.attempt)) return { ok: false, code: 'APP_SIGNAL_STALE_ATTEMPT', detail: `attempt ${sig.runAttempt} != ${expect.attempt}` };
  if (expect.appSha && String(sig.sha) !== String(expect.appSha)) return { ok: false, code: 'APP_SIGNAL_SHA_MISMATCH', detail: `${sig.sha} != ${expect.appSha}` };
  const issued = Date.parse(sig.publishedAt || sig.startedAt || '');
  const expires = Date.parse(sig.expiresAt || '');
  if (!Number.isFinite(expires)) return { ok: false, code: 'APP_SIGNAL_NO_EXPIRY', detail: 'expiresAt missing' };
  if (expires <= now) return { ok: false, code: 'APP_SIGNAL_EXPIRED', detail: `expired at ${sig.expiresAt}` };
  if (expires - now > MAX_TTL_MS) return { ok: false, code: 'APP_SIGNAL_TTL_TOO_LONG', detail: `ttl ${Math.round((expires - now) / 60000)} min` };
  if (Number.isFinite(issued) && issued - now > CLOCK_SKEW_MS) return { ok: false, code: 'APP_SIGNAL_FROM_FUTURE', detail: `publishedAt ${sig.publishedAt}` };
  if (expect.keyId && String((sig.credential.envelope || {}).keyId) !== String(expect.keyId)) {
    return { ok: false, code: 'APP_SIGNAL_UNKNOWN_KEY', detail: `keyId ${(sig.credential.envelope || {}).keyId} != ${expect.keyId}` };
  }
  return { ok: true, host, endpoint, expiresAt: new Date(expires).toISOString() };
}

/**
 * The published AAD is the identity the ciphertext is bound to. It is NOT
 * trusted as evidence of identity on its own (the run API is), but a mismatch
 * between the AAD and the published identity means the credential was sealed
 * for a different run/attempt/sha and must never be used.
 */
function verifyAppAad(sig) {
  const env = sig.credential && sig.credential.envelope;
  if (!env || !env.aadB64) return { ok: false, code: 'APP_SIGNAL_AAD_MISSING', detail: 'envelope.aadB64 missing' };
  let aad;
  try { aad = JSON.parse(Buffer.from(String(env.aadB64), 'base64').toString('utf8')); }
  catch (e) { return { ok: false, code: 'APP_SIGNAL_AAD_MALFORMED', detail: String(e.message || e).slice(0, 120) }; }
  const want = {
    schema: APP_SCHEMA,
    repository: String(sig.repository || ''),
    runId: String(sig.runId || ''),
    runAttempt: Number(sig.runAttempt || 0),
    sha: String(sig.sha || ''),
    keyId: String(env.keyId || '')
  };
  for (const k of Object.keys(want)) {
    if (aad[k] !== want[k]) return { ok: false, code: 'APP_SIGNAL_AAD_MISMATCH', detail: `${k}: ${JSON.stringify(aad[k])} != ${JSON.stringify(want[k])}` };
  }
  return { ok: true, aad };
}

/** Decrypt the hybrid envelope. Returns the plaintext credential (memory only). */
function openAppCredential(env, privateKeyPem) {
  if (!privateKeyPem) return { ok: false, code: 'SIGNAL_NO_PRIVATE_KEY', detail: 'the lab signal private key is not configured' };
  if (!env || env.v !== 1) return { ok: false, code: 'APP_SIGNAL_ENVELOPE_VERSION', detail: `envelope.v ${env && env.v}` };
  if (env.alg === APP_ALG_X25519) {
    return { ok: false, code: 'APP_SIGNAL_UNSUPPORTED_ALG', detail: 'the publisher sealed to an x25519 key; this reader holds an RSA lab key' };
  }
  if (env.alg !== APP_ALG_RSA) return { ok: false, code: 'APP_SIGNAL_UNKNOWN_ALG', detail: `alg ${JSON.stringify(env.alg)}` };
  try {
    const cek = crypto.privateDecrypt(
      { key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(String(env.wrappedKey || ''), 'base64')
    );
    const decipher = crypto.createDecipheriv('aes-256-gcm', cek, Buffer.from(String(env.nonce), 'base64'));
    decipher.setAAD(Buffer.from(String(env.aadB64 || ''), 'base64'));
    decipher.setAuthTag(Buffer.from(String(env.tag), 'base64'));
    const out = Buffer.concat([decipher.update(Buffer.from(String(env.ct), 'base64')), decipher.final()]).toString('utf8');
    if (!out) return { ok: false, code: 'APP_SIGNAL_KEY_EMPTY' };
    return { ok: true, key: out.replace(/\s+$/, '') };
  } catch (e) {
    return { ok: false, code: 'APP_SIGNAL_UNDECRYPTABLE', detail: String(e.message || e).slice(0, 140) };
  }
}

/**
 * Full application-format read. Same contract as `resolveSignal`:
 * the trusted identity is the caller's (run API), the plaintext never leaves
 * this process, and every failure is a named code.
 */
function resolveAppSignal(text, expect = {}, privateKeyPem) {
  const parsed = parseAppSignal(text);
  if (!parsed.ok) return parsed;
  const sig = parsed.signal;
  const valid = validateAppSignal(sig, expect);
  if (!valid.ok) return { ...valid, format: APP_SCHEMA };
  const aad = verifyAppAad(sig);
  if (!aad.ok) return { ...aad, format: APP_SCHEMA };
  const opened = openAppCredential(sig.credential.envelope, privateKeyPem);
  if (!opened.ok) return { ...opened, format: APP_SCHEMA };
  return {
    ok: true,
    format: APP_SCHEMA,
    envelope: {
      v: 1,
      repo: String(sig.repository),
      runId: Number(sig.runId),
      attempt: Number(sig.runAttempt),
      appSha: String(sig.sha),
      uiBuild: sig.ui && sig.ui.sha ? `ui-dist-${sig.ui.sha}` : null,
      endpoint: valid.endpoint,
      issuedAt: sig.publishedAt || sig.startedAt || null,
      expiresAt: valid.expiresAt,
      enc: { alg: sig.credential.envelope.alg, keyId: sig.credential.envelope.keyId }
    },
    key: opened.key,
    host: valid.host,
    expiresAt: valid.expiresAt,
    aad: aad.aad
  };
}

/**
 * Accept EITHER published format. The base64 format is tried first so its
 * refusals stay authoritative when it is present; a genuinely absent marker
 * falls through to the application format instead of reporting NOT_FOUND for a
 * signal that is demonstrably on the check run.
 */
function resolveAnySignal({ summary, text } = {}, expect = {}, privateKeyPem) {
  const lab = resolveSignal(summary, expect, privateKeyPem);
  if (lab.ok) return { ...lab, format: 'MC-SIGNAL v1' };
  if (!['SIGNAL_NOT_FOUND', 'SIGNAL_MALFORMED'].includes(lab.code)) return lab;
  const app = resolveAppSignal(text || summary, expect, privateKeyPem);
  if (app.ok) return app;
  if (['APP_SIGNAL_NOT_FOUND', 'APP_SIGNAL_SCHEMA'].includes(app.code)) {
    return { ...lab, detail: `${lab.detail}; application format: ${app.detail}`, appCode: app.code };
  }
  return app;
}

module.exports = {
  SIGNAL_NAME, SIGNAL_PREFIX, MAX_TTL_MS, APP_SCHEMA, APP_ALG_RSA, APP_ALG_X25519,
  buildSignal, parseSignal, validateSignal, decryptKey, resolveSignal, pickCheckRun, keyFingerprint,
  parseAppSignal, validateAppSignal, verifyAppAad, openAppCredential, resolveAppSignal, resolveAnySignal
};
