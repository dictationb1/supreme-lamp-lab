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
// TWO ON-THE-WIRE FORMATS ARE READ HERE, and they are NOT interchangeable:
//
//   1. `mc-signal/v1`  — the MERGED application publisher
//      (`supreme-lamp` scripts/live-signal-publisher.js, F200). It writes a
//      fenced JSON document into the check run's **output.text** (the human
//      Markdown goes to output.summary). The credential is sealed in
//      `credential.envelope` (also mirrored as `credentialEnvelope`) with
//      either
//        x25519-hkdf-sha256+aes-256-gcm  (epk/nonce/aadB64/ct/tag)
//        rsa-oaep-sha256+aes-256-gcm     (wrappedKey/nonce/aadB64/ct/tag)
//      and the AAD is the canonical identity
//      {schema, repository, runId(string), runAttempt(number), sha, keyId}
//      with SORTED keys. The signal carries `state` ("live" | "closed" |
//      "failed"), `publishedAt`, `expiresAt`, `heartbeatSec`,
//      `heartbeatMaxAgeSec`, `endpoint.primary` (an OBJECT, not a string) and
//      `ui.{sha,matchesRunSha}`.
//      Measured defect this reader fixes: the earlier lab reader looked only
//      at output.summary for the legacy text prefix, so a REAL application
//      signal was reported as SIGNAL_NOT_FOUND (and discovery fell through to
//      the plaintext log path, which cannot see a live run at all).
//
//   2. `MC-SIGNAL v1 <base64url>` — the lab's own older envelope, still used by
//      the CI self-validation harness and the regression suite. It stays
//      supported (read-only backwards compatibility) so nothing that used to
//      work stops working.
//
// Identity is ALWAYS re-derived from GitHub's run API by the caller, never
// taken from the signal's own words; this module only refuses on mismatch.

const crypto = require('crypto');

const SIGNAL_NAME = 'mission-control-live-signal';
const SIGNAL_PREFIX = 'MC-SIGNAL v1 ';
const APP_SCHEMA = 'mc-signal/v1';
const MAX_TTL_MS = 6 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 2 * 60 * 1000;
const DEFAULT_HEARTBEAT_MAX_AGE_SEC = 180;
const CGNAT_V4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/;
const APP_ALGS = ['x25519-hkdf-sha256+aes-256-gcm', 'rsa-oaep-sha256+aes-256-gcm'];

const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const fromB64 = s => Buffer.from(String(s).replace(/\s+/g, ''), 'base64');

