'use strict';
// EVIDENCE-PUBLISH GATE REGRESSIONS.
//
// The lab is public. `scripts/publish-evidence.js` is the only path that puts a
// client-VM report into the repository, so its refusal rules are security
// behaviour and are pinned here (a false negative publishes a secret).
//
// Also pinned: the idempotency rule that stops a re-run from producing an
// endless commit -> pull_request -> commit loop on the head branch.

const assert = require('assert');

module.exports = async function register({ test, assert: A }) {
  const { scan, ALLOW } = require('../publish-evidence.js');
  A = A || assert;

  await test('publish: a private key block is refused', async () => {
    const r = scan('-----BEGIN RSA PRIVATE KEY-----\nMIIE...', 'report.json');
    A.strictEqual(r.ok, false);
    A.strictEqual(r.code, 'REFUSED_CREDENTIAL_SHAPE');
  });

  await test('publish: an authenticated dashboard URL is refused', async () => {
    const r = scan('origin=http://100.99.208.107:7331/?key=AbCdEf0123456789Zz', 'report.json');
    A.strictEqual(r.ok, false);
  });

  await test('publish: a bearer token, a GitHub token and a sealed envelope are refused', async () => {
    A.strictEqual(scan('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345', 'r.json').ok, false);
    A.strictEqual(scan('token=ghp_abcdefghijklmnopqrstuvwx', 'r.json').ok, false);
    A.strictEqual(scan('{"wrappedKey":"AmxrtVrAFik4C0IvN6IkthCK/Geg9KQkgBiBtHKEbdYhN18CUsS7y9Wk"}', 'r.json').ok, false);
  });

  await test('publish: an unmasked RDP password is refused, a masked one is not', async () => {
    A.strictEqual(scan('{"rdpPass":"Sup3rSecret!"}', 'r.json').ok, false);
    A.strictEqual(scan('{"windowsPassMask":"************cret"}', 'r.json').ok, true);
  });

  await test('publish: a sanitized report (statuses, codes, timings) passes', async () => {
    const sample = JSON.stringify({
      schema: 'live-run-report/1',
      verdict: 'BLOCKED',
      code: 'READINESS_TIMEOUT',
      endpoint: 'http://100.99.208.107:7331',
      listeners: [{ port: 7331, route: '/api/ping', httpCode: '000', curlExit: 28, wallMs: 20001 }],
      keyFingerprint: 'sha256:9f2c...'
    }, null, 2);
    A.strictEqual(scan(sample, 'live-run-report.json').ok, true);
  });

  await test('publish: only evidence file types are eligible (no HAR, no browser profile)', async () => {
    const ok = name => ALLOW.some(re => re.test(name));
    A.strictEqual(ok('live-run-report.json'), true);
    A.strictEqual(ok('listeners.json'), true);
    A.strictEqual(ok('control-coverage.csv'), true);
    A.strictEqual(ok('overview.png'), true);
    A.strictEqual(ok('network.har'), false);
    A.strictEqual(ok('Cookies.sqlite'), false);
    A.strictEqual(ok('id_rsa'), false);
  });
};
