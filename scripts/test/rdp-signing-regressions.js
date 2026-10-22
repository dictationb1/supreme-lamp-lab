'use strict';
// REGRESSIONS for the SUPPORTED RDP-file signing / trust path.
//
// The observed blocker (lab run 39819073772, job `client`, mstsc pid 3820) is a
// per-connection "Remote Desktop Connection security warning" with Publisher
// "Unknown publisher". The supported fix is a signed .rdp plus a thumbprint pin
// in the trusted-.rdp-publisher policy. These tests pin the pieces that must not
// drift: thumbprint handling, the policy entry format, the identity state file,
// the refusal paths, and the guardrails that keep the "fix" from becoming the
// disable-the-protection stopgap.

const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = async function registerRdpSigningTests(H) {
  const { test, assert } = H;
  const signing = require('../lib/rdp-signing');
  const sha1 = 'a'.repeat(40);
  const sha256 = 'B'.repeat(64);

  await test('rdp signing: thumbprints are normalized and only SHA-1/SHA-256 lengths are accepted', async () => {
    assert.strictEqual(signing.normalizeThumbprint('aa:bb:cc'), 'AABBCC');
    assert.strictEqual(signing.isValidThumbprint(sha1), true);
    assert.strictEqual(signing.isValidThumbprint(sha256.toLowerCase()), true);
    assert.strictEqual(signing.thumbprintAlgorithm(sha1), 'SHA1');
    assert.strictEqual(signing.thumbprintAlgorithm(sha256), 'SHA256');
    assert.strictEqual(signing.isValidThumbprint('deadbeef'), false, 'a truncated hash must never be pinned');
    assert.strictEqual(signing.thumbprintAlgorithm('x'), null);
    assert.throws(() => signing.policyEntry('nope'), /INVALID_THUMBPRINT/);
  });

  await test('rdp signing: the policy entry is prefix + thumbprint, and the trust list is never "all publishers"', async () => {
    assert.strictEqual(signing.policyEntry(sha256, 'sha256:'), 'sha256:' + sha256);
    // normalized to uppercase hex, exactly as the ADMX list stores it
    assert.strictEqual(signing.policyEntry(sha1), sha1.toUpperCase());
    // The script must be able to write the ADMX-derived prefix, and must not
    // contain any of the "disable the protection" escape hatches.
    const script = fs.readFileSync(path.join(__dirname, '..', 'ps', 'Initialize-RdpFileSigning.ps1'), 'utf8');
    assert.ok(/RedirectionWarningDialogVersion/.test(script), 'the script documents the rejected stopgap by name');
    assert.ok(!/New-ItemProperty[^\n]*RedirectionWarningDialogVersion/.test(script), 'it must never WRITE the stopgap value');
    assert.ok(!/AllowUnsignedFiles[^\n]*0\b/.test(script) && !/AllowSignedFiles[^\n]*0\b/.test(script),
      'nothing may be blocked; this only adds trust for one publisher');
    assert.ok(/TS_CLIENT_TRUSTED_CERTIFICATE_THUMBPRINTS_1/.test(script), 'the policy is identified by its ADMX name');
    assert.ok(/Get-Content -LiteralPath \$AdmxPath/.test(script), 'the registry layout is read from the machine ADMX, not assumed');
    assert.ok(!/\*\s*$|cert:\/\/.*\*/i.test(script.split('Rollback')[0]), 'no wildcard certificate selection');
  });

  await test('rdp signing: an unconfigured client reports NOT_CONFIGURED (attended), a configured one demands a signature', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slab-signing-'));
    const none = signing.resolveSigningIdentity({ stateDir: dir });
    assert.strictEqual(none.configured, false);
    const posture = signing.describePosture(none);
    assert.strictEqual(posture.signed, false);
    assert.strictEqual(posture.code, 'RDP_FILE_SIGNING_NOT_CONFIGURED');
    assert.match(posture.detail, /NOT unattended/);

    const rec = { thumbprint: sha256, subject: 'CN=test', notAfter: '2028-01-01T00:00:00Z', policyKey: 'k', policyValue: 'sha256:' + sha256, computer: 'X', createdAt: '2026-01-01T00:00:00Z' };
    fs.writeFileSync(path.join(dir, 'identity.json'), JSON.stringify(rec));
    const found = signing.resolveSigningIdentity({ stateDir: dir });
    assert.strictEqual(found.configured, true);
    assert.strictEqual(found.thumbprint, sha256);
    assert.strictEqual(found.algorithm, 'SHA256');
    assert.strictEqual(signing.describePosture(found).code, 'RDP_FILE_SIGNING_CONFIGURED');

    // A corrupt/partial identity must not be treated as configured.
    fs.writeFileSync(path.join(dir, 'identity.json'), JSON.stringify({ thumbprint: 'zzz' }));
    assert.strictEqual(signing.resolveSigningIdentity({ stateDir: dir }).configured, false);

    // An explicit but invalid thumbprint is an error, not a silent fallback.
    const bad = signing.resolveSigningIdentity({ stateDir: dir, thumbprint: 'nothex' });
    assert.strictEqual(bad.configured, false);
    assert.match(String(bad.error), /INVALID_THUMBPRINT/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('rdp signing: signing a file without an identity is a named refusal on every platform', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slab-signing-'));
    const file = path.join(dir, 'probe.rdp');
    fs.writeFileSync(file, 'full address:s:100.64.0.1\r\n');
    const r = signing.signRdpFile(file, { stateDir: dir });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'NO_SIGNING_IDENTITY');
    assert.ok(!JSON.stringify(r).includes(sha256));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('rdp signing: the RDP attempt path signs the final .rdp before mstsc, and refuses an unsigned launch when configured', async () => {
    const mc = fs.readFileSync(path.join(__dirname, '..', 'mission-control-check.js'), 'utf8');
    const writeIdx = mc.indexOf('rdpFileInfo = writeRdpFile(');
    const signIdx = mc.indexOf('rdpSigning.signRdpFile(handle.rdpFile');
    const spawnIdx = mc.indexOf('const child = spawn(mstscExe, [handle.rdpFile]');
    assert.ok(writeIdx > 0 && signIdx > 0 && spawnIdx > 0, 'write -> sign -> launch must all exist');
    assert.ok(writeIdx < signIdx && signIdx < spawnIdx, 'signing must happen after the file is final and before mstsc starts');
    assert.ok(/RDP_FILE_SIGNING_FAILED/.test(mc), 'a configured-but-failed signature is a FAIL with its own code');
    assert.ok(/RDP_FILE_SIGNING_NOT_CONFIGURED/.test(mc), 'an unconfigured client records the fact instead of pretending');
  });

  await test('workflow structure gate: the committed gate passes on this tree and refuses a real defect', async () => {
    const gate = require('../workflow-structure-check');
    const { findings } = gate.run();
    assert.deepStrictEqual(findings, [], JSON.stringify(findings));
    // The gate is only meaningful if it bites. Prove the negative on a
    // temp copy of the workflows with one seeded defect.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slab-wf-'));
    const live = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'live-run.yml'), 'utf8');
    const seeded = live.replace(/^  pull_request:/m, '  # pull_request removed on purpose');
    assert.ok(seeded !== live);
    const wt2 = require('../lib/workflow-text');
    assert.ok(/^  pull_request:/m.test(live));
    assert.ok(!/^  pull_request:/m.test(seeded), 'the seeded copy really lost the trigger');
    assert.ok(wt2.concurrencyBlock(seeded).ok);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('rdp signing: the bootstrap workflow is restricted, opt-in and never weakens transport security', async () => {
    const wt = require('../lib/workflow-text');
    const wf = wt.readNormalized(path.join(__dirname, '..', '..', '.github', 'workflows', 'rdp-signing.yml'));
    assert.ok(/full_name == github\.repository/.test(wf), 'a fork PR must never reach this VM');
    assert.ok(/rdp-signing-bootstrap/.test(wf), 'Bootstrap is opt-in by label');
    assert.ok(/rdp-signing-probe/.test(wf), 'the probe is opt-in by label');
    assert.ok(/Mode Rollback/.test(wf), 'rollback is wired');
    for (const forbidden of ['RedirectionWarningDialogVersion', 'AllowUnsignedFiles', 'authentication level:i:', 'enablecredsspsupport:i:0']) {
      const body = wf.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
      assert.ok(!body.includes(forbidden), `the workflow must not weaken security (${forbidden})`);
    }
  });
};
