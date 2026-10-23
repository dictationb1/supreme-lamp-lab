'use strict';
// EVIDENCE PERSISTENCE REGRESSIONS (defect L-14).
//
// Why this file exists: probe run 39977560128 (2026-10-23) measured
// READINESS_TIMEOUT, printed its verdict, exited 4 - and the artifact upload
// then reported "No files were found". Two source-level reasons made that
// invisible:
//
//   1. scripts/live-run.js writeLiveEvidence(dir, report) ACCEPTED a directory
//      and never used it; it wrote through writeCapabilities(), which resolved
//      artifactDir() itself. Any caller passing a directory was writing to a
//      place nobody checked.
//   2. the two report writes in persistPartial() were wrapped in EMPTY catch
//      blocks, so a failed write produced no annotation, no exit code and no
//      artifact - the run looked like it had persisted evidence when it had not.
//
// These tests pin the repaired behaviour: an explicit directory is honoured, a
// write that cannot land is an ERROR (never silence), and the persistence path
// verifies by listing the directory rather than trusting the write calls.

const path = require('path');
const nodeFs = require('fs');
const nodeOs = require('os');

module.exports = async function register({ test, assert, tmpRoot }) {
  const fs = nodeFs;
  const { writeCapabilities, artifactDir } = require('../lib/results');
  const { CapabilitySet, STATUS } = require('../lib/status');
  const liveRun = require('../live-run');

  const root = tmpRoot || fs.mkdtempSync(path.join(nodeOs.tmpdir(), 'evidence-'));

  function capSet() {
    const c = new CapabilitySet({ probe: { required: true, contract: 'unit' } });
    c.set('probe', STATUS.BLOCKED, 'unit reason');
    return c;
  }

  test('L-14: writeCapabilities writes into an explicit dir, not into ARTIFACT_DIR', () => {
    const decoy = path.join(root, 'l14-decoy-artifact-dir');
    const target = path.join(root, 'l14-explicit-dir');
    const prev = process.env.ARTIFACT_DIR;
    process.env.ARTIFACT_DIR = decoy;
    try {
      const file = writeCapabilities('unit', capSet(), { unit: true }, { dir: target });
      assert.strictEqual(path.dirname(file), target, 'the returned path must be inside the requested dir');
      assert.ok(fs.existsSync(path.join(target, 'capabilities-unit.json')), 'the bundle must exist in the requested dir');
      assert.ok(!fs.existsSync(path.join(decoy, 'capabilities-unit.json')),
        'it must NOT also land in ARTIFACT_DIR: the caller asked for a directory');
    } finally {
      if (prev === undefined) delete process.env.ARTIFACT_DIR; else process.env.ARTIFACT_DIR = prev;
    }
  });

  test('L-14: writeLiveEvidence honours its dir argument (the exact probe-run regression)', () => {
    assert.strictEqual(typeof liveRun.writeLiveEvidence, 'function', 'writeLiveEvidence must be exported so it can be pinned');
    const decoy = path.join(root, 'l14-live-decoy');
    const target = path.join(root, 'l14-live-dir');
    const prev = process.env.ARTIFACT_DIR;
    process.env.ARTIFACT_DIR = decoy;
    try {
      // A report shaped like the one persistPartial builds when the run is
      // blocked BEFORE any feature was evaluated - which is exactly the
      // readiness-timeout case that produced the empty upload.
      const report = {
        kind: 'slab-live-run-report/1',
        origin: { repo: 'unit/repo', runId: 1, attempt: 1, correlationId: 'lr-unit-1' },
        scope: 'unit',
        stage: 'BLOCKED',
        verdict: { status: STATUS.BLOCKED, code: 'READINESS_TIMEOUT', accepted: false },
        identity: {},
        authorization: { outcome: 'NOT_MEASURED', code: 'AUTHORIZATION_NOT_REACHED', detail: 'blocked before the gate' }
        // note: no `features` at all - the blocked-before-features shape
      };
      const file = liveRun.writeLiveEvidence(target, report);
      assert.ok(file && fs.existsSync(file), 'writeLiveEvidence must return a path that exists');
      assert.strictEqual(path.dirname(file), target);
      assert.ok(!fs.existsSync(path.join(decoy, 'capabilities-live.json')), 'must not write to ARTIFACT_DIR when a dir is given');
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.strictEqual(doc.scope, 'live', 'the bundle identity field must be the scope argument');
      assert.strictEqual(doc.runScope, 'unit', "the caller's own scope value is preserved as runScope, not dropped");
      assert.strictEqual(doc.capabilities.live_origin_verified.status, STATUS.NOT_RUN,
        'L-15: a run that never reached descriptor verification must not report live_origin_verified=PASS');
      // A blocked-before-features run must not claim a PASS anywhere.
      for (const [name, c] of Object.entries(doc.capabilities)) {
        assert.notStrictEqual(c.status, STATUS.PASS, `${name} must not be PASS on a blocked run`);
      }
    } finally {
      if (prev === undefined) delete process.env.ARTIFACT_DIR; else process.env.ARTIFACT_DIR = prev;
    }
  });

  test('L-14 negative: a write that cannot land throws instead of vanishing', () => {
    // Point the "directory" at an existing FILE: mkdir/write must fail loudly.
    const notADir = path.join(root, 'l14-not-a-directory');
    fs.writeFileSync(notADir, 'this is a file, not a directory', 'utf8');
    const report = {
      origin: { repo: 'unit/repo', runId: 1, attempt: 1, correlationId: 'lr-unit-2' },
      authorization: { outcome: 'NOT_MEASURED', code: 'AUTHORIZATION_NOT_REACHED', detail: 'unit' },
      identity: {}, verdict: { status: STATUS.BLOCKED, code: 'UNIT', accepted: false }
    };
    let threw = null;
    try { liveRun.writeLiveEvidence(path.join(notADir, 'sub'), report); } catch (e) { threw = e; }
    assert.ok(threw, 'an impossible write target must raise, so persistPartial can annotate it');
  });

  test('L-14: listEvidence reports what actually persisted (the inventory annotation source)', () => {
    const dir = path.join(root, 'l14-listing');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'capabilities-live.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(dir, 'live-run-report.md'), '# unit', 'utf8');
    fs.writeFileSync(path.join(dir, 'ignored.bin'), Buffer.from([0, 1, 2, 3]));
    const found = liveRun.listEvidence(dir).map(f => path.basename(f)).sort();
    assert.deepStrictEqual(found, ['capabilities-live.json', 'live-run-report.md'],
      'the listing must match the evidence extensions the upload would carry');
    assert.deepStrictEqual(liveRun.listEvidence(path.join(root, 'l14-does-not-exist')), [],
      'a missing directory is an empty inventory, not an exception');
  });

  test('L-14 structural: persistPartial has no silent catch and verifies by listing', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'live-run.js'), 'utf8');
    const at = src.indexOf('async function persistPartial(');
    assert.ok(at > 0, 'persistPartial must still exist');
    const body = src.slice(at, src.indexOf('if (process.env.GITHUB_OUTPUT)', at));
    assert.ok(!/catch \(e\) \{ \}/.test(body), 'no empty catch may remain in the evidence-writing path');
    assert.match(body, /EVIDENCE_NOT_PERSISTED/, 'a zero-file result must be an ERROR annotation');
    assert.match(body, /evidence inventory/, 'a non-zero result must be annotated with the file list');
    assert.match(body, /listEvidence\(out\)/, 'the verification must LIST the directory, not trust the writes');
    // And the capabilities writer must be the one that honours the directory.
    assert.match(src, /return writeCapabilities\('live', capSet, \{ origin: report\.origin, scope: report\.scope \}, \{ dir \}\);/,
      'writeLiveEvidence must pass its dir through to writeCapabilities');
    const results = fs.readFileSync(path.join(__dirname, '..', 'lib', 'results.js'), 'utf8');
    assert.match(results, /opts\.dir/, 'writeCapabilities must accept an explicit dir');
    assert.match(results, /evidence write did not land/, 'writeCapabilities must verify its own write');
    assert.match(results, /runScope/, "a caller's own scope value must be preserved, not allowed to clobber the bundle identity");
    assert.ok(artifactDir(), 'artifactDir must still resolve for callers that do not pass a dir');
  });

  test('L-15: live_origin_verified follows the recorded verification result', () => {
    const dir = path.join(root, 'l15-origin');
    const base = {
      origin: { repo: 'unit/repo', runId: 1, attempt: 1, correlationId: 'lr-unit-3' },
      scope: 'unit', identity: {},
      authorization: { outcome: 'NOT_MEASURED', code: 'AUTHORIZATION_NOT_REACHED', detail: 'unit' },
      verdict: { status: STATUS.BLOCKED, code: 'UNIT', accepted: false }
    };
    const refused = liveRun.writeLiveEvidence(dir, { ...base, identity: { originVerification: { ok: false, code: 'ORIGIN_RUN_MISMATCH', checks: [{ code: 'run_id', ok: false, detail: 'x' }] } } });
    assert.strictEqual(JSON.parse(fs.readFileSync(refused, 'utf8')).capabilities.live_origin_verified.status, STATUS.FAIL,
      'a refused verification is FAIL, not PASS');
    const ok = liveRun.writeLiveEvidence(dir, { ...base, identity: { originVerification: { ok: true, code: 'ORIGIN_VERIFIED', checks: [{ code: 'run_id', ok: true, detail: 'x' }] } } });
    assert.strictEqual(JSON.parse(fs.readFileSync(ok, 'utf8')).capabilities.live_origin_verified.status, STATUS.PASS,
      'a verified origin is PASS');
  });

  test('L-16: the capability annotation keeps the status readable (no over-redaction)', () => {
    const dir = path.join(root, 'l16-annotation');
    const c = new CapabilitySet({ live_authorization: { required: true, contract: 'unit' } });
    c.set('live_authorization', STATUS.BLOCKED, 'blocked before the gate');
    const seen = [];
    const real = process.stdout.write;
    process.stdout.write = (chunk, ...rest) => { seen.push(String(chunk)); return true; };
    try { writeCapabilities('unit', c, {}, { dir }); } finally { process.stdout.write = real; }
    const line = seen.join('');
    assert.match(line, /live_authorization status=BLOCKED/, 'the status must survive into the annotation');
    assert.ok(!/live_authorization=\[REDACTED\]/.test(line),
      'the Authorization-header redaction pattern must not swallow a capability status');
    assert.match(line, /blocked before the gate/, 'the reason must survive too');
  });
};
