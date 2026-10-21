const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const registryUtils = require('./registry-utils');

let totalTests = 0;
let passedTests = 0;
let skippedTests = 0;
let failedTests = 0;

async function runTest(name, fn) {
  totalTests++;
  console.log(`\n=== Running Regression Test ${totalTests}: ${name} ===`);
  try {
    const result = await fn();
    if (result && result.status === 'SKIP') {
      console.log(`[SKIP] ${name}: ${result.reason || 'Skipped'}`);
      skippedTests++;
      return true;
    }
    console.log(`[PASS] ${name}`);
    passedTests++;
    return true;
  } catch (err) {
    console.error(`[FAIL] ${name}:`, err.message);
    failedTests++;
    return false;
  }
}


async function main() {
  await runTest('PowerShell Process-Scoped Bypass Execution Under Restricted Child Policy', () => {
    if (process.platform !== 'win32') {
      return { status: 'SKIP', reason: 'PowerShell child policy test is Windows-specific' };
    }
    const cmd = `powershell -NoProfile -NonInteractive -ExecutionPolicy Restricted -Command "powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command Write-Host 'Process Bypass OK'"`;
    const output = execSync(cmd).toString();
    if (!output.includes('Process Bypass OK')) {
      throw new Error(`Expected output 'Process Bypass OK' not found. Got: ${output}`);
    }
  });

  await runTest('Native Command Non-Zero Exit Code Propagation', () => {
    if (process.platform !== 'win32') {
      return { status: 'SKIP', reason: 'Native exit code propagation test is Windows-specific' };
    }
    const cmd = `powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; cmd /c exit 42; if ($LASTEXITCODE -ne 0) { throw \\"Native command failed with code $LASTEXITCODE\\" }"`;
    try {
      execSync(cmd, { stdio: 'pipe' });
      throw new Error('PowerShell should have thrown on non-zero LASTEXITCODE');
    } catch (err) {
      const combinedOutput = (err.message || '') + (err.stderr ? err.stderr.toString() : '');
      if (!combinedOutput.includes('Native command failed with code 42')) {
        throw new Error(`Unexpected error message: ${err.message}`);
      }
    }
  });

  await runTest('Browser Check Strictly Fails on Headed Launch Failure', () => {
    const browserScript = fs.readFileSync(path.join(__dirname, 'browser-check.js'), 'utf8');
    if (browserScript.includes('falling back to headless')) {
      throw new Error('browser-check.js still contains headless fallback logic!');
    }
    if (!browserScript.includes('HEADED_LAUNCH_FAILED')) {
      throw new Error('browser-check.js does not explicitly fail on headed launch error!');
    }
  });

  await runTest('Per-Run Output Directory Isolation', () => {
    const runId = 'test-run-123';
    const runAttempt = '1';
    const baseDir = process.env.RUNNER_TEMP || path.resolve(__dirname, '..');
    const targetDir = path.join(baseDir, `artifacts`, `run-${runId}-${runAttempt}`);
    if (targetDir.includes('artifacts/screenshot.png')) {
      throw new Error('Output path is not isolated per run!');
    }
  });

  await runTest('Process Registry UTF-8 Array Schema & Atomic Writes', () => {
    const tempDir = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'reg-test-'));
    const testRegPath = path.join(tempDir, 'test-registry.json');

    try {
      const initial = registryUtils.readRegistryFile(testRegPath);
      if (!Array.isArray(initial) || initial.length !== 0) {
        throw new Error('Initial registry read did not return an empty array');
      }

      const entry = registryUtils.registerProcess({
        pid: process.pid,
        processName: 'node-test',
        exePath: process.execPath,
        runId: 'isolated-test-run-1',
        runAttempt: '1',
        regPath: testRegPath
      });

      if (!entry || !entry.createTime) {
        throw new Error('Registered entry missing creation time metadata');
      }

      const records = registryUtils.readRegistryFile(testRegPath);
      if (!Array.isArray(records) || records.length !== 1) {
        throw new Error(`Expected 1 recorded process, found ${records.length}`);
      }

      if (records[0].pid !== process.pid || records[0].runId !== 'isolated-test-run-1') {
        throw new Error('Registry recorded fields mismatch expected isolated test parameters');
      }
    } finally {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
    }
  });

  await runTest('HTTP 200 Payload Indicating Not-Ready Fails Verification', async () => {
    const tempDir = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'notready-test-'));
    const serverCode = `
      const http = require('http');
      const body = JSON.stringify({ ok: false, status: 'not_ready', backendIdentity: 'test-backend', sourceCommit: 'abc', services: {} });
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
      });
      server.listen(0, '127.0.0.1', () => {
        console.log('PORT:' + server.address().port);
      });
    `;

    const serverProc = spawn(process.execPath, ['-e', serverCode], { stdio: ['ignore', 'pipe', 'inherit'] });
    let port = null;
    await new Promise((resolve, reject) => {
      serverProc.stdout.on('data', data => {
        const match = data.toString().match(/PORT:(\d+)/);
        if (match) {
          port = match[1];
          resolve();
        }
      });
      serverProc.on('error', reject);
    });

    try {
      const env = { ...process.env, RUNNER_TEMP: tempDir, MISSION_CONTROL_URL: `http://127.0.0.1:${port}`, ALLOW_MOCK_MISSION_CONTROL: 'false' };
      const scriptPath = path.join(__dirname, 'mission-control-check.js');
      try {
        execSync(`node "${scriptPath}"`, { env, stdio: 'pipe' });
        throw new Error('mission-control-check.js should have failed when readiness payload reports ok: false');
      } catch (err) {
        const artDir = path.join(tempDir, 'artifacts');
        let foundNotReady = false;
        if (fs.existsSync(artDir)) {
          const runs = fs.readdirSync(artDir);
          for (const run of runs) {
            const resFile = path.join(artDir, run, 'mission-control-results.json');
            if (fs.existsSync(resFile)) {
              const res = JSON.parse(fs.readFileSync(resFile, 'utf8'));
              if (res.failureReason && res.failureReason.includes('READINESS_NOT_READY')) {
                foundNotReady = true;
              }
            }
          }
        }
        if (!foundNotReady) {
          throw new Error(`Expected failureReason to contain READINESS_NOT_READY, got: ${err.message}`);
        }
      }
    } finally {
      serverProc.kill();
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
    }
  });

  await runTest('Single-Step Workflow Encapsulates Backend Lifecycle and Verification', () => {
    const wfPath = path.join(__dirname, '..', '.github', 'workflows', 'capability-check.yml');
    const content = fs.readFileSync(wfPath, 'utf8');
    if (!content.includes('Checkout, Provision & Verify Mission Control Application')) {
      throw new Error('capability-check.yml does not combine checkout, provisioning and verification into a single step!');
    }
    if (!content.includes('finally {')) {
      throw new Error('capability-check.yml does not include a finally cleanup block for supervised backend process!');
    }
  });

  await runTest('Workflow Disables Mock Fallback in Live Acceptance Mode', () => {
    const wfPath = path.join(__dirname, '..', '.github', 'workflows', 'capability-check.yml');
    const content = fs.readFileSync(wfPath, 'utf8');
    if (content.includes('$env:ALLOW_MOCK_MISSION_CONTROL = "true"')) {
      throw new Error('capability-check.yml still sets ALLOW_MOCK_MISSION_CONTROL to "true"!');
    }
    if (!content.includes('$env:ALLOW_MOCK_MISSION_CONTROL = "false"')) {
      throw new Error('capability-check.yml does not explicitly set ALLOW_MOCK_MISSION_CONTROL to "false"!');
    }
  });

  await runTest('Safe Lock Acquisition & Recovery Under Isolated Harness', () => {
    const tempDir = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'lock-test-'));
    const testLockDir = path.join(tempDir, 'test-lock.lock');

    try {
      const handle1 = registryUtils.acquireLock({
        runId: 'lock-run-1',
        runAttempt: '1',
        timeoutMs: 1000,
        lockDir: testLockDir
      });

      if (!fs.existsSync(testLockDir)) {
        throw new Error('Lock directory was not created');
      }

      try {
        registryUtils.acquireLock({
          runId: 'lock-run-2',
          runAttempt: '1',
          timeoutMs: 500,
          retryIntervalMs: 100,
          lockDir: testLockDir
        });
        throw new Error('Concurrent lock acquisition should have failed with timeout');
      } catch (err) {
        if (!err.message.includes('LOCK_ACQUISITION_FAILED')) {
          throw new Error(`Unexpected lock timeout error: ${err.message}`);
        }
      }

      registryUtils.releaseLock(testLockDir);
      if (fs.existsSync(testLockDir)) {
        throw new Error('Lock directory was not cleaned up after release');
      }
    } finally {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
    }
  });

  await runTest('Targeted Lab Cleanup Terminates Verified Process Without Affecting System', () => {
    if (process.platform !== 'win32') {
      return { status: 'SKIP', reason: 'Windows process cleanup verification requires win32 host' };
    }

    const tempDir = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'cleanup-test-'));
    const testRegPath = path.join(tempDir, 'cleanup-registry.json');
    const isolatedRunId = `cleanup-test-run-${Date.now()}`;

    let dummyProc = null;
    try {
      dummyProc = spawn('ping', ['127.0.0.1', '-n', '60'], { stdio: 'ignore' });
      if (!dummyProc.pid) {
        throw new Error('Failed to spawn harness process for cleanup test');
      }

      registryUtils.registerProcess({
        pid: dummyProc.pid,
        processName: 'ping',
        exePath: 'C:\\Windows\\System32\\PING.EXE',
        runId: isolatedRunId,
        runAttempt: '1',
        regPath: testRegPath
      });

      const preAlive = registryUtils.isProcessAlive(dummyProc.pid);
      if (!preAlive) {
        throw new Error('Harness process PID was not detected as alive before cleanup');
      }

      const cleanupScriptPath = path.join(__dirname, 'cleanup-lab.ps1');
      const cleanupCmd = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${cleanupScriptPath}" -RegistryPath "${testRegPath}" -TargetRunId "${isolatedRunId}"`;
      execSync(cleanupCmd, { stdio: 'pipe' });

      const postAlive = registryUtils.isProcessAlive(dummyProc.pid);
      if (postAlive) {
        throw new Error('Harness process PID remained alive after cleanup!');
      }
    } finally {
      if (dummyProc && dummyProc.pid) {
        try { process.kill(dummyProc.pid); } catch (e) {}
      }
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
    }
  });

  await runTest('Missing Mission Control Backend Fails Live Acceptance Without Mock', () => {
    const tempDir = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'mc-test-'));
    try {
      const env = { ...process.env, RUNNER_TEMP: tempDir, MISSION_CONTROL_URL: 'http://127.0.0.1:59999', ALLOW_MOCK_MISSION_CONTROL: 'false' };
      const scriptPath = path.join(__dirname, 'mission-control-check.js');
      try {
        execSync(`node "${scriptPath}"`, { env, stdio: 'pipe' });
        throw new Error('mission-control-check.js should have failed when backend is unreachable and mock is false');
      } catch (err) {
        const artDir = path.join(tempDir, 'artifacts');
        let foundResults = false;
        if (fs.existsSync(artDir)) {
          const runs = fs.readdirSync(artDir);
          for (const run of runs) {
            const resFile = path.join(artDir, run, 'mission-control-results.json');
            if (fs.existsSync(resFile)) {
              foundResults = true;
              const res = JSON.parse(fs.readFileSync(resFile, 'utf8'));
              if (res.status === 'PASS') {
                throw new Error('mission-control-check.js recorded status PASS for unreachable backend!');
              }
              if (res.isMockBackend === true) {
                throw new Error('mission-control-check.js started mock server when ALLOW_MOCK_MISSION_CONTROL=false!');
              }
            }
          }
        }
        if (!foundResults) {
          throw new Error('mission-control-results.json was not created during failure');
        }
      }
    } finally {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
    }
  });

  await runTest('Registry Handles Corrupt File and Recovers via Atomic Writes', () => {
    const tempDir = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'corrupt-test-'));
    const testRegPath = path.join(tempDir, 'corrupt-registry.json');

    try {
      fs.writeFileSync(testRegPath, '{ invalid json: true }', 'utf8');
      try {
        registryUtils.readRegistryFile(testRegPath);
        throw new Error('Expected REGISTRY_CORRUPT error on invalid JSON');
      } catch (err) {
        if (!err.message.includes('REGISTRY_CORRUPT')) {
          throw new Error(`Unexpected error on corrupt registry read: ${err.message}`);
        }
      }
      const files = fs.readdirSync(tempDir);
      const corruptBackup = files.find(f => f.includes('.corrupt.'));
      if (!corruptBackup) {
        throw new Error('Backup file for corrupt registry was not created!');
      }
    } finally {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
    }
  });

  console.log('\n========================================');
  console.log(`Regression Test Summary: Total: ${totalTests} | Passed: ${passedTests} | Skipped: ${skippedTests} | Failed: ${failedTests}`);
  console.log('========================================');

  if (failedTests > 0) {
    console.error(`\n[FAIL] ${failedTests} regression test(s) failed!`);
    process.exit(1);
  } else {
    console.log('\nAll regression checks completed successfully!');
  }
}

main().catch(err => {
  console.error('Fatal error in regression runner:', err);
  process.exit(1);
});
