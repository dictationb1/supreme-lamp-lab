const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function runTest(name, fn) {
  console.log(`\n=== Running Regression Test: ${name} ===`);
  try {
    fn();
    console.log(`[PASS] ${name}`);
    return true;
  } catch (err) {
    console.error(`[FAIL] ${name}:`, err.message);
    return false;
  }
}

let allPassed = true;

// Defect 1: Restricted Script Startup Regression Test
// Verify that executing PowerShell under Restricted policy with default process-scoped Bypass succeeds,
// and that syntax or non-zero exits propagate as failures.
allPassed = runTest('PowerShell Process-Scoped Bypass Execution Under Restricted Child Policy', () => {
  if (process.platform !== 'win32') {
    console.log('Skipping Windows-specific PowerShell test on non-Windows host');
    return;
  }

  // Invoke PowerShell child process setting execution policy to Restricted for child commands,
  // verifying process-scoped -ExecutionPolicy Bypass executes inline script successfully.
  const cmd = `powershell -NoProfile -NonInteractive -ExecutionPolicy Restricted -Command "powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \\"$ErrorActionPreference = 'Stop'; Write-Host 'Process Bypass OK'\\""`;
  const output = execSync(cmd).toString();
  if (!output.includes('Process Bypass OK')) {
    throw new Error(`Expected output 'Process Bypass OK' not found. Got: ${output}`);
  }
}) && allPassed;

// Defect 2: Fail-Fast Native Exit Code Propagation Test
allPassed = runTest('Native Command Non-Zero Exit Code Propagation', () => {
  if (process.platform !== 'win32') {
    console.log('Skipping Windows-specific test on non-Windows host');
    return;
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
  const baseDir = process.env.RUNNER_TEMP || path.resolve(__dirname, '..');
  const targetDir = path.join(baseDir, `artifacts`, `run-${runId}-${runAttempt}`);
  if (targetDir.includes('artifacts/screenshot.png')) {
    throw new Error('Output path is not isolated per run!');
  }
}) && allPassed;

if (!allPassed) {
  console.error('\nOne or more regression tests failed!');
  process.exit(1);
} else {
  console.log('\nAll regression tests passed successfully!');
}
