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
  const signalLib = require('../lib/live-signal');
  const signalLibName = () => signalLib.SIGNAL_NAME;
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
      const state = { runs: {}, blobs: {}, jobLogs: {}, jobMode: true, config: null, version: null, logStatus: 302, checkRuns: null };
      const srv = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        const p = u.pathname;
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
        const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
        if (req.method === 'POST' && /\/check-runs$/.test(p)) {
          state.checkRunCreated = JSON.parse(body || '{}');
          return json({ id: 4242 }, 201);
        }
        if (req.method === 'PATCH' && /\/check-runs\/4242$/.test(p)) {
          state.checkRunPatched = JSON.parse(body || '{}');
          if (state.checkRunPatched.output && state.checkRunPatched.output.summary) {
            state.checkRuns = [{ id: 4242, name: signalLibName(), status: state.checkRunPatched.status, started_at: new Date().toISOString(), output: state.checkRunPatched.output }];
          }
          return json({ id: 4242 });
        }
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
        const mChecks = p.match(/^\/repos\/([^/]+\/[^/]+)\/commits\/([0-9a-f]{7,40})\/check-runs$/);
        if (mChecks) {
          if (!state.checkRuns) return json({ message: 'Not Found' }, 404);
          return json({ total_count: state.checkRuns.length, check_runs: state.checkRuns });
        }
        const mJobs = p.match(/^\/repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/jobs$/);
        if (mJobs) {
          if (!state.jobMode) return json({ message: 'Not Found' }, 404);
          const id = mJobs[2];
          const jobs = (state.jobLogs[id] ? Object.keys(state.jobLogs[id]) : []).map((name, i) => ({
            id: Number(id) * 10 + i, name, status: 'in_progress', conclusion: null
          }));
          return json({ total_count: jobs.length, jobs });
        }
        const mJobLogs = p.match(/^\/repos\/([^/]+\/[^/]+)\/actions\/jobs\/(\d+)\/logs$/);
        if (mJobLogs) {
          const jobId = Number(mJobLogs[2]);
          const runId = String(Math.floor(jobId / 10));
          const name = Object.keys(state.jobLogs[runId] || {})[jobId % 10];
          if (!name) { res.writeHead(404); return res.end('no job log'); }
          res.writeHead(302, { location: `http://127.0.0.1:${srv.address().port}/jobblob/${jobId}` });
          return res.end();
        }
        const mJobBlob = p.match(/^\/jobblob\/(\d+)$/);
        if (mJobBlob) {
          const jobId = Number(mJobBlob[1]);
          const runId = String(Math.floor(jobId / 10));
          const name = Object.keys(state.jobLogs[runId] || {})[jobId % 10];
          if (!name) { res.writeHead(404); return res.end(); }
          res.writeHead(200, { 'content-type': 'text/plain' });
          return res.end(state.jobLogs[runId][name]);
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
      state.jobLogs[2001] = { rdp: 'x ' + READY_LINE + '\n' + bannerFor('100.101.102.103', 'k-old-joblog') };
      state.jobLogs[2002] = { rdp: 'x ' + READY_LINE + '\n' + bannerFor('100.101.102.103', 'k-new-joblog') };

      const res = await discovery.discoverOrigin({ originRepo: 'dictationb1/supreme-lamp' });
      assert.strictEqual(res.ok, true, res.detail || '');
      assert.strictEqual(res.descriptor.originRunId, 2001, 'FIFO by run start, never the newest server');
      assert.strictEqual(res.evidence.selection, 'oldest-in-progress-with-live-signal');
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

    await test('origin discovery: it reads PER-JOB logs (the only transport that exists while a run is live)', async () => {
      state.runs = {}; state.blobs = {}; state.jobLogs = {};
      const run = runObj({ id: 4501, startedMsAgo: 60 * 1000 });
      state.runs[4501] = run;
      state.jobLogs[4501] = {
        'Verify Dependencies & Authorize Launch': 'nothing useful here',
        rdp: 'step output\n' + READY_LINE + '\n' + bannerFor('100.101.102.104', 'k-joblog-live')
      };
      // no run archive at all: a run-level /logs call would 404
      state.blobs = {};
      const res = await discovery.discoverOrigin({ originRepo: 'dictationb1/supreme-lamp' });
      assert.strictEqual(res.ok, true, res.detail || '');
      assert.strictEqual(res.evidence.logTransport, 'per-job');
      assert.strictEqual(res.descriptor.authorizedEndpoint, 'http://100.101.102.104:7331');
      assert.strictEqual(res.secret.dashboardToken, 'k-joblog-live');
      assert.ok(!JSON.stringify(res.evidence).includes('k-joblog-live'), 'still no key in the evidence');
      // the job list names the rdp job first; the non-rdp job is not even read
      assert.ok(res.evidence.logJobs.some(j => /rdp/i.test(j.job)));
    });

    await test('origin discovery: the run archive is still a fallback when the job API is unavailable', async () => {
      state.runs = {}; state.blobs = {}; state.jobLogs = {}; state.jobMode = false;
      const run = runObj({ id: 4601, startedMsAgo: 60 * 1000 });
      state.runs[4601] = run;
      state.blobs[4601] = logZip({ ip: '100.101.102.105', key: 'k-archive-fallback' });
      try {
        const res = await discovery.discoverOrigin({ originRepo: 'dictationb1/supreme-lamp' });
        assert.strictEqual(res.ok, true, res.detail || '');
        assert.strictEqual(res.evidence.logTransport, 'run-archive');
        assert.strictEqual(res.secret.dashboardToken, 'k-archive-fallback');
      } finally { state.jobMode = true; }
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

    await test('analyseJobLogText: finds the keepalive banner and masks the one-time key', async () => {
      const text = [
        '2026-10-22T00:00:00Z ##[group]Run server',
        'Starting dashboard',
        'Dashboard API responded with valid readiness JSON',
        '     ps (7331) .........: http://100.101.102.103:7331/?key=SECRETKEY123   (tailnet only)',
        'Token ghp_abcdefghijklmnopqrstuvwxyz0123 leaked'
      ].join('\n');
      const a = discovery.analyseJobLogText(text);
      assert.strictEqual(a.banner, true);
      assert.strictEqual(a.readiness, true);
      assert.strictEqual(a.bannerHasKey, true);
      assert.ok(a.markers.includes('ps-banner'));
      const joined = a.tail.join('\n');
      assert.ok(!joined.includes('SECRETKEY123'), 'the key must never appear in a published tail');
      assert.ok(!joined.includes('ghp_abcdefghijklmnopqrstuvwxyz0123'), 'tokens must be masked');
      assert.ok(joined.includes('key=***'));
    });

    await test('analyseJobLogText: a log that never reached readiness reports banner=false', async () => {
      const a = discovery.analyseJobLogText('checkout\ninstalling tailscale\nerror: tailscale up failed');
      assert.strictEqual(a.banner, false);
      assert.strictEqual(a.readiness, false);
      assert.ok(a.markers.includes('error'));
    });

    // ------------------------------------------------------ live check-run signal
    const { publicKey: sigPub, privateKey: sigPriv } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const PUB_PEM = sigPub.export({ type: 'spki', format: 'pem' });
    const PRIV_PEM = sigPriv.export({ type: 'pkcs8', format: 'pem' });
    const signalFor = (run, { attempt, sha, endpoint = 'http://100.101.102.103:7331', ttlMs = 3600e3, key = 'sig-' + crypto.randomBytes(8).toString('hex') } = {}) => signalLib.buildSignal({
      repo: 'dictationb1/supreme-lamp', runId: run.id, attempt: attempt || run.run_attempt,
      appSha: sha || run.head_sha, endpoint, expiresAt: new Date(Date.now() + ttlMs).toISOString(), key
    }, PUB_PEM);

    await test('live signal: an encrypted envelope round-trips, and every stale identity is refused by name', async () => {
      const run = runObj({ id: 7001 });
      const text = signalFor(run);
      assert.ok(!text.includes('sig-'), 'the key must not appear in the public signal text');
      const expect = { repo: 'dictationb1/supreme-lamp', runId: 7001, attempt: 1, appSha: SHA };
      const ok = signalLib.resolveSignal(text, expect, PRIV_PEM);
      assert.strictEqual(ok.ok, true, ok.detail || '');
      assert.ok(ok.key.startsWith('sig-'));
      assert.strictEqual(signalLib.resolveSignal(text, { ...expect, attempt: 2 }, PRIV_PEM).code, 'SIGNAL_STALE_ATTEMPT');
      assert.strictEqual(signalLib.resolveSignal(text, { ...expect, runId: 7002 }, PRIV_PEM).code, 'SIGNAL_STALE_RUN');
      assert.strictEqual(signalLib.resolveSignal(text, { ...expect, appSha: 'f'.repeat(40) }, PRIV_PEM).code, 'SIGNAL_SHA_MISMATCH');
      assert.strictEqual(signalLib.resolveSignal(text, expect, null).code, 'SIGNAL_NO_PRIVATE_KEY');
      const expired = signalLib.resolveSignal(signalFor(run, { ttlMs: -1000 }), expect, PRIV_PEM);
      assert.strictEqual(expired.code, 'SIGNAL_EXPIRED');
      const offTailnet = signalLib.resolveSignal(signalFor(run, { endpoint: 'https://example.com:7331' }), expect, PRIV_PEM);
      assert.strictEqual(offTailnet.code, 'SIGNAL_ENDPOINT_NOT_TAILNET');
      const tampered = text.slice(0, -8) + 'AAAAAAAA';
      assert.strictEqual(signalLib.resolveSignal(tampered, expect, PRIV_PEM).ok, false);
    });

    await test('origin discovery: the live check-run signal attaches a run whose logs are NOT readable', async () => {
      state.runs = {}; state.blobs = {}; state.jobLogs = {}; state.checkRuns = null;
      const run = runObj({ id: 7101 });
      state.runs[7101] = run;
      const key = 'sig-live-' + crypto.randomBytes(6).toString('hex');
      state.checkRuns = [{ id: 99, name: signalLib.SIGNAL_NAME, status: 'in_progress', started_at: new Date().toISOString(), output: { summary: signalFor(run, { key }) } }];
      process.env.LAB_SIGNAL_PRIVATE_KEY = PRIV_PEM;
      const found = await discovery.discoverOrigin({ originRepo: 'dictationb1/supreme-lamp', explicitRunId: 7101 });
      delete process.env.LAB_SIGNAL_PRIVATE_KEY;
      assert.strictEqual(found.ok, true, found.detail || JSON.stringify(found.rejected || []));
      assert.strictEqual(found.secret.dashboardToken, key);
      assert.strictEqual(found.evidence.transport, 'check-run');
      assert.strictEqual(found.evidence.signalLive, true);
      assert.strictEqual(found.descriptor.authorizedEndpoint, 'http://100.101.102.103:7331');
      assert.ok(!JSON.stringify(found.descriptor).includes(key), 'the descriptor must not carry the key');
      assert.ok(!JSON.stringify(found.evidence).includes(key), 'the evidence must not carry the key');
    });

    await test('origin discovery: a signal for the WRONG attempt is refused and the readable log is used instead', async () => {
      state.runs = {}; state.blobs = {}; state.jobLogs = {}; state.checkRuns = null;
      const run = runObj({ id: 7201 });
      state.runs[7201] = run;
      state.blobs[7201] = logZip();
      state.checkRuns = [{ id: 98, name: signalLib.SIGNAL_NAME, status: 'in_progress', started_at: new Date().toISOString(), output: { summary: signalFor(run, { attempt: 9 }) } }];
      process.env.LAB_SIGNAL_PRIVATE_KEY = PRIV_PEM;
      const found = await discovery.discoverOrigin({ originRepo: 'dictationb1/supreme-lamp', explicitRunId: 7201 });
      delete process.env.LAB_SIGNAL_PRIVATE_KEY;
      assert.strictEqual(found.ok, true, found.detail || JSON.stringify(found.rejected || []));
      assert.strictEqual(found.evidence.transport, 'run-archive');
      assert.strictEqual(found.evidence.signalFallback, 'SIGNAL_STALE_ATTEMPT');
      assert.ok(!JSON.stringify(found.evidence).includes(KEY));
    });

    await test('app publisher (real file) publishes an encrypted signal that the lab reader decrypts', async () => {
      state.checkRunCreated = null; state.checkRunPatched = null;
      const { spawn } = require('child_process');
      const publisher = path.join(__dirname, '..', '..', 'patches', 'app-live-signal-publisher.js');
      const key = 'pub-' + crypto.randomBytes(8).toString('hex');
      // ASYNC spawn: the fake GitHub API lives in THIS process, so a sync child
      // would deadlock the event loop that has to answer its request.
      const out = await new Promise((resolve, reject) => {
        const ch = spawn(process.execPath, [publisher], {
          env: {
            ...process.env,
            GH_API_URL: apiUrl, GH_TOKEN: 'test', GH_REPO: 'dictationb1/supreme-lamp',
            GH_RUN_ID: '9001', GH_RUN_ATTEMPT: '3', GH_SHA: SHA,
            LAB_SIGNAL_PUBKEY: PUB_PEM, MC_SIGNAL_KEY: key,
            MC_SIGNAL_ENDPOINT: 'http://100.101.102.103:7331/', MC_SIGNAL_ONCE: '1'
          }
        });
        let s = '';
        ch.stdout.on('data', d => { s += d; });
        ch.stderr.on('data', d => { s += d; });
        const timer = setTimeout(() => { ch.kill('SIGKILL'); reject(new Error('publisher timeout: ' + s.slice(0, 200))); }, 30000);
        ch.on('close', code => { clearTimeout(timer); resolve(s + (code ? ` [exit ${code}]` : '')); });
      });
      assert.ok(/published/.test(out), out.slice(0, 200));
      const created = state.checkRunCreated;
      assert.ok(created, 'the publisher must create the check run');
      assert.strictEqual(created.name, signalLib.SIGNAL_NAME);
      assert.strictEqual(created.head_sha, SHA);
      assert.strictEqual(created.status, 'in_progress');
      const text = created.output.summary;
      assert.ok(!text.includes(key), 'the public signal must never carry the plaintext key');
      const resolved = signalLib.resolveSignal(text, { repo: 'dictationb1/supreme-lamp', runId: 9001, attempt: 3, appSha: SHA }, PRIV_PEM);
      assert.strictEqual(resolved.ok, true, resolved.detail || '');
      assert.strictEqual(resolved.key, key);
      assert.strictEqual(resolved.host, '100.101.102.103');
    });

    // ------------------------------------------------------------- workflows
    // REPRODUCED WINDOWS DEFECT (lab run 39819073772, job `client`):
    //   "AssertionError: concurrency block present" at this file line ~560.
    // The workflow DID contain the block; the Windows checkout had CRLF and the
    // assertion matched only `concurrency:\n`. The structural check now runs on
    // normalized text, and the same assertions are executed against LF, CRLF,
    // CR and BOM+CRLF renderings of the REAL file, plus genuine negatives.
    const wt = require('../lib/workflow-text');
    const wfPath = path.join(__dirname, '..', '..', '.github', 'workflows', 'live-run.yml');
    const wfLF = wt.readNormalized(wfPath);

    await test('live-run workflow: the concurrency block is read identically from LF, CRLF, CR and BOM checkouts', async () => {
      const variants = {
        lf: wfLF,
        crlf: wfLF.replace(/\n/g, '\r\n'),
        cr: wfLF.replace(/\n/g, '\r'),
        'bom-crlf': '\ufeff' + wfLF.replace(/\n/g, '\r\n')
      };
      for (const [name, text] of Object.entries(variants)) {
        const conc = wt.concurrencyBlock(text);
        assert.strictEqual(conc.ok, true, `${name}: ${conc.code} ${conc.detail || ''}`);
        // keys GitHub accepts are exactly these two; anything else fails the run
        assert.deepStrictEqual(conc.keys.sort(), ['cancel-in-progress', 'group'], `${name}: keys`);
      }
      // the file on disk (whatever EOL this checkout produced) is the same file
      const onDisk = wt.readNormalized(wfPath);
      assert.deepStrictEqual(wt.concurrencyBlock(onDisk).keys.sort(), ['cancel-in-progress', 'group']);
      assert.ok(!wfLF.includes('\r'), 'the reader normalizes before any structural match');
    });

    await test('live-run workflow: a missing, scalar or unknown-key concurrency block is refused (the assertion still bites)', async () => {
      assert.strictEqual(wt.concurrencyBlock('on:\n  push:\n').code, 'CONCURRENCY_MISSING');
      assert.strictEqual(wt.concurrencyBlock('concurrency: live-run-queue\n').code, 'CONCURRENCY_NOT_A_MAP');
      // this is the defect the assertion exists for: GitHub rejects the whole
      // workflow file when an unknown key appears under concurrency:
      const unknown = wt.concurrencyBlock('concurrency:\r\n  group: q\r\n  queue: max\r\n');
      assert.strictEqual(unknown.ok, false);
      assert.strictEqual(unknown.code, 'CONCURRENCY_UNKNOWN_KEY');
      assert.deepStrictEqual(unknown.keys, ['group', 'queue']);
      assert.strictEqual(wt.concurrencyBlock('concurrency: \n').code, 'CONCURRENCY_EMPTY');
    });

    await test('live-run workflow: it discovers automatically, is valid YAML, and never accepts an unvalidated payload', async () => {
      const wf = wfLF;
      // the automatic path exists and is wired to the signal-first transport
      assert.ok(/^  discover:/m.test(wf), 'a discovery job must exist');
      assert.ok(/--origin-transport', 'auto'|--origin-transport auto/.test(wf), 'the client must use the signal-first (auto) transport in live mode');
      assert.ok(!/--origin-transport', 'public-log'|--origin-transport public-log/.test(wf), 'the stale public-log label must not be what the client asks for');
      assert.ok(/--descriptor-id/.test(wf), 'the client must pin the descriptor the queue published');
      assert.ok(/node scripts\/live-run\.js discover/.test(wf));
      assert.ok(!/^on:[\s\S]{0,400}?^  workflow_run:/m.test(wf), 'no workflow_run trigger');
      assert.ok(/cron: '\*\/10 \* \* \* \*'/.test(wf));
      // the secret is never an output: outputs may name the token only as a
      // prohibition, never as a value producer
      assert.ok(!/dashToken|dashboardToken/.test(wf.split('jobs:')[0]), 'no secret in the trigger/output front matter');
    });

    // ------------------------------------------------- SIGNAL KEY WIRING (B)
    // REPRODUCED DEFECT (lab run 39819073772): LAB_SIGNAL_PRIVATE_KEY reached the
    // discover/claim steps but NOT the Windows LIVE VERIFICATION step, which
    // calls `scripts/live-run.js live` and re-discovers the origin in-process.
    // The reader takes the key from process.env.LAB_SIGNAL_PRIVATE_KEY, so every
    // live verification silently fell back to the plaintext run log.
    const LIVE_STEP = 'LIVE VERIFICATION (discover -> origin verify -> auth -> UI -> features -> report)';

    await test('live-run workflow: the Windows verification step receives LAB_SIGNAL_PRIVATE_KEY (and keeps GH_TOKEN + ARTIFACT_DIR)', async () => {
      const block = wt.stepBlock(wfLF, LIVE_STEP);
      assert.ok(block, `the step ${JSON.stringify(LIVE_STEP)} must exist in live-run.yml`);
      assert.strictEqual(wt.envValue(block, 'LAB_SIGNAL_PRIVATE_KEY'), '${{ secrets.LAB_SIGNAL_PRIVATE_KEY }}',
        'the live step must bind the secret explicitly (env, never an argument)');
      assert.strictEqual(wt.envValue(block, 'GH_TOKEN'), '${{ github.token }}');
      assert.ok(/ARTIFACT_DIR:\s*\$\{\{ runner\.temp \}\}/.test(block), 'ARTIFACT_DIR must be preserved');
      assert.ok(/scripts', 'live-run\.js', 'live'/.test(block) || /scripts\/live-run\.js', 'live'/.test(block), 'the step still runs the live command');
      // the same binding exists on the discover step that publishes the queue
      const discStep = wt.stepBlock(wfLF, 'Discover the originating run (publish one queue entry per run+attempt)');
      assert.ok(discStep, 'the discover step must exist');
      assert.strictEqual(wt.envValue(discStep, 'LAB_SIGNAL_PRIVATE_KEY'), '${{ secrets.LAB_SIGNAL_PRIVATE_KEY }}');
      // ... and on the read-only candidate gate, so config presence is proven pre-merge
      const keyStep = wt.stepBlock(wfLF, 'Signal key status (presence, algorithm, fingerprint - never the value)');
      assert.ok(keyStep, 'the candidate key-status step must exist');
      assert.strictEqual(wt.envValue(keyStep, 'LAB_SIGNAL_PRIVATE_KEY'), '${{ secrets.LAB_SIGNAL_PRIVATE_KEY }}');
    });

    await test('live-run workflow: the private key never becomes an output, an artifact path, an argument or a summary line', async () => {
      // 1. not a job output
      const outputsSection = wfLF.split(/^jobs:/m)[1] || '';
      const outLines = outputsSection.split('\n').filter(l => /^\s{6}[a-z_]+:/.test(l) && !/^\s{8}/.test(l));
      assert.ok(!outLines.some(l => /SIGNAL_PRIVATE|PRIVATE_KEY/.test(l)), 'the key must not be a job output');
      // 2. never a CLI argument (arguments are visible in the process table and in the log line)
      assert.ok(!/--private-key|--signal-key/.test(wfLF), 'the key must never be passed as an argument');
      // 3. never an uploaded path / artifact name
      const uploadBlocks = wfLF.split('actions/upload-artifact');
      for (const b of uploadBlocks.slice(1)) {
        const slice = b.slice(0, 600);
        assert.ok(!/LAB_SIGNAL_PRIVATE_KEY|\$\{\{\s*secrets\./.test(slice), 'no secret may appear in an artifact upload block');
      }
      // 4. never echoed into a step summary or an annotation
      for (const line of wfLF.split('\n')) {
        if (/GITHUB_STEP_SUMMARY|::notice|::warning|::error/.test(line)) {
          assert.ok(!/SIGNAL_PRIVATE_KEY/.test(line), `a summary/annotation line must not name the secret: ${line.trim()}`);
        }
      }
      // 5. every NON-COMMENT occurrence of the secret is a `${{ secrets.… }}` binding
      const bindings = wfLF.split('\n').filter(l => /LAB_SIGNAL_PRIVATE_KEY/.test(l) && !/^\s*#/.test(l));
      assert.ok(bindings.length >= 3, `the key is bound to every step that discovers an origin (saw ${bindings.length})`);
      for (const l of bindings) assert.match(l.trim(), /^LAB_SIGNAL_PRIVATE_KEY: \$\{\{ secrets\.LAB_SIGNAL_PRIVATE_KEY \}\}$/, l.trim());
    });

    await test('live-run workflow: a pre-merge candidate path exists and is restricted to same-repository branches', async () => {
      assert.ok(/^  pull_request:/m.test(wfLF), 'the candidate path must be triggerable before merge');
      assert.ok(/types: \[opened, synchronize, reopened, labeled\]/.test(wfLF), 'labelling must be an event type (live-verify)');
      assert.ok(/github\.event\.pull_request\.head\.repo\.full_name == github\.repository/.test(wfLF),
        'a fork PR must never reach the secret or the self-hosted desktop');
      assert.ok(/contains\(github\.event\.pull_request\.labels\.\*\.name, 'live-verify'\)/.test(wfLF),
        'the full pipeline on a PR is opt-in by label');
      assert.ok(/^  candidate:/m.test(wfLF), 'the read-only candidate gate job must exist');
      // the candidate gate never publishes into the live queue
      const candBlock = wt.stepBlock(wfLF, 'Real discovery decision for the application repository (read-only)');
      assert.ok(candBlock, 'candidate discovery step must exist');
      const candRun = candBlock.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
      assert.ok(!/--publish/.test(candRun), 'a PR candidate must never publish a queue entry');
      assert.ok(!/workflow_run/.test(wfLF.split('on:')[1].split('permissions:')[0]), 'no workflow_run trigger was introduced');
    });

    // --------------------------------------------- missing-key failure paths (B)
    await test('live signal: a missing private key is a NAMED refusal, and `signal` transport never downgrades to the plaintext log', async () => {
      state.runs = {}; state.blobs = {}; state.jobLogs = {}; state.checkRuns = null;
      const run = runObj({ id: 7301 });
      state.runs[7301] = run;
      state.blobs[7301] = logZip();
      state.jobLogs[7301] = { rdp: 'x ' + READY_LINE + '\n' + bannerFor('100.101.102.103', 'k-fallback') };
      state.checkRuns = [{ id: 77, name: signalLib.SIGNAL_NAME, status: 'in_progress', started_at: new Date().toISOString(), output: { summary: signalFor(run) } }];
      delete process.env.LAB_SIGNAL_PRIVATE_KEY;

      // signal-only: refused, with the exact code, and nothing is attached
      const strict = await discovery.discoverOrigin({ originRepo: 'dictationb1/supreme-lamp', explicitRunId: 7301, allowLogFallback: false });
      assert.strictEqual(strict.ok, false);
      assert.strictEqual(strict.code, 'NO_LIVE_ORIGIN');
      const rej = strict.evidence.rejected.find(r => r.runId === 7301);
      assert.strictEqual(rej.code, 'SIGNAL_NO_PRIVATE_KEY', JSON.stringify(rej));

      // default (auto): the log fallback is used AND reported as a fallback
      const fallback = await discovery.discoverOrigin({ originRepo: 'dictationb1/supreme-lamp', explicitRunId: 7301 });
      assert.strictEqual(fallback.ok, true, fallback.detail || '');
      assert.notStrictEqual(fallback.evidence.transport, 'check-run');
      assert.strictEqual(fallback.evidence.signalLive, false);
      assert.strictEqual(fallback.evidence.signalFallback, 'SIGNAL_NO_PRIVATE_KEY');
      assert.strictEqual(fallback.evidence.originLogPubliclyReadable, true, 'the report must admit the credential came from a public log');
    });

    await test('live signal: with the key present the same run attaches over the encrypted check-run transport', async () => {
      state.runs = {}; state.blobs = {}; state.jobLogs = {}; state.checkRuns = null;
      const run = runObj({ id: 7302 });
      state.runs[7302] = run;
      state.blobs[7302] = logZip();
      state.jobLogs[7302] = { rdp: 'x ' + READY_LINE + '\n' + bannerFor('100.101.102.103', 'k-should-not-be-used') };
      const key = 'k-' + crypto.randomBytes(8).toString('hex');
      state.checkRuns = [{ id: 78, name: signalLib.SIGNAL_NAME, status: 'in_progress', started_at: new Date().toISOString(), output: { summary: signalFor(run, { key }) } }];
      process.env.LAB_SIGNAL_PRIVATE_KEY = PRIV_PEM;
      const res = await discovery.discoverOrigin({ originRepo: 'dictationb1/supreme-lamp', explicitRunId: 7302, allowLogFallback: false });
      delete process.env.LAB_SIGNAL_PRIVATE_KEY;
      assert.strictEqual(res.ok, true, res.detail || JSON.stringify(res.evidence && res.evidence.rejected));
      assert.strictEqual(res.evidence.transport, 'check-run');
      assert.strictEqual(res.evidence.signalLive, true);
      assert.strictEqual(res.evidence.signalFallback, null);
      assert.strictEqual(res.evidence.originLogPubliclyReadable, false, 'a signal run never claims the credential was in the log');
      assert.strictEqual(res.evidence.checkRun.id, 78);
      assert.strictEqual(res.secret.dashboardToken, key, 'the decrypted key is returned in memory only');
      assert.ok(!JSON.stringify(res.evidence).includes(key), 'the key never enters the evidence object');
      assert.ok(!JSON.stringify(res.descriptor).includes(key), 'the key never enters the descriptor');
    });

    await test('live signal: an absent signal is refused under `signal` transport even when the log is perfectly readable', async () => {
      state.runs = {}; state.blobs = {}; state.jobLogs = {}; state.checkRuns = null;
      const run = runObj({ id: 7303 });
      state.runs[7303] = run;
      state.blobs[7303] = logZip();
      state.jobLogs[7303] = { rdp: 'x ' + READY_LINE + '\n' + bannerFor('100.101.102.103', 'k-only-in-log') };
      process.env.LAB_SIGNAL_PRIVATE_KEY = PRIV_PEM;
      const strict = await discovery.discoverOrigin({ originRepo: 'dictationb1/supreme-lamp', explicitRunId: 7303, allowLogFallback: false });
      const loose = await discovery.discoverOrigin({ originRepo: 'dictationb1/supreme-lamp', explicitRunId: 7303 });
      delete process.env.LAB_SIGNAL_PRIVATE_KEY;
      assert.strictEqual(strict.ok, false);
      assert.match(JSON.stringify(strict.evidence.rejected), /SIGNAL_ABSENT|SIGNAL_LIST_EMPTY/);
      assert.strictEqual(loose.ok, true);
      assert.strictEqual(loose.evidence.transport === 'check-run', false);
      assert.match(String(loose.evidence.signalFallback), /SIGNAL_ABSENT|SIGNAL_LIST_EMPTY/);
    });

  } finally {
    srv.close();
    delete process.env.GITHUB_API_URL;
  }
};
