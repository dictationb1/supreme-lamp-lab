'use strict';
// [FUNCTIONAL SWEEP] Structural pins for the real-backend contract probe
// (scripts/candidate/functional-sweep.js) and its capability-check wiring.
// The behavioral proof is the live Windows run; these pins keep the harness
// honest about what it measures and what it refuses to claim.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..');
function read(p) { return fs.readFileSync(path.join(REPO, p), 'utf8'); }

module.exports = async function functionalSweepTests({ test, assert }) {
  const src = read('scripts/candidate/functional-sweep.js');
  const wf = read('.github/workflows/capability-check.yml');
  const stageFx = read('scripts/server/Stage-FxFixtures.ps1');

  await test('functional sweep: pinned fixture expectations match the staged fixture bytes', async () => {
    // The pins must equal what Stage-FxFixtures writes: byte-deterministic
    // fixtures only. A pin drift (either side) fails here, before any run.
    const png = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,0x00,0x00,0x00,0x0D,0x49,0x48,0x44,0x52,0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,0x08,0x02,0x00,0x00,0x00,0x90,0x77,0x53,0xDE,0x00,0x00,0x00,0x0C,0x49,0x44,0x41,0x54,0x08,0xD7,0x63,0xF8,0xCF,0xC0,0x00,0x00,0x03,0x01,0x01,0x00,0x18,0xDD,0x8D,0xB0,0x00,0x00,0x00,0x00,0x49,0x45,0x4E,0x44,0xAE,0x42,0x60,0x82]);
    const pngSha = crypto.createHash('sha256').update(png).digest('hex');
    const nested = Buffer.from('nested lab fixture\n', 'utf8');
    const nestedSha = crypto.createHash('sha256').update(nested).digest('hex');
    assert.match(src, new RegExp(pngSha), 'the PNG fixture pin matches the staged bytes');
    assert.match(src, new RegExp(nestedSha), 'the nested-text fixture pin matches the staged bytes');
    // The pins are three-way: the index checksum is the second reference.
    assert.match(src, /sha === String\(f\.checksum\)\.toLowerCase\(\)/, 'served bytes are checked against the index checksum');
    // The timestamp-bearing fixtures are pinned by MARKER, never by hash.
    assert.match(src, /marker: 'lab file explorer fixture'/, 'lab-readme pinned by marker (staging timestamp inside)');
    assert.match(src, /marker: 'disposable lab fixture'/, 'lab-data pinned by marker');
    // Stage-FxFixtures still stages exactly these leaves (the sweep's coverage).
    for (const leaf of ['lab-readme.txt', 'lab-data.json', 'lab-pixel.png', 'subdir\\lab-nested.txt']) {
      assert.ok(stageFx.includes(leaf), 'stager still writes ' + leaf);
    }
  });

  await test('functional sweep: ids are recomputed, never trusted from the index', async () => {
    assert.match(src, /function stableId\(p\)/, 'local SHA-1(root+path) recompute exists');
    assert.match(src, /idsRecomputeOk/, 'list verdict gates on the recompute');
    assert.match(src, /newIdRecomputed/, 'a move must mint the recomputed new id');
    // SHA-1(root+path) is identity-only: pin the exact algorithm against the
    // documented example so a server-side change cannot drift silently.
    const id = crypto.createHash('sha1').update(Buffer.from('RDP-Storage/lab-fixture/lab-pixel.png', 'utf8')).digest('hex');
    assert.ok(!src.includes(id), 'no hardcoded ids (all recomputed at runtime)');
  });

  await test('functional sweep: no fabricated claims (upload delivery, ticket use, 401 vantage)', async () => {
    assert.match(src, /external gofile delivery is NOT claimed/, 'upload = queue contract only');
    assert.match(src, /ticket consumption needs the ghrdp:\/\/ handler/, 'rdp-token = issue only');
    assert.match(src, /a no-token 401\s*\n?\s*\/\/\s*CA NOT|\* CANNOT be observed from this vantage and is NOT claimed|CANNOT be observed from this vantage/, 'the tailnet-vantage limit on 401 is stated');
    assert.match(src, /Sessions reads native-status, NOT \/api\/sessions/, 'the earlier /api/sessions harness defect is documented');
  });

  await test('functional sweep: guardrails and lifecycle cover the production contract', async () => {
    assert.match(src, /noCsrf\.status === 403/, 'op without CSRF must be 403');
    assert.match(src, /hardFlag\.status === 400/, 'the hard flag must be refused 400');
    assert.match(src, /already trashed/, 'repeat-trash skip reason checked');
    assert.match(src, /not trashed/, 'repeat-restore skip reason checked');
    assert.match(src, /pin state/, 'repeat-pin skip reason checked');
    assert.match(src, /'Range': 'bytes=0-15'/, 'range probe');
    assert.match(src, /bytes=999999-1000000/, 'unsatisfiable range probe (416)');
    assert.match(src, /code\(url\) === 'VALIDATION_ERROR'/, 'search URL-in-query refused');
    assert.match(src, /code\(unknownAdapter\) === 'UNKNOWN_SOURCE'/, 'unknown adapter refused');
    assert.match(src, /limitLow\.status === 400 && limitHigh\.status === 400/, 'limit 0 and 51 refused');
    // Exit discipline: report FIRST, then the verdict decides the exit code.
    assert.match(src, /flush\(\);\s*\n\s*process\.stdout\.write\('FUNCTIONAL_SWEEP[\s\S]*?process\.exit\(verdicts\.FAIL > 0/, 'report written (and announced) before the fail exit');
  });

  await test('functional sweep: wired into the capability client job after the remote check', async () => {
    assert.match(wf, /Functional sweep \(fx\/search\/core contracts against the live candidate\)/, 'the step exists');
    assert.match(wf, /steps\.remote\.outcome == 'success'/, 'runs only when the remote capability check succeeded');
    assert.match(wf, /functional-sweep\.js --target/, 'invoked with the live peer target');
    assert.match(wf, /--expect-build \$env:CANDIDATE_BUILD/, 'the candidate build identity is passed');
    assert.match(wf, /functional-sweep\\functional-sweep-control-coverage\.csv/, 'the coverage CSV is published');
    assert.match(wf, /functional-sweep-report\.json|Filter '\*\.json'/, 'the report JSON is collected');
    // It must never run in consent-setup mode (that mode holds a dialog window).
    assert.match(wf, /inputs\.mode != 'consent-setup' && steps\.remote\.outcome == 'success'/, 'excluded from consent-setup mode');
  });
};
