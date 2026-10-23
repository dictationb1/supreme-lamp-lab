'use strict';
// Regressions for the QUEUE CLAIM PATH (scripts/pick-record.js).
//
// Three defects were measured on 2026-10-23 while a live run (39952421153) was
// waiting in the queue. Each one made the claim job answer "no verification was
// attempted" while a pickable record existed:
//   1. `poll-records` prints a human header and workflow-command annotations
//      around its JSON, and the loader required the JSON to end the file
//      (`/\{[\s\S]*\}\s*$/`) => RECORDS_UNREADABLE.
//   2. the selector read `rec.descriptor` off the store's `{ json, sha }`
//      wrapper => "Cannot read properties of undefined (reading 'clientTailnetIp')".
//   3. the workflow parsed `jq .pending` from the human file, which is not JSON
//      => the wake-up step always thought the queue was empty.
//
// These tests pin the fixes and, more importantly, the queue policy: a claimed,
// expired, disallowed or non-awaiting record is never substituted for the one
// that was asked for.

module.exports = async function register({ test, assert, fs, path, os, tmpRoot }) {
  const { loadRecords, selectRecord } = require('../pick-record');

  const REPO = 'dictationb1/supreme-lamp';
  const RUN = 39952421153;
  const SHA = '24ddaa9904c92dbbba39e3cc7aba458769e6bbe4';
  const nowMs = Date.now();

  function descriptor(over = {}) {
    return {
      protocol: 'slab-live-run/1',
      originRepo: REPO,
      originWorkflow: '.github/workflows/main.yml',
      originRunId: RUN,
      originAttempt: 1,
      appSha: SHA,
      uiBuild: `ui-dist-${SHA}`,
      backendIdentity: '100.87.91.3:7331',
      authorizedEndpoint: 'http://100.87.91.3:7331',
      issuedAt: new Date(nowMs - 60000).toISOString(),
      expiresAt: new Date(nowMs + 5 * 3600 * 1000).toISOString(),
      labRevision: 'f'.repeat(40),
      correlationId: `lr-${RUN}-1`,
      dashTokenFingerprint: 'a'.repeat(64),
      clientTailnetIp: '',
      mode: 'live-origin',
      ...over
    };
  }
  const row = (over = {}) => ({
    path: `records/dictationb1_supreme-lamp/${RUN}-1.json`,
    correlationId: `lr-${RUN}-1`,
    origin: `${REPO}#${RUN}/1`,
    appSha: SHA.slice(0, 12),
    mode: 'live-origin',
    state: 'AWAITING_LAB_ACCEPTANCE',
    claimedBy: null,
    expiresInSeconds: 18000,
    pickable: true,
    ...over
  });
  const readFull = d => async () => ({ json: { kind: 'slab-live-run-record/1', descriptor: d, state: 'AWAITING_LAB_ACCEPTANCE' }, sha: 'x' });
  const args = over => ({ correlation: '', origin: '', run: 0, attempt: 1, ...over });
  const allow = [REPO];

  await test('pick-record: the JSON payload is extracted from a stream with a header and trailing notices', () => {
    const text = '\n===== poll-records result (exit 0) =====\n{"records":[{"correlationId":"lr-1-1"}],"pending":1}\n\n[NOTICE] live-run poll-records: verified: \n::notice title=live-run poll-records::verified: \n';
    const loaded = loadRecords((() => {
      const f = path.join(tmpRoot, `records-${Math.random().toString(16).slice(2)}.txt`);
      fs.writeFileSync(f, text);
      return f;
    })());
    assert.strictEqual(loaded.error, undefined, loaded.error);
    assert.strictEqual(loaded.doc.pending, 1);
    assert.strictEqual(loaded.doc.records[0].correlationId, 'lr-1-1');
  });

  await test('pick-record: braces inside strings do not end the object early, and a truncated payload is refused', () => {
    const d = path.join(tmpRoot, `records-${Math.random().toString(16).slice(2)}.txt`);
    fs.writeFileSync(d, 'header\n{"a":"}{ not the end","records":[],"pending":0}\ntrailer');
    const ok = loadRecords(d);
    assert.strictEqual(ok.error, undefined, ok.error);
    assert.strictEqual(ok.doc.a, '}{ not the end');
    fs.writeFileSync(d, 'header\n{"records":[{"a":1}');
    const bad = loadRecords(d);
    assert.strictEqual(bad.error, 'no JSON payload in the records listing');
  });

  await test('pick-record: the store wrapper {json,sha} is unwrapped (regression: clientTailnetIp crash)', async () => {
    const r = await selectRecord({ rows: [row()], a: args(), allow, now: nowMs, readFull: readFull(descriptor()) });
    assert.strictEqual(r.proceed, 'yes', r.reason);
    assert.strictEqual(r.descriptor.originRunId, RUN);
    assert.strictEqual(r.descriptor.clientTailnetIp, '');
  });

  await test('pick-record: an explicitly requested correlation is never substituted', async () => {
    const r = await selectRecord({
      rows: [row({ correlationId: 'lr-other-1', origin: `${REPO}#1/1` })],
      a: args({ correlation: `lr-${RUN}-1` }), allow, now: nowMs, readFull: readFull(descriptor())
    });
    assert.strictEqual(r.proceed, 'no');
    assert.match(r.reason, /^CORRELATION_NOT_FOUND/);
  });

  await test('pick-record: a claimed, an expired or a disallowed record is skipped with its reason', async () => {
    const claimed = await selectRecord({ rows: [row({ claimedBy: '39929404780' })], a: args(), allow, now: nowMs, readFull: readFull(descriptor()) });
    assert.strictEqual(claimed.proceed, 'no');
    assert.match(claimed.reason, /already claimed by live lab run 39929404780/);

    const expired = await selectRecord({ rows: [row({ expiresInSeconds: -1 })], a: args(), allow, now: nowMs, readFull: readFull(descriptor()) });
    assert.match(expired.reason, /expired/);

    const foreign = await selectRecord({ rows: [row({ origin: 'attacker/other#9/1' })], a: args(), allow, now: nowMs, readFull: readFull(descriptor()) });
    assert.match(foreign.reason, /not allowlisted/);
  });

  await test('pick-record: a record body that cannot be read is reported, never invented', async () => {
    const r = await selectRecord({ rows: [row()], a: args(), allow, now: nowMs, readFull: async () => null });
    assert.strictEqual(r.proceed, 'no');
    assert.match(r.reason, /record body unavailable/);
  });

  await test('pick-record: an expired DESCRIPTOR is refused even when the row still looks pickable', async () => {
    const r = await selectRecord({
      rows: [row()], a: args(), allow, now: nowMs,
      readFull: readFull(descriptor({ expiresAt: new Date(nowMs - 1000).toISOString() }))
    });
    assert.strictEqual(r.proceed, 'no');
    assert.match(r.reason, /TTL_TOO_SHORT|EXPIRED|expired/);
  });
};
