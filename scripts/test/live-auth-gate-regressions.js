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

module.exports = async function register({ test, assert }) {
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

  await test('auth gate: classification never needs a credential value', async () => {
    const names = auth.secretFieldsOf(CONFIG_WITH_PASSWORDS);
    for (const n of names) {
      assert.ok(!String(n).includes('x') && !String(n).includes('y'), `the field name ${n} must not carry a value`);
      assert.match(n, /^[A-Za-z]+(\.[A-Za-z]+)?$/, `${n} is a key name`);
    }
  });
};
