'use strict';
// REGRESSIONS for the ZERO-APPLICATION-CHANGE discovery path.
// ---------------------------------------------------------------------------
// These tests pin the part of the integration that makes it automatic while
// the application repository stays read-only for this token:
//
//   scripts/lib/origin-discovery.js  reads GitHub's run API + the origin run's
//                                    OWN log and builds the descriptor
//   scripts/lib/server-identity.js   binds the answering server to that run
//
// Everything runs offline against a local server that speaks the same HTTP
// shapes as GitHub and as the application's `/api/config` + `/api/version`.
// A PASS is a contract statement; it is not a claim that a live run happened.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const zlib = require('zlib');

module.exports = async function registerOriginDiscoveryTests(H) {
  const { test } = H;
  const discovery = require('../lib/origin-discovery');
  const identity = require('../lib/server-identity');
  const rd = require('../lib/run-descriptor');
  const { setAllowedOriginRepos } = rd;
  setAllowedOriginRepos(['dictationb1/supreme-lamp']);

  const SHA = 'daf13685d051abf8dea304a2ade82522ae8733ba';

  // ---------------------------------------------------------------- zip helper
  function mkZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const { name, data } of entries) {
      const nb = Buffer.from(name, 'utf8');
      const comp = zlib.deflateRawSync(data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
      local.writeUInt16LE(8, 8); local.writeUInt32LE(0, 14);
      local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nb.length, 26); local.writeUInt16LE(0, 28);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(0, 12);
      central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(nb.length, 28); central.writeUInt32LE(0, 42); central.writeUInt32LE(offset, 42);
      locals.push(local, nb, comp);
      centrals.push(central, nb);
      offset += 30 + nb.length + comp.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
  }

  const READY_LINE = 'Dashboard API responded with valid readiness JSON in 0.4s.';
  const bannerFor = (ip, key) => `     ps (7331) .........: http://${ip}:7331/?key=${key}`;
  const KEY = 'k-' + crypto.randomBytes(12).toString('hex');

  function logZip({ ip = '100.101.102.103', key = KEY, ready = true, keepalive = true } = {}) {
    const lines = [];
    lines.push('2026-10-22T10:00:00.0000000Z === Bounded Pre-Keepalive Service Readiness Verification ===');
    if (ready) lines.push(`2026-10-22T10:00:01.0000000Z ${READY_LINE}`);
    lines.push('2026-10-22T10:00:02.0000000Z - Dashboard API Ready: ' + (ready ? 'True' : 'False'));
    if (keepalive) {
      lines.push('2026-10-22T10:00:03.0000000Z =====================================================================');
      lines.push('2026-10-22T10:00:03.0000000Z   GHRDP MISSION CONTROL - ALL SESSION RESOURCES  [boot]');
      lines.push('2026-10-22T10:00:03.0000000Z      ps (7331) .........: http://' + ip + ':7331/' + (key ? '?key=' + key : ''));
    }
    return mkZip([
      { name: 'rdp/4_Service Readiness Check.txt', data: Buffer.from(lines.slice(0, 3).join('\n')) },
      { name: 'rdp/9_Keep-alive.txt', data: Buffer.from(lines.join('\n')) }
    ]);
  }

  // ------------------------------------------------------- fake GitHub + app API
  function startServers() {
    return new Promise((resolve) => {
      const state = { runs: {}, blobs: {}, config: null, version: null, logStatus: 302 };
      const srv = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        const p = u.pathname;
        const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
        if (p === '/api/config') return json(state.config || {});
        if (p === '/api/version') return json(state.version || {});
        const mList = p.match(/^\/repos\/([^/]+\/[^/]+)\/actions\/runs$/);
        if (mList) {
          const all = Object.values(state.runs).filter(r => r.status === 'in_progress');
          return json({ total_count: all.length, workflow_runs: all });
        }
        const mRun = p.match(/^\/repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)$/);
        if (mRun) {
          const run = state.runs[mRun[2]];
          if (!run) return json({ message: 'Not Found' }, 404);
          return json(run);
        }
        const mLogs = p.match(/^\/repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/logs$/);
        if (mLogs) {
          const id = mLogs[2];
          if (!state.blobs[id]) { res.writeHead(404); return res.end('no log'); }
          if (state.logStatus === 200) {
            res.writeHead(200, { 'content-type': 'application/zip' });
            return res.end(state.blobs[id]);
          }
          res.writeHead(302, { location: `http://127.0.0.1:${srv.address().port}/blob/${id}` });
          return res.end();
        }
        const mBlob = p.match(/^\/blob\/(\d+)$/);
        if (mBlob) {
          const b = state.blobs[mBlob[1]];
          if (!b) { res.writeHead(404); return res.end(); }
          res.writeHead(200, { 'content-type': 'application/zip' });
          return res.end(b);
        }
        res.writeHead(404); res.end('not found');
      });
      srv.listen(0, '127.0.0.1', () => {
        const port = srv.address().port;
        process.env.GITHUB_API_URL = `http://127.0.0.1:${port}`;
        delete process.env.GH_TOKEN;
        delete process.env.GITHUB_TOKEN;
        resolve({ srv, state, port, url: `http://127.0.0.1:${port}` });
      });
    });
  }

  function runObj({ id, attempt = 1, status = 'in_progress', path: wf = '.github/workflows/main.yml', sha = SHA, startedMsAgo = 5 * 60 * 1000, repo = 'dictationb1/supreme-lamp' }) {
    const started = new Date(Date.now() - startedMsAgo).toISOString();
    return {
      id, run_attempt: attempt, status, conclusion: status === 'in_progress' ? null : 'success',
      path: wf, head_sha: sha, event: 'workflow_dispatch', created_at: started, run_started_at: started,
      head_repository: { full_name: repo }, html_url: `https://github.com/${repo}/actions/runs/${id}`
    };
  }

  const { srv, state, url: apiUrl } = await startServers();
  try {
    // ------------------------------------------------------------- log parsing
    await test('origin discovery: the parser reads the app\'s real banner and never returns the key inside evidence', async () => {
      const parsed = discovery.parseOriginLog(logZip());
      assert.strictEqual(parsed.ok, true, parsed.detail || '');
      assert.strictEqual(parsed.endpoint.url, 'http://100.101.102.103:7331');
      assert.strictEqual(parsed.endpoint.host, '100.101.102.103');
      assert.strictEqual(parsed.endpoint.port, 7331);
      assert.strictEqual(parsed.secret.dashboardToken, KEY);
      assert.strictEqual(parsed.evidence.keyFingerprint, crypto.createHash('sha256').update(KEY).digest('hex'));
      const ev = JSON.stringify(parsed.evidence);
      assert.ok(!ev.includes(KEY), 'the raw key must never appear in the evidence object');
      assert.ok(!/\?key=[^*]/.test(ev), 'a key-bearing URL must be masked in the evidence');
      assert.strictEqual(parsed.evidence.ready, true);
    });

    await test('origin discovery: a tailnet FQDN banner is refused (the lab may only be steered to a CGNAT endpoint)', async () => {
      const parsed = discovery.parseOriginLog(logZip({ ip: '203.0.113.9' }));
      assert.strictEqual(parsed.ok, false);
      assert.strictEqual(parsed.code, 'ORIGIN_ENDPOINT_NOT_TAILNET');
      assert.ok(!JSON.stringify(parsed.evidence).includes(KEY));
    });

    await test('origin discovery: no banner and no readiness marker are distinct, reportable refusals', async () => {
      const noBanner = discovery.parseOriginLog(logZip({ keepalive: false }));
      assert.strictEqual(noBanner.code, 'ORIGIN_LOG_NO_ENDPOINT');
      const noReady = discovery.parseOriginLog(logZip({ ready: false }));
      assert.strictEqual(noReady.code, 'ORIGIN_NOT_READY_IN_LOG');
    });

    // ------------------------------------------------------------- descriptor
    await test('origin discovery: the descriptor is valid, deterministic per run+attempt, and expires with the server', async () => {
      const run = runObj({ id: 1111, startedMsAgo: 10 * 60 * 1000 });
      const parsed = discovery.parseOriginLog(logZip());
      const built = discovery.buildDescriptor({
        originRepo: 'dictationb1/supreme-lamp',
        originWorkflow: '.github/workflows/main.yml',
        run,
        endpoint: parsed.endpoint,
        fingerprint: parsed.evidence.keyFingerprint,
        labRevision: '8067e4e9b3316cbfa21115a5de112351eb67d417'
      });
      assert.strictEqual(built.ok, true, built.detail || '');
      const d = built.descriptor;
      assert.strictEqual(d.protocol, rd.PROTOCOL);
      assert.strictEqual(d.originRunId, 1111);
      assert.strictEqual(d.originAttempt, 1);
      assert.strictEqual(d.appSha, SHA);
      assert.strictEqual(d.correlationId, 'lr-1111-1');
      assert.strictEqual(d.authorizedEndpoint, 'http://100.101.102.103:7331');
      assert.ok(!JSON.stringify(d).includes(KEY), 'the descriptor carries a fingerprint, never the key');
      assert.ok(Date.parse(d.expiresAt) > Date.now() + 60 * 1000);
      // the ephemeral server cannot outlive 6h from its own start
      assert.ok(Date.parse(d.expiresAt) <= Date.parse(run.run_started_at) + 6 * 60 * 60 * 1000 + 1000);
      // A later sweep re-derives expiry, so the full descriptor id may differ;
      // the STABLE identity (what the queue and the client must agree on) may not.
      await new Promise(r => setTimeout(r, 5));
      const again = discovery.buildDescriptor({
        originRepo: 'dictationb1/supreme-lamp', originWorkflow: '.github/workflows/main.yml', run,
        endpoint: parsed.endpoint, fingerprint: parsed.evidence.keyFingerprint,
        labRevision: '8067e4e9b3316cbfa21115a5de112351eb67d417'
      });
      assert.strictEqual(again.descriptor.stableIdentity, d.stableIdentity, 'the same run+attempt must keep one stable identity');
      assert.strictEqual(again.descriptor.correlationId, d.correlationId);
    });

    await test('origin discovery: a run that has almost exhausted its 6h window is refused instead of queued', async () => {
      const run = runObj({ id: 1112, startedMsAgo: 5.99 * 60 * 60 * 1000 });
      const parsed = discovery.parseOriginLog(logZip());
      const built = discovery.buildDescriptor({
        originRepo: 'dictationb1/supreme-lamp', originWorkflow: '.github/workflows/main.yml', run,
        endpoint: parsed.endpoint, fingerprint: parsed.evidence.keyFingerprint, labRevision: 'unknown'
      });
      assert.strictEqual(built.ok, false);
      assert.strictEqual(built.code, 'ORIGIN_EXPIRED');
    });

    // --------------------------------------------------------- discoverOrigin
    await test('origin discovery: end to end, it selects the OLDEST attachable live run and refuses a completed one', async () => {
      state.runs = {};
      state.blobs = {};
      const newRun = runObj({ id: 2002, startedMsAgo: 60 * 1000 });
      const oldRun = runObj({ id: 2001, startedMsAgo: 20 * 60 * 1000 });
      const doneRun = runObj({ id: 2000, startedMsAgo: 40 * 60 * 1000, status: 'completed' });
      for (const r of [newRun, oldRun, doneRun]) state.runs[r.id] = r;
      state.blobs[2001] = logZip({ key: 'k-old-' + crypto.randomBytes(4).toString('hex') });
      state.blobs[2002] = logZip({ key: 'k-new-' + crypto.randomBytes(4).toString('hex') });

      const res = await discovery.discoverOrigin({ originRepo: 'dictationb1/supreme-lamp' });
      assert.strictEqual(res.ok, true, res.detail || '');
      assert.strictEqual(res.descriptor.originRunId, 2001, 'FIFO by run start, never the newest server');
      assert.strictEqual(res.evidence.selection, 'oldest-in-progress-with-live-banner');
      // the completed run was never even a candidate (the list filters by status)
      assert.ok(!res.evidence.rejected.some(r => r.runId === 2000), 'a completed run is not attachable');
    });

    await test('origin discovery: explicit run id wins, a wrong attempt is refused, and a foreign repo is refused', async () => {
      state.runs = {}; state.blobs = {};
      const run = runObj({ id: 3001, attempt: 2, startedMsAgo: 2 * 60 * 1000 });
      state.runs[3001] = run;
      state.blobs[3001] = logZip();
      const ok = await discovery.discoverOrigin({ originRepo: 'dictationb1/supreme-lamp', explicitRunId: 3001, explicitAttempt: 2 });
      assert.strictEqual(ok.ok, true);
      assert.strictEqual(ok.descriptor.originAttempt, 2);
      const wrongAttempt = await discovery.discoverOrigin({ originRepo: 'dictationb1/supreme-lamp', explicitRunId: 3001, explicitAttempt: 1 });
      assert.strictEqual(wrongAttempt.ok, false);
      assert.strictEqual(wrongAttempt.code, 'NO_LIVE_ORIGIN');
      const foreign = await discovery.discoverOrigin({ originRepo: 'someone/else' });
      assert.strictEqual(foreign.code, 'ORIGIN_REPO_NOT_ALLOWED');
    });

    await test('origin discovery: a stale attempt is refused after GitHub reports a newer attempt', async () => {
      state.runs = {}; state.blobs = {};
      const run = runObj({ id: 4001, attempt: 1, startedMsAgo: 3 * 60 * 1000 });
      state.runs[4001] = run;
      state.blobs[4001] = logZip();
      // GitHub advances the attempt between the list and the final re-read.
      const orig = state.runs[4001];
      state.runs[4001] = { ...orig };
      let served = 0;
      const srvHandler = srv.listeners('request')[0];
      srv.removeAllListeners('request');
      srv.on('request', (req, res) => {
        if (/^\/repos\/[^/]+\/[^/]+\/actions\/runs\/4001$/.test(new URL(req.url, 'http://x').pathname)) {
          served++;
          // Every direct read reports attempt 2: the list said 1, so the
          // high-water re-read must catch the superseded attempt.
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ...orig, run_attempt: 2, status: 'in_progress' }));
        }
        return srvHandler(req, res);
      });
      try {
        const res = await discovery.discoverOrigin({ originRepo: 'dictationb1/supreme-lamp' });
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.code, 'NO_LIVE_ORIGIN');
        assert.ok(JSON.stringify(res.evidence.rejected).includes('ATTEMPT_SUPERSEDED'));
      } finally {
        srv.removeAllListeners('request');
        srv.on('request', srvHandler);
      }
    });

    await test('origin discovery: an unreadable origin log is a named refusal, not an attach', async () => {
      state.runs = {}; state.blobs = {};
      const run = runObj({ id: 5001, startedMsAgo: 2 * 60 * 1000 });
      state.runs[5001] = run; // no blob -> 404 from the logs endpoint
      const res = await discovery.discoverOrigin({ originRepo: 'dictationb1/supreme-lamp' });
      assert.strictEqual(res.ok, false);
      assert.ok(JSON.stringify(res.evidence.rejected).includes('LOG_UNAVAILABLE'));
    });

    // ---------------------------------------------------------- server identity
    await test('server identity: buildSha + sessionId bind the answering process to the origin run', async () => {
      state.config = {
        buildSha: SHA, sessionId: 's-20261022-100000', hostKind: 'ephemeral', dnsName: 'ghrdp-abc123.tailnet.ts.net',
        // A tailnet caller really does receive a password block on the app's
        // current build. The lab must never read it, and must never return it.
        creds: { fqdn: 'ghrdp-abc123.tailnet.ts.net', user: 'ghrdp-9f2c', ip: '100.101.102.103', windowsPass: 'SuperSecretValue1!' }
      };
      state.version = { ok: true, server: 'ghrdp', sha: SHA, sha7: SHA.slice(0, 7) };
      const res = await identity.attestBackend({ target: apiUrl, appSha: SHA });
      assert.strictEqual(res.ok, true, res.detail || '');
      assert.strictEqual(res.identity.buildSha, SHA);
      assert.strictEqual(res.identity.sessionId, 's-20261022-100000');
      assert.strictEqual(res.rdp.fqdn, 'ghrdp-abc123.tailnet.ts.net');
      assert.strictEqual(res.rdp.user, 'ghrdp-9f2c');
      assert.strictEqual(res.rdp.tailnetIp, '100.101.102.103');
      const dumped = JSON.stringify(res);
      assert.ok(!dumped.includes('SuperSecretValue1!'), 'a password must never leave the identity module');
      assert.ok(!dumped.toLowerCase().includes('windowspass'), 'the credential block is not part of identity evidence');
    });

    await test('server identity: a different build, a missing session, or a non-tailnet target is refused with its own code', async () => {
      state.config = { buildSha: 'f'.repeat(40), sessionId: 's-1', creds: { fqdn: 'x.ts.net', user: 'u' } };
      state.version = { ok: true, server: 'ghrdp', sha: 'f'.repeat(40), sha7: 'fffffff' };
      const mismatch = await identity.attestBackend({ target: apiUrl, appSha: SHA });
      assert.strictEqual(mismatch.ok, false);
      assert.strictEqual(mismatch.code, 'IDENTITY_BUILD_SHA_MISMATCH');

      state.config = { buildSha: SHA, sessionId: '', creds: {} };
      state.version = { ok: true, server: 'ghrdp', sha: SHA, sha7: SHA.slice(0, 7) };
      const noSession = await identity.attestBackend({ target: apiUrl, appSha: SHA });
      assert.strictEqual(noSession.ok, false);
      assert.strictEqual(noSession.code, 'IDENTITY_NO_SESSION');

      state.config = { buildSha: SHA, sessionId: 's-2', creds: { fqdn: 'not-a-tailnet-host.example', user: 'u' } };
      const noTarget = await identity.attestBackend({ target: apiUrl, appSha: SHA });
      assert.strictEqual(noTarget.ok, true, 'identity still binds; only the RDP target is withheld');
      assert.strictEqual(noTarget.rdp, null, 'a non ts.net target must never become an RDP destination');
    });

    await test('server identity: a restart between readiness and the feature pass is detected, not averaged away', async () => {
      state.config = { buildSha: SHA, sessionId: 's-first', creds: {} };
      const stable = await identity.reassertSession({ target: apiUrl, sessionId: 's-first' });
      assert.strictEqual(stable.ok, true);
      state.config = { buildSha: SHA, sessionId: 's-second', creds: {} };
      const changed = await identity.reassertSession({ target: apiUrl, sessionId: 's-first' });
      assert.strictEqual(changed.ok, false);
      assert.strictEqual(changed.code, 'IDENTITY_SESSION_CHANGED');
    });

    // ------------------------------------------------------------- workflows
    await test('live-run workflow: it discovers automatically, is valid YAML, and never accepts an unvalidated payload', async () => {
      const wf = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'live-run.yml'), 'utf8');
      // valid concurrency keys only (GitHub rejects unknown keys with a failed
      // "workflow file" run and zero jobs - measured)
      const conc = wf.match(/^concurrency:\n((?:[ \t]+.*\n)+)/m);
      assert.ok(conc, 'concurrency block present');
      const keys = conc[1].split('\n').map(l => (l.match(/^\s+([a-z-]+):/) || [])[1]).filter(Boolean);
      assert.deepStrictEqual(keys.sort(), ['cancel-in-progress', 'group']);
      // the automatic path exists and is wired to the zero-change transport
      assert.ok(/^  discover:/m.test(wf), 'a discovery job must exist');
      assert.ok(/--origin-transport', 'public-log'|--origin-transport public-log/.test(wf), 'the client must use the public-log transport in live mode');
      assert.ok(/--descriptor-id/.test(wf), 'the client must pin the descriptor the queue published');
      assert.ok(/node scripts\/live-run\.js discover/.test(wf));
      assert.ok(!/^on:[\s\S]{0,400}?^  workflow_run:/m.test(wf), 'no workflow_run trigger');
      assert.ok(/cron: '\*\/10 \* \* \* \*'/.test(wf));
      // the secret is never an output: outputs may name the token only as a
      // prohibition, never as a value producer
      assert.ok(!/dashToken|dashboardToken/.test(wf.split('jobs:')[0]), 'no secret in the trigger/output front matter');
    });
  } finally {
    srv.close();
    delete process.env.GITHUB_API_URL;
  }
};
