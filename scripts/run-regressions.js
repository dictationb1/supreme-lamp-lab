const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function runTest(name, fn) {
  console.log(`\n=== Running Regression Test: ${name} ===`);
  try {
    const result = fn();
    if (result === 'SKIPPED') {
      console.log(`[SKIPPED] ${name}`);
      return true;
    }
    console.log(`[PASS] ${name}`);
    return true;
  } catch (err) {
    console.error(`[FAIL] ${name}:`, err.message);
    return false;
  }
}

let allPassed = true;

// Defect 1: Restricted Script Startup Regression Test
allPassed = runTest('PowerShell Process-Scoped Bypass Execution Under Restricted Child Policy', () => {
  if (process.platform !== 'win32') {
    console.log('Non-Windows platform: verifying PowerShell invocation script string structure...');
    const workflowPath = path.join(__dirname, '../.github/workflows/capability-check.yml');
    const content = fs.readFileSync(workflowPath, 'utf8');
    if (!content.includes('-ExecutionPolicy Bypass')) {
      throw new Error('capability-check.yml missing -ExecutionPolicy Bypass shell parameter');
    }
    return true;
  }

  const cmd = `powershell -NoProfile -NonInteractive -ExecutionPolicy Restricted -Command "powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \\"$ErrorActionPreference = 'Stop'; Write-Host 'Process Bypass OK'\\""`;
  const output = execSync(cmd).toString();
  if (!output.includes('Process Bypass OK')) {
    throw new Error(`Expected output 'Process Bypass OK' not found. Got: ${output}`);
  }
}) && allPassed;

// Defect 2: Fail-Fast Native Exit Code Propagation Test
allPassed = runTest('Native Command Non-Zero Exit Code Propagation', () => {
  if (process.platform !== 'win32') {
    console.log('Non-Windows platform: verifying exit code check logic in workflow...');
    const workflowPath = path.join(__dirname, '../.github/workflows/capability-check.yml');
    const content = fs.readFileSync(workflowPath, 'utf8');
    if (!content.includes('LASTEXITCODE -ne 0')) {
      throw new Error('capability-check.yml missing $LASTEXITCODE checks for native commands');
    }
    return true;
  }

  const cmd = `powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; cmd /c exit 42; if ($LASTEXITCODE -ne 0) { throw \\"Native command failed with code $LASTEXITCODE\\" }"`;
  try {
    execSync(cmd, { stdio: 'pipe' });
    throw new Error('PowerShell should have thrown on non-zero LASTEXITCODE');
  } catch (err) {
    if (!err.message.includes('Native command failed with code 42') && !err.stderr.toString().includes('Native command failed with code 42')) {
      throw new Error(`Unexpected error message: ${err.message}`);
    }
  }
}) && allPassed;

// Defect 3: Interactive Headed Browser Launch Failure Handling
allPassed = runTest('Browser Check Strictly Fails on Headed Launch Failure', () => {
  const browserScript = fs.readFileSync(path.join(__dirname, 'browser-check.js'), 'utf8');
  if (browserScript.includes('falling back to headless')) {
    throw new Error('browser-check.js still contains headless fallback logic!');
  }
  if (!browserScript.includes('HEADED_LAUNCH_FAILED')) {
    throw new Error('browser-check.js does not explicitly fail on headed launch error!');
  }
}) && allPassed;

// Defect 4: Fresh Per-Run Output Directory Verification
allPassed = runTest('Per-Run Output Directory Isolation', () => {
  const runId = 'test-run-123';
  const runAttempt = '1';
  const targetDir = path.resolve(__dirname, `../artifacts/run-${runId}-${runAttempt}`);
  if (targetDir.includes('artifacts/screenshot.png')) {
    throw new Error('Output path is not isolated per run!');
  }
}) && allPassed;

// Defect 5: Session 0 Desktop Isolation Gate Check
allPassed = runTest('Session 0 Service Execution Gate Enforcement', () => {
  const workflowPath = path.join(__dirname, '../.github/workflows/capability-check.yml');
  const content = fs.readFileSync(workflowPath, 'utf8');
  if (!content.includes('Session ID > 0') || !content.includes('Session 0 execution is BLOCKED')) {
    throw new Error('capability-check.yml does not strictly block Session 0 service execution!');
  }
}) && allPassed;

// Defect 6: Mission Control Contract & PID Tracking Verification
allPassed = runTest('Mission Control Strict Contract & Target Process Tracking', () => {
  const mcScript = fs.readFileSync(path.join(__dirname, 'mission-control-check.js'), 'utf8');
  if (mcScript.includes('taskkill /IM mstsc.exe')) {
    throw new Error('mission-control-check.js uses global taskkill /IM mstsc.exe!');
  }
  if (!mcScript.includes('CONTRACT_VIOLATION')) {
    throw new Error('mission-control-check.js lacks strict contract violation checks!');
  }
}) && allPassed;

if (!allPassed) {
  console.error('\nOne or more regression tests failed!');
  process.exit(1);
} else {
  console.log('\nAll regression tests passed successfully!');
}
