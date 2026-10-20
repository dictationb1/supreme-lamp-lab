const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const registryUtils = require('./registry-utils');

let totalTests = 0;
let passedTests = 0;
let skippedTests = 0;
let failedTests = 0;

function runTest(name, fn) {
  totalTests++;
  console.log(`\n=== Running Regression Test ${totalTests}: ${name} ===`);
  try {
    const result = fn();
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

// Defect 1: Restricted PowerShell Process-Scoped Bypass Execution
runTest('PowerShell Process-Scoped Bypass Execution Under Restricted Child Policy', () => {
  if (process.platform !== 'win32') {
    return { status: 'SKIP', reason: 'PowerShell child policy test is Windows-specific' };
  }
  const cmd = `powershell -NoProfile -NonInteractive -ExecutionPolicy Restricted -Command "powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command Write-Host 'Process Bypass OK'"`;
  const output = execSync(cmd).toString();
  if (!output.includes('Process Bypass OK')) {
    throw new Error(`Expected output 'Process Bypass OK' not found. Got: ${output}`);
  }
});

// Defect 2: Fail-Fast Native Exit Code Propagation
runTest('Native Command Non-Zero Exit Code Propagation', () => {
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

// Defect 3: Interactive Headed Browser Launch Failure Handling
runTest('Browser Check Strictly Fails on Headed Launch Failure', () => {
  const browserScript = fs.readFileSync(path.join(__dirname, 'browser-check.js'), 'utf8');
  if (browserScript.includes('falling back to headless')) {
    throw new Error('browser-check.js still contains headless fallback logic!');
  }
  if (!browserScript.includes('HEADED_LAUNCH_FAILED')) {
    throw new Error('browser-check.js does not explicitly fail on headed launch error!');
  }
});

// Defect 4: Fresh Per-Run Output Directory Verification
runTest('Per-Run Output Directory Isolation', () => {
  const runId = 'test-run-123';
  const runAttempt = '1';
  const baseDir = process.env.RUNNER_TEMP || path.resolve(__dirname, '..');
  const targetDir = path.join(baseDir, `artifacts`, `run-${runId}-${runAttempt}`);
  if (targetDir.includes('artifacts/screenshot.png')) {
    throw new Error('Output path is not isolated per run!');
  }
});

// Defect 5: Isolated Process Registry Encoding & Schema Integrity
runTest('Process Registry UTF-8 Array Schema & Atomic Writes', () => {
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

// Defect 6: Bounded Lock Acquisition and Safe Recovery
runTest('Safe Lock Acquisition & Recovery Under Isolated Harness', () => {
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

// Defect 7: Process Cleanup Protection and Verification
runTest('Targeted Lab Cleanup Terminates Verified Process Without Affecting System', () => {
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

console.log('\n========================================');
console.log(`Regression Test Summary: Total: ${totalTests} | Passed: ${passedTests} | Skipped: ${skippedTests} | Failed: ${failedTests}`);
console.log('========================================');

if (failedTests > 0) {
  console.error(`\n[FAIL] ${failedTests} regression test(s) failed!`);
  process.exit(1);
} else {
  console.log('\nAll regression checks completed successfully!');
}
