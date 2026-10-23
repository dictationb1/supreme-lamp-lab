'use strict';
// WORKFLOW OWNERSHIP + EVIDENCE-ORDER REGRESSIONS (H-04, H-05).
//
// Two workflow properties are not stylistic: they decide whether the single
// interactive Windows desktop can be stolen by an unrelated job, and whether a
// run's evidence is reachable before a 15-minute viewer hold. Both were broken
// and both are pinned here by reading the files (no interpreter, no YAML dep).

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

module.exports = async function register({ test, assert }) {
  await test('ownership: the capability client job needs the capability-run label', async () => {
    const wf = read('.github/workflows/capability-check.yml');
    assert.ok(/types:\s*\[[^\]]*labeled[^\]]*\]/.test(wf), 'pull_request must include the labeled type');
    const clientJob = wf.slice(wf.indexOf('\n  client:'));
    assert.ok(/github\.event\.label\.name == 'capability-run'/.test(clientJob), 'the client job must gate on the capability-run label');
  });

  await test('ownership: live-run verify is the only job on the self-hosted desk in that file', async () => {
    const wf = read('.github/workflows/live-run.yml');
    const hits = wf.match(/runs-on:\s*\[self-hosted[^\]]*\]/g) || [];
    assert.strictEqual(hits.length, 1, 'exactly one self-hosted job in live-run.yml');
  });

  await test('evidence order: publish runs BEFORE the viewer hold in live-run.yml', async () => {
    const wf = read('.github/workflows/live-run.yml');
    const publish = wf.indexOf('Publish sanitized evidence into the repository');
    const viewer = wf.indexOf('Keep the authorized viewer open');
    assert.ok(publish > 0 && viewer > 0, 'both steps exist');
    assert.ok(publish < viewer, 'the report must be persisted before a 15-minute hold can delay it');
  });

  await test('evidence order: the publish step always runs and names the branch', async () => {
    const wf = read('.github/workflows/live-run.yml');
    const block = wf.slice(wf.indexOf('Publish sanitized evidence into the repository'));
    assert.ok(/if:\s*always\(\)/.test(block.slice(0, 400)), 'publish must be if: always()');
    assert.ok(/HEAD_BRANCH:\s*\$\{\{\s*github\.event\.pull_request\.head\.ref \|\| github\.ref_name\s*\}\}/.test(block.slice(0, 900)));
  });

  await test('candidate: the stub is never labelled as the application server', async () => {
    const stub = read('scripts/candidate/stub-server.js');
    assert.ok(/lab-candidate-stub/.test(stub));
    assert.ok(/NOT the application server/i.test(stub), 'the file must say what it is not');
  });
};
