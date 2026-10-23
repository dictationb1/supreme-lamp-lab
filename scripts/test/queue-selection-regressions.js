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
    assert.match(pre, /\$code -eq 2 -or \$code -eq 4/, 'survivors/snapshot failures are fatal');
    assert.match(pre, /::warning title=preflight cleanup::exit \$code/, 'bookkeeping failures are visible but not fatal');
    const post = wf.slice(wf.indexOf('- name: Postflight cleanup'), wf.indexOf('- name: Upload live-run evidence'));
    assert.ok(post.length > 100, 'postflight step located');
    assert.match(post, /cleanup-postflight\.json/, 'postflight writes its JSON into the uploaded artifact dir');
    assert.match(post, /\$code -eq 2 -or \$code -eq 4/);
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