function keyFingerprint(publicKeyPem) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// identity helpers shared by both formats
// ---------------------------------------------------------------------------
function tailnetHost(endpoint) {
  const raw = typeof endpoint === 'string' ? endpoint : '';
  if (!raw) return { ok: false, code: 'SIGNAL_ENDPOINT_INVALID', detail: 'no endpoint on the signal' };
  let u = null;
  try { u = new URL(raw); } catch (e) { return { ok: false, code: 'SIGNAL_ENDPOINT_INVALID', detail: `unparseable endpoint ${JSON.stringify(raw)}` }; }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!CGNAT_V4.test(host) && !/\.ts\.net\.?$/i.test(host)) {
    return { ok: false, code: 'SIGNAL_ENDPOINT_NOT_TAILNET', detail: `endpoint host ${JSON.stringify(host)} is not tailnet-scoped` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, code: 'SIGNAL_ENDPOINT_SCHEME', detail: `endpoint scheme ${u.protocol}` };
  }
  return {
    ok: true,
    host,
    url: `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/, ''),
    port: Number(u.port || (u.protocol === 'https:' ? 443 : 80))
  };
}

/** Canonical JSON (sorted keys, no whitespace) — the AAD contract. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/** The app publisher's canonicalIdentity() must be reproduced byte-for-byte. */
function appAad(identity) {
  return Buffer.from(stableStringify({
    schema: APP_SCHEMA,
    repository: String(identity.repository || ''),
    runId: String(identity.runId || ''),
    runAttempt: Number(identity.runAttempt || 0),
    sha: String(identity.sha || ''),
    keyId: String(identity.keyId || '')
  }), 'utf8');
}

/**
 * The app's `keyId` for a key, so a lab fingerprint can be compared with a
 * published envelope without either half leaving its repository:
 *   rsa:<sha256(SPKI DER) hex[0:16]>   x25519:<sha256(raw 32) hex[0:16]>
 */
function createKeyObjectSafe(spec) {
  const text = String(spec || '').trim();
  if (!text) return null;
  const norm = text.includes('\\n') ? text.replace(/\\n/g, '\n') : text;
  if (/-----BEGIN [A-Z ]*KEY-----/.test(norm)) {
    try { return crypto.createPrivateKey(norm); } catch (e) { /* public next */ }
    try { return crypto.createPublicKey(norm); } catch (e) { return null; }
  }
  try { return crypto.createPrivateKey({ key: fromB64(norm), format: 'der', type: 'pkcs8' }); } catch (e) { /* next */ }
  try { return crypto.createPublicKey({ key: fromB64(norm), format: 'der', type: 'spki' }); } catch (e) { return null; }
}

function appKeyId(keyLike) {
  const key = typeof keyLike === 'string' ? createKeyObjectSafe(keyLike) : keyLike;
  if (!key) return null;
  const type = key.type === 'private' ? key.asymmetricKeyType : key.asymmetricKeyType;
  const publicKey = key.type === 'private' ? crypto.createPublicKey(key) : key;
  const der = publicKey.export({ format: 'der', type: 'spki' });
  if (type === 'rsa') return `rsa:${crypto.createHash('sha256').update(der).digest('hex').slice(0, 16)}`;
  if (type === 'x25519') return `x25519:${crypto.createHash('sha256').update(der.subarray(-32)).digest('hex').slice(0, 16)}`;
  return null;
}

function parsePrivateKey(spec) {
  const text = String(spec || '').trim();
  if (!text) return null;
  const norm = text.includes('\\n') ? text.replace(/\\n/g, '\n') : text;
  try { return crypto.createPrivateKey(norm); } catch (e) { /* next */ }
  try { return crypto.createPrivateKey({ key: fromB64(norm), format: 'der', type: 'pkcs8' }); } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// format 2 (legacy, lab self-validation): MC-SIGNAL v1 <base64url>
// ---------------------------------------------------------------------------
/**
 * Build the legacy signal text a lab-owned publisher writes into
 * `output.summary`. `payload.key` is encrypted here and never leaves this
 * function in clear. (The APPLICATION does not use this format; see
 * `resolveCheckRun` for what it actually publishes.)
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
  const ep = tailnetHost(env.endpoint);
  if (!ep.ok) return ep;
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
  return { ok: true, host: ep.host, endpoint: ep, expiresAt: new Date(expires).toISOString() };
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

// ---------------------------------------------------------------------------
// format 1 (the MERGED application publisher): mc-signal/v1 fenced JSON
// ---------------------------------------------------------------------------
/** Pull the fenced ```json block (output.text) out of a check run's text. */
function extractFencedJson(text) {
  const raw = String(text || '');
  const fences = raw.match(/```(?:json|JSON)?\s*\n([\s\S]*?)\n```/g) || [];
  for (const block of fences) {
    const body = block.replace(/^```[a-zA-Z]*\s*\n/, '').replace(/\n```$/, '');
    try {
      const obj = JSON.parse(body);
      if (obj && typeof obj === 'object') return { ok: true, json: obj };
    } catch (e) { /* try the next block */ }
  }
  // A bare JSON body is accepted too (defensive: an operator may have pasted it).
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try { return { ok: true, json: JSON.parse(trimmed) }; } catch (e) { /* fall through */ }
  }
  return { ok: false };
}

function parseAppSignal(text) {
  const got = extractFencedJson(text);
  if (!got.ok) return { ok: false, code: 'APP_SIGNAL_NOT_FOUND', detail: 'no fenced JSON payload in the check-run output text' };
  const s = got.json;
  if (String(s.schema || '') !== APP_SCHEMA) {
    return { ok: false, code: 'APP_SIGNAL_SCHEMA', detail: `schema ${JSON.stringify(s.schema)} != ${APP_SCHEMA}` };
  }
  if (!s.credential || !s.credential.envelope) {
    // A CLOSED signal legitimately carries no envelope; report that as its own
    // state instead of calling it malformed.
    const st = String(s.state || '');
    if (st && st !== 'live') return { ok: false, code: 'APP_SIGNAL_NOT_LIVE', detail: `state=${st}${s.reason ? ` (${s.reason})` : ''}; a closed signal carries no credential` };
    return { ok: false, code: 'APP_SIGNAL_INCOMPLETE', detail: 'credential.envelope missing' };
  }
  return { ok: true, signal: s };
}

