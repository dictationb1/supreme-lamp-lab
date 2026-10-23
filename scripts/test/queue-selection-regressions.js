'use strict';
// ===========================================================================
// QUEUE SELECTION (the step that decides whether the client VM runs at all)
// ---------------------------------------------------------------------------
// Measured on lab run 39899953594 (PR #23, 2026-10-23): discovery published a
// valid record for application run 39899087271/1, the claim job exited
// "success", and the client job was SKIPPED. Two independent defects in
// scripts/pick-record.js made every selection return proceed=no:
//   a. loadRecords required the document to end with `}`; poll-records prints a
//      header line before the JSON and a `[NOTICE] …` line after it.
//   b. readRepoFile returns {text,json,sha,size}; the selector read the file
//      envelope instead of `.json`, so every record was "body unavailable".
// ===========================================================================

module.exports = async function register({ test, assert, fs, path, tmpRoot }) {
  const pick = require('../pick-record');
  const live = require('../live-run');
  const rd = require('../lib/run-descriptor');

  const SHA = 'c470531e4739be072daea20425a1de203d0ed326';
  const DESC = () => ({
    protocol: 'slab-live-run/1',
    originRepo: 'dictationb1/supreme-lamp',
    originWorkflow: '.github/workflows/main.yml',
    originRunId: 39899087271,
    originAttempt: 1,
    appSha: SHA,
    uiBuild: `ui-dist-${SHA}`,
    backendIdentity: '100.124.43.82:7331',
    authorizedEndpoint: 'http://100.124.43.82:7331',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 6 * 3600e3).toISOString(),
    labRevision: 'unknown',
    correlationId: 'lr-39899087271-1',
    dashTokenFingerprint: 'b'.repeat(64),
    clientTailnetIp: '',
    mode: 'live-origin'
  });
  const ROW = () => ({
    path: 'records/dictationb1_supreme-lamp/39899087271-1.json',
    correlationId: 'lr-39899087271-1',
    origin: 'dictationb1/supreme-lamp#39899087271/1',
    appSha: SHA.slice(0, 12),
    mode: 'live-origin',
    state: 'AWAITING_LAB_ACCEPTANCE',
    claimedBy: null,
    expiresInSeconds: 20919,
    pickable: true
  });
  const ARGS = { correlation: '', origin: '', run: 0, attempt: 1 };

  await test('queue: poll-records output with a header and a trailing [NOTICE] line still parses', async () => {
    const text = [
      '',
      '===== poll-records result (exit 0) =====',
      '{',
      '  "cmd": "poll-records",',
      '  "exit": 0,',
      '  "records": [ { "correlationId": "lr-39899087271-1", "state": "AWAITING_LAB_ACCEPTANCE" } ],',
      '  "pending": 1',
      '}',
      '',
      '[NOTICE] live-run poll-records: verified: ',
      ''
    ].join('\n');
    const file = path.join(tmpRoot, 'records-poll.txt');
    fs.writeFileSync(file, text, 'utf8');
    const loaded = pick.loadRecords(file);
    assert.ok(!loaded.error, loaded.error);
    assert.strictEqual(loaded.doc.records.length, 1);
    assert.strictEqual(loaded.doc.records[0].correlationId, 'lr-39899087271-1');
  });



  await test('ack: a job conclusion is never a verification verdict (the 39904246194 relabel)', async () => {
    const lr = require('../live-run');
    assert.strictEqual(lr.ackStateForJobResult('success'), 'BLOCKED', 'a green job without an in-process report claims nothing');
    assert.strictEqual(lr.ackStateForJobResult('failure'), 'FAILED');
    assert.strictEqual(lr.ackStateForJobResult('cancelled'), 'BLOCKED');
    assert.strictEqual(lr.ackStateForJobResult('skipped'), 'BLOCKED');
    assert.strictEqual(lr.ackStateForJobResult('nonsense'), 'BLOCKED');
    for (const v of Object.values(lr.ACK_JOB_RESULT_STATES)) assert.notStrictEqual(v, 'REPORTED_VERIFIED');
  });


  await test('workflow: every step that reads the lab key declares it (the probe was missing it)', async () => {
    const { readNormalized } = require('../lib/workflow-text');
    const wf = readNormalized(__dirname, '..', '..', '.github', 'workflows', 'live-run.yml');
    const blocks = wf.split(/\n(?=      - )/).filter(b => /node scripts\/live-run\.js (live|signal-status|discover|origin-signal)/.test(b));
    assert.ok(blocks.length >= 2, 'found the key-consuming steps');
    for (const b of blocks) {
      assert.match(b, /LAB_SIGNAL_PRIVATE_KEY: \$\{\{ secrets\.LAB_SIGNAL_PRIVATE_KEY \}\}/, 'a step that reads the key must receive it: ' + b.split('\n')[0].trim());
    }
  });

  await test('workflow: the client job prints its verdict and its origin probe on the run page', async () => {
    const { readNormalized } = require('../lib/workflow-text');
    const wf = readNormalized(__dirname, '..', '..', '.github', 'workflows', 'live-run.yml');
    const verifyJob = wf.slice(wf.indexOf('  verify:'), wf.indexOf('  report:'));
    assert.match(verifyJob, /signal-status --origin-repo/, 'the origin lookup is probed in this job');
    assert.match(verifyJob, /live-run-report\.json/, 'the verdict is read from the report');
    assert.match(verifyJob, /::error title=live-run verdict::/, 'a non-accepted verdict is annotated, not hidden');
    assert.match(verifyJob, /if \(\$code -eq 0\) \{ exit 0 \}/, 'only a VERIFIED exit is a green step');
  });


  await test('queue: a claim left by a terminal lab run does not make the origin unattachable', async () => {
    const body = { descriptor: DESC(), state: 'FAILED', retryable: true };
    const row = { ...ROW(), state: 'FAILED', retryable: true, claimedBy: '39904982757' };
    const liveClaim = await pick.pickFromRows([row], ARGS, {
      allow: ['dictationb1/supreme-lamp'], claimLive: async () => true,
      readFull: async () => ({ json: body })
    });
    assert.strictEqual(liveClaim.proceed, 'no');
    assert.match(liveClaim.reason, /already claimed by live lab run/);

    const unknown = await pick.pickFromRows([row], ARGS, {
      allow: ['dictationb1/supreme-lamp'], claimLive: async () => null,
      readFull: async () => ({ json: body })
    });
    assert.strictEqual(unknown.proceed, 'no', 'an unreadable claimant is treated as live');

    const stale = await pick.pickFromRows([row], ARGS, {
      allow: ['dictationb1/supreme-lamp'], claimLive: async () => false,
      readFull: async () => ({ json: body })
    });
    assert.strictEqual(stale.proceed, 'yes', stale.reason);
    assert.match(stale.reason, /SELECTED .*claim=39904982757/);
  });

  await test('queue: a lab attempt that died without an in-process report leaves the origin retryable', async () => {
    const row = { ...ROW(), state: 'FAILED', retryable: true };
    const res = await pick.pickFromRows([row], ARGS, {
      allow: ['dictationb1/supreme-lamp'],
      readFull: async () => ({ json: { descriptor: DESC(), state: 'FAILED', retryable: true } })
    });
    assert.strictEqual(res.proceed, 'yes', res.reason);
    assert.match(res.reason, /retryable=FAILED/);
  });

  await test('queue: a reported failure/verification is never re-served (no duplicate work, no relabelling)', async () => {
    for (const state of ['REPORTED_VERIFIED', 'REPORTED_FAILED']) {
      const row = { ...ROW(), state };
      const res = await pick.pickFromRows([row], ARGS, {
        allow: ['dictationb1/supreme-lamp'],
        readFull: async () => ({ json: { descriptor: DESC(), state } })
      });
      assert.strictEqual(res.proceed, 'no', `${state} must not be picked`);
      assert.match(res.reason, /state=REPORTED_/);
    }
    // FAILED without the retryable flag (the poisoning defect) is not served
    const poisoned = { ...ROW(), state: 'FAILED' };
    const res2 = await pick.pickFromRows([poisoned], ARGS, {
      allow: ['dictationb1/supreme-lamp'],
      readFull: async () => ({ json: { descriptor: DESC(), state: 'FAILED' } })
    });
    assert.strictEqual(res2.proceed, 'no');
  });

  await test('queue: the JSON extractor is balanced (braces inside strings cannot truncate it)', async () => {
    const obj = pick.extractJsonObject('noise {"a":{"b":"}{"},"c":[1,2]} trailing noise }');
    assert.deepStrictEqual(obj, { a: { b: '}{' }, c: [1, 2] });
    assert.strictEqual(pick.extractJsonObject('no json at all'), null);
    assert.strictEqual(pick.extractJsonObject('{broken'), null);
  });

  await test('queue: a record read through record-store ({text,json,sha,size}) is selected, not "body unavailable"', async () => {
    const res = await pick.pickFromRows([ROW()], ARGS, {
      allow: ['dictationb1/supreme-lamp'],
      readFull: async () => ({ text: JSON.stringify({ descriptor: DESC(), state: 'AWAITING_LAB_ACCEPTANCE' }), json: { descriptor: DESC(), state: 'AWAITING_LAB_ACCEPTANCE' }, sha: 'x', size: 10 })
    });
    assert.strictEqual(res.proceed, 'yes', res.reason);
    assert.strictEqual(res.descriptor.originRunId, 39899087271);
    assert.strictEqual(res.descriptor.authorizedEndpoint, 'http://100.124.43.82:7331');
  });

  await test('queue: reading the file envelope instead of .json is exactly the rejected shape', async () => {
    const res = await pick.pickFromRows([ROW()], ARGS, {
      allow: ['dictationb1/supreme-lamp'],
      // no `json` and no `text`: this is what a wrong field read looks like
      readFull: async () => ({ sha: 'x', size: 10 })
    });
    assert.strictEqual(res.proceed, 'no');
    assert.match(res.reason, /record body unavailable/);
  });

  await test('queue: a live claim by another lab run is honoured (one desktop claimant per origin attempt)', async () => {
    const row = { ...ROW(), claimedBy: '39900000001' };
    const res = await pick.pickFromRows([row], ARGS, {
      allow: ['dictationb1/supreme-lamp'],
      readFull: async () => ({ json: { descriptor: DESC(), state: 'CLAIMED_BY_LAB' } })
    });
    assert.strictEqual(res.proceed, 'no');
    assert.match(res.reason, /already claimed by live lab run 39900000001/);
  });

  await test('queue: an origin outside the allowlist is never selected, even with a valid descriptor', async () => {
    const row = { ...ROW(), origin: 'someone/else#39899087271/1' };
    const res = await pick.pickFromRows([row], ARGS, {
      allow: ['dictationb1/supreme-lamp'],
      readFull: async () => ({ json: { descriptor: { ...DESC(), originRepo: 'someone/else' }, state: 'AWAITING_LAB_ACCEPTANCE' } })
    });
    assert.strictEqual(res.proceed, 'no');
    assert.match(res.reason, /not allowlisted|ORIGIN_REPO_UNTRUSTED/);
  });

  await test('queue: an expired record is skipped (a dead ephemeral server is never attached)', async () => {
    const row = { ...ROW(), expiresInSeconds: -5 };
    const res = await pick.pickFromRows([row], ARGS, {
      allow: ['dictationb1/supreme-lamp'],
      readFull: async () => ({ json: { descriptor: DESC(), state: 'AWAITING_LAB_ACCEPTANCE' } })
    });
    assert.strictEqual(res.proceed, 'no');
    assert.match(res.reason, /expired/);
  });

  await test('queue: an explicit correlation is never substituted with another record', async () => {
    const res = await pick.pickFromRows([ROW()], { ...ARGS, correlation: 'lr-does-not-exist' }, {
      allow: ['dictationb1/supreme-lamp'],
      readFull: async () => ({ json: { descriptor: DESC(), state: 'AWAITING_LAB_ACCEPTANCE' } })
    });
    assert.strictEqual(res.proceed, 'no');
    assert.match(res.reason, /CORRELATION_NOT_FOUND/);
  });

  await test('queue: FIFO selection takes the oldest record, never the newest', async () => {
    const older = { ...ROW(), correlationId: 'lr-39899000001-1', origin: 'dictationb1/supreme-lamp#39899000001/1', path: 'records/a.json' };
    const newer = { ...ROW(), correlationId: 'lr-39899999999-1', origin: 'dictationb1/supreme-lamp#39899999999/1', path: 'records/b.json' };
    const res = await pick.pickFromRows([newer, older], ARGS, {
      allow: ['dictationb1/supreme-lamp'],
      readFull: async (p) => ({ json: { descriptor: { ...DESC(), correlationId: p === 'records/a.json' ? older.correlationId : newer.correlationId, originRunId: p === 'records/a.json' ? 39899000001 : 39899999999 }, state: 'AWAITING_LAB_ACCEPTANCE' } })
    });
    assert.strictEqual(res.proceed, 'yes');
    assert.strictEqual(res.descriptor.originRunId, 39899000001);
  });


  await test('workflow: cleanup bookkeeping cannot skip the verification; process-table safety still fails it', async () => {
    const { readNormalized } = require('../lib/workflow-text');
    const wf = readNormalized(__dirname, '..', '..', '.github', 'workflows', 'live-run.yml');
    const pre = wf.slice(wf.indexOf('- name: Preflight owned-process cleanup'), wf.indexOf('- name: Install lab dependencies'));
    assert.ok(pre.length > 100, 'preflight step located');
    assert.match(pre, /\$code -eq 2/, 'survivors are fatal');
    assert.match(pre, /\$code -eq 4/, 'an unreadable process table is fatal');
    assert.match(pre, /::warning title=preflight cleanup::exit \$code/, 'bookkeeping failures are visible but not fatal');
    // the two runner mechanics that made the previous version fail silently
    assert.match(pre, /\$ErrorActionPreference = 'Continue'/, 'native stderr redirection must not be terminating');
    assert.doesNotMatch(pre, /2>&1/, 'never fold native stderr into the PowerShell pipeline');
    assert.match(pre, /--out \$jsonPath/, 'the summary is read from a file, not from console text');
    assert.match(pre, /cleanup-preflight\.json/, 'the summary lands in the uploaded artifact dir');
    assert.match(pre, /^\s*exit 0$/m, 'a classified warning still exits the step successfully');
    assert.match(pre, /GITHUB_STEP_SUMMARY/, 'the summary is surfaced as an annotation-grade artifact');
    const post = wf.slice(wf.indexOf('- name: Postflight cleanup'), wf.indexOf('- name: Upload live-run evidence'));
    assert.ok(post.length > 100, 'postflight step located');
    assert.match(post, /cleanup-postflight\.json/, 'postflight writes its JSON into the uploaded artifact dir');
    assert.match(post, /\$code -eq 2/);
    assert.match(post, /\$code -eq 4/);
    assert.match(post, /^\s*exit 0$/m);

    // MEASURED (39902940714): the job had no node on PATH, the cleanup no-op'd
    // silently and the next step threw an unexplained exit 1.
    const verifyJob = wf.slice(wf.indexOf('  verify:'), wf.indexOf('  report:'));
    // MEASURED (39903491430): actions/setup-node itself failed here (7zr.exe exit
    // 2), so node must not be a tool-cache dependency of this job.
    assert.doesNotMatch(verifyJob, /uses: actions\/setup-node@/, 'the client job does not depend on the tool cache');
    assert.match(verifyJob, /node-portable/, 'a portable node is the fallback');
    assert.match(verifyJob, /NO NODE ON CLIENT VM/, 'a missing node is named as a prerequisite');
    assert.ok(verifyJob.indexOf('Provision Node.js') < verifyJob.indexOf('Preflight owned-process cleanup'), 'node is provisioned before the cleanup uses it');
    assert.match(verifyJob, /deps-install\.log/, 'dependency install output is kept as evidence');
    assert.match(verifyJob, /title=npm ci::exit/, 'npm ci failure names the command and the code');
  });

  await test('workflow: the live step re-derives the credential in process (key in env, signal-first transport)', async () => {
    const { readNormalized } = require('../lib/workflow-text');
    const wf = readNormalized(__dirname, '..', '..', '.github', 'workflows', 'live-run.yml');
    const live = wf.slice(wf.indexOf('- name: LIVE VERIFICATION'), wf.indexOf('- name: Keep the authorized viewer open'));
    assert.match(live, /LAB_SIGNAL_PRIVATE_KEY: \$\{\{ secrets\.LAB_SIGNAL_PRIVATE_KEY \}\}/);
    assert.match(live, /'--origin-transport', 'auto'/);
    assert.match(live, /'--native-handoff', 'handler'/);
    // and the secret must also reach the discover/claim steps that decrypt
    const discover = wf.slice(wf.indexOf('- name: Discover the originating run'), wf.indexOf('- name: claim + verify origin') > 0 ? wf.indexOf('  claim:') : undefined);
    assert.match(discover, /LAB_SIGNAL_PRIVATE_KEY: \$\{\{ secrets\.LAB_SIGNAL_PRIVATE_KEY \}\}/);
  });

  await test('credential source: a live-origin run re-derives the signal IN PROCESS, never from the queue record', async () => {
    // The queue record published by `discover` names a generic artifact
    // transport that an application run never uploads. Treating it as the
    // envelope source made every automatic attachment fail after a successful
    // discovery.
    assert.strictEqual(live.envelopeSource({ originTransport: 'auto' }), 'discovery');
    assert.strictEqual(live.envelopeSource({ originTransport: 'signal' }), 'discovery');
    assert.strictEqual(live.envelopeSource({ originTransport: 'public-log' }), 'discovery');
    assert.strictEqual(live.envelopeSource({ originTransport: 'record' }), 'record');
    assert.strictEqual(live.envelopeSource({ originTransport: 'auto', envelopeArtifactRepo: 'dictationb1/supreme-lamp-lab' }), 'artifact');
    const inline = path.join(tmpRoot, 'inline-env.json');
    fs.writeFileSync(inline, '{}');
    assert.strictEqual(live.envelopeSource({ originTransport: 'auto', envelopeInline: inline }), 'inline');
  });
};
