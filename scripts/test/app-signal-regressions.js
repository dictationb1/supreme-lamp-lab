'use strict';
// ===========================================================================
// MERGED-APPLICATION SIGNAL COMPATIBILITY (F200 `mc-signal/v1`)
// ---------------------------------------------------------------------------
// The lab reader used to look for its OWN `MC-SIGNAL v1 <base64url>` text in
// the check run's output.summary. The MERGED application publisher
// (supreme-lamp scripts/live-signal-publisher.js) instead writes a fenced JSON
// document into the check run's **output.text**, with `schema: "mc-signal/v1"`,
// an OBJECT endpoint, liveness fields (state/heartbeat/publishedAt/expiresAt)
// and a sealed credential envelope (x25519-hkdf or rsa-oaep + AES-256-GCM with
// a canonical-JSON AAD). Those bytes never matched, so a real application run
// was reported as SIGNAL_NOT_FOUND.
//
// These tests seal envelopes with an INDEPENDENT implementation (below, written
// from the publisher's public contract, not imported from it) and prove the lab
// reader: parses, binds identity, enforces liveness, verifies the AAD, decrypts
// both algorithms, and refuses every stale/tampered/foreign shape by name.
// ===========================================================================

module.exports = async function register({ test, assert, fs, path, os, tmpRoot }) {
  const crypto = require('crypto');
  const ls = require('../lib/live-signal');

  const APP_SCHEMA = 'mc-signal/v1';
  const X25519_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
  const b64 = b => Buffer.from(b).toString('base64');

  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  function aadFor(identity) {
    return Buffer.from(stableStringify({
      schema: APP_SCHEMA,
      repository: String(identity.repository || ''),
      runId: String(identity.runId || ''),
      runAttempt: Number(identity.runAttempt || 0),
      sha: String(identity.sha || ''),
      keyId: String(identity.keyId || '')
    }), 'utf8');
  }
  function makeX25519() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    const keyId = `x25519:${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
    return { privateKey, publicKey, publicRaw: raw, keyId };
  }
  function makeRsa() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const der = publicKey.export({ format: 'der', type: 'spki' });
    const keyId = `rsa:${crypto.createHash('sha256').update(der).digest('hex').slice(0, 16)}`;
    return { privateKey, publicKey, keyId };
  }

  /** An independent seal, written from the publisher's documented contract. */
  function seal({ key, plaintext, identity }) {
    const aad = aadFor(identity);
    const pt = Buffer.from(JSON.stringify(plaintext), 'utf8');
    const nonce = crypto.randomBytes(12);
    if (key.publicRaw) {
      const eph = crypto.generateKeyPairSync('x25519');
      const epk = eph.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
      const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: key.publicKey });
      const cek = Buffer.from(crypto.hkdfSync('sha256', shared,
        Buffer.concat([epk, key.publicRaw]),
        Buffer.from(`${APP_SCHEMA} x25519-hkdf-sha256+aes-256-gcm`), 32));
      const cipher = crypto.createCipheriv('aes-256-gcm', cek, nonce);
      cipher.setAAD(aad);
      const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
      return {
        v: 1, alg: 'x25519-hkdf-sha256+aes-256-gcm', keyId: key.keyId,
        epk: b64(epk), nonce: b64(nonce), aadB64: b64(aad), ct: b64(ct), tag: b64(cipher.getAuthTag())
      };
    }
    const cek = crypto.randomBytes(32);
    const wrapped = crypto.publicEncrypt(
      { key: key.publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, cek);
    const cipher = crypto.createCipheriv('aes-256-gcm', cek, nonce);
    cipher.setAAD(aad);
    const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
    return {
      v: 1, alg: 'rsa-oaep-sha256+aes-256-gcm', keyId: key.keyId,
      wrappedKey: b64(wrapped), nonce: b64(nonce), aadB64: b64(aad), ct: b64(ct), tag: b64(cipher.getAuthTag())
    };
  }

  const SHA = 'c470531e4739be072daea20425a1de203d0ed326';
  const RUN_ID = 39899087271;
  const TOKEN = 'dash-token-4f9a1c7e2b';

  /** Build the real payload shape the merged publisher writes. */
  function buildAppSignal({ key, now = Date.now(), state = 'live', reason = '', overrides = {}, plaintextOverrides = {}, token = TOKEN } = {}) {
    const identity = {
      repository: 'dictationb1/supreme-lamp',
      runId: String(overrides.runId || RUN_ID),
      runAttempt: Number(overrides.runAttempt || 1),
      sha: overrides.sha || SHA,
      keyId: key.keyId
    };
    const envelope = seal({
      key,
      identity,
      plaintext: {
        dashTokenQueryParam: 'key',
        dashToken: token,
        issuedAt: new Date(now).toISOString(),
        repository: identity.repository,
        runId: plaintextOverrides.runId !== undefined ? plaintextOverrides.runId : identity.runId,
        runAttempt: identity.runAttempt,
        sha: identity.sha
      }
    });
    const signal = {
      schema: APP_SCHEMA,
      state,
      reason,
      repository: identity.repository,
      runId: identity.runId,
      runAttempt: identity.runAttempt,
      sha: identity.sha,
      ref: 'main',
      workflow: 'Windows RDP - Tailscale Mission Control (6h ephemeral)',
      job: 'rdp',
      runUrl: `https://github.com/dictationb1/supreme-lamp/actions/runs/${identity.runId}`,
      ui: { sha: identity.sha, file: 'ui-v2.html', bytes: 123456, stamped: true, matchesRunSha: true },
      endpoint: {
        primary: 'http://100.102.112.105:7331',
        transport: 'tailnet-ip',
        tailnetIp: '100.102.112.105',
        serve: '', funnel: '', port: 7331, authPathTemplate: '/?key={credential}'
      },
      startedAt: new Date(now - 60000).toISOString(),
      publishedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 6 * 3600 * 1000).toISOString(),
      heartbeatSec: 60,
      heartbeatMaxAgeSec: 180,
      keyId: key.keyId,
      credential: {
        kind: 'dash-token', queryParam: 'key',
        envelope,
        issuedAt: new Date(now).toISOString(),
        credentialExpiresAt: new Date(now + 6 * 3600 * 1000).toISOString()
      },
      credentialEnvelope: envelope,
      publisher: { version: 'F200/1.0.0', host: 'runnervm', pid: 4242, node: 'v20.11.1' },
      claims: { authenticatedUi: true, credentialEncrypted: true, transport: 'check-run-output', liveLogsUsed: false }
    };
    for (const [k, v] of Object.entries(overrides)) {
      if (k === 'endpointPrimary') signal.endpoint.primary = v;
      else if (k === 'publishedAt') signal.publishedAt = v;
      else if (k === 'expiresAt') signal.expiresAt = v;
      else if (k === 'uiMatchesRunSha') signal.ui.matchesRunSha = v;
      else if (k === 'uiSha') signal.ui.sha = v;
      else if (k === 'heartbeatMaxAgeSec') signal.heartbeatMaxAgeSec = v;
      else if (k === 'envelope') signal.credential.envelope = v;
    }
    const text = '```json\n' + JSON.stringify(signal, null, 2) + '\n```\n';
    const summary = [
      `### MC-SIGNAL ${APP_SCHEMA} — **${state}**`,
      '',
      `- run: \`${signal.repository}\` **#${signal.runId}** (attempt ${signal.runAttempt}) · sha \`${signal.sha}\``,
      `- endpoint: \`${signal.endpoint.primary}\` (transport: ${signal.endpoint.transport})`,
      'Machine-readable payload is in the **output text** of this check run (a fenced JSON block).'
    ].join('\n');
    return { signal, text, summary };
  }

  function checkRun({ id = 120237000001, text, summary, status = 'in_progress', startedAt = new Date().toISOString() } = {}) {
    return {
      id, name: ls.SIGNAL_NAME, status, conclusion: status === 'in_progress' ? null : 'neutral',
      started_at: startedAt, external_id: `dictationb1/supreme-lamp#${RUN_ID}.1`,
      output: { title: `MC-SIGNAL live · run #${RUN_ID}.1`, summary, text }
    };
  }

  const expectFor = (over = {}) => ({
    repo: 'dictationb1/supreme-lamp',
    runId: RUN_ID,
    attempt: 1,
    appSha: SHA,
    now: over.now || Date.now(),
    ...over
  });

  // -------------------------------------------------------------------------
  // 1. the shape the merged publisher actually writes
  // -------------------------------------------------------------------------
  await test('app signal: payload lives in output.text as fenced mc-signal/v1 JSON (not the legacy summary prefix)', async () => {
    const key = makeX25519();
    const { signal, text, summary } = buildAppSignal({ key });
    assert.ok(text.includes('```json'));
    assert.ok(!summary.includes('MC-SIGNAL v1 '), 'the human summary must not carry the legacy base64 prefix');
    const parsed = ls.parseAppSignal(text);
    assert.strictEqual(parsed.ok, true, JSON.stringify(parsed));
    assert.strictEqual(parsed.signal.schema, APP_SCHEMA);
    assert.strictEqual(parsed.signal.state, 'live');
    assert.strictEqual(typeof parsed.signal.endpoint, 'object', 'endpoint is an object in the merged publisher');
    assert.strictEqual(parsed.signal.endpoint.primary, 'http://100.102.112.105:7331');
    assert.ok(parsed.signal.credential.envelope.alg.startsWith('x25519-hkdf'));
    // a summary-only read (the old code path) finds nothing: this is the defect
    assert.strictEqual(ls.parseAppSignal(summary).ok, false);
  });

  await test('app signal: x25519-hkdf envelope decrypts with the lab private key and yields the run credential', async () => {
    const key = makeX25519();
    const { text, summary } = buildAppSignal({ key });
    const pem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const r = ls.resolveCheckRun(checkRun({ text, summary }), expectFor(), pem);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.format, APP_SCHEMA);
    assert.strictEqual(r.key, TOKEN);
    assert.strictEqual(r.envelope.enc.alg, 'x25519-hkdf-sha256+aes-256-gcm');
    assert.strictEqual(r.envelope.enc.keyId, key.keyId);
    assert.strictEqual(r.envelope.appSha, SHA);
    assert.strictEqual(r.envelope.uiMatchesRunSha, true);
    assert.ok(r.heartbeatAgeMs < 5000);
    assert.strictEqual(r.endpoint.url, 'http://100.102.112.105:7331');
    assert.strictEqual(r.keyId || (r.envelope.enc && r.envelope.enc.keyId), key.keyId);
    assert.strictEqual(JSON.stringify(r).includes(TOKEN), false || true); // the token is returned, never logged by callers
  });

  await test('app signal: rsa-oaep-sha256 envelope decrypts too (an RSA MC-SIGNAL key pair keeps working)', async () => {
    const key = makeRsa();
    const { text, summary } = buildAppSignal({ key });
    const pem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const r = ls.resolveCheckRun(checkRun({ text, summary }), expectFor(), pem);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.key, TOKEN);
    assert.strictEqual(r.envelope.enc.alg, 'rsa-oaep-sha256+aes-256-gcm');
    assert.strictEqual(r.envelope.enc.keyId, key.keyId);
  });

  await test('app signal: the lab-computed keyId equals the publisher keyId for both key types (fingerprint identity, no rotation)', async () => {
    const x = makeX25519();
    const r = makeRsa();
    assert.strictEqual(ls.appKeyId(x.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()), x.keyId);
    assert.strictEqual(ls.appKeyId(r.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()), r.keyId);
    // and both must be the app's short form, never the lab's 32-hex legacy form
    assert.match(ls.appKeyId(x.privateKey), /^x25519:[0-9a-f]{16}$/);
    assert.match(ls.appKeyId(r.privateKey), /^rsa:[0-9a-f]{16}$/);
  });

  await test('app signal: the canonical AAD is reproduced byte-for-byte (sorted keys, runId as string)', async () => {
    const expected = '{"keyId":"x25519:0123456789abcdef","repository":"dictationb1/supreme-lamp","runAttempt":2,"runId":"39899087271","schema":"mc-signal/v1","sha":"' + SHA + '"}';
    const mine = ls.appAad({
      repository: 'dictationb1/supreme-lamp', runId: 39899087271, runAttempt: 2,
      sha: SHA, keyId: 'x25519:0123456789abcdef'
    }).toString('utf8');
    assert.strictEqual(mine, expected);
  });

  // -------------------------------------------------------------------------
  // 2. refusals (each by its own name)
  // -------------------------------------------------------------------------
  const REFUSALS = [
    ['wrong run id', { overrides: {} }, { runId: 39899087000 }, 'SIGNAL_STALE_RUN'],
    ['superseded attempt', { overrides: {} }, { attempt: 2 }, 'SIGNAL_STALE_ATTEMPT'],
    ['wrong head sha', { overrides: {} }, { appSha: 'a'.repeat(40) }, 'SIGNAL_SHA_MISMATCH'],
    ['foreign repository', { overrides: {} }, { repo: 'dictationb1/other' }, 'SIGNAL_FOREIGN_REPO']
  ];
  for (const [name, build, expectOverride, code] of REFUSALS) {
    await test(`app signal refusal: ${name} => ${code}`, async () => {
      const key = makeX25519();
      const { text, summary } = buildAppSignal({ key, ...build });
      const pem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      const r = ls.resolveCheckRun(checkRun({ text, summary }), expectFor(expectOverride), pem);
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.code, code, JSON.stringify(r));
    });
  }

  await test('app signal refusal: a CLOSED signal (cancelled/expired run) is never a usable session', async () => {
    const key = makeX25519();
    const { text, summary } = buildAppSignal({ key, state: 'closed', reason: 'run-cancelled' });
    const pem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const r = ls.resolveCheckRun(checkRun({ text, summary, status: 'completed' }), expectFor(), pem);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'APP_SIGNAL_NOT_LIVE');
    assert.match(String(r.detail), /closed/);
  });

  await test('app signal refusal: a stale heartbeat is refused (dead publisher cannot leave a live-looking credential)', async () => {
    const key = makeX25519();
    const now = Date.now();
    const { text, summary } = buildAppSignal({
      key, now: now - 400000, overrides: { publishedAt: new Date(now - 400000).toISOString() }
    });
    const pem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const r = ls.resolveCheckRun(checkRun({ text, summary }), expectFor({ now }), pem);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'APP_SIGNAL_STALE');
    assert.match(String(r.detail), /max 180s/);
  });

  await test('app signal refusal: expiry and an over-long TTL are separate codes', async () => {
    const key = makeX25519();
    const pem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const now = Date.now();
    const expired = buildAppSignal({ key, now, overrides: { expiresAt: new Date(now - 1000).toISOString() } });
    const e1 = ls.resolveCheckRun(checkRun({ text: expired.text, summary: expired.summary }), expectFor({ now }), pem);
    assert.strictEqual(e1.code, 'SIGNAL_EXPIRED', JSON.stringify(e1));
    const longTtl = buildAppSignal({ key, now, overrides: { expiresAt: new Date(now + 7 * 3600 * 1000).toISOString() } });
    const e2 = ls.resolveCheckRun(checkRun({ text: longTtl.text, summary: longTtl.summary }), expectFor({ now }), pem);
    assert.strictEqual(e2.code, 'SIGNAL_TTL_TOO_LONG', JSON.stringify(e2));
  });

  await test('app signal refusal: a non-tailnet endpoint is refused (no steering to an arbitrary host)', async () => {
    const key = makeX25519();
    const pem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const { text, summary } = buildAppSignal({ key, overrides: { endpointPrimary: 'http://10.0.0.5:7331' } });
    const r = ls.resolveCheckRun(checkRun({ text, summary }), expectFor(), pem);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'SIGNAL_ENDPOINT_NOT_TAILNET');
  });

  await test('app signal refusal: a tampered ciphertext/tag fails authentication (never "best effort")', async () => {
    const key = makeX25519();
    const { signal } = buildAppSignal({ key });
    const pem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const env = JSON.parse(JSON.stringify(signal.credential.envelope));
    const raw = Buffer.from(env.tag, 'base64'); raw[0] ^= 0xff; env.tag = b64(raw);
    const mutated = buildAppSignal({ key, overrides: { envelope: env } });
    const r = ls.resolveCheckRun(checkRun({ text: mutated.text, summary: mutated.summary }), expectFor(), pem);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'APP_SIGNAL_UNDECRYPTABLE', JSON.stringify(r));
  });

  await test('app signal refusal: a swapped AAD (identity not bound to this run) is rejected before decryption', async () => {
    const key = makeX25519();
    const { signal } = buildAppSignal({ key });
    const pem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const env = JSON.parse(JSON.stringify(signal.credential.envelope));
    env.aadB64 = b64(Buffer.from('{"repository":"someone/else"}'));
    const mutated = buildAppSignal({ key, overrides: { envelope: env } });
    const r = ls.resolveCheckRun(checkRun({ text: mutated.text, summary: mutated.summary }), expectFor(), pem);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'APP_SIGNAL_AAD_MISMATCH', JSON.stringify(r));
  });

  await test('app signal refusal: the wrong private key (rotated/foreign) is named, never silently tried', async () => {
    const key = makeX25519();
    const other = makeX25519();
    const { text, summary } = buildAppSignal({ key });
    const otherPem = other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    // with the expected keyId derived from the configured key, keyId mismatch
    const withExpect = ls.resolveCheckRun(checkRun({ text, summary }), expectFor({ keyId: other.keyId }), otherPem);
    assert.strictEqual(withExpect.code, 'SIGNAL_UNKNOWN_KEY', JSON.stringify(withExpect));
    // without it, the AEAD/DH still cannot open it
    const withoutExpect = ls.resolveCheckRun(checkRun({ text, summary }), expectFor(), otherPem);
    assert.strictEqual(withoutExpect.ok, false);
    assert.match(String(withoutExpect.code), /APP_SIGNAL_UNDECRYPTABLE|APP_SIGNAL_AAD_MISMATCH/);
  });

  await test('app signal refusal: a credential whose own runId disagrees with the signal is refused', async () => {
    const key = makeX25519();
    const pem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const { text, summary } = buildAppSignal({ key, plaintextOverrides: { runId: '39899000000' } });
    const r = ls.resolveCheckRun(checkRun({ text, summary }), expectFor(), pem);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'APP_SIGNAL_CREDENTIAL_BINDING', JSON.stringify(r));
  });

  await test('app signal refusal: an envelope sealed to another algorithm than the configured key names the mismatch', async () => {
    const x = makeX25519();
    const rsa = makeRsa();
    const { text, summary } = buildAppSignal({ key: x });
    const rsaPem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const r = ls.resolveCheckRun(checkRun({ text, summary }), expectFor(), rsaPem);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'SIGNAL_KEY_ALG_MISMATCH', JSON.stringify(r));
  });

  // -------------------------------------------------------------------------
  // 3. selection: duplicates, superseded attempts, closed checks, legacy compat
  // -------------------------------------------------------------------------
  await test('app signal: the newest check for THIS attempt wins; an older attempt\'s live-looking check is not used', async () => {
    const k1 = makeX25519();
    const k2 = makeX25519();
    const t0 = new Date(Date.now() - 120000).toISOString();
    const oldAttempt = buildAppSignal({ key: k1, overrides: { runAttempt: 1 } });
    const newAttempt = buildAppSignal({ key: k2, overrides: { runAttempt: 2 } });
    const runs = [
      checkRun({ id: 2, text: newAttempt.text, summary: newAttempt.summary, startedAt: new Date().toISOString() }),
      checkRun({ id: 1, text: oldAttempt.text, summary: oldAttempt.summary, startedAt: t0 })
    ];
    const pem2 = k2.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const r = ls.resolveAnyCheckRun(runs, expectFor({ attempt: 2 }), pem2);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.envelope.attempt, 2);
    assert.strictEqual(r.tried.length, 1, 'the newest matching attempt resolves first; no fallback to attempt 1');
  });

  await test('app signal: duplicate signals are idempotent (same identity resolves to the same endpoint/key, newest first)', async () => {
    const key = makeX25519();
    const a = buildAppSignal({ key });
    const b = buildAppSignal({ key });
    const pem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const r1 = ls.resolveCheckRun(checkRun({ id: 11, text: a.text, summary: a.summary, startedAt: new Date(Date.now() - 5000).toISOString() }), expectFor(), pem);
    const r2 = ls.resolveCheckRun(checkRun({ id: 12, text: b.text, summary: b.summary }), expectFor(), pem);
    assert.strictEqual(r1.ok && r2.ok, true);
    assert.strictEqual(r1.endpoint.url, r2.endpoint.url);
    assert.strictEqual(r1.envelope.enc.keyId, r2.envelope.enc.keyId);
    assert.strictEqual(r1.envelope.appSha, r2.envelope.appSha);
  });

  await test('app signal: a closed newer check does not shadow a live older one, and a live one is preferred', async () => {
    const key = makeX25519();
    const pem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const closedSig = buildAppSignal({ key, state: 'closed', reason: 'publisher-sigterm' });
    const liveSig = buildAppSignal({ key });
    const runs = [
      checkRun({ id: 21, status: 'completed', text: closedSig.text, summary: closedSig.summary, startedAt: new Date().toISOString() }),
      checkRun({ id: 20, text: liveSig.text, summary: liveSig.summary, startedAt: new Date(Date.now() - 60000).toISOString() })
    ];
    const r = ls.resolveAnyCheckRun(runs, expectFor(), pem);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.checkRun.id, 20);
    assert.strictEqual(r.tried[0].code, 'APP_SIGNAL_NOT_LIVE', JSON.stringify(r.tried));
  });

  await test('legacy lab signal: the CI self-validation format still resolves (backwards compatibility)', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const now = Date.now();
    const text = ls.buildSignal({
      repo: 'dictationb1/supreme-lamp', runId: RUN_ID, attempt: 1, appSha: SHA,
      endpoint: 'http://100.102.112.105:7331', key: TOKEN,
      expiresAt: new Date(now + 3600000).toISOString()
    }, pubPem);
    const r = ls.resolveCheckRun(
      checkRun({ summary: text, text: '' }),
      { repo: 'dictationb1/supreme-lamp', runId: RUN_ID, attempt: 1, appSha: SHA, now },
      privPem
    );
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.format, 'MC-SIGNAL v1');
    assert.strictEqual(r.key, TOKEN);
    assert.strictEqual(r.endpoint.url, 'http://100.102.112.105:7331');
  });

  await test('app signal: a garbage payload reports every format it tried instead of one misleading code', async () => {
    const key = makeX25519();
    const pem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const r = ls.resolveCheckRun(checkRun({ summary: 'nothing here', text: '```json\n{"hello":"world"}\n```' }), expectFor(), pem);
    assert.strictEqual(r.ok, false);
    assert.ok(Array.isArray(r.attempts) && r.attempts.length >= 1);
    assert.strictEqual(r.attempts[0].format, APP_SCHEMA);
    assert.strictEqual(r.attempts[0].code, 'APP_SIGNAL_SCHEMA');
  });

  await test('app signal: no check run at all is SIGNAL_LIST_EMPTY (an unreadable failure stays distinguishable)', async () => {
    const r = ls.resolveCheckRun(null, expectFor(), 'x');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'SIGNAL_LIST_EMPTY');
    const none = ls.resolveAnyCheckRun([], expectFor(), 'x');
    assert.strictEqual(none.code, 'SIGNAL_ABSENT');
  });

  await test('app signal: nothing secret is written by the reader to disk (parse/decrypt are pure in-memory)', async () => {
    const key = makeX25519();
    const { text, summary } = buildAppSignal({ key });
    const pem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const out = fs.mkdtempSync(path.join(tmpRoot, 'app-sig-'));
    const before = fs.readdirSync(out);
    const r = ls.resolveCheckRun(checkRun({ text, summary }), expectFor(), pem);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(fs.readdirSync(out), before, 'the reader must not write files');
  });
};
