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
// CRLF-robust read: a Windows runner may check the tree out with autocrlf
// (the same root cause the capability CRLF guard fixed for git apply); every
// assertion below anchors on \n, so normalize before matching. Measured on
// the lab VM client job (run 40108408924): the raw read made this suite fail
// on Windows while passing on Linux - a runner-environment false alarm.
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

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

  await test('evidence permissions: the capability server can publish, and a failed required job vetoes VERIFIED', async () => {
    const wf = read('.github/workflows/capability-check.yml');
    const server = wf.slice(wf.indexOf('  server:\n'), wf.indexOf('  client:\n'));
    assert.ok(/permissions:\s*\n\s*contents: write/.test(server), 'the server sanitized-evidence publisher needs contents:write');
    assert.ok(server.includes('Publish sanitized server evidence'));
    const report = read('scripts/verification-report.js');
    assert.ok(report.includes('requiredJobsOk') && report.includes("capability: `required_job_${j.job}`"), 'job failures must remain visible even when every capability row is PASS');
  });

  await test('evidence permissions: the 8C handler enrollment fetches the app source, never a deleted served route', async () => {
    // The application deleted /install.ps1 (remediation 8C); the probe used to
    // fail with PRODUCTION_INSTALLER_UNAVAILABLE: HTTP 404 (run 40108408924).
    // The enrollment must now follow docs/AUTOLOGIN.md: the app source zip at
    // the pinned sha (pin-verified when available), csc compile + HKCU
    // registration, interactive-only self-test recorded as skipped.
    const mc = read('scripts/mission-control-check.js');
    assert.ok(!mc.includes('\${args.target}/install.ps1'), 'the probe never fetches the deleted served route');
    assert.match(mc, /codeload\.github\.com\/dictationb1\/supreme-lamp\/zip\/\$\{appShaForZip\}/, 'the handler kit comes from the app source zip at the pinned sha');
    assert.match(mc, /APP_ZIP_SHA_MISMATCH/, 'the zip pin is enforced when provided');
    const helper = read('scripts/ps/Install-ProductionHandler.ps1');
    assert.match(helper, /docs\/AUTOLOGIN\.md/, 'the helper cites the documented enrollment');
    assert.match(helper, /ghrdp-rdp-launcher\.cs/, 'compiles the production launcher source');
    assert.match(helper, /Microsoft\.NET\\Framework64\\v4\.0\.30319/, 'in-box csc exactly like install.cmd');
    assert.match(helper, /selfTestSkipped/, 'the interactive-only self-test is recorded as skipped, never silently claimed');
    assert.match(helper, /HANDLER_PREEXISTING/, 'refuses to overwrite a preexisting registration');
    assert.match(helper, /HANDLER_COMMAND_READBACK_FAILED/, 'the registry readback is the truth gate');
    const wf = read('.github/workflows/capability-check.yml');
    assert.match(wf, /--app-zip-sha256/, 'the workflow passes the zip pin');
    assert.match(wf, /dadee74430ca5ee1645d3631f033f17d7d04ae4a8bebadafd39c07c2c44aa378/, 'the pin is the config-pinned base zip hash');
  });

  await test('candidate: the stub is never labelled as the application server', async () => {
    const stub = read('scripts/candidate/stub-server.js');
    assert.ok(/lab-candidate-stub/.test(stub));
    assert.ok(/NOT the application server/i.test(stub), 'the file must say what it is not');
    assert.ok(stub.includes("p === '/api/f92-selftest'") && stub.includes("'version:match': { status: 'pass' }"), 'the Settings recheck fixture must implement the production endpoint and response shape');
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
    assert.ok(sweep.includes("pathname === '/api/f92-selftest'") && sweep.includes("row?.status === 'pass' && verdict === 'match'"), 'the recheck test must wait for the production request and rendered match result');
    const workflow = read('.github/workflows/app-candidate.yml');
    const verdict = workflow.slice(workflow.indexOf('Evaluate the published candidate verdict'));
    assert.ok(verdict.includes('if ($fail -gt 0)'), 'failed controls must fail the candidate run');
    assert.ok(verdict.includes('if ($blocked -gt 0)'), 'BLOCKED controls must not produce a green candidate run');
    assert.ok(workflow.indexOf('Publish sanitized candidate evidence') < workflow.indexOf('Postflight (stop anything') && workflow.indexOf('Postflight (stop anything') < workflow.indexOf('Evaluate the published candidate verdict'), 'publish and cleanup must precede the honest failing verdict');
    const { literal, globMatch } = require('../candidate/inventory-source');
    const ts = {
      isStringLiteral: n => n.kind === 'string', isNoSubstitutionTemplateLiteral: n => n.kind === 'template',
      isJsxExpression: n => n.kind === 'jsx-expression'
    };
    assert.strictEqual(literal({ initializer: { kind: 'string', text: 'stable-id' } }, ts), 'stable-id');
    assert.strictEqual(literal({ initializer: { kind: 'jsx-expression', expression: { kind: 'template', text: 'template-id' } } }, ts), 'template-id');
    assert.strictEqual(literal({ initializer: { kind: 'jsx-expression', expression: { kind: 'binary' } } }, ts), null);
    assert.ok(globMatch('src/pages/search/v2/AdvancedPanel.tsx', 'src/pages/search/**'));
    assert.ok(!globMatch('src/pages/search2/Other.tsx', 'src/pages/search/**'));
  });

  await test('revision: every PR job checks out the exact head, not a merge of candidate and old main', async () => {
    for (const file of ['.github/workflows/live-run.yml', '.github/workflows/app-candidate.yml', '.github/workflows/capability-check.yml', '.github/workflows/real-backend.yml']) {
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
      const realBackend = read('scripts/candidate/real-backend.js');
      assert.ok(/lockDir:\s*registry\.sessionLockDir\(\)/.test(live));
      assert.ok(/lockDir:\s*registry\.sessionLockDir\(\)/.test(preflight));
      assert.ok(/lockDir:\s*registry\.sessionLockDir\(\)/.test(realBackend), 'the real-backend job must share the same desktop lock');
    } finally {
      if (oldState === undefined) delete process.env.LAB_STATE_DIR; else process.env.LAB_STATE_DIR = oldState;
      if (oldLock === undefined) delete process.env.LAB_LOCK_DIR; else process.env.LAB_LOCK_DIR = oldLock;
    }
  });

  await test('real-backend workflow: same-repo label gate, exclusive lock, honest BLOCKED acceptance', async () => {
    const wf = read('.github/workflows/real-backend.yml');
    assert.ok(/contains\(github\.event\.pull_request\.labels\.\*\.name, 'real-backend-run'\)/.test(wf), 'gate on the real-backend-run label');
    assert.ok(/github\.event\.pull_request\.head\.repo\.full_name == github\.repository/.test(wf), 'same-repository guard, never fork code on the VM');
    assert.ok(/runs-on:\s*\[self-hosted, Windows, X64, rdp-lab-client\]/.test(wf), 'runs on the interactive client VM');
    assert.ok(/concurrency:\s*\n\s*group:\s*real-backend/.test(wf), 'serialized with its own concurrency group');
    // Baseline + patched MUST both run against the same pristine/patched server.
    assert.ok(/pristine-ghrdp-server\.ps1/.test(wf), 'a pristine baseline server is preserved before patching');
    assert.ok(/foreach \(\$lbl in @\('baseline','patched'\)\)/.test(wf) && /--label \$lbl/.test(wf), 'both baseline and patched labels are measured via one loop');
    const evaluate = wf.slice(wf.indexOf('Evaluate real-backend verdict'));
    assert.ok(evaluate.includes('if ($fails -gt 0)') && evaluate.includes('exit 2'), 'a real control FAIL must fail the job');
    const rb = read('scripts/candidate/real-backend.js');
    assert.ok(/not the live origin/i.test(rb), 'the harness must say what it is not');
    assert.ok(/BLOCKED: native RDP/.test(rb) && /BLOCKED: web desktop/i.test(rb), 'native RDP and Web Desktop are BLOCKED, never simulated PASS');
    assert.ok(/real-backend-report\.json/.test(rb), 'structured evidence is always written');
    // R2: the accept-loop starvation is measured with the bounded single-socket
    // probe (for a direct baseline-vs-candidate comparison) AND the full real-
    // socket matrix. After the runspace repair the browser drives a REAL
    // WebSocket: the old LabStubWS interception is removed and genuine /ws
    // frames are observed at the Playwright context level.
    assert.ok(/measureWsBlock/.test(rb) && /backend\.ws_accept_loop_block/.test(rb), 'R2 single-socket block must still be probed for baseline comparison');
    assert.ok(/measureR2Matrix/.test(rb), 'the full R2 starvation matrix must run against the real server');
    assert.ok(/browserWebSocketStubbed:\s*false/.test(rb), 'acceptance must record an unstubbed real browser WebSocket');
    assert.ok(!/LabStubWS/.test(rb), 'the WebSocket stub must be removed after the R2 runspace repair');
    assert.ok(/ctx\.on\('websocket'/.test(rb), 'real browser /ws frames must be observed, not faked');
    assert.ok(/backendKind:\s*'actual_application'/.test(rb), 'backend kind must be the actual application, never a stub');
    assert.ok(/GLOBAL_DEADLINE_MS/.test(rb) && /function flush\(\)/.test(rb), 'the harness must be time-bounded and publish incrementally');
    assert.ok(/port,\s*headless,/.test(rb) && !/headless:\s*!headless/.test(rb), 'the report browser-mode field must equal the value passed to chromium.launch');
    assert.ok(read('reports/mission-control/40051974454-1/defects/R2-WEBSOCKET-ACCEPT-LOOP-BLOCK.md').includes('fix deferred'), 'the historical R2 record stays immutable inside its own bundle');
  });

  await test('real-backend evidence: reported browser mode equals the Chromium launch mode', async () => {
    const rb = read('scripts/candidate/real-backend.js');
    assert.ok(/port,\s*headless,/.test(rb), 'identity.headless must record the actual boolean');
    assert.ok(!/headless:\s*!headless/.test(rb), 'the historical inverted metadata field must not return');
    assert.ok(/chromium\.launch\(\{\s*headless\s*,/.test(rb), 'chromium.launch must use the same boolean');
  });

  await test('R1 patch: applies at app root, includes the regression, nav weak-check replaced', async () => {
    const fsx = require('fs');
    const patchPath = path.join(ROOT, 'reports/mission-control/40051974454-1/app-patches/0002-R1-server-startup-readiness.patch');
    assert.ok(fsx.existsSync(patchPath), 'R1 patch must exist in the bundle');
    const patch = read('reports/mission-control/40051974454-1/app-patches/0002-R1-server-startup-readiness.patch');
    const diffs = patch.split('\n').filter(l => l.startsWith('diff --git '));
    assert.ok(diffs.every(l => !l.includes('a/candidate/') && !l.includes('b/candidate/')), 'R1 patch applies at the application root');
    assert.ok(diffs.some(l => l.includes('a/payloads/ghrdp-server.ps1')) && diffs.some(l => l.includes('a/src/tests/smoke/r1-server-readiness.test.ts')));
    const series = read('reports/mission-control/40051974454-1/series.txt');
    assert.ok(series.indexOf('0001-F201') >= 0 && series.indexOf('0002-R1') >= 0);
    assert.ok(series.indexOf('0001-F201') < series.indexOf('0002-R1'), 'series order is F201 then R1');
    // The nav check must assert a page-specific marker, not a non-empty body.
    const sweep = read('scripts/candidate/sweep.js');
    assert.ok(/ALL_PAGE_MARKERS/.test(sweep) && /NAV-1/.test(sweep), 'navigation must assert routed page markers');
    assert.ok(!/ok\s*=\s*!!shell\s*&&\s*body\.length\s*>\s*0/.test(sweep), 'the old body-nonempty navigation check must be gone');
  });
};
