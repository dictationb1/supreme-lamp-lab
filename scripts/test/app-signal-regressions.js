'use strict';
// Regressions for the APPLICATION-format signal (`mc-signal/v1`).
//
// Measured defect this closes (2026-10-23, run 39952421153): the application's
// merged publisher publishes a fenced JSON document in the check run's OUTPUT
// TEXT with a hybrid RSA-OAEP + AES-256-GCM envelope, while the lab reader only
// looked for a base64url `MC-SIGNAL v1` token in the SUMMARY. A correct, live
// signal was therefore reported SIGNAL_NOT_FOUND and the client verification
// could never attach.
//
// The sealer below is an independent implementation of the publisher's
// documented algorithm (stable-stringified AAD, RSA-OAEP-SHA256-wrapped CEK,
// AES-256-GCM with the published AAD). It must interoperate with the reader
// without importing it.

module.exports = async function register({ test, assert, tmpRoot }) {
  const crypto = require('crypto');
  const ls = require('../lib/live-signal');
  const { auditSignalBinding } = require('../lib/signal-binding');

  const SHA = '24ddaa9904c92dbbba39e3cc7aba458769e6bbe4';
  const REPO = 'dictationb1/supreme-lamp';
  const RUN_ID = '39952421153';
  const NOW = Date.parse('2026-10-23T12:40:00Z');

  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
  const pubPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const otherPair = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
  const otherPrivPem = otherPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  const b64 = b => Buffer.from(b).toString('base64');
  function stable(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    const k = Object.keys(v).sort();
    return '{' + k.map(x => JSON.stringify(x) + ':' + stable(v[x])).join(',') + '}';
  }

  let lastCredential = null;
  function seal({ plaintext = null, overrides = {}, aadOverrides = {}, credential = null } = {}) {
    const dashToken = 'dash-token-' + crypto.randomBytes(6).toString('hex');
    lastCredential = credential || {
      dashTokenQueryParam: 'key', dashToken, issuedAt: new Date().toISOString(),
      repository: REPO, runId: RUN_ID, runAttempt: 1, sha: SHA
    };
    if (plaintext === null) plaintext = JSON.stringify(lastCredential);
    const keyId = 'rsa:' + crypto.createHash('sha256').update(pubPem).digest('hex').slice(0, 16);
    const identity = {
      schema: 'mc-signal/v1', repository: REPO, runId: RUN_ID, runAttempt: 1, sha: SHA, keyId,
      ...aadOverrides
    };
    const aad = Buffer.from(stable(identity), 'utf8');
    const cek = crypto.randomBytes(32);
    const wrappedKey = crypto.publicEncrypt({ key: pubPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, cek);
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', cek, nonce);
    cipher.setAAD(aad);
    const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
    const tag = cipher.getAuthTag();
    const signal = {
      schema: 'mc-signal/v1',
      state: 'live',
      repository: REPO,
      runId: RUN_ID,
      runAttempt: 1,
      sha: SHA,
      ui: { sha: SHA, stamped: true, matchesRunSha: true },
      endpoint: { primary: 'http://100.87.91.3:7331', transport: 'tailnet-ip' },
      publishedAt: new Date(NOW - 60000).toISOString(),
      expiresAt: new Date(NOW + 5 * 3600 * 1000).toISOString(),
      keyId,
      credential: {
        kind: 'dash-token',
        envelope: { v: 1, alg: 'rsa-oaep-sha256+aes-256-gcm', keyId, wrappedKey: b64(wrappedKey), nonce: b64(nonce), aadB64: b64(aad), ct: b64(ct), tag: b64(tag) }
      },
      ...overrides
    };
    const text = 'summary text\n\n```json\n' + JSON.stringify(signal, null, 2) + '\n```\n';
    return { signal, text, plaintext, credential: lastCredential };
  }

  const expect = { repo: REPO, runId: RUN_ID, attempt: 1, appSha: SHA, now: NOW };

  await test('app signal: the published mc-signal/v1 envelope parses, validates, binds its AAD and decrypts', () => {
    const { text, credential } = seal();
    const r = ls.resolveAppSignal(text, expect, privPem);
    assert.strictEqual(r.ok, true, r.code + ' ' + r.detail);
    assert.strictEqual(r.format, 'mc-signal/v1');
    // The app seals a JSON credential object; the resolved key is the TOKEN,
    // never the envelope blob (which also carries a moving issuedAt).
    assert.strictEqual(r.key, credential.dashToken);
    assert.strictEqual(r.credentialMeta.queryParam, 'key');
    assert.strictEqual(r.envelope.appSha, SHA);
    assert.strictEqual(r.envelope.attempt, 1);
    assert.strictEqual(r.aad.runId, RUN_ID);
  });

  await test('app signal: another attempt / sha / run is refused by name before any decryption', () => {
    const { text } = seal();
    assert.strictEqual(ls.resolveAppSignal(text, { ...expect, attempt: 2 }, privPem).code, 'APP_SIGNAL_STALE_ATTEMPT');
    assert.strictEqual(ls.resolveAppSignal(text, { ...expect, appSha: 'f'.repeat(40) }, privPem).code, 'APP_SIGNAL_SHA_MISMATCH');
    assert.strictEqual(ls.resolveAppSignal(text, { ...expect, runId: '39952421154' }, privPem).code, 'APP_SIGNAL_STALE_RUN');
  });

  await test('app signal: AAD that names a different repository is refused (the credential is sealed to another identity)', () => {
    const { text } = seal({ aadOverrides: { repository: 'attacker/other' } });
    const r = ls.resolveAppSignal(text, expect, privPem);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'APP_SIGNAL_AAD_MISMATCH');
  });

  await test('app signal: a non-tailnet endpoint is refused even when the identity and AAD match', () => {
    const { text } = seal({ overrides: { endpoint: { primary: 'http://203.0.113.5:7331' } } });
    assert.strictEqual(ls.resolveAppSignal(text, expect, privPem).code, 'APP_SIGNAL_ENDPOINT_NOT_TAILNET');
  });

  await test('app signal: a closed state, an expired envelope and a >6h TTL are refused by name', () => {
    assert.strictEqual(ls.resolveAppSignal(seal({ overrides: { state: 'closed' } }).text, expect, privPem).code, 'APP_SIGNAL_NOT_LIVE');
    assert.strictEqual(ls.resolveAppSignal(seal({ overrides: { expiresAt: new Date(NOW - 1000).toISOString() } }).text, expect, privPem).code, 'APP_SIGNAL_EXPIRED');
    assert.strictEqual(ls.resolveAppSignal(seal({ overrides: { expiresAt: new Date(NOW + 7 * 3600 * 1000).toISOString() } }).text, expect, privPem).code, 'APP_SIGNAL_TTL_TOO_LONG');
  });

  await test('app signal: the wrong private key is a NAMED undecryptable refusal, never a key', () => {
    const { text } = seal();
    const r = ls.resolveAppSignal(text, expect, otherPrivPem);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'APP_SIGNAL_UNDECRYPTABLE');
    assert.strictEqual(r.key, undefined);
  });

  await test('app signal: a missing private key is SIGNAL_NO_PRIVATE_KEY (not a silent plaintext fallback)', () => {
    const { text } = seal();
    assert.strictEqual(ls.resolveAppSignal(text, expect, '').code, 'SIGNAL_NO_PRIVATE_KEY');
  });

  await test('app signal: an x25519-sealed envelope is a named unsupported algorithm for this RSA key', () => {
    const { signal } = seal();
    signal.credential.envelope.alg = 'x25519-hkdf-sha256+aes-256-gcm';
    const text = '```json\n' + JSON.stringify(signal) + '\n```';
    assert.strictEqual(ls.resolveAppSignal(text, expect, privPem).code, 'APP_SIGNAL_UNSUPPORTED_ALG');
  });

  await test('app signal: resolveAnySignal reads EITHER format, and reports NOT_FOUND only when neither exists', () => {
    const app = seal();
    const viaApp = ls.resolveAnySignal({ summary: 'human summary only', text: app.text }, expect, privPem);
    assert.strictEqual(viaApp.ok, true);
    assert.strictEqual(viaApp.format, 'mc-signal/v1');
    assert.strictEqual(viaApp.key, app.credential.dashToken);

    const labText = ls.buildSignal({ repo: REPO, runId: Number(RUN_ID), attempt: 1, appSha: SHA, endpoint: 'http://100.87.91.3:7331', issuedAt: new Date(NOW - 30000).toISOString(), expiresAt: new Date(NOW + 3600000).toISOString(), key: 'lab-sealed' }, pubPem);
    const viaLab = ls.resolveAnySignal({ summary: labText, text: '' }, expect, privPem);
    assert.strictEqual(viaLab.ok, true);
    assert.strictEqual(viaLab.format, 'MC-SIGNAL v1');

    const none = ls.resolveAnySignal({ summary: 'nothing here', text: 'nothing here' }, expect, privPem);
    assert.strictEqual(none.ok, false);
    assert.strictEqual(none.code, 'SIGNAL_NOT_FOUND');
  });

  await test('app signal: the public auditor binds the real app format to the run and checks envelope shape without decrypting', () => {
    const { text } = seal();
    const run = { id: Number(RUN_ID), run_attempt: 1, head_sha: SHA, status: 'in_progress' };
    const checkRun = {
      id: 120415090302, name: ls.SIGNAL_NAME, status: 'in_progress', conclusion: null,
      head_sha: SHA, external_id: `${REPO}#${RUN_ID}.1`,
      output: { title: 'MC-SIGNAL live', summary: '### MC-SIGNAL mc-signal/v1 - live', text }
    };
    const r = auditSignalBinding({ run, checkRun, originRepo: REPO, now: NOW });
    assert.strictEqual(r.ok, true, r.code + ' ' + r.detail);
    assert.strictEqual(r.code, 'SIGNAL_BOUND');
    assert.strictEqual(r.evidence.format, 'mc-signal/v1');
    assert.strictEqual(r.evidence.envelope.enc.hasAad, true);
    assert.strictEqual(r.evidence.envelope.enc.wrappedKeyChars >= 340, true);
    assert.strictEqual(JSON.stringify(r).includes('dash-token-'), false);
  });

  await test('app signal: a sealed credential whose EMBEDDED identity names another sha is refused', () => {
    const { text } = seal({ credential: { dashTokenQueryParam: 'key', dashToken: 'x', repository: REPO, runId: RUN_ID, runAttempt: 1, sha: 'f'.repeat(40) } });
    const r = ls.resolveAppSignal(text, expect, privPem);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'APP_SIGNAL_CREDENTIAL_IDENTITY_MISMATCH');
  });

  await test('app signal: a bare-string credential still works (older publishers)', () => {
    const { text } = seal({ plaintext: 'bare-token-value' });
    const r = ls.resolveAppSignal(text, expect, privPem);
    assert.strictEqual(r.ok, true, r.code);
    assert.strictEqual(r.key, 'bare-token-value');
    assert.strictEqual(r.credentialMeta, null);
  });

  await test('app signal: the auditor refuses an app signal whose AAD names another run', () => {
    const { text } = seal({ aadOverrides: { runId: '39952421154' } });
    const run = { id: Number(RUN_ID), run_attempt: 1, head_sha: SHA, status: 'in_progress' };
    const checkRun = { id: 1, name: ls.SIGNAL_NAME, status: 'in_progress', head_sha: SHA, external_id: null, output: { summary: 'x', text } };
    const r = auditSignalBinding({ run, checkRun, originRepo: REPO, now: NOW });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'APP_SIGNAL_AAD_MISMATCH');
  });
};
