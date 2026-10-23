'use strict';
// AUTHORIZATION CLASSIFIER REGRESSIONS.
//
// Why this file exists: the lab reported one coarse AUTHORIZATION_UNAVAILABLE
// for a live origin whose server had actually answered, and separately refused
// every real origin with a CREDENTIAL_GATE_LEAKED claim that was simply wrong
// (the application always returns creds:{fqdn,user,ip} with no secret in it).
// The classifier in scripts/lib/live-auth.js is now layered, and every layer is
// pinned here against an OUT-OF-PROCESS emulator of the application's own route
// contract (scripts/test/fixtures/auth-gate-backend.js, a copy of
// payloads/ghrdp-server.ps1 @24ddaa9904c92dbbba39e3cc7aba458769e6bbe4).
//
// MOCKS PROVE THE CLASSIFIER, NOT THE APPLICATION. A green suite here means the
// lab will report the right subcode for a given server behaviour; it is never
// evidence that the live origin behaved that way.

const { spawn } = require('child_process');
const path = require('path');
const nodeCrypto = require('crypto');

const FIXTURE = path.join(__dirname, 'fixtures', 'auth-gate-backend.js');

function startGate(env = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [FIXTURE], { env: { ...process.env, PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch (e) { } reject(new Error('auth-gate fixture did not start')); }, 15000);
    c.stdout.on('data', d => {
      buf += d;
      const m = buf.match(/AUTH_GATE_LISTENING port=(\d+) pid=(\d+)/);
      if (m) { clearTimeout(t); resolve({ child: c, port: Number(m[1]), url: `http://127.0.0.1:${m[1]}` }); }
    });
    c.on('exit', code => { clearTimeout(t); reject(new Error(`auth-gate fixture exited ${code}`)); });
  });
}
function stopGate(g) { if (g && g.child && g.child.exitCode === null) { try { g.child.kill('SIGKILL'); } catch (e) { } } }

