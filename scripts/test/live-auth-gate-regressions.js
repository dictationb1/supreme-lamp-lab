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





  await test('live: an unstamped /api/version is BLOCKED (not a false "different instance")', async () => {
    const feat = require('../lib/live-features');
    const http2 = require('http');
    const srv = http2.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sha: 'dev', sha7: 'dev' }));
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    try {
      const r = await feat.evalProvenance({ target: `http://127.0.0.1:${srv.address().port}`, descriptor: { appSha: 'c470531e4739be072daea20425a1de203d0ed326', uiBuild: 'ui-x' } });
      assert.strictEqual(r.status, 'BLOCKED', JSON.stringify(r));
      assert.match(r.reason, /VERSION_STAMP_ABSENT/);
      assert.ok(!/different instance/.test(r.reason), 'an unstamped endpoint is not proof of another instance');
    } finally { srv.close(); }
  });

  await test('live: a genuine different sha stays a FAIL', async () => {
    const feat = require('../lib/live-features');
    const http2 = require('http');
    const srv = http2.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sha: 'a'.repeat(40) }));
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    try {
      const r = await feat.evalProvenance({ target: `http://127.0.0.1:${srv.address().port}`, descriptor: { appSha: 'c470531e4739be072daea20425a1de203d0ed326' } });
      assert.strictEqual(r.status, 'FAIL');
      assert.match(r.reason, /BACKEND_SHA_MISMATCH/);
    } finally { srv.close(); }
  });

  await test('live: no evaluator can hang the pass (watchdog + dialogs + no bare in-page fetch)', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'live-run.js'), 'utf8');
    const featSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'live-features.js'), 'utf8');
    // MEASURED (run 39920375772): the job was killed at 45 minutes with ZERO
    // feature verdicts. Three guards, each pinned:
    assert.match(src, /EVALUATOR_TIMEOUT/, 'a per-evaluator watchdog must exist');
    assert.match(src, /Promise\.race\(\[fn\(\), guard\]\)/, 'the evaluator must be raced against its budget');
    assert.match(src, /'--feature-timeout-ms'/, 'the budget must be settable, not magic');
    assert.match(src, /page\.on\('dialog'/, 'a script dialog blocks every evaluate; it must be answered and recorded');
    assert.match(featSrc, /AbortController/, 'an in-page fetch needs its own deadline');
    assert.match(featSrc, /PROBE_TIMEOUT_AFTER_8S/, 'and its timeout must be a reported verdict');
    // every page.evaluate goes through withTimeout: Playwright gives evaluate no
    // default timeout, and the auth gate's DOM read is the first thing the pass does.
    const evals = (src.match(/page\.evaluate\(/g) || []).length;
    const guarded = (src.match(/withTimeout\(page\.evaluate\(/g) || []).length;
    assert.strictEqual(guarded, evals, `every page.evaluate must be bounded (${guarded}/${evals})`);
    assert.match(src, /function withTimeout\(/, 'the bounded-evaluate helper must exist');
    // the stage timeline is on the run page, so a dead job still says where it was
    assert.match(src, /annotate\.notice\('stage'/, 'every stage transition must be visible on the run page');
    assert.match(src, /annotate\.notice\('feature start'/, 'long evaluators must announce their start');
  });

  await test('live: the UI pass measures the shipped dashboard, not invented hash routes', async () => {
    const feat = require('../lib/live-features');
    const live = require('../live-run');
    const src = fs.readFileSync(path.join(__dirname, '..', 'live-run.js'), 'utf8');
    // MEASURED: payloads/ui.html has no hash router. A `#/overview` list measured
    // URLs the application never had and then blamed it for the result.
    assert.doesNotMatch(src, /#\/overview|#\/sessions|#\/files|#\/telemetry/, 'no invented hash routes');
    assert.doesNotMatch(src, /function defaultRoutes/, 'the invented route list is gone');
    const surfaces = live.defaultSurfaces({ authorizedEndpoint: 'http://100.64.0.5:7331' });
    const ids = surfaces.map(x => x.id);
    for (const must of ['#pillConn', '#sec-conn', '#sec-keys', '#sec-native-rdp', '#sec-mirror', '#sec-log', '#fileRows']) {
      assert.ok(ids.includes(must), `the dashboard contract must name the app's own anchor ${must}: ${ids}`);
    }
    // A build that DOES publish routes still wins (a future router must not be
    // locked out by this fix).
    const declared = [{ id: 'x', url: 'http://h/#/x' }];
    const viaRoutes = await feat.evalDashboardSurfaces({ page: { goto: async () => {} }, markers: { errorCount: () => 0, routeMarker: async () => ({ found: true, via: 't' }) }, surfaces, routes: declared });
    assert.strictEqual(viaRoutes.status, 'PASS', JSON.stringify(viaRoutes));
    assert.strictEqual(viaRoutes.evidence.mode, undefined, 'declared routes go through evalRoutes');
    // The dashboard path: every surface present, zero errors -> PASS
    const page = { goto: async () => {}, __errors: { n: 0, samples: [] } };
    const markers = {
      errorCount: p => p.__errors.n,
      errorSamples: (p, n) => p.__errors.samples.slice(-n),
      pageSections: async (p, sels) => Object.fromEntries(sels.map(x => [x, { found: x !== '#sec-log', visible: true, textLen: 12 }]))
    };
    const missing = await feat.evalDashboardSurfaces({ page, markers, surfaces, target: 'http://h:7331' });
    assert.strictEqual(missing.status, 'FAIL', JSON.stringify(missing));
    assert.match(missing.reason, /1\/7 documented dashboard surface\(s\) missing: #sec-log/);
    const all = { ...markers, pageSections: async (p, sels) => Object.fromEntries(sels.map(x => [x, { found: true, visible: true, textLen: 12 }])) };
    const pass = await feat.evalDashboardSurfaces({ page, markers: all, surfaces, target: 'http://h:7331' });
    assert.strictEqual(pass.status, 'PASS', JSON.stringify(pass));
    assert.match(pass.reason, /rendered all 7 documented surfaces/);
    // ... and an error on a complete dashboard is still a FAIL, with its text
    const noisy = { ...all, errorCount: p => p.__errors.n, errorSamples: () => ['TypeError: boom'] };
    const noisyPage = { goto: async () => { noisyPage.__errors.n = 1; }, __errors: { n: 0, samples: [] } };
    const err = await feat.evalDashboardSurfaces({ page: noisyPage, markers: noisy, surfaces, target: 'http://h:7331' });
    assert.strictEqual(err.status, 'FAIL', JSON.stringify(err));
    assert.match(err.reason, /TypeError: boom/);
  });

  await test('live: readiness and binding are two different measurements, not one readiness check twice', async () => {
    const feat = require('../lib/live-features');
    const http2 = require('http');
    const ready = { ok: true, status: 'ok', phase: 'ready', apiReadiness: true, pid: 1234, port: 7331, serverTs: '2026-10-23T04:20:00Z' };
    const partial = { ...ready, ok: false, status: 'ok' };
    let readiness = ready;
    const srv = http2.createServer((req, res) => {
      const u = String(req.url);
      if (u.startsWith('/api/readiness')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(readiness)); }
      if (u.startsWith('/api/progress')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ serverTs: ready.serverTs, runStartedAt: '2026-10-23T04:12:31Z', startedAt: '2026-10-23T04:13:48Z', sessionStartedAt: '2026-10-23T04:13:50Z' }));
      }
      res.writeHead(404); res.end();
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const target = `http://127.0.0.1:${srv.address().port}`;
    try {
      const r1 = await feat.evalReadinessContract({ target, descriptor: { port: 7331 } });
      assert.strictEqual(r1.status, 'PASS', JSON.stringify(r1));
      const live = await feat.evalLiveBinding({ target, descriptor: { originRunId: 39899087271 }, originRunStartedAt: '2026-10-23T04:12:31Z' });
      assert.strictEqual(live.status, 'PASS', JSON.stringify(live));
      assert.strictEqual(live.evidence.deltaMs, 0);
      // a partial readiness answer is a contract FAIL with its own code
      readiness = partial;
      const r2 = await feat.evalReadinessContract({ target, descriptor: { port: 7331 } });
      assert.strictEqual(r2.status, 'FAIL', JSON.stringify(r2));
      assert.match(r2.reason, /READINESS_/);
      // ... and it must NOT decide the binding feature
      const stillLive = await feat.evalLiveBinding({ target, descriptor: { originRunId: 39899087271 }, originRunStartedAt: '2026-10-23T04:12:31Z' });
      assert.strictEqual(stillLive.status, 'PASS', 'one readiness problem must not veto two features');
      // a process from another run is a mismatch, and an unreported start is BLOCKED
      const wrong = await feat.evalLiveBinding({ target, descriptor: { originRunId: 1 }, originRunStartedAt: '2026-10-23T06:00:00Z' });
      assert.strictEqual(wrong.status, 'FAIL', JSON.stringify(wrong));
      assert.match(wrong.reason, /BINDING_MISMATCH/);
      const unknown = await feat.evalLiveBinding({ target, descriptor: { originRunId: 1 }, originRunStartedAt: '' });
      assert.strictEqual(unknown.status, 'BLOCKED', JSON.stringify(unknown));
      assert.match(unknown.reason, /BINDING_NO_ORIGIN_TIMESTAMP/);
    } finally { srv.close(); }
  });

  await test('live: a forged key that only sees creds{fqdn,user,ip} is NOT called a credential leak', async () => {
    const feat = require('../lib/live-features');
    const http2 = require('http');
    let mode = 'names-only';
    const srv = http2.createServer((req, res) => {
      if (String(req.url).startsWith('/api/rdp-token')) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{}'); }
      const body = mode === 'names-only'
        ? { creds: { fqdn: 'x.ts.net', user: 'runneradmin', ip: '100.64.0.9' } }
        : { creds: { fqdn: 'x.ts.net', user: 'runneradmin', windowsPass: 'nope' } };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const target = `http://127.0.0.1:${srv.address().port}`;
    try {
      const clean = await feat.evalStaleKey({ target, forgedToken: 'deadbeef' });
      assert.strictEqual(clean.status, 'PASS', JSON.stringify(clean));
      assert.deepStrictEqual(clean.evidence.configLeakedFields, [], 'the app always returns creds without secrets');
      mode = 'leaky';
      const leaky = await feat.evalStaleKey({ target, forgedToken: 'deadbeef' });
      assert.strictEqual(leaky.status, 'FAIL', JSON.stringify(leaky));
      assert.match(leaky.reason, /STALE_KEY_LEAKED_CREDENTIALS/);
      assert.deepStrictEqual(leaky.evidence.configLeakedFields, ['creds.windowsPass'], 'field NAMES only, never a value');
    } finally { srv.close(); }
  });

  await test('live: the auth feature names the ticket-route defect, not "bad credential"', async () => {
    const feat = require('../lib/live-features');
    const authProof = { ok: false, code: 'AUTHORIZATION_REJECTED', detail: 'ourBearer=401', results: { ourBearer: { status: 401 }, noBearer: { status: 401 }, wrongBearer: { status: 401 } } };
    const markers = { gateCleared: async () => ({ cleared: true, via: 'dom', detail: 'app shell rendered without the gate' }) };
    const staleOutcome = { code: 'APP_TICKET_ROUTE_BOOT_SNAPSHOT_STALE', refreshAware: { code: 'REFRESH_AWARE_CURRENT' } };
    const r = await feat.evalAuthGate({ authProof, page: {}, markers, authOutcome: staleOutcome });
    assert.strictEqual(r.status, 'FAIL', 'an application defect is a FAIL, never BLOCKED and never PASS');
    assert.match(r.reason, /^APP_TICKET_ROUTE_BOOT_SNAPSHOT_STALE/);
    assert.match(r.reason, /REFRESH_AWARE_CURRENT/);
    assert.match(r.reason, /application defect, not a stale credential/);
    assert.strictEqual(r.evidence.ui.cleared, true, 'the UI gate result is still reported');
    assert.strictEqual(r.evidence.authorization.code, 'APP_TICKET_ROUTE_BOOT_SNAPSHOT_STALE');
    // Without the rescue the plain gate code is still reported honestly.
    const plain = await feat.evalAuthGate({ authProof, page: null, markers, authOutcome: { code: 'AUTHORIZATION_REJECTED' } });
    assert.strictEqual(plain.status, 'FAIL');
    assert.match(plain.reason, /AUTHORIZATION_REJECTED/);
    // And a proven credential with a stale UI gate is still a FAIL.
    const uiFail = await feat.evalAuthGate({ authProof: { ok: true, results: {}, configGate: 'x' }, page: {}, markers: { gateCleared: async () => ({ cleared: false, detail: 'the token gate is still rendered' }) } });
    assert.strictEqual(uiFail.status, 'FAIL');
    assert.match(uiFail.reason, /UI_GATE_NOT_CLEARED/);
  });

  await test('live: the feature pass gets the budget the measured run needed', async () => {
    const wf = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'live-run.yml'), 'utf8');
    const m = wf.match(/'--timeout-ms', '(\d+)'/);
    assert.ok(m, 'the live step must pass an explicit deadline');
    assert.ok(Number(m[1]) >= 1800000, `a full feature pass measured ~31 min; ${m[1]} ms would cut it short`);
    const job = wf.match(/name: client VM \(live Mission Control\)[\s\S]{0,200}?timeout-minutes: (\d+)/);
    assert.ok(job && Number(job[1]) >= 45, 'the job timeout must leave room for the pass, the report and the cleanup');
  });

  await test('live: a route that renders with errors says WHICH error (not only a count)', async () => {
    const feat = require('../lib/live-features');
    const samples = ['TypeError: x is not a function', 'Failed to load resource: 401 @ /api/rdp-token'];
    // the route ADDS the errors: a delta is what evalRoutes reports
    const page = { __errors: { n: 0, samples: [] }, goto: async () => { page.__errors.n = 2; page.__errors.samples.push(...samples); } };
    const markers = {
      errorCount: p => p.__errors.n,
      errorSamples: (p, n) => p.__errors.samples.slice(-n),
      routeMarker: async () => ({ found: true, via: 'testid:topbar' })
    };
    const r = await feat.evalRoutes({ page, routes: [{ id: 'overview', url: 'http://127.0.0.1:1/#/overview' }], markers });
    assert.strictEqual(r.status, 'FAIL', JSON.stringify(r));
    assert.match(r.reason, /overview=rendered-with-errors/, 'the route name and status stay in the reason');
    assert.match(r.reason, /TypeError: x is not a function/, 'the operator must be able to act on it');
    assert.strictEqual(r.evidence.routes[0].newErrors, 2);
    assert.deepStrictEqual(r.evidence.routes[0].errors, samples);
    // A clean route stays clean and carries no error text.
    const quiet = { __errors: { n: 2, samples }, goto: async () => { } };
    const clean = await feat.evalRoutes({ page: quiet, routes: [{ id: 'overview', url: 'u' }], markers });
    assert.strictEqual(clean.status, 'PASS', JSON.stringify(clean));
  });

  await test('live: the error collector keeps the newest samples (a per-route delta must read from the tail)', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'live-run.js'), 'utf8');
    assert.match(src, /pageErrors\.samples\.splice\(0, pageErrors\.samples\.length - 8\)/, 'the ring must drop the OLDEST samples');
    assert.doesNotMatch(src, /samples\.length < 5/, 'the first-five-only collector hid the route that was actually failing');
    assert.match(src, /errorSamples\(page, n\)/, 'the marker surface must expose the samples');
  });

  await test('live: no call site references a helper that does not exist', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'live-run.js'), 'utf8');
    assert.doesNotMatch(src, /summarizeToCapabilities\s*\(/, 'the dead helper must have no call site');
    // Every bare identifier called as foo( that is not defined locally/required
    // is out of scope for a regex; this pins the one that broke REPORTING.
    const mod = require('../live-run');
    assert.strictEqual(typeof mod.cmdLive, 'function');
  });

  await test('auth: the refresh-aware route separates "stale credential" from "stale ticket route"', async () => {
    const token = 'run-token-current-0123456789';
    let mode = 'current';
    const srv = http.createServer((req, res) => {
      if (!String(req.url).startsWith('/api/search/status')) { res.writeHead(404); return res.end(); }
      const presented = String(req.headers['x-dash-token'] || '');
      const ok = mode === 'unenforced' ? true : (mode === 'current' && presented === token);
      if (!ok) { res.writeHead(403, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ code: 'AUTH_REQUIRED' })); }
      // post-auth: the sentinel search id is unknown
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'UNKNOWN_SOURCE' }));
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const target = `http://127.0.0.1:${srv.address().port}`;
    const authLib = require('../lib/live-auth');
    try {
      const cur = await authLib.probeRefreshAwareToken(target, token);
      assert.strictEqual(cur.code, 'REFRESH_AWARE_CURRENT', JSON.stringify(cur));
      mode = 'rejected';
      const rej = await authLib.probeRefreshAwareToken(target, token);
      assert.strictEqual(rej.code, 'REFRESH_AWARE_REJECTED');
      mode = 'unenforced';
      const un = await authLib.probeRefreshAwareToken(target, token);
      assert.strictEqual(un.code, 'REFRESH_AWARE_UNENFORCED', 'a gate that serves everyone proves nothing');
      const none = await authLib.probeRefreshAwareToken(target, '');
      assert.strictEqual(none.code, 'TOKEN_ABSENT');
      // the probe never puts the token in a URL
      assert.ok(!JSON.stringify(await authLib.probeRefreshAwareToken(target, token)).includes(token));
    } finally { srv.close(); }
  });

  await test('live: a stale ticket route is named, and RDP is not claimed from it', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'live-run.js'), 'utf8');
    assert.match(src, /APP_TICKET_ROUTE_BOOT_SNAPSHOT_STALE/);
    assert.match(src, /probeRefreshAwareToken/);
    assert.match(src, /report\.authorization\.outcome = 'PROVEN_FOR_UI_TICKET_ROUTE_STALE'/);
    assert.match(src, /Unattended native RDP must therefore be reported BLOCKED/, 'the report says what is NOT proven');
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