/** Normalize the app payload into the shape the rest of the lab consumes. */
function normalizeAppSignal(s) {
  const endpointPrimary = s.endpoint && (s.endpoint.primary || s.endpoint.serve || s.endpoint.funnel) || '';
  return {
    v: 1,
    repo: String(s.repository || ''),
    runId: Number(s.runId),
    attempt: Number(s.runAttempt || 1),
    appSha: String(s.sha || ''),
    uiBuild: `ui-dist-${String(s.sha || '')}`,
    uiSha: s.ui && s.ui.sha ? String(s.ui.sha) : null,
    uiMatchesRunSha: Boolean(s.ui && s.ui.matchesRunSha),
    endpoint: String(endpointPrimary),
    endpointTransport: s.endpoint && s.endpoint.transport ? String(s.endpoint.transport) : null,
    issuedAt: s.publishedAt || s.startedAt || '',
    expiresAt: s.expiresAt || '',
    state: String(s.state || ''),
    heartbeatSec: Number(s.heartbeatSec || 60),
    heartbeatMaxAgeSec: Number(s.heartbeatMaxAgeSec || DEFAULT_HEARTBEAT_MAX_AGE_SEC),
    checkId: s.checkId || null,
    publisherVersion: s.publisher && s.publisher.version ? String(s.publisher.version) : null,
    raw: s
  };
}

/**
 * Validate the app signal against GitHub's own run metadata AND its own
 * liveness rules (state / heartbeat / expiry), plus key-id identity.
 */
function validateAppSignal(sig, expect = {}) {
  const now = expect.now || Date.now();
  if (sig.state !== 'live') {
    return { ok: false, code: 'APP_SIGNAL_NOT_LIVE', detail: `state=${sig.state || 'missing'}${sig.raw && sig.raw.reason ? ` (${sig.raw.reason})` : ''}` };
  }
  const ep = tailnetHost(sig.endpoint);
  if (!ep.ok) return ep;
  if (expect.repo && sig.repo !== expect.repo) return { ok: false, code: 'SIGNAL_FOREIGN_REPO', detail: `${sig.repo} != ${expect.repo}` };
  if (expect.runId && Number(sig.runId) !== Number(expect.runId)) return { ok: false, code: 'SIGNAL_STALE_RUN', detail: `run ${sig.runId} != ${expect.runId}` };
  if (expect.attempt && Number(sig.attempt) !== Number(expect.attempt)) return { ok: false, code: 'SIGNAL_STALE_ATTEMPT', detail: `attempt ${sig.attempt} != ${expect.attempt}` };
  if (expect.appSha && sig.appSha && sig.appSha !== expect.appSha) return { ok: false, code: 'SIGNAL_SHA_MISMATCH', detail: `${sig.appSha} != ${expect.appSha}` };
  if (!sig.appSha) return { ok: false, code: 'APP_SIGNAL_NO_SHA', detail: 'the signal carries no application sha' };

  const published = Date.parse(sig.issuedAt);
  const expires = Date.parse(sig.expiresAt);
  if (!Number.isFinite(published)) return { ok: false, code: 'SIGNAL_NO_ISSUE_TIME', detail: 'publishedAt missing' };
  if (!Number.isFinite(expires)) return { ok: false, code: 'SIGNAL_NO_EXPIRY', detail: 'expiresAt missing' };
  if (published - now > CLOCK_SKEW_MS) return { ok: false, code: 'SIGNAL_FROM_FUTURE', detail: `publishedAt ${sig.issuedAt}` };
  const ageMs = now - published;
  if (ageMs > sig.heartbeatMaxAgeSec * 1000) {
    // The publisher refreshes every heartbeatSec; a stale one means the process
    // died (or the run is gone) and the credential must not be used.
    return { ok: false, code: 'APP_SIGNAL_STALE', detail: `heartbeat is ${Math.round(ageMs / 1000)}s old (max ${sig.heartbeatMaxAgeSec}s)` };
  }
  if (expires <= now) return { ok: false, code: 'SIGNAL_EXPIRED', detail: `expired at ${sig.expiresAt}` };
  if (expires - now > MAX_TTL_MS) return { ok: false, code: 'SIGNAL_TTL_TOO_LONG', detail: `ttl ${Math.round((expires - now) / 60000)} min` };

  const env = sig.raw.credential.envelope;
  if (!APP_ALGS.includes(String(env.alg))) {
    return { ok: false, code: 'APP_SIGNAL_UNSUPPORTED_ALG', detail: `envelope alg ${JSON.stringify(env.alg)}` };
  }
  if (expect.keyId && String(env.keyId) !== String(expect.keyId)) {
    return { ok: false, code: 'SIGNAL_UNKNOWN_KEY', detail: `keyId ${env.keyId} != ${expect.keyId}` };
  }
  if (env.aadB64) {
    // Prove the envelope is bound to THIS identity before touching the ciphertext.
    const expected = appAad({
      repository: sig.raw.repository, runId: sig.raw.runId, runAttempt: sig.raw.runAttempt,
      sha: sig.raw.sha, keyId: env.keyId || sig.raw.keyId
    });
    const publishedAad = fromB64(env.aadB64);
    if (publishedAad.length !== expected.length || !crypto.timingSafeEqual(publishedAad, expected)) {
      return { ok: false, code: 'APP_SIGNAL_AAD_MISMATCH', detail: 'the envelope AAD is not the canonical identity of this run' };
    }
  }
  return { ok: true, host: ep.host, endpoint: ep, expiresAt: new Date(expires).toISOString(), ageMs };
}

