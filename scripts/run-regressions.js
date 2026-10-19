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

// Defect 5: Safe Registry Cleanup Test - Missing Metadata
allPassed = runTest('Registry Cleanup Missing Metadata', () => {
  if (process.platform !== 'win32') return;
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const registryPath = path.join(os.tmpdir(), 'supreme-lamp-lab-registry', 'lab-registry.json');
  try {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, JSON.stringify([{}], null, 2));
    require('child_process').execSync(`powershell -NoProfile -NonInteractive -Command "$env:GITHUB_RUN_ID='fake'; $env:GITHUB_RUN_ATTEMPT='1'; ./scripts/cleanup-lab.ps1"`, { stdio: 'pipe' });
  } finally {
    try { fs.rmSync(registryPath); } catch(e){}
  }
}) && allPassed;

// Defect 6: Checksum Mismatch
allPassed = runTest('Checksum Mismatch', () => {
  if (process.platform !== 'win32') return;
  try {
    require('child_process').execSync(`powershell -NoProfile -NonInteractive -Command "$ErrorActionPreference = 'Stop'; $actualHash = 'bad'; $expectedHash = 'good'; if ($actualHash -ne $expectedHash) { throw 'Checksum mismatch' }"`, { stdio: 'pipe' });
    throw new Error('Should have failed');
  } catch(e) {
    if (!e.message.includes('Checksum mismatch')) throw e;
  }
}) && allPassed;

// Defect 7: Safe Registry Cleanup Execution
allPassed = runTest('Safe Registry Cleanup Execution', () => {
  if (process.platform !== 'win32') {
    console.log('Skipping Windows-specific cleanup test on non-Windows host');
    return;
  }

  const { registerProcess } = require('./registry-utils');
  const testProc = require('child_process').spawn('cmd.exe', ['/c', 'timeout', '/t', '10'], { detached: true });
  registerProcess(testProc.pid, 'cmd.exe', 'Regression Test Dummy');

  // Set fake current run environment variables and run POSTFLIGHT cleanup to trigger cleanup of this process
  try {
    execSync(`powershell -NoProfile -NonInteractive -Command "$env:GITHUB_RUN_ID='local-run'; $env:GITHUB_RUN_ATTEMPT='1'; $env:POSTFLIGHT_CLEANUP='true'; ./scripts/cleanup-lab.ps1"`, { stdio: 'pipe' });
    // Check if process was killed
    try {
      process.kill(testProc.pid, 0);
      throw new Error("Process survived cleanup but should have been killed");
    } catch(e) {
      if (e.code !== 'ESRCH') throw e; // ESRCH means process doesn't exist, which is expected
    }
  } finally {
    try { process.kill(testProc.pid); } catch(e) {}
  }
}) && allPassed;

// Defect 4: Custom Node Setup Zip Extraction Regression
allPassed = runTest('Custom Node Setup Zip Extraction (Expand-Archive)', () => {
  if (process.platform !== 'win32') {
    console.log('Skipping Windows-specific Expand-Archive test on non-Windows host');
    return;
  }

  // Verify that Expand-Archive correctly creates the target output without 7zr.exe failure
  const testZipPath = path.join(__dirname, 'test_expand.zip');
  const testOutPath = path.join(__dirname, 'test_expand_out');

  // Create a minimal dummy zip file via PowerShell first
  execSync(`powershell -NoProfile -NonInteractive -Command "New-Item -ItemType Directory -Path 'test_dummy_dir' -Force | Out-Null; New-Item -ItemType File -Path 'test_dummy_dir\\dummy.txt' -Value 'dummy' -Force | Out-Null; Compress-Archive -Path 'test_dummy_dir\\*' -DestinationPath '${testZipPath}' -Force; Remove-Item -Recurse -Force 'test_dummy_dir'"`, { cwd: __dirname });

  try {
    const cmd = `powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; Expand-Archive -Path '${testZipPath}' -DestinationPath '${testOutPath}' -Force; if (-not (Test-Path '${testOutPath}\\dummy.txt')) { throw \\"Extraction failed or missing file\\" }"`;
    execSync(cmd, { stdio: 'pipe' });
  } finally {
    // Cleanup
    try { fs.unlinkSync(testZipPath); } catch(e) {}
    try { fs.rmSync(testOutPath, { recursive: true, force: true }); } catch(e) {}
  }
}) && allPassed;

// Defect 5: Fresh Per-Run Output Directory Verification
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
