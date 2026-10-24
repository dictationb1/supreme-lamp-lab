'use strict';
// WORKFLOW OWNERSHIP + EVIDENCE-ORDER REGRESSIONS (H-04, H-05).
//
// Two workflow properties are not stylistic: they decide whether the single
// interactive Windows desktop can be stolen by an unrelated job, and whether a
// run's evidence is reachable before a 15-minute viewer hold. Both were broken
// and both are pinned here by reading the files (no interpreter, no YAML dep).

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

module.exports = async function register({ test, assert }) {
  await test('ownership: the capability client job needs the capability-run label', async () => {
    const wf = read('.github/workflows/capability-check.yml');
    assert.ok(/types:\s*\[[^\]]*labeled[^\]]*\]/.test(wf), 'pull_request must include the labeled type');
    const clientJob = wf.slice(wf.indexOf('\n  client:'));
    assert.ok(/contains\(github\.event\.pull_request\.labels\.\*\.name, 'capability-run'\)/.test(clientJob), 'the client job must gate on the current PR label set, including synchronize events after evidence commits');
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

  await test('evidence order: the viewer hold requires an authenticated viewer (exit 0)', async () => {
    const wf = read('.github/workflows/live-run.yml');
    const block = wf.slice(wf.indexOf('Keep the authorized viewer open'));
    assert.ok(/steps\.live\.outputs\.exit_code == '0'/.test(block.slice(0, 900)), 'a blocked run must not pay the hold');
  });

  await test('evidence paths: each lab run publishes into its own directory', async () => {
    const wf = read('.github/workflows/live-run.yml');
    assert.ok(/evidence\/lab-run-\$env:GITHUB_RUN_ID/.test(wf), 'two runs must never overwrite one report');
  });

  await test('candidate: the stub is never labelled as the application server', async () => {
    const stub = read('scripts/candidate/stub-server.js');
    assert.ok(/lab-candidate-stub/.test(stub));
    assert.ok(/NOT the application server/i.test(stub), 'the file must say what it is not');
  });

  await test('candidate: replay patch paths and browser click preconditions are honest', async () => {
    const patch = read('reports/mission-control/40051974454-1/app-patches/0001-F201-probe-honesty.patch');
    const diffs = patch.split('\n').filter(l => l.startsWith('diff --git '));
    assert.ok(diffs.length > 0);
    assert.ok(diffs.every(l => !l.includes('a/candidate/') && !l.includes('b/candidate/')), 'patch must apply at the application root, not a nested candidate directory');
    assert.ok(diffs.some(l => l.includes('a/src/tests/smoke/f201-probe-honesty.test.tsx') && l.includes('b/src/tests/smoke/f201-probe-honesty.test.tsx')));
    const sweep = read('scripts/candidate/sweep.js');
    assert.ok(sweep.indexOf('await unlockWithSyntheticToken(page, mode)') < sweep.indexOf("control: 'settings.theme_toggle'"));
    assert.ok(/clickError=\$\{themeClickError\}/.test(sweep));
    assert.ok(!/themeBtn\.click\([^\n]+\)\.catch\(\(\) => \{\}\)/.test(sweep), 'a timed-out click must not be recorded as clicked');
    const workflow = read('.github/workflows/app-candidate.yml');
    const verdict = workflow.slice(workflow.indexOf('Evaluate the published candidate verdict'));
    assert.ok(verdict.includes('if ($fail -gt 0)'), 'failed controls must fail the candidate run');
    assert.ok(verdict.includes('if ($blocked -gt 0)'), 'BLOCKED controls must not produce a green candidate run');
    assert.ok(workflow.indexOf('Publish sanitized candidate evidence') < workflow.indexOf('Postflight (stop anything') && workflow.indexOf('Postflight (stop anything') < workflow.indexOf('Evaluate the published candidate verdict'), 'publish and cleanup must precede the honest failing verdict');
  });

  await test('revision: every PR job checks out the exact head, not a merge of candidate and old main', async () => {
    for (const file of ['.github/workflows/live-run.yml', '.github/workflows/app-candidate.yml', '.github/workflows/capability-check.yml']) {
      const wf = read(file);
      const lines = wf.split('\n');
      let checkoutCount = 0;
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes('- uses: actions/checkout@')) continue;
        checkoutCount++;
        const step = lines.slice(i, i + 7).join('\n');
        if (/repository:\s*dictationb1\/supreme-lamp(?:\s|$)/.test(step)) continue; // the application checkout is pinned to APP_SHA instead
        assert.ok(/ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha \|\| github\.sha\s*\}\}/.test(step), `${file}: checkout at line ${i + 1} must pin the PR head SHA`);
      }
      assert.ok(checkoutCount > 0, `${file}: checkout steps found`);
    }
    const live = read('.github/workflows/live-run.yml');
    assert.ok(/lab_sha:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha \|\| github\.sha\s*\}\}/.test(live), 'claim must pass the same head SHA to Windows verification');
  });

  await test('preflight: VM evidence is separate from origin readiness and signal prerequisites', async () => {
    const { evaluatePreflight } = require('../candidate/vm-preflight');
    const vm = {
      interactiveDesktop: true, sessionId: 1, account: 'HOST\\User', responsive: true,
      runnerWorkerProcessCount: 1, memoryFreeBytes: 1024 ** 3, systemDriveFreeBytes: 4 * 1024 ** 3,
      nativeLauncher: { mstscPresent: true, ghrdpHandlerUser: false, ghrdpHandlerMachine: false },
      tailscale: { present: true, selfOnline: true, backendState: 'Running', error: '' }
    };
    const result = evaluatePreflight({
      vm,
      browser: { ok: true, message: 'click passed', screenshot: 'client-preflight.png' },
      origin: {
        expected: { repository: 'dictationb1/supreme-lamp', run: '1', attempt: 1, sha: 'a'.repeat(40) },
        run: { repository: 'dictationb1/supreme-lamp', id: '1', attempt: 1, headSha: 'a'.repeat(40), workflowPath: '.github/workflows/main.yml' },
        readinessReached: false, firstFailure: 'step 28: staging failed', signalPublished: false,
        signalDetail: 'SIGNAL_NOT_PUBLISHED', endpoint: ''
      }
    });
    assert.strictEqual(result.vmVerdict, 'PASS');
    assert.deepStrictEqual(result.originChecks.map(c => c.status), ['PASS', 'BLOCKED', 'BLOCKED', 'BLOCKED']);
    assert.ok(result.originChecks.every(c => c.status !== 'FAIL'), 'an unpublished signal during setup is not a broken publisher');
  });

  await test('preflight: wrong origin identity and a failed desktop cannot become PASS', async () => {
    const { evaluatePreflight } = require('../candidate/vm-preflight');
    const result = evaluatePreflight({ vm: { error: 'session 0' }, browser: { ok: false, message: 'headed launch failed' }, origin: null });
    assert.strictEqual(result.vmVerdict, 'FAIL');
    assert.ok(result.checks.every(c => c.status === 'FAIL'));
    assert.strictEqual(result.originChecks[0].status, 'BLOCKED');
  });

  await test('ownership: every production desktop path resolves the same lock; test state stays isolated', async () => {
    const registry = require('../lib/registry');
    const oldState = process.env.LAB_STATE_DIR;
    const oldLock = process.env.LAB_LOCK_DIR;
    try {
      delete process.env.LAB_STATE_DIR;
      process.env.LAB_LOCK_DIR = path.join(os.tmpdir(), 'shared-production-lock');
      assert.strictEqual(registry.sessionLockDir(), path.join(os.tmpdir(), 'shared-production-lock', 'rdp-lab-desktop'));
      process.env.LAB_STATE_DIR = path.join(os.tmpdir(), 'isolated-test-state');
      assert.strictEqual(registry.sessionLockDir(), path.join(os.tmpdir(), 'isolated-test-state', 'desktop-session.lock.d'));
      const live = read('scripts/live-run.js');
      const preflight = read('scripts/candidate/vm-preflight.js');
      assert.ok(/lockDir:\s*registry\.sessionLockDir\(\)/.test(live));
      assert.ok(/lockDir:\s*registry\.sessionLockDir\(\)/.test(preflight));
    } finally {
      if (oldState === undefined) delete process.env.LAB_STATE_DIR; else process.env.LAB_STATE_DIR = oldState;
      if (oldLock === undefined) delete process.env.LAB_LOCK_DIR; else process.env.LAB_LOCK_DIR = oldLock;
    }
  });
};
