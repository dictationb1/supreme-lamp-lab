'use strict';
// ===========================================================================
// THE /api/config CREDENTIAL GATE AS THE APPLICATION ACTUALLY IMPLEMENTS IT
// ---------------------------------------------------------------------------
// Measured on lab run 39906231257 (live, application-originated): the client
// VM got all the way to AUTH and then reported
//   BLOCKED / CREDENTIAL_GATE_LEAKED
//   "/api/config served its gated credentials block to an anonymous ... caller"
// for an application build that does no such thing.
//
// Two independent mistakes in the lab's predicate:
//   a. it treated the PRESENCE of a `creds` object as the credential block, but
//      payloads/ghrdp-server.ps1 Remove-CredKeys ALWAYS rebuilds
//      creds:{fqdn,user,ip} - no secret in it - so every real origin matched.
//   b. it ignored Test-CredsAllowed's second rule: any source inside the tailnet
//      CGNAT range (100.64/10) is authorized by SOURCE, so an anonymous request
//      FROM the client VM (itself a tailnet peer) legitimately receives the
//      password block. That is the documented trust model, not a leak, and it
//      also means the key gate cannot be demonstrated from this vantage point.
//
// Both are now classified explicitly and never as a leak.
// ===========================================================================

module.exports = async function register({ test, assert, fs, path }) {
  const http = require('http');
  const crypto = require('crypto');
  const shortHash = v => crypto.createHash('sha256').update(String(v), 'utf8').digest('hex').slice(0, 8);
  const auth = require('../lib/live-auth');

  const CONFIG_NO_SECRETS = {
    json: { ok: true, creds: { fqdn: 'pc.example.ts.net', user: 'ghrdp', ip: '100.124.43.82' }, dashTokenIssued: true }
  };
  const CONFIG_WITH_PASSWORDS = {
    json: { ok: true, creds: { fqdn: 'pc.example.ts.net', user: 'ghrdp', ip: '100.124.43.82', windowsPass: 'x', windowsPassMask: '****', vncPass: 'y' } }
  };

  await test('auth gate: the normal creds object is NOT treated as a leaked credential block', async () => {
    assert.deepStrictEqual(auth.secretFieldsOf(CONFIG_NO_SECRETS), []);
    assert.deepStrictEqual(auth.secretFieldsOf(CONFIG_WITH_PASSWORDS).sort(), ['creds.vncPass', 'creds.windowsPass']);
    assert.deepStrictEqual(auth.secretFieldsOf({ json: { rawCreds: { a: 1 } } }), ['rawCreds']);
    assert.deepStrictEqual(auth.secretFieldsOf(null), []);
    assert.deepStrictEqual(auth.secretFieldsOf({ json: { creds: { windowsPassMask: '****' } } }), [], 'a mask alone is not the raw secret');
  });

  await test('auth gate: a tailnet peer receiving the password block is tailnet-trust, not a leak', async () => {
    assert.strictEqual(auth.classifyConfigGate({
      anonymous: ['creds.windowsPass'], wrongKey: [], ourKey: ['creds.windowsPass'], tailnetSource: true
    }), 'tailnet-trust');
  });

  await test('auth gate: the same answer from a non-peer IS a leak', async () => {
    assert.strictEqual(auth.classifyConfigGate({
      anonymous: ['creds.windowsPass'], wrongKey: [], ourKey: ['creds.windowsPass'], tailnetSource: false
    }), 'leaked');
    assert.strictEqual(auth.classifyConfigGate({
      anonymous: [], wrongKey: ['rdpPass'], ourKey: ['rdpPass'], tailnetSource: false
    }), 'leaked');
  });

  await test('auth gate: the three honest non-leak outcomes stay distinct', async () => {
    assert.strictEqual(auth.classifyConfigGate({ anonymous: [], wrongKey: [], ourKey: ['creds.windowsPass'], tailnetSource: false }), 'enforced');
    assert.strictEqual(auth.classifyConfigGate({ anonymous: [], wrongKey: [], ourKey: [], tailnetSource: false }), 'unsupported');
    assert.strictEqual(auth.classifyConfigGate({}), 'unsupported');
  });


  await test('auth diag: the server\'s own telemetry says whether it expects the published token', async () => {
    const ring = [
      { route: '/api/rdp-token', presentedHash: 'aaaaaaaa', expectedHash: 'bbbbbbbb', valid: false, presentedLen: 3, expectedLen: 32 }
    ];
    const srv = http.createServer((req, res) => {
      if (req.url.startsWith('/api/diag/comprehensive')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ bundleVersion: 'f99/1', runner: { token: { dashTokenTelemetry: ring } } }));
      }
      res.writeHead(404); res.end();
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const target = `http://127.0.0.1:${srv.address().port}`;
    try {
      const notEqual = await auth.diagTokenEvidence(target, 'published-token-value');
      assert.strictEqual(notEqual.ok, true);
      assert.strictEqual(notEqual.serverExpectedEqualsPublished, false, 'a different expected hash must read as false');
      assert.strictEqual(notEqual.expectedLen, 32);
      assert.strictEqual(notEqual.presentedLen, 3);

      ring[0].expectedHash = shortHash('published-token-value');
      ring[0].expectedLen = 'published-token-value'.length;
      const equal = await auth.diagTokenEvidence(target, 'published-token-value');
      assert.strictEqual(equal.serverExpectedEqualsPublished, true, 'the same token must read as true');
      assert.ok(!JSON.stringify(equal).includes('published-token-value'), 'the evidence must never carry the token');
    } finally { srv.close(); }
  });

  await test('auth diag: the telemetry ring is found structurally, not by a bundle key', async () => {
    assert.deepStrictEqual(auth.findTokenRing({ a: { b: { dashTokenTelemetry: [{ expectedHash: 'x' }] } } }), [{ expectedHash: 'x' }]);
    assert.strictEqual(auth.findTokenRing({ a: 1 }), null);
    assert.strictEqual(auth.findTokenRing(null), null);
  });


  await test('identity: the serving process start time is read from the diagnostics bundle', async () => {
    const si = require('../lib/server-identity');
    assert.deepStrictEqual(si.findServerStart({ a: { logonCollector: { startedAt: '2026-10-23T04:00:00.0000000Z', uptimeSec: 7200 } } }),
      { startedAt: '2026-10-23T04:00:00.000Z', uptimeSec: 7200, source: 'startedAt' });
    assert.strictEqual(si.findServerStart({ a: { note: 'no time here' } }), null);

    const srv = http.createServer((req, res) => {
      if (req.url !== '/api/native-status') { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('nope'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ bundleVersion: 'f99/1', rdpListener: { logonCollector: { startedAt: '2026-10-23T04:00:00Z', uptimeSec: 60 } } }));
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    try {
      const b = await si.serverBootTime({ target: `http://127.0.0.1:${srv.address().port}` });
      assert.strictEqual(b.ok, true, JSON.stringify(b));
      assert.strictEqual(b.boot.startedAt, '2026-10-23T04:00:00.000Z');
      assert.strictEqual(b.boot.route, '/api/native-status', 'the route that answered is named');
    } finally { srv.close(); }
    const dead = await si.serverBootTime({ target: 'http://127.0.0.1:1', timeoutMs: 3000 });
    assert.strictEqual(dead.ok, false);
    assert.strictEqual(dead.code, 'BOOT_TIME_UNAVAILABLE', 'an unreachable bundle is reported, never guessed');
  });

  await test('live: a process that started before the origin run is refused as a different instance', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'live-run.js'), 'utf8');
    assert.match(src, /ORIGIN_INSTANCE_PREDATES_RUN/);
    assert.match(src, /predatesMs > 120000/, 'the rule has an explicit tolerance');
    assert.match(src, /serverBootTime/, 'it uses the measured start time');
  });

  await test('auth gate: classification never needs a credential value', async () => {
    const names = auth.secretFieldsOf(CONFIG_WITH_PASSWORDS);
    for (const n of names) {
      assert.ok(!String(n).includes('x') && !String(n).includes('y'), `the field name ${n} must not carry a value`);
      assert.match(n, /^[A-Za-z]+(\.[A-Za-z]+)?$/, `${n} is a key name`);
    }
  });
};