/** Decrypt an app envelope (x25519-hkdf or rsa-oaep) with the lab private key. */
function decryptAppCredential(envelope, privateKey, signalRaw) {
  const priv = typeof privateKey === 'string' ? parsePrivateKey(privateKey) : privateKey;
  if (!priv) return { ok: false, code: 'SIGNAL_NO_PRIVATE_KEY', detail: 'the lab signal private key is missing or does not parse' };
  if (!envelope || envelope.v !== 1) return { ok: false, code: 'APP_SIGNAL_ENVELOPE_VERSION', detail: `envelope.v ${envelope && envelope.v}` };
  const aadBytes = envelope.aadB64 ? fromB64(envelope.aadB64) : appAad(signalRaw || {});
  const nonce = fromB64(envelope.nonce);
  const tag = fromB64(envelope.tag);
  const ct = fromB64(envelope.ct);
  let key = null;
  try {
    if (envelope.alg === 'x25519-hkdf-sha256+aes-256-gcm') {
      if (priv.asymmetricKeyType !== 'x25519') {
        return { ok: false, code: 'SIGNAL_KEY_ALG_MISMATCH', detail: `the envelope needs an x25519 private key; configured key is ${priv.asymmetricKeyType}` };
      }
      const peerRaw = fromB64(envelope.epk);
      const peer = crypto.createPublicKey({
        key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), peerRaw]),
        format: 'der', type: 'spki'
      });
      const shared = crypto.diffieHellman({ privateKey: priv, publicKey: peer });
      const selfRaw = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32);
      key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([peerRaw, selfRaw]),
        Buffer.from(`${APP_SCHEMA} x25519-hkdf-sha256+aes-256-gcm`), 32));
    } else if (envelope.alg === 'rsa-oaep-sha256+aes-256-gcm') {
      if (priv.asymmetricKeyType !== 'rsa') {
        return { ok: false, code: 'SIGNAL_KEY_ALG_MISMATCH', detail: `the envelope needs an RSA private key; configured key is ${priv.asymmetricKeyType}` };
      }
      key = crypto.privateDecrypt(
        { key: priv, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        fromB64(envelope.wrappedKey)
      );
    } else {
      return { ok: false, code: 'APP_SIGNAL_UNSUPPORTED_ALG', detail: `envelope alg ${JSON.stringify(envelope.alg)}` };
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(aadBytes);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    let parsed = null;
    try { parsed = JSON.parse(plaintext); } catch (e) { parsed = null; }
    if (!parsed || !parsed.dashToken) {
      return { ok: false, code: 'APP_SIGNAL_CREDENTIAL_SHAPE', detail: 'decrypted payload has no dashToken' };
    }
    // The credential's own binding fields, when present, must agree too.
    const want = signalRaw || {};
    for (const [k, v] of Object.entries({ repository: want.repository, runId: want.runId, runAttempt: want.runAttempt, sha: want.sha })) {
      if (parsed[k] !== undefined && parsed[k] !== null && String(parsed[k]) !== String(v)) {
        return { ok: false, code: 'APP_SIGNAL_CREDENTIAL_BINDING', detail: `credential.${k} ${JSON.stringify(parsed[k])} != signal ${JSON.stringify(v)}` };
      }
    }
    return { ok: true, key: String(parsed.dashToken), credential: { queryParam: parsed.dashTokenQueryParam || 'key', issuedAt: parsed.issuedAt || null } };
  } catch (e) {
    return { ok: false, code: 'APP_SIGNAL_UNDECRYPTABLE', detail: String(e.message || e).slice(0, 160) };
  }
}

