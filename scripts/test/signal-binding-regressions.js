'use strict';
// Regressions for the PUBLIC-ONLY MC-SIGNAL identity audit
// (scripts/lib/signal-binding.js + scripts/verify-signal-binding.js).
//
// The point of these tests is the negative direction: a signal that names a
// different run, a different attempt, a different sha, a closed check run, an
// expired envelope or a non-tailnet endpoint must NOT be reported as bound.
// The positive case is built from the real builder (buildSignal) so the
// envelope shape under test is the production one.

module.exports = async function register({ test, assert, fs, path, os, tmpRoot }) {
  const crypto = require('crypto');
  const lib = require('../lib/signal-binding');
  const signalLib = require('../lib/live-signal');

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const keyId = signalLib.keyFingerprint(pubPem);
  const SHA = '24ddaa9904c92dbbba39e3cc7aba458769e6bbe4';
  const OTHER = 'f'.repeat(40);
  const repo = 'dictationb1/supreme-lamp';

  const run = {
    id: 39952421153,
    run_attempt: 1,
    head_sha: SHA,
    status: 'in_progress',
    conclusion: null,
    repository: { full_name: repo }
  };
  const NOW = Date.parse('2026-10-23T12:40:00Z');

  function envelope(patch = {}) {
    const payload = {
      repo, runId: run.id, attempt: 1, appSha: SHA,
      uiBuild: `ui-dist-${SHA}`, endpoint: 'http://100.108.80.74:7331/',
      issuedAt: new Date(NOW - 30000).toISOString(),
      expiresAt: new Date(NOW + 3 * 3600 * 1000).toISOString(),
      key: 'run-credential-value-never-logged',
      ...patch
    };
    // buildSignal seals payload.key with the lab public key exactly as the app
    // publisher does; the test never needs the plaintext afterwards.
    return signalLib.buildSignal(payload, pubPem);
  }
  function checkRun(summary, patch = {}) {
    return {
      id: 900001, name: signalLib.SIGNAL_NAME, status: 'in_progress', conclusion: null,
      started_at: '2026-10-23T12:39:00Z', completed_at: null, head_sha: SHA,
      external_id: `${repo}#${run.id}.1`,
      output: { title: 'MC-SIGNAL live', summary },
      ...patch
    };
  }
  const audit = (summary, patch = {}, r = run) => lib.auditSignalBinding({ run: r, checkRun: checkRun(summary, patch), originRepo: repo, now: NOW });

  await test('signal binding: a genuine envelope for this run/attempt/sha is BOUND (no decryption)', () => {
    const r = audit(envelope());
    assert.strictEqual(r.ok, true, r.detail);
    assert.strictEqual(r.code, 'SIGNAL_BOUND');
    assert.strictEqual(r.evidence.envelope.appSha, SHA);
    assert.strictEqual(r.evidence.envelope.attempt, 1);
    assert.strictEqual(r.evidence.envelope.enc.ciphertextChars > 300, true);
  });

  await test('signal binding: another attempt is refused by name (never "the latest attempt")', () => {
    const r = audit(envelope({ attempt: 2 }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'SIGNAL_STALE_ATTEMPT');
  });

  await test('signal binding: another sha is refused by name', () => {
    const r = audit(envelope({ appSha: OTHER, uiBuild: null }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'SIGNAL_SHA_MISMATCH');
  });

  await test('signal binding: another run id is refused by name', () => {
    const r = audit(envelope({ runId: 39952421154 }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'SIGNAL_STALE_RUN');
  });

  await test('signal binding: an expired envelope is refused, not accepted because it parses', () => {
    const r = audit(envelope({ expiresAt: new Date(NOW - 60000).toISOString() }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'SIGNAL_EXPIRED');
  });

  await test('signal binding: a ttl beyond the 6 h cap is refused', () => {
    const r = audit(envelope({ expiresAt: new Date(NOW + 7 * 3600 * 1000).toISOString() }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'SIGNAL_TTL_TOO_LONG');
  });

  await test('signal binding: a non-tailnet endpoint is refused even when every id matches', () => {
    const r = audit(envelope({ endpoint: 'http://203.0.113.9:7331/' }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'SIGNAL_ENDPOINT_NOT_TAILNET');
  });

  await test('signal binding: a closed check run is SIGNAL_NOT_LIVE, not a pass on stale bytes', () => {
    const r = audit(envelope(), { status: 'completed', conclusion: 'neutral', completed_at: '2026-10-23T12:39:30Z' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'SIGNAL_NOT_LIVE');
  });

  await test('signal binding: a check run whose own head_sha differs is refused before decoding', () => {
    const r = audit(envelope(), { head_sha: OTHER });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'SIGNAL_CHECK_SHA_MISMATCH');
  });

  await test('signal binding: a mismatched publisher external_id is refused', () => {
    const r = audit(envelope(), { external_id: `${repo}#39952421153.2` });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'SIGNAL_EXTERNAL_ID_MISMATCH');
  });

  await test('signal binding: no signal check run is SIGNAL_NOT_PUBLISHED (not "verified")', () => {
    const r = lib.auditSignalBinding({ run, checkRun: null, originRepo: repo, now: NOW });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'SIGNAL_NOT_PUBLISHED');
  });

  await test('signal binding: a truncated ciphertext is refused on shape', () => {
    const text = envelope();
    const token = text.slice('MC-SIGNAL v1 '.length);
    const env = JSON.parse(Buffer.from(token.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    env.enc.ciphertext = 'AAAA';
    const tampered = 'MC-SIGNAL v1 ' + Buffer.from(JSON.stringify(env), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const r = audit(tampered);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'SIGNAL_CIPHERTEXT_SHAPE');
  });

  await test('signal binding: the audit never decrypts and never prints the plaintext it was given', () => {
    const r = audit(envelope());
    const text = JSON.stringify(r);
    assert.strictEqual(text.includes('run-credential-value-never-logged'), false);
    assert.strictEqual(r.evidence.envelope.enc.ciphertextChars > 0, true);
    // the private key is unused by the audit: a decrypt with the WRONG key fails,
    // which is what proves this module cannot have proven the credential.
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const env = signalLib.parseSignal(envelope()).envelope;
    const wrong = signalLib.decryptKey(env, other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    assert.strictEqual(wrong.ok, false);
    assert.strictEqual(wrong.code, 'SIGNAL_UNDECRYPTABLE');
    assert.ok(privateKey);
  });
};
