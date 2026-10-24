'use strict';
// [R2b FAULT INJECTION] Structural pins for the residual-risk measurement
// harness (scripts/candidate/r2-fault-injection.js) and its workflow wiring.
// The behavioral proof is the real Windows run; these pins keep the harness
// honest about what it mutates and what it refuses to claim.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..');
function read(p) { return fs.readFileSync(path.join(REPO, p), 'utf8'); }

module.exports = async function r2FaultInjectionTests({ test, assert, tmpRoot }) {
  const wf = read('.github/workflows/real-backend.yml');
  const src = read('scripts/candidate/r2-fault-injection.js');

  // Load the harness with a temp out dir so the module never touches real paths.
  const outDir = fs.mkdtempSync(path.join(tmpRoot, 'r2fi-'));
  const origArgv = process.argv.slice();
  process.argv = ['node', 'r2-fault-injection.js', '--out', outDir];
  let mod = null;
  try { mod = require('../candidate/r2-fault-injection'); } finally { process.argv = origArgv; }
  assert.ok(mod && typeof mod.deriveFaultVariant === 'function', 'harness is loadable and exports its seams');

  await test('r2 fault: the harness mutates only the pool-init sites and records variant identity', async () => {
    // A synthetic server file carrying the real init sites.
    const fake = path.join(outDir, 'fake-server.ps1');
    fs.writeFileSync(fake, [
      '$script:R2WsPool = [runspacefactory]::CreateRunspacePool($r2Iss)',
      '$script:R2WsPool.Open()',
      'Write-Host nothing else matters'
    ].join('\n'), 'utf8');
    const before = crypto.createHash('sha256').update(fs.readFileSync(fake)).digest('hex');
    const v1 = mod.deriveFaultVariant(fake, 'persistent', 't-persistent');
    const v2 = mod.deriveFaultVariant(fake, 'transient', 't-transient');
    // The SOURCE file is never modified.
    assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(fake)).digest('hex'), before, 'source untouched');
    const t1 = fs.readFileSync(v1, 'utf8');
    const t2 = fs.readFileSync(v2, 'utf8');
    assert.ok(!t1.includes('[runspacefactory]::CreateRunspacePool'), 'persistent variant replaces the pool creation');
    assert.ok(t1.includes(mod.PERSISTENT_THROW), 'persistent variant carries the injected throw');
    assert.ok(t2.includes(mod.TRANSIENT_THROW), 'transient variant carries the one-shot throw');
    assert.ok(t2.includes('[runspacefactory]::CreateRunspacePool'), 'transient variant keeps pool creation (only Open is one-shot)');
    // [RUN 40108408903 LESSON] A one-shot guard WITHOUT an else-branch calling
    // the real Open() makes the second init a silent no-op: the pool stays
    // BeforeOpen while the bookkeeping says available - the harness then
    // measures its own mutation bug, not the repair. The else branch MUST call
    // the real Open() so later attempts genuinely succeed.
    assert.match(mod.TRANSIENT_THROW, /\} else \{ \$script:R2WsPool\.Open\(\) \}/, 'the transient guard calls the REAL Open() on later attempts');
    const guardCount = (t2.match(/LabR2FaultOnce/g) || []).length;
    assert.ok(guardCount >= 2, 'the one-shot guard state is set and read');
    // Unknown kinds are refused.
    let threw = null;
    try { mod.deriveFaultVariant(fake, 'everything', 't-bad'); } catch (e) { threw = e; }
    assert.ok(threw && /unknown fault kind/.test(threw.message), 'unknown fault kind refused');
    // A file WITHOUT the site is refused (never a silent no-op "success").
    const noSite = path.join(outDir, 'no-site.ps1');
    fs.writeFileSync(noSite, 'Write-Host no pool here\n', 'utf8');
    threw = null;
    try { mod.deriveFaultVariant(noSite, 'persistent', 't-nosite'); } catch (e) { threw = e; }
    assert.ok(threw && /FAULT_SITE_MISSING/.test(threw.message), 'missing fault site refused');
  });

  await test('r2 fault: the harness never claims the fallback defect was already runtime-proven', async () => {
    assert.match(src, /SOURCE-IDENTIFIED, never runtime-proven/, 'the header states the provenance honestly');
    assert.match(src, /negative control/i, 'phase A is labelled a negative control');
    // Phase A PASS means the DEFECT reproduced (on the PRE-repair server), and
    // the note must say so - it can never be read as a candidate PASS.
    assert.match(src, /PASS means the defect was reproduced as predicted/);
    assert.match(src, /PRE-REPAIR server/);
  });

  await test('r2 fault: thresholds are declared before any run and bounded', async () => {
    const T = mod.T;
    assert.ok(T.healthTimeoutMs >= 2000 && T.healthTimeoutMs <= 10000, 'health stall threshold bounded');
    assert.ok(T.responsiveP95MaxMs >= 500 && T.responsiveP95MaxMs <= 5000, 'responsiveness threshold bounded');
    assert.ok(T.pumpBoundSec <= 30, 'the faulted pump lifetime stays bounded (measurement never hangs)');
    assert.ok(T.recoveryWaitMs > T.retryWindowSec * 1000, 'recovery wait exceeds the retry window');
  });

  await test('r2 fault: the workflow stages both server generations and gates on the fault verdicts', async () => {
    assert.match(wf, /r2-fault-injection\.js/, 'the fault lane is wired');
    assert.match(wf, /--server-old \(Join-Path \$env:APP_DIR 'payloads\\ghrdp-server\.ps1'\)/, 'old = the 0001-0003 patched server');
    assert.match(wf, /--server-new \$env:R2B_SERVER/, 'new = the 0001-0004 candidate');
    assert.match(wf, /40051974454-1-v2/, 'the full series comes from the v2 bundle');
    assert.match(wf, /--port 7341/, 'dedicated port so lanes never collide');
    assert.match(wf, /R2b FAULT LANE MISSING/, 'a missing fault report is a failure, never a skip');
    assert.match(wf, /R2b FAULT LANE FAIL/, 'fault control failures gate the job');
    assert.match(wf, /'r2-fault-report\.json','r2-fault-control-coverage\.csv'/, 'the fault report + coverage are published');
    assert.match(wf, /\('r2b-' \+ \$n\)/, 'published under the r2b- prefix');
  });

  await test('r2 fault: the 0004-patched server keeps the exact init sites the harness targets', async () => {
    // The sites must exist in the CURRENT candidate source. Read them from the
    // replayed patched tree is not possible here (no app checkout in the lab),
    // so pin them from the patch content itself: 0004 must keep the
    // CreateRunspacePool line (inside Initialize-R2WsPool) and the Open() line.
    const p4 = read('reports/mission-control/40051974454-1-v2/app-patches/0004-R2b-pool-fallback-bounded-truth.patch');
    assert.match(p4, /\+\s+\$script:R2WsPool = \[runspacefactory\]::CreateRunspacePool\(\$r2Iss\)/, 'pool creation preserved in the function');
    assert.match(p4, /\+\s+\$script:R2WsPool\.Open\(\)/, 'Open preserved in the function');
    // And the 0003 server (the old generation) also had them at top level.
    const p3 = read('reports/mission-control/40072158991-1/app-patches/0003-R2-websocket-worker-runspace.patch');
    assert.match(p3, /\+\s+\$script:R2WsPool = \[runspacefactory\]::CreateRunspacePool\(\$r2Iss\)/);
    assert.match(p3, /\+\s+\$script:R2WsPool\.Open\(\)/);
  });
};