/** Full read of the app format: parse -> validate -> decrypt (in memory). */
function resolveAppSignal(text, expect = {}, privateKeyPem) {
  const parsed = parseAppSignal(text);
  if (!parsed.ok) return parsed;
  const sig = normalizeAppSignal(parsed.signal);
  const valid = validateAppSignal(sig, expect);
  if (!valid.ok) return { ...valid, signal: parsed.signal, format: APP_SCHEMA };
  if (!privateKeyPem) return { ok: false, code: 'SIGNAL_NO_PRIVATE_KEY', detail: 'the lab signal private key is not configured', format: APP_SCHEMA };
  const dec = decryptAppCredential(parsed.signal.credential.envelope, privateKeyPem, parsed.signal);
  if (!dec.ok) return { ...dec, format: APP_SCHEMA };
  return {
    ok: true,
    format: APP_SCHEMA,
    envelope: {
      v: 1, repo: sig.repo, runId: sig.runId, attempt: sig.attempt, appSha: sig.appSha,
      uiBuild: sig.uiBuild, endpoint: valid.endpoint.url,
      issuedAt: sig.issuedAt, expiresAt: valid.expiresAt,
      enc: { alg: parsed.signal.credential.envelope.alg, keyId: parsed.signal.credential.envelope.keyId },
      state: sig.state, uiSha: sig.uiSha, uiMatchesRunSha: sig.uiMatchesRunSha,
      heartbeatSec: sig.heartbeatSec, heartbeatMaxAgeSec: sig.heartbeatMaxAgeSec
    },
    key: dec.key,
    credentialQueryParam: dec.credential.queryParam,
    host: valid.host,
    endpoint: valid.endpoint,
    expiresAt: valid.expiresAt,
    heartbeatAgeMs: valid.ageMs,
    signal: parsed.signal
  };
}

/**
 * Full read of the LEGACY format. `text` may be the summary and/or the text.
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
    format: 'MC-SIGNAL v1',
    envelope: { ...parsed.envelope, enc: { alg: parsed.envelope.enc.alg, keyId: parsed.envelope.enc.keyId } },
    key: dec.key,
    host: valid.host,
    endpoint: valid.endpoint,
    expiresAt: valid.expiresAt
  };
}

// ---------------------------------------------------------------------------
// check-run selection
// ---------------------------------------------------------------------------
function pickCheckRun(checkRuns) {
  const rows = (Array.isArray(checkRuns) ? checkRuns : []).filter(c => c && c.name === SIGNAL_NAME);
  if (!rows.length) return null;
  rows.sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')));
  return rows[0];
}

/**
 * Resolve the signal from a check run, trying the MERGED APPLICATION format
 * first (output.text fenced JSON) and the lab's legacy prefix second.
 * Returns the same shape as resolveSignal plus `format` and `attempts[]`, so a
 * failure names every format it tried instead of a single misleading code.
 */
