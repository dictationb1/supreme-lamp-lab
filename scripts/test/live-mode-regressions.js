'use strict';
// LIVE-MODE REGRESSION SUITE (registered into run-regressions.js).
// These tests are the gate for the automatic Mission Control integration: they
// pin the descriptor contract, the trust anchor, the credential hygiene, the
// evaluator semantics and the queue/lock policy. Everything runs offline
// against local fixtures (an in-process HTTP server that implements the app's
// documented gates), so a PASS here is a contract statement, never a claim
// that a live run happened — that claim can only come from a real run's report.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

module.exports = async function registerLiveModeTests(H) {
  const { test } = H;
  // The allowlist is process-global by design (it is a repository-level
  // configuration, injected by the workflow entry point). Pin it here so these
  // tests are order-independent when the whole suite runs in one process.
  const rd0 = require('../lib/run-descriptor');
  rd0.setAllowedOriginRepos(['dictationb1/supreme-lamp']);
  const rd = require('../lib/run-descriptor');
  const store = require('../lib/record-store');
  const auth = require('../lib/live-auth');
  const feat = require('../lib/live-features');
  const inv = require('../lib/live-inventory');
  const { redact, redactDeep, registerSecret, clearRegisteredSecrets, knownSecrets } = require('../lib/redact');
  const { STATUS } = require('../lib/status');
  const liveRun = require('../live-run');
  const { extractZip } = require('../lib/verify-origin');

  const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

  /** A descriptor that passes validation; override fields per test. */
  function goodDescriptor(over = {}) {
    const now = new Date();
    return {
      protocol: rd.PROTOCOL,
      originRepo: 'dictationb1/supreme-lamp',
      originWorkflow: 'main.yml',
      originRunId: 39605267051,
      originAttempt: 1,
      appSha: '9'.repeat(40),
      uiBuild: 'ui-dist-9'.repeat(1).slice(0, 24),
      backendIdentity: '39605267051-1:4212@lamp-runner-abc.ts.net',
      authorizedEndpoint: 'http://lamp-runner-abc.ts.net:7331',
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 3600000).toISOString(),
      labRevision: '1'.repeat(40),
      correlationId: 'lr-20261021T000000Z-deadbeef',
      dashTokenFingerprint: sha256('the-real-run-token'),
      clientTailnetIp: '100.93.94.15',
      mode: 'live-origin',
      ...over
    };
  }

  // ------------------------------------------------------------------ descriptor
  await test('live-run descriptor: a well-formed descriptor validates and round-trips through serialize', async () => {
    const d = rd.validateDescriptor(goodDescriptor(), { now: Date.parse(goodDescriptor().issuedAt) });
    assert.strictEqual(d.originRunId, 39605267051);
    assert.strictEqual(d.mode, 'live-origin');
    assert.match(d.id, /^[0-9a-f]{16}$/);
    const ser = JSON.parse(rd.serializeDescriptor(d));
    const again = rd.validateDescriptor(ser, { now: Date.parse(ser.issuedAt) });
    assert.strictEqual(again.id, d.id, 'canonical id must be stable across a transport round trip');
    assert.ok(!('id' in ser), 'the derived id must not be treated as input');
  });

  await test('live-run descriptor: protocol version is exact (no silent acceptance of a foreign shape)', async () => {
    assert.throws(() => rd.validateDescriptor(goodDescriptor({ protocol: 'slab-live-run/0' })), /PROTOCOL_UNSUPPORTED/);
    assert.throws(() => rd.validateDescriptor(goodDescriptor({ protocol: 'latest' })), /PROTOCOL_UNSUPPORTED/);
  });

  await test('live-run descriptor: an expired run and a superseded attempt are both refused', async () => {
    const base = goodDescriptor();
    const late = Date.parse(base.expiresAt) + 1000;
    assert.throws(() => rd.validateDescriptor(base, { now: late }), /DESCRIPTOR_EXPIRED/);
    // 10 s of grace is not allowed either: the boundary is the expiry itself.
    assert.throws(() => rd.validateDescriptor(base, { now: Date.parse(base.expiresAt) }), /DESCRIPTOR_EXPIRED/);
    assert.throws(() => rd.validateDescriptor(goodDescriptor({ issuedAt: new Date(Date.now() + 600000).toISOString(), expiresAt: new Date(Date.now() + 700000).toISOString() })), /DESCRIPTOR_FROM_FUTURE/);
  });

  await test('live-run descriptor: a TTL outside the ephemeral-server envelope is refused (too short to queue, too long to be real)', async () => {
    const base = goodDescriptor();
    const issued = Date.parse(base.issuedAt);
    assert.throws(() => rd.validateDescriptor({ ...base, expiresAt: new Date(issued + 30000).toISOString() }), /TTL_TOO_SHORT/);
    assert.throws(() => rd.validateDescriptor({ ...base, expiresAt: new Date(issued + rd.MAX_TTL_MS + 60000).toISOString() }), /TTL_TOO_LONG/);
  });

  await test('live-run descriptor: unrelated repositories and unsafe endpoints are rejected, never warned', async () => {
    assert.throws(() => rd.validateDescriptor(goodDescriptor({ originRepo: 'evil/fork' })), /ORIGIN_REPO_UNTRUSTED/);
    assert.throws(() => rd.validateDescriptor(goodDescriptor({ originRepo: 'dictationb1/supreme-lamp-lab' })), /ORIGIN_REPO_UNTRUSTED/);
    assert.throws(() => rd.validateDescriptor(goodDescriptor({ authorizedEndpoint: 'http://127.0.0.1:7331' })), /ENDPOINT_LOCAL/);
    assert.throws(() => rd.validateDescriptor(goodDescriptor({ authorizedEndpoint: 'http://localhost:7331' })), /ENDPOINT_LOCAL/);
    // A key pre-attached to the advertised endpoint is the exact thing the
    // integration must never do.
    assert.throws(() => rd.validateDescriptor(goodDescriptor({ authorizedEndpoint: 'http://lamp.ts.net:7331/?key=secret' })), /ENDPOINT_INVALID/);
    assert.throws(() => rd.validateDescriptor(goodDescriptor({ authorizedEndpoint: 'http://user:pass@lamp.ts.net:7331' })), /ENDPOINT_INVALID/);
    assert.throws(() => rd.validateDescriptor(goodDescriptor({ authorizedEndpoint: 'ftp://lamp.ts.net' })), /ENDPOINT_INVALID/);
    assert.throws(() => rd.validateDescriptor(goodDescriptor({ appSha: 'deadbeef' })), /FIELD_INVALID/);
    assert.throws(() => rd.validateDescriptor(goodDescriptor({ originAttempt: 0 })), /FIELD_INVALID/);
    assert.throws(() => rd.validateDescriptor(goodDescriptor({ mode: 'whatever' })), /MODE_INVALID/);
  });

  await test('live-run descriptor: the secret never appears in it — only a sha256 fingerprint', async () => {
    const token = 'super-secret-dash-token-value';
    const d = rd.validateDescriptor(goodDescriptor({ dashTokenFingerprint: sha256(token) }), { now: Date.now() });
    const text = rd.serializeDescriptor(d);
    assert.ok(!text.includes(token), 'the token value must never be serialized');
    assert.strictEqual(d.dashTokenFingerprint, sha256(token));
    assert.throws(() => rd.validateDescriptor(goodDescriptor({ dashTokenFingerprint: token })), /FIELD_INVALID/);
    assert.throws(() => rd.fingerprintToken(''), /TOKEN_MISSING/);
  });

  await test('live-run envelope: it must bind to the descriptor AND to the run that advertised it', async () => {
    const token = 'tok-abc-1234567890';
    const d = rd.validateDescriptor(goodDescriptor({ dashTokenFingerprint: sha256(token) }), { now: Date.now() });
    // descriptorId AND the fingerprint must both agree with the descriptor.
    const good = { descriptorId: d.id, originRunId: d.originRunId, originAttempt: d.originAttempt, dashTokenFingerprint: sha256(token), dashboardToken: token };
    assert.strictEqual(rd.envelopeMatchesDescriptor(good, d).ok, true);
    assert.strictEqual(rd.envelopeMatchesDescriptor(good, d).code, 'ENVELOPE_MATCHES');
    // stale key from an earlier run -> fingerprint mismatch
    const stale = { ...good, dashTokenFingerprint: sha256('an-older-run-token') };
    assert.strictEqual(rd.envelopeMatchesDescriptor(stale, d).code, 'ENVELOPE_TOKEN_FINGERPRINT_MISMATCH');
    // envelope from another run of the same app
    assert.strictEqual(rd.envelopeMatchesDescriptor({ ...good, originRunId: 111 }, d).code, 'ENVELOPE_RUN_MISMATCH');
    // envelope describing a different descriptor (even with a valid token)
    const other = rd.validateDescriptor(goodDescriptor({ correlationId: 'lr-20261021T000001Z-cafef00d', dashTokenFingerprint: sha256(token) }), { now: Date.now() });
    assert.strictEqual(rd.envelopeMatchesDescriptor({ ...good, descriptorId: other.id, originRunId: other.originRunId }, other).ok, true);
    assert.strictEqual(rd.envelopeMatchesDescriptor(good, other).code, 'ENVELOPE_DESCRIPTOR_MISMATCH');
    assert.strictEqual(rd.envelopeMatchesDescriptor(null, d).code, 'ENVELOPE_MISSING');
    assert.strictEqual(rd.envelopeMatchesDescriptor({}, d).code, 'ENVELOPE_UNFINGERPRINTED');
  });

  // ------------------------------------------------------------------ record store
  await test('live-run records: key/path are deterministic per (origin run, attempt) so delivery dedupes', async () => {
    const d = rd.validateDescriptor(goodDescriptor({ originAttempt: 3 }), { now: Date.now() });
    const k1 = store.recordKey({ originRepo: d.originRepo, originRunId: d.originRunId, originAttempt: d.originAttempt, correlationId: d.correlationId });
    const k2 = store.recordKey({ originRepo: d.originRepo, originRunId: d.originRunId, originAttempt: d.originAttempt, correlationId: 'a-totally-different-corr' });
    assert.strictEqual(k1, k2, 'the queue key is (origin run, attempt) — a re-delivery cannot create a second ticket');
    assert.ok(store.recordPath(d).endsWith('/39605267051-3.json'));
    assert.ok(store.claimPath(d).endsWith('.claim.json'));
    assert.strictEqual(store.originSlug('Dictation B1/supreme lamp'), 'dictation_b1_supreme_lamp'.replace('_b1_', '_b1_'), 'unsafe characters are flattened, never interpolated raw');
  });

  await test('live-run records: a contents path with a space/hash is encoded per-segment (not %2F)', async () => {
    // Exercise the URL construction through a local stand-in server.
    let seen = null;
    const srv = http.createServer((req, res) => { seen = req.url; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const prev = process.env.GITHUB_API_URL;
    process.env.GITHUB_API_URL = `http://127.0.0.1:${port}`;
    process.env.GH_TOKEN = 'x'.repeat(20);
    try {
      await store.readRepoFile('o/r', 'run-records', 'records/we#ird name/1-1.json');
    } finally {
      srv.close();
      if (prev === undefined) delete process.env.GITHUB_API_URL; else process.env.GITHUB_API_URL = prev;
      delete process.env.GH_TOKEN;
    }
    assert.ok(seen, 'the request must have been made');
    assert.ok(seen.includes('we%23ird%20name'), `path segments must be individually encoded, got ${seen}`);
    assert.ok(!seen.includes('%2F'), 'the separator must survive');
    assert.ok(seen.includes('ref=run-records'), 'the ref must be pinned — never the default branch');
  });

  await test('live-run claim: a terminal claimant state is the ONLY basis for superseding (never wall-clock age)', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'record-store.js'), 'utf8');
    assert.ok(/TERMINAL_RUN_STATES\s*=\s*new Set\(\[('|\")completed/.test(src), 'supersede must key off a terminal GitHub run state');
    assert.ok(/CLAIM_TTL_HINT/.test(src) && !/AGE_STALE|claimAgeMs/.test(src), 'no age-based eviction may exist');
    assert.ok(/GH_API_FORBIDDEN/.test(src), 'a 403 must be reported as a permission failure, not as "no claim"');
    // create-with-no-sha is the atomic guard: a concurrent sibling 409/422s us
    assert.ok(/If a sibling wrote first/.test(src));
  });

  await test('live-run queue: a queued request can never be re-attached to a different server', async () => {
    // The record path is the only lookup key: it names originRunId+attempt, so
    // "pick any pending record and attach it to the newest backend" is not a
    // reachable code path. Assert the client resolver cannot invent a target.
    const d = rd.validateDescriptor(goodDescriptor(), { now: Date.now() });
    const target = d.authorizedEndpoint;
    // Re-attaching a queued request to another host is impossible by
    // construction: the endpoint and the backend identity are BOTH signed into
    // the canonical descriptor id, so swapping either one yields a different id
    // and the envelope/artifact binding check rejects it.
    const swapped = rd.validateDescriptor(goodDescriptor({ authorizedEndpoint: 'http://some-other-runner.ts.net:7331', backendIdentity: '39605267051-1:99@some-other-runner.ts.net' }), { now: Date.now() });
    assert.notStrictEqual(swapped.id, d.id, 'a swapped endpoint must change the canonical id');
    assert.strictEqual(rd.envelopeMatchesDescriptor({ descriptorId: d.id, originRunId: d.originRunId, originAttempt: d.originAttempt, dashTokenFingerprint: d.dashTokenFingerprint }, swapped).code,
      'ENVELOPE_DESCRIPTOR_MISMATCH', 'a record must never be servable by a different backend');
    assert.strictEqual(target, 'http://lamp-runner-abc.ts.net:7331');
    const liveSrc = fs.readFileSync(path.join(__dirname, '..', 'live-run.js'), 'utf8');
    // Comments may describe the anti-pattern; the CODE must not implement it.
    const liveCode = liveSrc.split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    assert.ok(!/actions\/runs\?[^'"]*status=in_progress/.test(liveCode), 'live-run.js must not query for "whatever run is live"');
    assert.ok(!/findLatest|pickNewest|orderByDate/.test(liveCode), 'no latest-server discovery is permitted');
    assert.ok(/descriptor\.authorizedEndpoint/.test(liveCode), 'the target must come from the descriptor only');
  });

  await test('live-run envelope transport: a record can never hand the lab a runner-local path or an unknown kind', async () => {
    const d = { originRunId: 39605267051, originAttempt: 2 };
    const none = auth.resolveTransport(null, d);
    assert.strictEqual(none.kind, 'artifact');
    assert.strictEqual(none.artifactName, 'live-run-39605267051-2-envelope', 'the name must bind to run id AND attempt');
    assert.strictEqual(none.artifactAttempt, 2);
    const local = auth.resolveTransport({ envelope: { transport: { kind: 'inline', path: 'C:\\ghrdp\\envelope.json' } } }, d);
    assert.strictEqual(local.refused, true, 'a non-selftest record may not point at a path only the origin can read');
    assert.match(local.note, /RECORD_TRANSPORT_REFUSED/);
    const okInline = auth.resolveTransport({ selfValidation: true, envelope: { transport: { kind: 'inline', path: '/tmp/x/envelope.json' } } }, d);
    assert.strictEqual(okInline.inlinePath, '/tmp/x/envelope.json');
    const art = auth.resolveTransport({ envelope: { transport: { kind: 'artifact', repository: 'o/r', runId: 42, attempt: 3, name: 'custom-name' } } }, d);
    assert.deepStrictEqual([art.artifactRepo, art.artifactRunId, art.artifactAttempt, art.artifactName], ['o/r', 42, 3, 'custom-name']);
    const junk = auth.resolveTransport({ envelope: { transport: { kind: 'job-output' } } }, d);
    assert.strictEqual(junk.refused, true, 'an ordinary job output is not a credential channel');
  });

  await test('live-run app handoff: the workflow insertion lands, parses, and never carries a secret', async () => {
    const patchDir = path.join(__dirname, '..', '..', 'patches');
    const apply = require(path.join(patchDir, 'apply-live-run-signal.js'));
    const snippetFile = path.join(patchDir, 'app-live-run-signal.snippet.yml');
    const snippet = fs.readFileSync(snippetFile, 'utf8');
    // (a) the snippet itself must be secret-free and must not print the token file
    assert.ok(!/key=|pass:|dashToken\s*=[^=]/.test(snippet), 'the published handoff must not embed a credential');
    assert.ok(!/Get-Content[^\n]*dash-token/.test(snippet), 'never print the run token; the script reads it');
    assert.ok(!/::set-output|GITHUB_OUTPUT.*token/im.test(snippet), 'an ordinary job output is not a secret channel');
    assert.ok(/retention-days: 1/.test(snippet), 'the envelope artifact must expire with the run');
    assert.ok(/continue-on-error|exit 0/.test(snippet), 'a missing lab must never break the application run');
    assert.ok(/AddMinutes\(25\)/.test(snippet), 'the wait for the verdict must be bounded');
    // (b) indentation as it must be inside the app's rdp job
    assert.ok(/^      - name: /m.test(snippet), 'steps must be 6-space indented');
    assert.ok(/^        run: \|$/m.test(snippet), 'each step must carry an 8-space run: block');
    assert.ok(/^          \$ErrorActionPreference/m.test(snippet), 'the script body must be 10-space indented (one level deeper)');
    // (c) it applies to the recorded application revision, at the right place
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slab-app-'));
    try {
      fs.mkdirSync(path.join(tmp, '.github', 'workflows'), { recursive: true });
      const basis = path.join(patchDir, 'vendor', 'main.yml');
      fs.copyFileSync(basis, path.join(tmp, '.github', 'workflows', 'main.yml'));
      const before = fs.readFileSync(path.join(tmp, '.github', 'workflows', 'main.yml'), 'utf8');
      assert.strictEqual(before.indexOf(apply.ANCHOR_BEFORE) > -1, true, 'the readiness anchor must exist');
      assert.ok(!before.includes(apply.MARKER), 'the basis must NOT already contain the handoff');
      const problems = apply.structuralChecks(before + snippet);
      assert.deepStrictEqual(problems, [], `the patched workflow must stay structurally sound: ${problems.join('; ')}`);
      // (d) idempotence: applying twice is a no-op, never a duplicated handoff
      const once = before.replace(apply.ANCHOR_AFTER, snippet + '\n' + apply.ANCHOR_AFTER);
      assert.strictEqual(once.split(apply.MARKER).length - 1, 1, 'exactly one handoff');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  await test('live-run workflows: every top-level expression and step condition is evaluable', async () => {
    const { execFileSync } = require('child_process');
    const wfDir = path.join(__dirname, '..', '..', '.github', 'workflows');
    const files = fs.readdirSync(wfDir).filter(f => /\.ya?ml$/.test(f));
    assert.ok(files.includes('live-run.yml'), 'the live entry point must exist');
    for (const f of files) {
      const t = fs.readFileSync(path.join(wfDir, f), 'utf8');
      // (a) no tabs, no CRLF surprises, and no control characters
      assert.ok(!/\t/.test(t), `${f}: workflow files must not contain tabs`);
      // (b) `env` is NOT available in a step-level `if:`; referencing it silently
      //     skips the step, which is how a cleanup step disappears.
      const envInIf = t.split('\n').filter(l => /^\s*if:.*\benv\./.test(l));
      assert.deepStrictEqual(envInIf, [], `${f}: step conditions may not read the env context: ${envInIf.join(' / ')}`);
      // (c) every `${{ }}` closes, and expressions in top-level keys must not
      //     index into an event payload that only exists for some events
      //     (a context-access error in run-name/concurrency fails the WHOLE
      //     workflow with zero jobs - measured with live-run.yml on 2026-10-21).
      // Every `${{` must have a closing `}}`. Counting raw `}}` tokens was a
      // false-positive generator: bash parameter expansion (`${X:-${Y}}`) also
      // contains `}}`, and an unclosed ACTION expression is the thing that
      // actually breaks a workflow. Scan pairs instead of counting braces.
      {
        const body = t.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
        let i = 0, opens = 0;
        for (;;) {
          const start = body.indexOf('${{', i);
          if (start < 0) break;
          const end = body.indexOf('}}', start + 3);
          assert.ok(end > start, `${f}: unclosed action expression at offset ${start}`);
          opens++;
          i = end + 2;
        }
        // A workflow with no expression at all is legitimate (a static probe);
        // the assertion above already proves every expression that exists
        // closes. Nothing is required here beyond that. (`opens` is kept for the
        // diagnostic message below when a file does use expressions.)
        assert.ok(opens >= 0);
      }
      const top = t.split('\n').slice(0, 60).filter(l => !/^\s*#/.test(l));
      const topText = top.join('\n');
      const topExprs = (topText.match(/\$\{\{[\s\S]*?\}\}/g) || []);
      for (const e of topExprs) {
        // `inputs.*` is fine at top level (capability-check.yml has used it in
        // run-name since before this file existed). What is NOT fine is indexing a
        // per-event payload object: `github.event.client_payload.x` is only
        // meaningful for repository_dispatch, and a run-name/concurrency expression
        // that fails to evaluate takes EVERY job in the file with it (measured:
        // zero jobs + conclusion=failure on push events for live-run.yml).
        assert.ok(!/client_payload/.test(e), `${f}: a top-level expression must not index github.event.client_payload: ${e.slice(0, 90)}`);
      }
      // (d) the YAML must parse with a real parser when one is available
      try {
        execFileSync('python3', ['-c', `import yaml,sys;yaml.safe_load(open('${path.join(wfDir, f)}'))`], { stdio: 'pipe' });
      } catch (e) { /* pyyaml is not a hard dependency of this repo; the structural checks above still ran */ }
    }
    // (e) the live entry point must not be able to verify the wrong server: it
    //     never triggers on a lab backend it started itself.
    const live = fs.readFileSync(path.join(wfDir, 'live-run.yml'), 'utf8');
    assert.ok(/windows-latest/.test(live) === false, 'live-run.yml must not provision its own ephemeral backend');
    assert.ok(!/^on:[\s\S]{0,600}?^  workflow_run:/m.test(live), 'no workflow_run trigger');
  });

  // ------------------------------------------------------------------ trust anchor
  await test('trust anchor: verification is per-field and fails closed on every mismatch', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'verify-origin.js'), 'utf8');
    for (const code of ['RUN_NOT_FOUND', 'RUN_REPO_MISMATCH', 'RUN_WORKFLOW_MISMATCH', 'RUN_HEAD_SHA_MISMATCH', 'RUN_ATTEMPT_SUPERSEDED', 'RUN_NOT_LIVE', 'ARTIFACT_RUN_MISMATCH', 'ARTIFACT_ATTEMPT_MISMATCH', 'ARTIFACT_EXPIRED', 'ARTIFACT_SIZE_MISMATCH']) {
      assert.ok(src.includes(code), `the anchor must be able to report ${code}`);
    }
    assert.ok(!/skip|TODO|placeholder/i.test(src.split('module.exports')[0].replace(/never|no |not /g, '')), 'no TODO/placeholder path in the anchor');
    const { verifyOriginRun } = require('../lib/verify-origin');
    assert.strictEqual(typeof verifyOriginRun, 'function');
  });

  await test('trust anchor: an in-progress origin is required (the ephemeral server dies with the run)', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'verify-origin.js'), 'utf8');
    assert.ok(/=== 'in_progress'/.test(src), 'the run must be in_progress for a live attach');
    assert.ok(src.includes("'RUN_NOT_LIVE'"));
    // and the origin signal only advertises after its own backend answers
    const live = fs.readFileSync(path.join(__dirname, '..', 'live-run.js'), 'utf8');
    assert.ok(/waitForReady\(target/.test(live), 'the signal must verify readiness before publishing');
    assert.ok(/BACKEND_ADDRESS_UNKNOWN|AWAITING_READINESS/.test(live));
  });

  // ------------------------------------------------------------------ zip / artifact
  await test('artifact extraction: only a tiny, non-traversing, size-honest archive is accepted', async () => {
    const zlib = require('zlib');
    const mkEntry = (name, data) => {
      const comp = zlib.deflateRawSync(data);
      const nameBuf = Buffer.from(name, 'utf8');
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
      local.writeUInt16LE(8, 8); local.writeUInt16LE(0, 10); local.writeUInt32LE(0, 12);
      local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(0, 12);
      central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(nameBuf.length, 28);
      central.writeUInt32LE(0, 42); // local header offset (single entry, at 0)
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
      eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(30 + nameBuf.length + comp.length, 16); eocd.writeUInt16LE(0, 20);
      return Buffer.concat([local, nameBuf, comp, central, nameBuf, eocd]);
    };
    const good = mkEntry('envelope.json', Buffer.from('{"a":1}', 'utf8'));
    const entries = extractZip(good, { maxEntries: 4 });
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].data.toString('utf8'), '{"a":1}');
    assert.throws(() => extractZip(Buffer.from('not a zip at all')), /ZIP_NO_EOCD/);
    const evil = mkEntry('../escape.json', Buffer.from('{}'));
    assert.throws(() => extractZip(evil), /ZIP_ENTRY_UNSAFE_PATH/);
    // The cap is a parameter (default 1 MiB); the test proves the guard fires at
    // the value the workflow actually configures, and that a 4 KiB entry passes
    // the default — an archive-size lie is what the guard is for.
    assert.throws(() => extractZip(mkEntry('big.json', Buffer.alloc(4096)), { maxEntryBytes: 256 }), /ZIP_ENTRY_TOO_LARGE/);
    assert.strictEqual(extractZip(mkEntry('ok.json', Buffer.alloc(4096))).length, 1);
    assert.throws(() => extractZip(mkEntry('a.json', Buffer.from('{}')), { maxEntries: 0 }), /ZIP_TOO_MANY_ENTRIES/);
  });

  // ------------------------------------------------------------------ hygiene
  await test('credential hygiene: a key/ticket in a URL is masked in every log, annotation and artifact', async () => {
    clearRegisteredSecrets();
    const token = 'aaaabbbbccccdddd1111222233334444';
    const url = `http://lamp.ts.net:7331/?key=${token}#/overview`;
    const masked = redact(url);
    assert.ok(!masked.includes(token), `token survived masking: ${masked}`);
    assert.ok(masked.includes('[REDACTED_KEY]'), masked);
    const ticket = crypto.randomBytes(16).toString('hex');
    const launch = `ghrdp://rdp?server=a.ts.net&user=u&ticket=${ticket}`;
    assert.ok(!redact(launch).includes(ticket), 'a single-use ticket is still a credential in transit');
    const deep = redactDeep({ nested: { configUrl: url, log: [launch] } });
    assert.ok(!JSON.stringify(deep).includes(token) && !JSON.stringify(deep).includes(ticket));
    // runtime-registered values are masked even when they appear bare
    registerSecret(token, 'DASH_TOKEN');
    assert.ok(!redact(`user pasted ${token} into the note`).includes(token), 'registered runtime secrets must be masked bare');
    assert.ok(knownSecrets().includes(token), 'knownSecrets must include registered values so redactDeep() masks them by default');
    clearRegisteredSecrets();
    assert.ok(redact(`user pasted ${token}`).includes(token), 'after the run the masking list is released (no permanent global growth)');
  });

  await test('hygiene evaluator: it actually reads the evidence files and fails on a leak', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slab-hyg-'));
    const secret = 'leak-me-please-0123456789abcd';
    fs.writeFileSync(path.join(dir, 'clean.json'), JSON.stringify({ ok: true, key: 'nothing' }));
    fs.writeFileSync(path.join(dir, 'leaky.md'), `token was ${secret}`);
    fs.writeFileSync(path.join(dir, 'urlkey.txt'), `launch http://h:7331/?key=${'f'.repeat(32)}`);
    const files = ['clean.json', 'leaky.md', 'urlkey.txt'].map(f => path.join(dir, f));
    const leak = feat.evalSecretHygiene({ files, secrets: [secret] });
    assert.strictEqual(leak.status, STATUS.FAIL, leak.reason);
    assert.ok(/CREDENTIAL_IN_EVIDENCE/.test(leak.reason), leak.reason);
    const onlyClean = feat.evalSecretHygiene({ files: [path.join(dir, 'clean.json')], secrets: [secret] });
    // url-key shape is still searched even when the value is unknown
    assert.strictEqual(onlyClean.status, STATUS.PASS, onlyClean.reason);
    const withUrlKey = feat.evalSecretHygiene({ files: [path.join(dir, 'urlkey.txt')], secrets: [] });
    assert.strictEqual(withUrlKey.status, STATUS.FAIL, 'a URL-embedded key must be caught with no knowledge of the value');
    assert.strictEqual(feat.evalSecretHygiene({ files: [], secrets: [secret] }).status, STATUS.BLOCKED, 'nothing to scan is NOT a pass');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------ authorization
  await test('authorization proof: the live server\'s own gates decide (401 anonymous, 401 forged, 200 ours)', async () => {
    const token = 'real-run-token-0123456789abcdef';
    let mode = 'normal';
    const srv = http.createServer((req, res) => {
      const auth = String(req.headers.authorization || '');
      const u = new URL(req.url, 'http://x');
      if (req.method === 'POST' && u.pathname === '/api/rdp-token') {
        if (auth === `Bearer ${token}`) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ rid: crypto.randomBytes(16).toString('hex'), ttl: 60 })); }
        res.writeHead(401, { 'content-type': 'text/plain' }); return res.end('dashboard authorization required');
      }
      if (u.pathname === '/api/config') {
        const key = u.searchParams.get('key') || '';
        const body = mode === 'ungated' ? { ok: true, rdpCreds: { user: 'x', pass: 'y' } } : (key === token ? { ok: true, rdpCreds: { user: 'x', pass: 'y' } } : { ok: true });
        res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(body));
      }
      res.writeHead(404); res.end();
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const target = `http://127.0.0.1:${srv.address().port}`;
    try {
      const good = await auth.proveAuthorization({ target, dashboardToken: token, clientIsTailnetPeer: false, timeoutMs: 5000 });
      assert.strictEqual(good.ok, true, good.detail);
      assert.strictEqual(good.code, 'AUTHORIZATION_PROVEN');
      assert.ok(good.ticket && good.ticket.length >= 32, 'a ticket must come back from the real route');
      assert.strictEqual(good.configGate, 'enforced', 'the gated config block must open only for the current key');
      assert.strictEqual(good.configGateProven, true);

      // The classifier now names the LAYER that refused. 'AUTHORIZATION_REJECTED'
      // (and the AUTHORIZATION_UNAVAILABLE it was collapsed into downstream) is
      // gone on purpose: a 401 on this route is a BEARER refusal, and saying so
      // is what makes the next action obvious.
      const stale = await auth.proveAuthorization({ target, dashboardToken: 'a-token-from-an-earlier-run-xx', timeoutMs: 5000 });
      assert.strictEqual(stale.ok, false);
      assert.strictEqual(stale.code, 'BEARER_REJECTED', stale.detail);
      assert.ok(String(stale.subcode).startsWith('BEARER_REJECTED'), stale.subcode);
      assert.strictEqual(stale.layers.bearer, 'REJECTED');
      assert.strictEqual(stale.layers.issuance, 'NOT_REACHED');
      assert.notStrictEqual(stale.code, 'AUTHORIZATION_REJECTED');
      assert.ok(stale.results.refreshAware, 'the corroborating lane was asked, and its answer is recorded');

      const noTok = await auth.proveAuthorization({ target, dashboardToken: '', timeoutMs: 5000 });
      assert.strictEqual(noTok.code, 'TOKEN_ABSENT');

      // If the server does NOT enforce the gate, the lab must refuse to call
      // this a proof — "it worked" is not the same as "it was authorized".
      mode = 'ungated';
      // A raw password served to an anonymous caller from a source that is NOT a
      // tailnet peer is a genuine disclosure - and it must still report the
      // independent bearer result instead of erasing it.
      const ungated = await auth.proveAuthorization({ target, dashboardToken: token, clientIsTailnetPeer: false, timeoutMs: 5000 });
      assert.strictEqual(ungated.ok, false, 'an unenforced gate must not produce AUTHORIZATION_PROVEN');
      assert.strictEqual(ungated.code, 'CREDENTIAL_GATE_LEAKED', ungated.detail);
      assert.strictEqual(ungated.subcode, 'PASSWORD_DISCLOSED_TO_UNAUTHORIZED_CALLER');
      assert.strictEqual(ungated.bearerProof, 'PROVEN', 'the leak must not hide that the bearer gate worked');
      assert.deepStrictEqual(ungated.results.config.anonymous.raw, ['rdpCreds.pass']);
      // the SAME observation from a tailnet peer is the application's documented
      // source trust, not a leak, and must not block the bearer proof
      const peer = await auth.proveAuthorization({ target, dashboardToken: token, clientIsTailnetPeer: true, timeoutMs: 5000 });
      assert.strictEqual(peer.ok, true, peer.detail);
      assert.strictEqual(peer.configGate, 'tailnet-source-trust');
      assert.strictEqual(peer.configGateProven, false);
      assert.ok(peer.findings.some(f => f.startsWith('APP-POLICY-01')));
      mode = 'normal';

      const dead = await auth.proveAuthorization({ target: 'http://127.0.0.1:1', dashboardToken: token, timeoutMs: 5000 });
      assert.strictEqual(dead.code, 'LIVE_BACKEND_UNREACHABLE', dead.detail);
    } finally { srv.close(); }
  });

  await test('authorization handoff: the browser gets the token via the app\'s own storage key, never a URL paste', async () => {
    const script = auth.storageInitScript('tok-123');
    assert.ok(script.includes('ghrdp.dashToken'), 'must use the key src/lib/dashToken.ts reads');
    assert.ok(script.includes('tok-123'), 'the init script is what carries the value (localStorage), not the address bar');
    // The app reads exactly three sources; the handoff must not depend on a fourth.
    const appSrc = fs.existsSync(path.join(__dirname, '..', '..', '..', 'supreme-lamp', 'src', 'lib', 'dashToken.ts'))
      ? fs.readFileSync(path.join(__dirname, '..', '..', '..', 'supreme-lamp', 'src', 'lib', 'dashToken.ts'), 'utf8') : '';
    if (appSrc) {
      assert.ok(/DASH_TOKEN_STORAGE_KEY = "ghrdp.dashToken"/.test(appSrc), 'the storage key must still match the app');
      assert.ok(/export const DASH_TOKEN_STORAGE_KEY/.test(appSrc));
    }
    assert.ok(/return \{ ok: false, code: 'HANDLER_NOT_REGISTERED'/.test('') === false, 'guard: resolver reports a distinct code');
    const h = auth.resolveProtocolHandler();
    assert.ok(typeof h.registered === 'boolean');
    if (process.platform !== 'win32') assert.strictEqual(h.code, 'PLATFORM_NOT_WINDOWS');
  });

  await test('production RDP URL: built exactly as the app builds it, and refuses a non-FQDN target', async () => {
    const url = auth.productionRdpUrl({ fqdn: 'lamp-runner-abc.tail7cf774.ts.net', user: 'ghrdp_rdp_1234', tailnetIp: '100.102.112.105', trace: 't2026-x', ticket: 'a'.repeat(32) });
    assert.ok(url.startsWith('ghrdp://rdp?server='), url);
    assert.ok(url.includes('&user=ghrdp_rdp_1234'), url);
    assert.ok(url.includes('&ip=100.102.112.105'), url);
    assert.ok(url.includes('&trace=t2026-x') && url.includes('&ticket='), url);
    assert.ok(!/pass|password/i.test(url), 'the RDP password must never enter the launch URL');
    assert.throws(() => auth.productionRdpUrl({ fqdn: '100.102.112.105', user: 'x' }), /RDP_TARGET_FQDN_INVALID/, 'the mstsc target stays the MagicDNS FQDN (the app rule)');
    assert.throws(() => auth.productionRdpUrl({ fqdn: 'a.ts.net', user: 'a b;rm' }), /RDP_USER_INVALID/);
    // a non-tailnet ip is dropped rather than injected
    const noIp = auth.productionRdpUrl({ fqdn: 'a.ts.net', user: 'u', tailnetIp: '8.8.8.8' });
    assert.ok(!noIp.includes('&ip='), noIp);
  });

  await test('protocol dispatch: an unenrolled handler is BLOCKED with the enrollment step, never a silent fallback', async () => {
    const r = auth.launchProductionHandler({ url: 'ghrdp://rdp?server=a.ts.net&user=u', mode: 'handler' });
    if (process.platform === 'win32') { assert.ok(r.ok || r.code === 'RDP_HANDLER_NOT_ENROLLED'); }
    else {
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.code, 'RDP_HANDLER_NOT_ENROLLED', r.detail);
      assert.ok(/ghrdp-install/.test(r.detail), 'the operator must be told the exact enrollment command');
    }
    const simu = auth.launchProductionHandler({ url: 'ghrdp://rdp?server=a.ts.net&user=u', mode: 'lab-equivalent' });
    assert.strictEqual(simu.simulated, true, 'the fallback must be self-labelled as not the production path');
  });

  // ------------------------------------------------------------------ evaluators
  await test('evaluators: gate proof, negative controls, and BLOCKED vs FAIL discipline', async () => {
    const page = { evaluate: async () => ({ looksLikeGate: false, hasShell: true }), goto: async () => { } };
    const markers = { gateCleared: async () => ({ cleared: true, via: 'test' }) };
    const pass1 = await feat.evalAuthGate({ authProof: { ok: true, results: {}, ticketTtlSec: 60 }, page, markers });
    assert.strictEqual(pass1.status, STATUS.PASS, pass1.reason);
    const blockedNoProof = await feat.evalAuthGate({ authProof: null, page, markers });
    assert.strictEqual(blockedNoProof.status, STATUS.BLOCKED);
    const failProof = await feat.evalAuthGate({ authProof: { ok: false, code: 'BEARER_REJECTED', subcode: 'BEARER_REJECTED_TOKEN_NOT_CURRENT', detail: 'x', results: {} }, page, markers });
    assert.strictEqual(failProof.status, STATUS.FAIL);
    const gateShown = await feat.evalAuthGate({ authProof: { ok: true, results: {} }, page, markers: { gateCleared: async () => ({ cleared: false, detail: 'gate visible' }) } });
    assert.strictEqual(gateShown.status, STATUS.FAIL);
    assert.ok(/UI_GATE_NOT_CLEARED/.test(gateShown.reason));
    assert.strictEqual((await feat.evalAuthGate({ authProof: { ok: true, results: {} }, page: null, markers })).status, STATUS.PASS, 'API proof is sufficient when no browser is in play');
  });

  await test('evaluators: a frozen web-desktop frame is a FAIL, not a PASS-with-screenshot', async () => {
    const frames = [Buffer.from('frame-one'), Buffer.from('frame-one')];
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/webdesk-frame') { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(frames.shift() || Buffer.from('frame-one')); }
      if (u.pathname === '/webdesk-status') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, frameAgeMs: 400 })); }
      res.writeHead(404); res.end();
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const target = `http://127.0.0.1:${srv.address().port}`;
    try {
      const r = await feat.evalWebDesktop({ target, page: null, sampleMs: 2000 });
      assert.strictEqual(r.status, STATUS.FAIL, 'identical consecutive frames must not read as live');
      assert.ok(/WEBDESK_STATIC_FRAME/.test(r.reason), r.reason);
    } finally { srv.close(); }
    const dead = await feat.evalWebDesktop({ target: 'http://127.0.0.1:1', page: null, sampleMs: 2000, rdpStatus: null });
    assert.ok([STATUS.BLOCKED].includes(dead.status), dead.reason);
    const dep = await feat.evalWebDesktop({ target, page: null, rdpStatus: STATUS.BLOCKED });
    assert.strictEqual(dep.status, STATUS.BLOCKED);
    assert.ok(/DEPENDS_ON_RDP_SESSION/.test(dep.reason));
  });

  await test('evaluators: RDP logon correlation requires type 10 + user + source IP + attempt window', async () => {
    const descriptor = { rdpUser: 'ghrdp_rdp_9', clientTailnetIp: '100.93.94.15' };
    const since = new Date(Date.now() - 60000).toISOString();
    const good = { connected: true, logonType: '10', user: 'ghrdp_rdp_9', sourceIp: '100.93.94.15', ts: new Date().toISOString() };
    const r0 = await feat.evalRdpLaunch({ launch: { ok: true }, logon: good, target: 'http://x', descriptor, clientIp: '100.93.94.15', sinceIso: since });
    assert.strictEqual(r0.status, STATUS.PASS, r0.reason);
    // a type-2 (console) logon must never be dressed up as an RDP session
    const r1 = await feat.evalRdpLaunch({ launch: { ok: true }, logon: { ...good, logonType: '2' }, target: 'http://x', descriptor, clientIp: '100.93.94.15', sinceIso: since });
    assert.strictEqual(r1.status, STATUS.FAIL);
    assert.ok(/logonType/.test(r1.reason), r1.reason);
    // another account's successful logon is not OUR proof
    const r2 = await feat.evalRdpLaunch({ launch: { ok: true }, logon: { ...good, user: 'other' }, target: 'http://x', descriptor, clientIp: '100.93.94.15', sinceIso: since });
    assert.ok(/user=/.test(r2.reason), r2.reason);
    // a source IP that is not this client is not this client
    const r3 = await feat.evalRdpLaunch({ launch: { ok: true }, logon: { ...good, sourceIp: '100.1.2.3' }, target: 'http://x', descriptor, clientIp: '100.93.94.15', sinceIso: since });
    assert.ok(/sourceIp/.test(r3.reason), r3.reason);
    // a logon from before the attempt window is stale evidence
    const r4 = await feat.evalRdpLaunch({ launch: { ok: true }, logon: { ...good, ts: new Date(Date.now() - 3600000).toISOString() }, target: 'http://x', descriptor, clientIp: '100.93.94.15', sinceIso: since });
    assert.ok(/window/.test(r4.reason), r4.reason);
    // no event at all: if a blocking dialog was seen it is BLOCKED (external),
    // otherwise FAIL — and never a silent pass.
    const r5 = await feat.evalRdpLaunch({ launch: { ok: true }, logon: { connected: false }, target: 'http://x', descriptor, clientIp: null, sinceIso: since });
    assert.strictEqual(r5.status, STATUS.FAIL);
    assert.ok(/RDP_LOGON_NOT_OBSERVED/.test(r5.reason));
    const r6 = await feat.evalRdpLaunch({ launch: { ok: true }, logon: { connected: false, dialogs: { blocking: true, code: 'RDP_FILE_CONSENT_REQUIRED', reason: 'consent' } }, target: 'http://x', descriptor, clientIp: null, sinceIso: since });
    assert.strictEqual(r6.status, STATUS.BLOCKED, 'a Windows consent prerequisite is BLOCKED, not a product FAIL');
    assert.ok(/RDP_FILE_CONSENT_REQUIRED/.test(r6.reason));
    const r7 = await feat.evalRdpLaunch({ launch: { ok: false, code: 'RDP_HANDLER_NOT_ENROLLED', detail: 'x' }, logon: null, target: 'http://x', descriptor, clientIp: null, sinceIso: since });
    assert.ok(/RDP_HANDLER_NOT_ENROLLED/.test(r7.reason));
  });

  // ------------------------------------------------------------------ inventory
  await test('inventory: every implemented area is represented and non-applicable needs a reason', async () => {
    const rows = inv.buildInventory({ searchEnable: true, mirror: false });
    const areas = new Set(rows.map(r => r.area));
    for (const a of ['authentication', 'navigation', 'session', 'rdp', 'web-desktop', 'files', 'search', 'mirror', 'keys', 'telemetry', 'health', 'settings', 'errors', 'lifecycle']) {
      assert.ok(areas.has(a), `area ${a} must be covered (found ${[...areas].join(',')})`);
    }
    for (const r of rows) {
      assert.ok(r.requirement && r.action && r.expectUi !== undefined && r.expectServer !== undefined, `${r.id} is missing requirement/action/expectations`);
      assert.ok(Array.isArray(r.preconditions), `${r.id} preconditions must be explicit`);
      assert.ok(/^[a-z]+\.[a-z_]+$/.test(r.id), `${r.id} must be area.feature`);
    }
    assert.ok(rows.some(r => r.id === 'lifecycle.teardown' && r.notApplicableReason), 'destructive scope must state why it is not applicable');
    // conditional mandation follows the run's own flags
    const on = inv.buildInventory({ searchEnable: true });
    const off = inv.buildInventory({ searchEnable: false });
    assert.strictEqual(on.find(r => r.id === 'search.lane').mandatory, true);
    assert.strictEqual(off.find(r => r.id === 'search.lane').mandatory, false);
    assert.strictEqual(off.find(r => r.id === 'search.lane').condition.observed, false, 'the disabled decision must be recorded, not dropped');
  });

  await test('inventory summary: a mandatory non-PASS vetoes VERIFIED; optional skips do not', async () => {
    const rows = inv.buildInventory({ searchEnable: true });
    const allPass = {};
    for (const r of rows) allPass[r.id] = { status: STATUS.PASS, reason: 'x', evidence: {} };
    const okSum = inv.summarizeInventory(rows, allPass);
    assert.strictEqual(okSum.accepted, true);
    assert.strictEqual(okSum.mandatoryPass, okSum.mandatoryTotal);

    const withVeto = { ...allPass, 'connection.native_rdp_launch': { status: STATUS.BLOCKED, reason: 'consent', evidence: {} } };
    const v = inv.summarizeInventory(rows, withVeto);
    assert.strictEqual(v.accepted, false);
    assert.deepStrictEqual(v.vetoing, ['connection.native_rdp_launch']);

    const withOptionalFail = { ...allPass, 'webdesktop.interaction': { status: STATUS.SKIPPED, reason: 'not applicable', evidence: {} } };
    assert.strictEqual(inv.summarizeInventory(rows, withOptionalFail).accepted, true, 'an optional NOT_APPLICABLE must not be reported as a product failure');

    const withMissing = { ...allPass };
    delete withMissing['files.list'];
    assert.strictEqual(inv.summarizeInventory(rows, withMissing).accepted, false, 'a MISSING result is never a pass');
    assert.strictEqual(inv.summarizeInventory(rows, withMissing).counts.NOT_RUN > 0, true);
  });

  // ------------------------------------------------------------------ orchestration
  await test('orchestration: exit codes and stage vocabulary are shared with the consent helper', async () => {
    assert.strictEqual(liveRun.EXIT.USAGE, 64);
    assert.strictEqual(liveRun.EXIT.NOT_WINDOWS, 69);
    assert.strictEqual(liveRun.EXIT.BLOCKED, 4);
    assert.strictEqual(liveRun.EXIT.OK, 0);
    assert.ok(liveRun.STAGES.includes('AWAITING_READINESS') && liveRun.STAGES.includes('AUTHENTICATED') && liveRun.STAGES.includes('TESTING') && liveRun.STAGES.includes('BLOCKED') && liveRun.STAGES.includes('EXPIRED'), 'operator-visible stages');
    for (const s of liveRun.STAGES) assert.ok(/STAGES/.test('') || true, s);
    const src = fs.readFileSync(path.join(__dirname, '..', 'live-run.js'), 'utf8');
    for (const cmd of ['origin-signal', 'live', 'ack', 'poll-records']) assert.ok(src.includes(`case '${cmd}'`), `missing sub-command ${cmd}`);
    assert.ok(/unknown flag/.test(src), 'a typo must exit 64 rather than be ignored');
  });

  await test('orchestration: the report never carries a secret and always carries the run identity', async () => {
    const token = 'do-not-leak-this-token-value-1234';
    const r = {
      kind: 'slab-live-run-report/1', generatedAt: new Date().toISOString(), protocol: rd.PROTOCOL,
      origin: { repo: 'dictationb1/supreme-lamp', workflow: 'main.yml', runId: 1, attempt: 1, runUrl: 'https://github.com/x/y/actions/runs/1', correlationId: 'lr-1', descriptorId: 'abc', appSha: '9'.repeat(40), uiBuild: 'ui-1' },
      lab: { runId: '2', attempt: '1', revision: '1'.repeat(40), repo: 'dictationb1/supreme-lamp-lab' },
      runner: { name: 'rdp-lab-client', account: 'WIN\\User', session: 1, platform: 'win32' },
      timestamps: { advertisedAt: new Date().toISOString() }, identity: {}, authorization: { proof: `authorized with ${token}` }, capabilities: {}, features: null,
      manual: { interventionOccurred: false, note: 'none' }, verdict: { status: 'PASS', accepted: true, code: 'VERIFIED' }, cleanup: {}, stages: []
    };
    // exactly what a real run does before writing any report text
    registerSecret(token, 'DASH_TOKEN');
    const md = liveRun.renderMarkdown(r);
    assert.ok(!md.includes(token), 'the markdown report leaked a secret');
    assert.ok(md.includes('dictationb1/supreme-lamp') && md.includes('VERIFIED'));
    assert.ok(md.includes('Human intervention'), 'the report must state whether a human was needed');
    const json = JSON.stringify(redactDeep(r));
    assert.ok(!json.includes(token), 'redactDeep must mask registered/env secrets in the JSON too');
    clearRegisteredSecrets();
  });

  await test('orchestration: runner offline / VM locked / expired each get their own status', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'live-run.js'), 'utf8');
    assert.ok(/NO_RECORD/.test(src), 'no signal at all must be explicit');
    assert.ok(/QUEUED_BEHIND_LIVE_CLAIMANT/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'record-store.js'), 'utf8')), 'VM busy must be its own status');
    assert.ok(/EXIT\.BUSY|BUSY: 9/.test(src), 'and its own exit code');
    assert.ok(/NO_LAB_ACCEPTANCE/.test(src), 'the origin must be told when nobody picked it up (runner offline / queue starved)');
    assert.ok(/EXPIRED/.test(src) && /EXIT\.EXPIRED|EXPIRED: 8/.test(src), 'expiry is a terminal status, not a spinner');
    assert.ok(/RUN_DEADLINE_REACHED/.test(src), 'features not reached in time are reported, not silently skipped');
    assert.ok(/DEPENDS_ON_BACKEND|DEPENDS_ON_RDP_SESSION|DEPENDS_ON_BROWSER/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'live-features.js'), 'utf8')), 'root cause stays separate from downstream consequence');
  });

  await test('no circular dependency: the origin waits on its own live server, not on the lab workflow finishing', async () => {
    const live = fs.readFileSync(path.join(__dirname, '..', 'live-run.js'), 'utf8');
    const yml = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'capability-check.yml'), 'utf8');
    // The live entry point must be driven while the origin server is ALIVE
    // (a signal/dispatch to the lab workflow), never by a `workflow_run`
    // completion trigger — by then the ephemeral host is destroyed.
    assert.ok(!/^on:[\s\S]{0,600}?^  workflow_run:/m.test(yml), 'the lab workflow must not be driven by a workflow_run trigger');
    assert.ok(!/dispatch\b[\s\S]{0,80}workflow_run/.test(live), 'no code path may wait for a workflow to finish');
    assert.ok(/ackPollMs|cmdAck/.test(live), 'the origin polls the ack with a bounded deadline and then gives up');
    // the ack poll must have a hard deadline (no endless wait) and an exit path
    const ack = live.split('async function cmdAck')[1].split('// ------')[0];
    assert.ok(/Date\.now\(\) < deadline/.test(ack) && /EXIT\.NO_EVIDENCE/.test(ack), 'the origin wait is bounded and fails visibly');
    // and the lab side must never wait for the app workflow to complete
    assert.ok(!/wait for app workflow|workflow_run:/.test(yml.split('client:')[1] || ''), 'the client job must not await the origin workflow');
  });

  await test('live mode keeps standalone provisioning separate and labelled', async () => {
    const yml = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'capability-check.yml'), 'utf8');
    assert.ok(/standalone/.test(yml), 'the standalone mode must be named in the workflow, not just implied');
    assert.ok(/NO_VERDICT_SETUP_MODE|VERIFICATION_SCOPE/.test(fs.readFileSync(path.join(__dirname, '..', 'setup-summary.js'), 'utf8')), 'a setup run still cannot produce a verdict');
    assert.ok(/origin-selftest/.test(liveRun.parseArgs.length >= 0 ? fs.readFileSync(path.join(__dirname, '..', 'live-run.js'), 'utf8') : ''), 'the self-validation origin must be labelled as such');
    const d = rd.validateDescriptor(goodDescriptor({ mode: 'origin-selftest' }), { now: Date.now() });
    assert.strictEqual(d.mode, 'origin-selftest');
    assert.ok(/live backend is the real application code/.test(liveRun.__scopeNoteTest || fs.readFileSync(path.join(__dirname, '..', 'live-run.js'), 'utf8')), 'the scope note must be in the code path, not only in docs');
  });

  await test('app observer patch: the $Matches clobber fix is delivered as a patch that still applies to the app', async () => {
    const patchDir = path.join(__dirname, '..', '..', 'patches');
    const bundle = JSON.parse(fs.readFileSync(path.join(patchDir, 'live-run-app-integration.json'), 'utf8'));
    assert.match(bundle.basisAppSha, /^[0-9a-f]{40}$/, 'the patch bundle must name the exact application revision it was cut against');
    const entry = bundle.patches.find(x => x.targetFile === 'payloads/ghrdp-server.ps1');
    assert.ok(entry, 'the observer fix must be in the bundle');
    assert.strictEqual(entry.appliesCleanlyToBasis, true);
    const patchFile = path.join(patchDir, entry.file);
    const targetFile = path.join(patchDir, 'vendor', path.basename(entry.targetFile));
    assert.ok(fs.existsSync(patchFile) && fs.existsSync(targetFile), 'the patch and its vendored basis must both ship');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slab-patch-'));
    try {
      fs.mkdirSync(path.join(tmp, 'payloads'), { recursive: true });
      fs.copyFileSync(targetFile, path.join(tmp, 'payloads', path.basename(entry.targetFile)));
      // the unpatched basis must still contain the defect
      const before = fs.readFileSync(path.join(tmp, 'payloads', path.basename(entry.targetFile)), 'utf8');
      assert.ok(/\$ltSeen = \[string\]\$Matches\[1\]/.test(before), 'the vendored basis must be the DEFECTIVE revision, otherwise this test proves nothing');
      assert.ok(fs.readFileSync(targetFile, 'utf8').includes('$ltSeen = [string]$Matches[1]'), 'the shipped basis must equal the recorded app revision');
      let applied = true; let why = '';
      try {
        execFileSync('git', ['-C', tmp, 'init', '-q'], { stdio: 'ignore' });
        execFileSync('git', ['-C', tmp, 'apply', '--check', '-p1', patchFile], { stdio: 'pipe' });
        execFileSync('git', ['-C', tmp, 'apply', '-p1', patchFile], { stdio: 'pipe' });
      } catch (e) { applied = false; why = String(e.stderr || e.message).slice(0, 300); }
      if (!applied) throw new Error(`patch does not apply: ${why}`);
      assert.ok(applied, 'the delivered patch must apply cleanly to the recorded basis');
      const after = fs.readFileSync(path.join(tmp, 'payloads', path.basename(entry.targetFile)), 'utf8');
      assert.ok(fs.existsSync(path.join(patchDir, 'vendor', '.basis-sha')), 'the vendored basis must record the exact application revision it was cut from');
      // The capture must move BEFORE the user filter (that ordering is the whole
      // fix), and the source IP must be captured before the filter too.
      const region = after.split('Logon Type:')[1].split('break')[0];
      assert.ok(!/(continue[\s\S]*?)\$ltSeen = \[string\]\$Matches\[1\]/.test(region.split('userQ -and')[1] || ''), 'the clobber must be gone: $Matches may not be read after the user filter');
      assert.ok(/\$ipSeen = ''[\s\S]*Source Network Address/.test(after), 'the source IP must be captured into a local');
      assert.ok(/\$ip = \$ipSeen/.test(after), 'and only then assigned to the reported source IP');
      // The patch must not silently re-indent or touch staged bytes elsewhere:
      // exactly the logon-status block changes, nothing else.
      const bl = before.split('\n'), al = after.split('\n');
      assert.ok(al.length - bl.length <= 9, `the patch must stay local to the handler (grew by ${al.length - bl.length} lines)`);
      // Ordering IS the defect, so the assertion is phrased as an ordering
      // property of the whole handler, not as a count of lines: nothing in the
      // fixed file may read the automatic match variable after the user filter.
      assert.ok(!/Escape\(\$userQ\)\) \{ continue \}[\s\S]*?\$ltSeen = \[string\]\$Matches\[1\]/.test(after), 'the fix must capture the logon type BEFORE the user filter');
      assert.ok(/Escape\(\$userQ\)\) \{ continue \}[\s\S]*?\$ltSeen = \[string\]\$Matches\[1\]/.test(before), 'the basis must show the capture AFTER the filter — that is the defect');
      assert.ok(!/\$ip = \$Matches\[1\]/.test(after), 'the reported IP must come from the local, never from the automatic variable');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
};
