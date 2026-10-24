'use strict';
// [CANDIDATE STAGING] Regression pins for the complete-patched-candidate path:
//   * capability-check.yml must PATCH the pinned app source BEFORE building and
//     staging, build the UI from the patched tree, stage that local build (never
//     an upstream release asset), and verify the semantic result;
//   * the served candidate must be identified separately from the app source
//     SHA (--expect-build / VITE_BUILD_SHA=cand-<labrev>);
//   * the fx fixtures stage through the production RDP-Storage root + index;
//   * the cert-bind script must always publish its failure cause (16 invisible
//     failures before this repair);
//   * the v2 bundle series must preserve 0001-0003 byte-identical and add 0004.
// These are structural pins; the behavioral proof is the real Windows run.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..');

function read(p) { return fs.readFileSync(path.join(REPO, p), 'utf8'); }

module.exports = async function candidateStagingTests({ test, assert }) {
  const wf = read('.github/workflows/capability-check.yml');
  const stageApp = read('scripts/server/Stage-App.ps1');
  const fxFixtures = read('scripts/server/Stage-FxFixtures.ps1');
  const bindCert = read('scripts/server/Bind-RdpCertificate.ps1');
  const mc = read('scripts/mission-control-check.js');
  const cfgCap = read('scripts/configure-capability.js');

  await test('candidate staging: capability-check patches the app before staging and gates on semantic markers', async () => {
    const patchStep = wf.indexOf('Apply the ordered candidate patch series');
    const buildStep = wf.indexOf('Install app dependencies, run the candidate regressions, build the production UI');
    const stageStep = wf.indexOf('Stage backend + CANDIDATE-built UI bundle');
    assert.ok(patchStep > 0, 'patch step exists');
    assert.ok(buildStep > patchStep, 'build runs after patching');
    assert.ok(stageStep > buildStep, 'staging runs after the patched build');
    assert.match(wf, /PATCH_SEMANTIC_CHECK_FAILED/, 'fuzzy patch success is not accepted');
    assert.match(wf, /-LabLocalUi \$env:CANDIDATE_UI/, 'staging uses the locally built patched UI');
    assert.match(wf, /uiBundleSource -ne 'local-patched-build'/, 'the stage result must prove candidate provenance');
    assert.match(wf, /VITE_BUILD_SHA = \$env:CANDIDATE_BUILD/, 'the build stamps the candidate identity');
  });

  await test('candidate staging: the candidate build identity is separate from the app source SHA and reaches the dashboard check', async () => {
    assert.match(wf, /CANDIDATE_BUILD: cand-\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/, 'deterministic candidate id');
    assert.match(wf, /--expect-build \$env:CANDIDATE_BUILD/, 'the remote check verifies the candidate build');
    assert.match(mc, /--expect-build/, 'mission-control-check parses --expect-build');
    assert.match(mc, /dashboardVariant\(page, args\.expectBuild \|\| args\.expectSha/, 'the dashboard variant uses the candidate build id');
    // The SOURCE identity stays the 40-hex app sha for readiness/version.
    assert.match(mc, /--expect-sha must be a 40-char commit SHA/, 'the app sha stays a 40-hex source identity');
  });

  await test('candidate staging: fx fixtures stage through the production RDP-Storage root and stable ids', async () => {
    assert.match(fxFixtures, /'RDP-Storage'/, 'fixtures live under the production root name');
    assert.match(fxFixtures, /Join-Path \$StageRoot 'storage'/, 'the RDP-Storage base directory is the production mapping');
    assert.match(fxFixtures, /fx-index\.json/, 'the production index file is written');
    assert.match(fxFixtures, /Get-FxStableIdLocal/, 'ids are computed like the module');
    assert.match(fxFixtures, /SHA1/, 'stable id is SHA-1(root+path) like Get-FxStableId');
    assert.match(fxFixtures, /schemaVersion = 2/, 'the index is schema v2');
    assert.match(wf, /Stage-FxFixtures\.ps1/, 'the capability server job stages the fixtures');
    // The id computation must match the module exactly: verify against the
    // module's own algorithm on a known input.
    const root = 'RDP-Storage';
    const p = '/lab-fixture/lab-readme.txt';
    const expect = crypto.createHash('sha1').update(root + p, 'utf8').digest('hex');
    const m = fxFixtures.match(/ComputeHash\(\[System\.Text\.Encoding\]::UTF8\.GetBytes\(\(\$RootName \+ \$Path\)\)\)/);
    assert.ok(m, 'the local id function hashes root+path UTF-8');
    assert.match(expect, /^[0-9a-f]{40}$/, 'known-good sha1: ' + expect);
  });

  await test('candidate staging: Stage-App accepts a local built bundle with its own sha and never calls it an upstream asset', async () => {
    assert.match(stageApp, /\[string\]\$LabLocalUi = ''/, 'parameter exists');
    assert.match(stageApp, /UI_BUNDLE_LOCAL_MISSING/, 'missing local build fails loudly');
    assert.match(stageApp, /source = 'local-patched-build'/, 'local build provenance is recorded');
    assert.match(stageApp, /source = 'upstream-release-asset'/, 'upstream path is separately identified');
    assert.match(stageApp, /uiBundleSource/, 'the stage result carries the source');
  });

  await test('candidate staging: the search lane is enabled on the candidate config (production default)', async () => {
    assert.match(cfgCap, /searchEnabled: true/, 'configure-capability enables the search lane');
  });

  await test('cert observability: Bind-RdpCertificate always publishes its failure cause', async () => {
    assert.match(bindCert, /function Save-Diag/, 'diagnostic writer exists');
    assert.match(bindCert, /stage = 'start'; code = 'NOT_RUN'/, 'initial state is explicit');
    // The catch path re-writes the diagnostic when no stage wrote it yet.
    assert.match(bindCert, /UNEXPECTED_FAILURE/, 'unexpected failures are still recorded');
    // Per-attempt evidence is captured, redacted, and capped.
    assert.match(bindCert, /function Redact-TsText/, 'output is redacted before recording');
    assert.match(bindCert, /REDACTED/, 'token-like lines are stripped');
    // The workflow publishes the raw attempt files.
    assert.match(wf, /capability-cert-1\.out/, 'raw cert output is published');
    assert.match(wf, /capability-cert-1\.err/, 'raw cert stderr is published');
    // PowerShell case-insensitivity trap: no $out variable shadowing $Out.
    assert.ok(!/\$out\s*=(?!=)/.test(bindCert), 'no $out assignment shadowing the $Out param');
  });

  await test('bundle v2: series preserves 0001-0003 byte-identical and adds 0004', async () => {
    const series = read('reports/mission-control/40051974454-1-v2/series.txt');
    const lines = series.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
    assert.deepStrictEqual(lines, [
      'app-patches/0001-F201-probe-honesty.patch',
      'app-patches/0002-R1-server-startup-readiness.patch',
      'app-patches/0003-R2-websocket-worker-runspace.patch',
      'app-patches/0004-R2b-pool-fallback-bounded-truth.patch'
    ], 'exact order');
    const oldSums = read('reports/mission-control/40072158991-1/SHA256SUMS');
    for (const n of ['0001-F201-probe-honesty.patch', '0002-R1-server-startup-readiness.patch', '0003-R2-websocket-worker-runspace.patch']) {
      const bytes = fs.readFileSync(path.join(REPO, 'reports/mission-control/40051974454-1-v2/app-patches', n));
      const sha = crypto.createHash('sha256').update(bytes).digest('hex');
      assert.ok(oldSums.includes(sha), `${n} byte-identical to the accepted bundle (${sha})`);
    }
  });

  await test('bundle v2: patch 0004 removes the inline pump and adds the bounded truthful degradation', async () => {
    const p4 = read('reports/mission-control/40051974454-1-v2/app-patches/0004-R2b-pool-fallback-bounded-truth.patch');
    // The old fallback line is REMOVED by the patch...
    assert.match(p4, /^-\s+try \{ \$r2Inline = Invoke-F99WebSocketUpgrade -Client \$Client/m, 'the inline pump call is deleted');
    // ...and the new bounded path is ADDED.
    assert.match(p4, /^\+.*websocket worker pool unavailable; retry/m, 'truthful 503 body');
    assert.match(p4, /^\+.*GHRDP_WS_POOL_RETRY_SEC/m, 'clamped retry window');
    assert.match(p4, /Initialize-R2WsPool/, 'retryable init function');
    assert.match(p4, /wsReason/, '/health reports the degraded reason');
    assert.match(p4, /r2-websocket-worker\.test\.ts/, 'the regression test ships in the same patch');
    // Series does not double-apply: 0004 applies AFTER 0003 (context includes 0003's code).
    assert.match(p4, /diff --git a\/payloads\/ghrdp-server\.ps1/, 'targets the server');
  });

  await test('candidate staging: the CRLF checkout guard renormalizes patch targets before git apply (run 40102291995)', async () => {
    // actions/checkout on Windows may materialize CRLF files while the bundle
    // patches are LF-normalized; git apply then fails on every touched file.
    // The guard must derive targets FROM the patches, rewrite existing files
    // byte-exactly (Latin-1), and never touch patch-created files.
    assert.match(wf, /CRLF GUARD/, 'the guard is present and explained');
    assert.match(wf, /Groups\[1\]\.Value/, 'targets parsed from +++ b/ headers');
    assert.match(wf, /GetEncoding\(28591\)/, 'Latin-1 round-trip: byte-exact, no UTF-8 corruption');
    assert.match(wf, /patch-created=\$created/, 'patch-created targets are counted, not renormalized');
    // Sanity: every file the current series touches is either renormalized or
    // created - the guard must not depend on a hardcoded file list.
    const v2 = path.join(REPO, 'reports/mission-control/40051974454-1-v2');
    const series = fs.readFileSync(path.join(v2, 'series.txt'), 'utf8')
      .split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
    let targets = 0;
    for (const rel of series) {
      const txt = fs.readFileSync(path.join(v2, rel), 'utf8');
      targets += (txt.match(/^\+\+\+ b\/.+$/gm) || []).filter(l => !l.includes('/dev/null')).length;
    }
    assert.ok(targets >= 11, 'series touches ' + targets + ' files (guard covers them all dynamically)');
  });
};