function resolveCheckRun(checkRun, expect = {}, privateKeyPem) {
  if (!checkRun) return { ok: false, code: 'SIGNAL_LIST_EMPTY', detail: 'no mission-control-live-signal check run exists for this commit' };
  const out = checkRun.output || {};
  const text = String(out.text || '');
  const summary = String(out.summary || '');
  const attempts = [];
  // 1. app format from output.text (also accept it in summary, defensively)
  for (const [source, body] of [['output.text', text], ['output.summary', summary]]) {
    if (!body) continue;
    const app = resolveAppSignal(body, expect, privateKeyPem);
    attempts.push({ format: APP_SCHEMA, source, code: app.ok ? 'OK' : app.code, detail: app.detail || null });
    if (app.ok) return { ...app, checkRun: { id: checkRun.id, status: checkRun.status, startedAt: checkRun.started_at || null }, attempts };
    if (app.code && !/NOT_FOUND|SCHEMA/.test(app.code) && app.code !== 'APP_SIGNAL_NOT_FOUND') {
      // The payload WAS the app schema and it was refused on identity /
      // liveness / crypto. Do not silently fall through to the legacy reader:
      // that is exactly how a stale or forged signal gets accepted.
      return { ...app, checkRun: { id: checkRun.id, status: checkRun.status, startedAt: checkRun.started_at || null }, attempts };
    }
  }
  // 2. legacy format, whether in the summary or the text. The keyId expectation
  // belongs to the APP envelope (rsa:/x25519: short fingerprint); the legacy
  // envelope uses the lab's 32-hex fingerprint, so it is deliberately not
  // handed to that reader.
  const legacyExpect = { ...expect };
  delete legacyExpect.keyId;
  const legacy = resolveSignal(`${summary}\n${text}`, legacyExpect, privateKeyPem);
  attempts.push({ format: 'MC-SIGNAL v1', source: 'summary+text', code: legacy.ok ? 'OK' : legacy.code, detail: legacy.detail || null });
  if (legacy.ok) return { ...legacy, checkRun: { id: checkRun.id, status: checkRun.status, startedAt: checkRun.started_at || null }, attempts };
  // The app payload WAS present and was refused on identity / liveness / crypto:
  // report that refusal, never the legacy reader's "not found".
  const appFailure = attempts.find(a => a.format === APP_SCHEMA && a.code !== 'APP_SIGNAL_NOT_FOUND' && a.code !== 'APP_SIGNAL_SCHEMA');
  const code = appFailure ? appFailure.code : legacy.code;
  const detail = appFailure ? appFailure.detail : legacy.detail;
  return { ok: false, code, detail, attempts, checkRun: { id: checkRun.id, status: checkRun.status, startedAt: checkRun.started_at || null } };
}

/**
 * Try every signal check run for a commit (newest first) and stop at the first
 * one that resolves. Duplicate / superseded / closed checks therefore cannot
 * shadow a live one, and a run re-run at a newer attempt naturally wins.
 */
function resolveAnyCheckRun(checkRuns, expect = {}, privateKeyPem) {
  const rows = (Array.isArray(checkRuns) ? checkRuns : []).filter(c => c && c.name === SIGNAL_NAME);
  if (!rows.length) return { ok: false, code: 'SIGNAL_ABSENT', detail: 'the commit has no mission-control-live-signal check run' };
  rows.sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')));
  const tried = [];
  for (const row of rows.slice(0, 8)) {
    const r = resolveCheckRun(row, expect, privateKeyPem);
    tried.push({ checkId: row.id, status: row.status, startedAt: row.started_at || null, code: r.ok ? 'OK' : r.code });
    if (r.ok) return { ...r, tried };
  }
  const first = resolveCheckRun(rows[0], expect, privateKeyPem);
  return { ...first, tried };
}

module.exports = {
  SIGNAL_NAME, SIGNAL_PREFIX, APP_SCHEMA, APP_ALGS, MAX_TTL_MS,
  buildSignal, parseSignal, validateSignal, decryptKey, resolveSignal, pickCheckRun, keyFingerprint,
  // application-format reader (the merged publisher)
  parseAppSignal, normalizeAppSignal, validateAppSignal, decryptAppCredential,
  resolveAppSignal, resolveCheckRun, resolveAnyCheckRun,
  appKeyId, parsePrivateKey, stableStringify, appAad, tailnetHost, extractFencedJson
};
