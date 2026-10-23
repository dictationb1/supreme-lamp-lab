'use strict';
// ===========================================================================
// AN UNANSWERED PROBE IS NOT A SECURITY FINDING
// ---------------------------------------------------------------------------
// Measured on lab run 39929404780 (client job 120333833464): the evaluator
//   auth.no_stale_key_reuse
// published FAIL "STALE_KEY_ACCEPTED: the live server minted a ticket for a
// token it should not know" in the same job that hit page.goto timeouts, six
// unreachable-route timeouts and an artifact upload failure (ENOTFOUND). The
// predicate was
//     refusedTicket = r1.transport === 'ok' && (r1.status === 401 || 403)
// so a TIMEOUT (transport !== 'ok') fell through to the FAIL branch: the lab
// accused the application of accepting a stale dashboard key because the
// probe never got an answer.
//
// Fixed contract:
//   transport failure                    -> BLOCKED (TICKET_ROUTE_UNREACHABLE)
//   2xx                                  -> FAIL    (STALE_KEY_ACCEPTED)
//   401/403 + config answered, no secret -> PASS
//   401/403 + config unreachable         -> BLOCKED (CONFIG_UNREACHABLE)
//   secret fields served for a bad key   -> FAIL    (STALE_KEY_LEAKED_CREDENTIALS)
// ===========================================================================
module.exports = async ({ test, assert }) => {
  const path = require('path');
  const { STATUS } = require(path.join(__dirname, '..', 'lib', 'status.js'));
  const feat = require(path.join(__dirname, '..', 'lib', 'live-features.js'));
  const target = 'http://127.0.0.1:7331';
  const forged = 'not-this-runs-token';

  function transport(answers) {
    const calls = [];
    const send = async (url) => {
      calls.push(url);
      const key = url.includes('/api/rdp-token') ? 'ticket' : 'config';
      return answers[key];
    };
    send.calls = calls;
    return send;
  }

  await test('stale-key: a timed-out ticket probe is BLOCKED, never STALE_KEY_ACCEPTED', async () => {
    const http = transport({
      ticket: { transport: 'timeout', status: null, ok: false, json: null },
      config: { transport: 'ok', status: 200, ok: true, json: { ok: true } },
    });
    const r = await feat.evalStaleKey({ http, target, forgedToken: forged });
    assert.equal(r.status, STATUS.BLOCKED);
    assert.match(r.reason, /TICKET_ROUTE_UNREACHABLE/);
    assert.doesNotMatch(r.reason, /STALE_KEY_ACCEPTED/);
    assert.equal(r.evidence.ticketStatus, 'timeout');
  });

  await test('stale-key: a minted ticket for a foreign key is still a FAIL', async () => {
    const http = transport({
      ticket: { transport: 'ok', status: 200, ok: true, json: { rid: 'x', ttl: 60 } },
      config: { transport: 'ok', status: 200, ok: true, json: { ok: true } },
    });
    const r = await feat.evalStaleKey({ http, target, forgedToken: forged });
    assert.equal(r.status, STATUS.FAIL);
    assert.match(r.reason, /STALE_KEY_ACCEPTED/);
  });

  await test('stale-key: a refused key with an answered config is a PASS', async () => {
    const http = transport({
      ticket: { transport: 'ok', status: 401, ok: false, json: null },
      config: { transport: 'ok', status: 200, ok: true, json: { ok: true, creds: { fqdn: 'a.b.ts.net', user: 'u', ip: '100.64.0.1' } } },
    });
    const r = await feat.evalStaleKey({ http, target, forgedToken: forged });
    assert.equal(r.status, STATUS.PASS);
  });

  await test('stale-key: a refused key with an unreachable config is BLOCKED', async () => {
    const http = transport({
      ticket: { transport: 'ok', status: 401, ok: false, json: null },
      config: { transport: 'timeout', status: null, ok: false, json: null },
    });
    const r = await feat.evalStaleKey({ http, target, forgedToken: forged });
    assert.equal(r.status, STATUS.BLOCKED);
    assert.match(r.reason, /CONFIG_UNREACHABLE/);
  });

  await test('stale-key: the injected transport is actually used', async () => {
    const http = transport({
      ticket: { transport: 'ok', status: 401, ok: false, json: null },
      config: { transport: 'ok', status: 200, ok: true, json: { ok: true } },
    });
    await feat.evalStaleKey({ http, target, forgedToken: forged });
    assert.equal(http.calls.length, 2);
    assert.ok(http.calls[0].endsWith('/api/rdp-token'));
  });
};