module.exports = async function register({ test, assert }) {
  const crypto = nodeCrypto;
  const auth = require('../lib/live-auth');
  const TOKEN = 'fixture-current-run-token-value';
  const FORGED = crypto.randomBytes(16).toString('hex');

  // Nothing in a classifier result may carry a ticket, a password or a token.
  function assertNoSecrets(obj, secrets) {
    const text = JSON.stringify(obj);
    for (const s of secrets) {
      if (s && text.includes(String(s))) throw new Error(`a secret value reached the report: ${String(s).slice(0, 4)}...`);
    }
  }

  async function prove(env, opts = {}) {
    const g = await startGate({ TOKEN, ...env });
    try {
      const r = await auth.proveAuthorization({
        target: g.url,
        dashboardToken: opts.token === undefined ? TOKEN : opts.token,
        clientIsTailnetPeer: opts.tailnet === undefined ? false : opts.tailnet,
        corroborate: opts.corroborate !== false,
        timeoutMs: opts.timeoutMs || 1500
      });
      return { r, url: g.url };
    } finally { stopGate(g); }
  }

  // ---- 1. the happy path: our bearer accepted, both negatives refused ------
  await test('auth gate: a current bearer that mints a ticket while anonymous+forged are refused is AUTHORIZATION_PROVEN', async () => {
    const { r } = await prove({ CONFIG_POLICY: 'key-only', SEARCH_LANE: 'current' });
    assert.equal(r.ok, true, `expected ok, got ${r.code}: ${r.detail}`);
    assert.equal(r.code, 'AUTHORIZATION_PROVEN');
    assert.equal(r.subcode, 'BEARER_SOURCE_PREREQUISITE_ISSUANCE_ALL_PASS');
    assert.equal(r.layers.bearer, 'ACCEPTED');
    assert.equal(r.layers.source, 'ACCEPTED');
    assert.equal(r.layers.prerequisite, 'ACCEPTED');
    assert.equal(r.layers.issuance, 'ISSUED');
    assert.equal(r.results.noBearer.status, 401);
    assert.equal(r.results.wrongBearer.status, 401);
    assert.equal(r.results.ourBearer.ticketFormatOk, true);
    assert.equal(r.results.ourBearer.ticketTtl, 60);
    assert.equal(r.configGate, 'enforced');
    assert.equal(r.configGateProven, true);
    assert.match(r.ticket, /^[0-9a-f]{32}$/, 'the in-memory ticket is the real value');
    // the ticket must not survive into anything that is written down
    const serializable = JSON.parse(JSON.stringify({ ...r, ticket: undefined }));
    assertNoSecrets(serializable, [r.ticket, TOKEN, FORGED]);
  });

  // ---- 2. source-policy rejection AFTER bearer validation -----------------
  await test('auth gate: a 403 after the bearer matched is SOURCE_POLICY_REJECTED, never a stale credential', async () => {
    const { r } = await prove({ SOURCE_POLICY: 'reject', CONFIG_POLICY: 'key-only' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'SOURCE_POLICY_REJECTED');
    assert.equal(r.subcode, 'BEARER_ACCEPTED_SOURCE_NOT_TAILNET');
    assert.equal(r.layers.bearer, 'ACCEPTED');
    assert.equal(r.layers.source, 'REJECTED');
    assert.equal(r.bearerAccepted, true);
    assert.equal(r.results.ourBearer.reasonCode, 'SOURCE_POLICY_DIRECT_TAILNET_REQUIRED');
    // the detail must SAY the credential was accepted and must not blame it
    assert.ok(/WAS accepted/i.test(r.detail), `detail must state the bearer passed: ${r.detail}`);
    assert.ok(/not a stale credential/i.test(r.detail));
    assert.notEqual(r.code, 'BEARER_REJECTED');
    assert.notEqual(r.code, 'AUTHORIZATION_REJECTED');
    assert.ok(/source/i.test(r.detail));
  });

  // ---- 3. missing MagicDNS prerequisite ----------------------------------
  await test('auth gate: a 409 after bearer+source is CONFIG_PREREQUISITE_MISSING (authorization proven, issuance blocked)', async () => {
    const { r } = await prove({ PREREQ: 'missing', CONFIG_POLICY: 'key-only' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CONFIG_PREREQUISITE_MISSING');
    assert.equal(r.subcode, 'PREREQUISITE_MAGICDNS_FQDN_MISSING');
    assert.equal(r.layers.bearer, 'ACCEPTED');
    assert.equal(r.layers.source, 'ACCEPTED');
    assert.equal(r.layers.prerequisite, 'MISSING');
    assert.equal(r.bearerAccepted, true);
  });

  // ---- 4a. our own request timed out: transport, not rejection -------------
  await test('auth gate: a transport timeout on the proving request is LIVE_TRANSPORT_INCOMPLETE, not a rejection', async () => {
    const { r } = await prove({ STALL: 'ours' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'LIVE_TRANSPORT_INCOMPLETE');
    assert.equal(r.subcode, 'TRANSPORT_TIMEOUT');
    assert.equal(r.layers.bearer, 'UNMEASURED');
    assert.ok(/NOT an authorization rejection/i.test(r.detail));
    assert.ok(!/AUTHORIZATION_REJECTED|stale/i.test(r.code + r.detail));
  });

  // ---- 4b. mixed transport outcomes: issuance ok, a negative never answered -
  await test('auth gate: a ticket issued while a negative control timed out is NEGATIVE_CONTROLS_INCOMPLETE (partial, not proven)', async () => {
    const { r } = await prove({ NEGATIVE_MODE: 'timeout', CONFIG_POLICY: 'key-only' });
    assert.equal(r.ok, false, 'a partial proof must never be ok');
    assert.equal(r.code, 'NEGATIVE_CONTROLS_INCOMPLETE');
    assert.equal(r.subcode, 'BOTH_NEGATIVES_TRANSPORT_FAILED');
    assert.equal(r.layers.issuance, 'ISSUED');
    assert.equal(r.layers.bearer, 'ACCEPTED');
    assert.equal(r.partial, true);
    assert.ok(/transport timeout is not a rejection/i.test(r.detail));
  });

  // ---- 5. empty / masked config fields are not a disclosure ----------------
  await test('auth gate: masked-only password metadata is CONFIG masked-only, not a leak', async () => {
    const { r } = await prove({ CONFIG_POLICY: 'masked' });
    assert.equal(r.ok, true, `masked metadata must not block a proven bearer: ${r.code}`);
    assert.equal(r.code, 'AUTHORIZATION_PROVEN');
    assert.equal(r.configGate, 'masked-only');
    assert.equal(r.configGateProven, false);
    assert.deepEqual(r.results.config.anonymous.raw, [], 'no raw password reached an anonymous caller');
    assert.deepEqual(r.results.config.wrongKey.raw, [], 'no raw password reached a forged-key caller');
    assert.ok(r.results.config.ourKey.masked.length > 0, 'the mask fields are reported by NAME');
    assert.ok(!r.results.config.ourKey.raw.length, 'a mask is never classified as raw');
  });

  await test('classifier: credentialDisclosure separates absent / empty / masked / raw', () => {
    const mk = json => ({ transport: 'ok', status: 200, json });
    assert.deepEqual(auth.credentialDisclosure(mk({ creds: { fqdn: 'a.ts.net', user: 'u', ip: '100.64.0.9' } })).raw, [],
      'the application\'s normal creds:{fqdn,user,ip} block is not a disclosure');
    const empty = auth.credentialDisclosure(mk({ creds: { windowsPass: '', vncPass: null } }));
    assert.deepEqual(empty.raw, []); assert.equal(empty.empty.length, 2);
    const masked = auth.credentialDisclosure(mk({ creds: { windowsPassMask: '************cdef' } }));
    assert.deepEqual(masked.raw, []); assert.deepEqual(masked.masked, ['creds.windowsPassMask']);
    const raw = auth.credentialDisclosure(mk({ creds: { windowsPass: 'real-secret-value' } }));
    assert.deepEqual(raw.raw, ['creds.windowsPass']);
    // a masked-shaped VALUE in the password field itself is still masked, not raw
    const maskedValue = auth.credentialDisclosure(mk({ creds: { windowsPass: '************cdef' } }));
    assert.deepEqual(maskedValue.raw, []); assert.deepEqual(maskedValue.masked, ['creds.windowsPass']);
    // nested containers are all inspected
    assert.deepEqual(auth.credentialDisclosure(mk({ rawCreds: { rdpPass: 'x'.repeat(12) } })).raw, ['rawCreds.rdpPass']);
  });

  await test('classifier: classifyConfigGate returns the five distinct outcomes', () => {
    const d = (raw = [], masked = [], empty = []) => ({ raw, masked, empty });
    assert.equal(auth.classifyConfigGate({ anonymous: d(), wrongKey: d(), ourKey: d() }), 'unsupported');
    assert.equal(auth.classifyConfigGate({ anonymous: d(), wrongKey: d(), ourKey: d(['creds.windowsPass']) }), 'enforced');
    assert.equal(auth.classifyConfigGate({ anonymous: d(['creds.windowsPass']), wrongKey: d(), ourKey: d(['creds.windowsPass']), sourceIsTailnet: false }), 'leaked');
    assert.equal(auth.classifyConfigGate({ anonymous: d(['creds.windowsPass']), wrongKey: d(['creds.windowsPass']), ourKey: d(['creds.windowsPass']), sourceIsTailnet: true }), 'tailnet-source-trust');
    assert.equal(auth.classifyConfigGate({ anonymous: d([], ['creds.windowsPassMask']), wrongKey: d([], ['creds.windowsPassMask']), ourKey: d([], ['creds.windowsPassMask']) }), 'masked-only');
    // an empty password field for a stranger is not a disclosure either
    assert.equal(auth.classifyConfigGate({ anonymous: d([], [], ['creds.windowsPass']), wrongKey: d(), ourKey: d(['creds.windowsPass']) }), 'enforced');
  });

  // ---- 6/8. genuine disclosure to a NON-tailnet caller --------------------
  await test('auth gate: a raw password served to an anonymous non-peer caller is CREDENTIAL_GATE_LEAKED (a real failure)', async () => {
    const { r } = await prove({ CONFIG_POLICY: 'leak' }, { tailnet: false });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CREDENTIAL_GATE_LEAKED');
    assert.equal(r.subcode, 'PASSWORD_DISCLOSED_TO_UNAUTHORIZED_CALLER');
    assert.deepEqual(r.results.config.anonymous.raw, ['creds.windowsPass']);
    // the leak must not erase the independent bearer result
    assert.equal(r.bearerProof, 'PROVEN');
    assert.equal(r.layers.bearer, 'ACCEPTED');
    assert.equal(r.layers.issuance, 'ISSUED');
  });

  // ---- 7. permitted tailnet-source access --------------------------------
  await test('auth gate: tailnet-source-permitted config access is inconclusive for the key gate and NEVER blocks bearer proof', async () => {
    const { r } = await prove({ CONFIG_POLICY: 'tailnet-trust' }, { tailnet: true });
    assert.equal(r.ok, true, `a documented source policy must not invalidate a proven bearer: ${r.code}`);
    assert.equal(r.code, 'AUTHORIZATION_PROVEN');
    assert.equal(r.configGate, 'tailnet-source-trust');
    assert.equal(r.configGateProven, false, 'source trust is not key-gate proof');
    assert.ok(r.findings.some(f => f.startsWith('APP-POLICY-01')), 'the policy conflict is recorded as a separate finding');
    assert.equal(r.results.source.isTailnetPeer, true);
    assert.equal(r.results.source.determinedBy, 'injected');
  });

  await test('auth gate: a tailnet peer is never told its own authorized access was a leak', async () => {
    const { r } = await prove({ CONFIG_POLICY: 'tailnet-trust' }, { tailnet: true });
    assert.notEqual(r.code, 'CREDENTIAL_GATE_LEAKED');
    assert.ok(!/leak/i.test(r.code));
  });

  // ---- 9. unsupported config contract ------------------------------------
  await test('auth gate: a build with no password block at all is configGate=unsupported, and bearer proof still stands', async () => {
    const { r } = await prove({ CONFIG_POLICY: 'none' });
    assert.equal(r.ok, true);
    assert.equal(r.configGate, 'unsupported');
    assert.equal(r.configGateProven, false);
    assert.ok(/no key-gated password block/i.test(r.detail));
  });

  // ---- passing a credential gate is not successful ticket issuance --------
  await test('auth gate: 200 without a well-formed rid is TICKET_ISSUANCE_MALFORMED', async () => {
    for (const mode of ['no-rid', 'malformed', 'bad-ttl']) {
      const { r } = await prove({ ISSUE_MODE: mode, CONFIG_POLICY: 'key-only' });
      assert.equal(r.ok, false, `${mode} must not be a pass`);
      assert.equal(r.code, 'TICKET_ISSUANCE_MALFORMED', `${mode} -> ${r.code}`);
      assert.equal(r.layers.bearer, 'ACCEPTED');
      assert.equal(r.layers.issuance, 'MALFORMED');
      assert.ok(/NOT successful ticket issuance/i.test(r.detail));
    }
  });

  await test('classifier: inspectTicket requires the documented 32-hex rid and a numeric ttl', () => {
    assert.equal(auth.inspectTicket({ json: { rid: 'a'.repeat(32), ttl: 60 } }).formatOk, true);
    assert.equal(auth.inspectTicket({ json: { rid: 'A'.repeat(32), ttl: 60 } }).formatOk, false, 'uppercase is not the documented shape');
    assert.equal(auth.inspectTicket({ json: { rid: 'a'.repeat(31), ttl: 60 } }).formatOk, false);
    assert.equal(auth.inspectTicket({ json: { ttl: 60 } }).present, false);
    assert.equal(auth.inspectTicket({ json: { rid: 'a'.repeat(32), ttl: 'soon' } }).ttlOk, false);
    assert.equal(auth.inspectTicket({ json: { rid: 'a'.repeat(32), ttl: 0 } }).ttlOk, false);
    assert.equal(auth.inspectTicket({ json: { rid: 'a'.repeat(32), ttl: 60 } }).ttlIsDocumented, true);
  });

  // ---- an unenforced bearer gate is a real failure -----------------------
  await test('auth gate: a ticket minted for an anonymous bearer too is BEARER_GATE_UNENFORCED', async () => {
    const { r } = await prove({ NEGATIVE_MODE: 'accept', CONFIG_POLICY: 'key-only' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'BEARER_GATE_UNENFORCED');
    assert.equal(r.layers.bearer, 'UNENFORCED');
  });

  // ---- 401 is separated into three causes by the server's own lanes -------
  await test('auth gate: 401 on the strict route while the refresh-aware lane accepts the SAME token is STRICT_ROUTE_CREDENTIAL_DIVERGENCE', async () => {
    // The application compares the strict /api/rdp-token credential against
    // dash-token.txt (authoritative) and the search lane against the
    // refresh-aware union. STRICT_TOKEN models the two disagreeing - the exact
    // situation that previously produced one unreadable AUTHORIZATION_REJECTED.
    const { r } = await prove({ STRICT_TOKEN: 'a-different-strict-credential', CONFIG_POLICY: 'key-only', SEARCH_LANE: 'current' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'BEARER_REJECTED');
    assert.equal(r.subcode, 'STRICT_ROUTE_CREDENTIAL_DIVERGENCE');
    assert.equal(r.results.refreshAware.code, 'REFRESH_AWARE_CURRENT');
    assert.ok(/refresh-aware comparator/i.test(r.detail), r.detail);
    assert.ok(/STRICT/i.test(r.detail));
    assertNoSecrets({ ...r, ticket: undefined }, [TOKEN]);
  });

  await test('auth gate: 401 refused by BOTH comparators is BEARER_REJECTED_TOKEN_NOT_CURRENT', async () => {
    const { r } = await prove({ CONFIG_POLICY: 'key-only', SEARCH_LANE: 'refuse' }, { token: 'a-credential-this-run-never-published' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'BEARER_REJECTED');
    assert.equal(r.subcode, 'BEARER_REJECTED_TOKEN_NOT_CURRENT');
    assert.equal(r.results.refreshAware.code, 'REFRESH_AWARE_REJECTED');
    assert.equal(r.layers.bearer, 'REJECTED');
    assert.equal(r.layers.issuance, 'NOT_REACHED');
  });

  await test('auth gate: 401 because the server has NO dash token is named SERVER_HAS_NO_DASH_TOKEN', async () => {
    const g = await startGate({ TOKEN: '', CONFIG_POLICY: 'none', SEARCH_LANE: 'no-token' });
    // faithful emulation: with no server credential at all, OUR presented token
    // mismatches while the ANONYMOUS probe reports 'server-has-no-dash-token'.
    try {
      const r = await auth.proveAuthorization({ target: g.url, dashboardToken: TOKEN, clientIsTailnetPeer: false, corroborate: true, timeoutMs: 1500 });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'BEARER_REJECTED');
      assert.equal(r.subcode, 'SERVER_HAS_NO_DASH_TOKEN');
      assert.equal(r.results.refreshAware.code, 'REFRESH_AWARE_SERVER_HAS_NO_TOKEN');
      assert.equal(r.results.refreshAware.probes.anonymous.reason, 'server-has-no-dash-token');
      assert.equal(r.results.refreshAware.probes.serverHasNoDashToken, true);
      assert.equal(r.results.refreshAware.probes.ours.reason, 'token-mismatch-after-refresh-aware-compare');
      // booleans only: the server's hashes are compared, never copied out
      assert.equal(typeof r.results.refreshAware.probes.ours.expectedHashEqualsMine, 'boolean');
    } finally { stopGate(g); }
  });

  await test('classifier: probeRefreshAwareToken separates current / rejected / no-token / unenforced / absent', async () => {
    const cases = [
      [{ SEARCH_LANE: 'current' }, TOKEN, 'REFRESH_AWARE_CURRENT', true],
      [{ SEARCH_LANE: 'refuse' }, TOKEN, 'REFRESH_AWARE_REJECTED', false],
      [{ SEARCH_LANE: 'no-token' }, TOKEN, 'REFRESH_AWARE_SERVER_HAS_NO_TOKEN', false],
      [{ SEARCH_LANE: 'absent' }, TOKEN, 'REFRESH_AWARE_UNPROVEN', false]
    ];
    for (const [env, tok, wantCode, wantOk] of cases) {
      const g = await startGate({ TOKEN, ...env });
      try {
        const r = await auth.probeRefreshAwareToken(g.url, tok);
        assert.equal(r.code, wantCode, `${JSON.stringify(env)} -> ${r.code}`);
        assert.equal(Boolean(r.ok), wantOk);
      } finally { stopGate(g); }
    }
    // query credentials are refused by the route, so the probe must use a header
    const g = await startGate({ TOKEN });
    try {
      const r = await auth.probeRefreshAwareToken(g.url, TOKEN);
      assert.equal(r.results.ours.code, 'UNKNOWN_SOURCE', 'the sentinel id must reach the post-auth branch');
      assertNoSecrets(r.results, [TOKEN]);
    } finally { stopGate(g); }
  });

  await test('classifier: findTokenRing locates the ring structurally, not by a fixed key name', () => {
    const ring = [{ route: '/api/rdp-token', presentedHash: 'aaaa1111', expectedHash: 'bbbb2222', valid: false }];
    assert.equal(auth.findTokenRing({ a: { b: { comparisons: ring } } }), ring);
    assert.equal(auth.findTokenRing({ x: [1, 2, { y: ring }] }), ring);
    assert.equal(auth.findTokenRing({ nothing: true }), null);
    assert.equal(auth.findTokenRing(null), null);
  });

  // ---- ticket lifecycle: probe tickets are NOT launch tickets -------------
  await test('tickets: mintTicket labels its purpose and redeemTicket classifies by layer without returning the body', async () => {
    const g = await startGate({ TOKEN, TICKET_TTL: '5' });
    try {
      const probe = await auth.mintTicket(g.url, TOKEN, { purpose: 'authorization-proof' });
      assert.equal(probe.ok, true);
      assert.equal(probe.purpose, 'authorization-proof');
      assert.match(probe.ticket, /^[0-9a-f]{32}$/);

      const launch = await auth.mintTicket(g.url, TOKEN, { purpose: 'native-launch' });
      assert.equal(launch.ok, true);
      assert.notEqual(launch.ticket, probe.ticket, 'a launch ticket is minted fresh, never reused from the proof');

      const first = await auth.redeemTicket(g.url, launch.ticket);
      assert.equal(first.ok, true);
      assert.equal(first.code, 'TICKET_REDEEMED');
      assert.equal(first.bodySuppressed, true, 'the redemption body (which carries the RDP password) is never returned');
      assertNoSecrets(first, ['fixture-secret-password', launch.ticket]);

      const second = await auth.redeemTicket(g.url, launch.ticket);
      assert.equal(second.ok, false);
      assert.equal(second.code, 'REDEEM_TICKET_REFUSED');
      assert.equal(second.subcode, 'TICKET_INVALID_OR_EXPIRED');

      const unknown = await auth.redeemTicket(g.url, crypto.randomBytes(16).toString('hex'));
      assert.equal(unknown.ok, false);
      assert.equal(unknown.code, 'REDEEM_TICKET_REFUSED');

      const malformed = await auth.redeemTicket(g.url, 'not-a-ticket');
      assert.equal(malformed.code, 'TICKET_SHAPE_INVALID');
      assert.equal(malformed.observation.transport, 'not-sent', 'a malformed ticket is never sent to the server');
    } finally { stopGate(g); }
  });

  await test('tickets: an expired ticket is distinguishable from a consumed one only inside the ttl window', async () => {
    const g = await startGate({ TOKEN, TICKET_TTL: '1' });
    try {
      const t = await auth.mintTicket(g.url, TOKEN, { purpose: 'expiry-window' });
      assert.equal(t.ok, true);
      assert.ok(t.expiresAtEpochMs > Date.now());
      await new Promise(res => setTimeout(res, 1300));
      const late = await auth.redeemTicket(g.url, t.ticket);
      assert.equal(late.ok, false);
      assert.equal(late.code, 'REDEEM_TICKET_REFUSED', 'the server answers 401 for expiry AND consumption - the caller must not claim single-use from a late probe');
      assert.ok(Date.now() > t.expiresAtEpochMs, 'the caller can tell this 401 was inside the expiry window');
    } finally { stopGate(g); }
  });

  await test('tickets: mint failures carry the same layer subcodes as the proof', async () => {
    const g = await startGate({ TOKEN, SOURCE_POLICY: 'reject' });
    try {
      const r = await auth.mintTicket(g.url, TOKEN, { purpose: 'launch' });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'TICKET_NOT_ISSUED');
      assert.equal(r.subcode, 'SOURCE_POLICY_REJECTED');
    } finally { stopGate(g); }
  });

  // ---- the whole server is silent ---------------------------------------
  await test('auth gate: every request timing out is LIVE_BACKEND_UNREACHABLE, not an authorization verdict', async () => {
    const g = await startGate({ TOKEN, STALL: 'all' });
    try {
      const r = await auth.proveAuthorization({ target: g.url, dashboardToken: TOKEN, clientIsTailnetPeer: false, corroborate: false, timeoutMs: 1500 });
      assert.equal(r.ok, false);
      assert.ok(['LIVE_BACKEND_UNREACHABLE', 'LIVE_TRANSPORT_INCOMPLETE'].includes(r.code), `got ${r.code}`);
      assert.notEqual(r.code, 'BEARER_REJECTED');
    } finally { stopGate(g); }
  });

  await test('auth gate: no token to prove is TOKEN_ABSENT before any request is sent', async () => {
    const r = await auth.proveAuthorization({ target: 'http://127.0.0.1:1', dashboardToken: '' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'TOKEN_ABSENT');
  });
};
