const path = require('path');
const fs = require('fs');
const http = require('http');
const { execSync, spawn } = require('child_process');
const registryUtils = require('./registry-utils');

let chromium;
try {
  chromium = require('playwright').chromium;
} catch (e) {
  // Playwright optional for early failure checks prior to browser launch
}

function startMockMissionControlServer(port = 8080, commitSha = 'local-sha') {
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Supreme Lamp Mission Control Dashboard (Mock)</title>
    <style>
        body { font-family: monospace; background: #0f172a; color: #f8fafc; margin: 40px; }
        .card { background: #1e293b; padding: 20px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #334155; }
        .status-ok { color: #4ade80; font-weight: bold; }
    </style>
</head>
<body>
    <h1>Mission Control Dashboard (MOCK)</h1>
    <div class="card">
        <h2>Backend Status: <span class="status-ok">ONLINE (MOCK)</span></h2>
        <p id="telemetry">Commit: ${commitSha}</p>
        <div id="web-desktop-frame" style="width: 400px; height: 200px; background: #0284c7; border: 2px solid #38bdf8;">
            Web Desktop Active
        </div>
    </div>
</body>
</html>`;

  const server = http.createServer((req, res) => {
    if (req.url === '/api/readiness') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        backendIdentity: 'supreme-lamp-mc-backend-mock',
        sourceCommit: commitSha,
        isMock: true,
        services: {
          webDesktop: 'ok',
          rdp: 'ok',
          telemetry: 'ok'
        }
      }));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(htmlContent);
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      console.log(`Mock Mission Control server listening at http://127.0.0.1:${port}`);
      resolve(server);
    });
    server.on('error', reject);
  });
}

function captureDesktopScreenshot(outputPath) {
  const tempDir = process.env.TEMP || process.env.RUNNER_TEMP || '/tmp';
  const scriptPath = path.join(tempDir, `cap-desktop-${Date.now()}-${Math.random().toString(36).substring(2, 6)}.ps1`);
  const psScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save($args[0], [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bmp.Dispose()
`;
  try {
    fs.writeFileSync(scriptPath, psScript, 'utf8');
    execSync(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}" "${outputPath}"`, { stdio: 'pipe', timeout: 10000 });
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
      return true;
    }
    console.error('Desktop screenshot output file does not exist or is empty');
    return false;
  } catch (err) {
    console.error('Failed to capture native desktop screenshot via PowerShell:', err.message);
    return false;
  } finally {
    try { if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath); } catch (e) {}
  }
}

async function runMissionControlCheck() {
  const runId = process.env.GITHUB_RUN_ID || 'local-mc-run';
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT || '1';
  const commitSha = process.env.GITHUB_SHA || 'local-sha';
  const runnerName = process.env.RUNNER_NAME || process.env.COMPUTERNAME || 'local-runner';

  const allowMock = process.env.ALLOW_MOCK_MISSION_CONTROL === 'true';
  let serverUrl = process.env.MISSION_CONTROL_URL || (allowMock ? 'http://127.0.0.1:8080' : null);

  const baseDir = process.env.RUNNER_TEMP || path.resolve(__dirname, '..');
  const outputDir = path.join(baseDir, `artifacts`, `run-${runId}-${runAttempt}`);
  const videoDir = path.join(outputDir, 'videos');
  const screenshotPath = path.join(outputDir, 'mc-dashboard.png');
  const desktopScreenshotPath = path.join(outputDir, 'native-desktop-mstsc.png');
  const resultsPath = path.join(outputDir, 'mission-control-results.json');

  if (!fs.existsSync(videoDir)) {
    fs.mkdirSync(videoDir, { recursive: true });
  }

  // Register process and acquire lock
  try {
    registryUtils.registerProcess({ pid: process.pid, processName: 'node-mc-check', runId, runAttempt });
  } catch (e) {}

  let lockAcquired = false;
  try {
    registryUtils.acquireLock({ runId, runAttempt, timeoutMs: 5000 });
    lockAcquired = true;
  } catch (lockErr) {
    console.warn(`[LOCK_WARN] ${lockErr.message}`);
  }

  const startTime = Date.now();
  let serverInstance = null;
  let browser = null;
  let context = null;
  let page = null;

  let overallStatus = 'FAIL';
  let failureReason = null;

  const capabilities = {
    backendCheck: 'NOT_RUN',
    dashboardCheck: 'NOT_RUN',
    webDesktopCheck: 'NOT_RUN',
    rdpAutoLoginCheck: 'NOT_RUN'
  };

  let backendIdentity = null;
  let backendCommit = null;
  let readinessServices = null;
  let isMockBackend = false;

  try {
    if (!serverUrl) {
      capabilities.backendCheck = allowMock ? 'SKIPPED' : 'BLOCKED';
      throw new Error('MISSING_CONFIG: MISSION_CONTROL_URL environment variable is required for live Mission Control check and ALLOW_MOCK_MISSION_CONTROL is false.');
    }

    console.log(`Connecting to Mission Control server at ${serverUrl}/api/readiness...`);
    let readinessRes = null;
    try {
      readinessRes = await fetch(`${serverUrl}/api/readiness`, { signal: AbortSignal.timeout(3000) });
    } catch (fetchErr) {
      if (allowMock) {
        console.log(`Mission Control server at ${serverUrl} not responding. Starting mock Mission Control server (ALLOW_MOCK_MISSION_CONTROL=true)...`);
        try {
          const parsedUrl = new URL(serverUrl);
          const port = parseInt(parsedUrl.port || '8080', 10);
          serverInstance = await startMockMissionControlServer(port, commitSha);
          readinessRes = await fetch(`${serverUrl}/api/readiness`, { signal: AbortSignal.timeout(3000) });
        } catch (srvErr) {
          capabilities.backendCheck = 'FAIL';
          throw new Error(`MISSION_CONTROL_UNREACHABLE: Could not connect to or start mock Mission Control server at ${serverUrl}: ${srvErr.message}`);
        }
      } else {
        capabilities.backendCheck = 'FAIL';
        const causeMsg = fetchErr.cause ? ` (${fetchErr.cause.code || fetchErr.cause.message || fetchErr.cause})` : '';
        throw new Error(`MISSION_CONTROL_UNREACHABLE: Live Mission Control server at ${serverUrl} is unreachable: ${fetchErr.message}${causeMsg}. Mocks are disabled.`);
      }
    }

    if (!readinessRes || !readinessRes.ok) {
      capabilities.backendCheck = 'FAIL';
      throw new Error(`READINESS_FAILED: Readiness check returned HTTP ${readinessRes ? readinessRes.status : 'No Response'}`);
    }

    const readinessData = await readinessRes.json();

    backendIdentity = readinessData.backendIdentity || readinessData.identity || (readinessData.pid ? `ghrdp-server-pid-${readinessData.pid}` : (readinessData.status ? 'ghrdp-server-backend' : null));
    const validEnvSha = process.env.SUPREME_LAMP_SHA && process.env.SUPREME_LAMP_SHA !== 'unknown' && process.env.SUPREME_LAMP_SHA !== 'main-zip' ? process.env.SUPREME_LAMP_SHA : null;
    backendCommit = readinessData.sourceCommit || readinessData.commit || validEnvSha;
    readinessServices = readinessData.services || readinessData.dependencyHealth;
    isMockBackend = Boolean(readinessData.isMock);

    if (!backendIdentity) {
      capabilities.backendCheck = 'FAIL';
      throw new Error("READINESS_SCHEMA_INVALID: Missing backend identity in readiness JSON");
    }
    if (!backendCommit) {
      capabilities.backendCheck = 'FAIL';
      throw new Error("READINESS_SCHEMA_INVALID: Missing verifiable source commit in readiness JSON or environment");
    }
    if (!readinessServices) {
      capabilities.backendCheck = 'FAIL';
      throw new Error("READINESS_SCHEMA_INVALID: Missing services or dependencyHealth in readiness JSON");
    }

    if (readinessData.ok === false || (readinessData.status && readinessData.status !== 'ok' && readinessData.status !== 'ready')) {
      capabilities.backendCheck = 'FAIL';
      throw new Error(`READINESS_NOT_READY: Backend reported NOT READY (status: ${readinessData.status}, phase: ${readinessData.phase})`);
    }

    capabilities.backendCheck = isMockBackend ? 'SIMULATED' : 'PASS';
    console.log(`Backend Identity: ${backendIdentity}, Commit: ${backendCommit}, Mock: ${isMockBackend}`);

    if (!chromium) {
      throw new Error('MODULE_NOT_FOUND: Playwright package is not installed');
    }

    // Playwright Dashboard & Web Desktop Verification
    console.log(`Launching browser for Mission Control dashboard check at ${serverUrl}...`);
    try {
      browser = await chromium.launch({ headless: false });
    } catch (launchErr) {
      capabilities.dashboardCheck = 'FAIL';
      capabilities.webDesktopCheck = 'FAIL';
      throw new Error(`HEADED_LAUNCH_FAILED: ${launchErr.message}`);
    }

    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } }
    });
    page = await context.newPage();

    await page.goto(serverUrl, { waitUntil: 'networkidle', timeout: 10000 });

    const bodyContent = await page.textContent('body');
    if (!bodyContent || bodyContent.trim().length === 0) {
      capabilities.dashboardCheck = 'FAIL';
      throw new Error('EMPTY_PAGE: Mission Control page body content empty');
    }

    capabilities.dashboardCheck = isMockBackend ? 'SIMULATED' : 'PASS';

    // Verify explicit Web Desktop element or frame (must NOT pass on generic body or app without web desktop frame/canvas/component)
    const webDesktopFrame = await page.$('#web-desktop-frame');
    const canvas = await page.$('canvas');
    const desktopElem = await page.$('[data-testid="web-desktop"]') || await page.$('#web-desktop') || await page.$('.web-desktop');

    if (webDesktopFrame || canvas || desktopElem) {
      capabilities.webDesktopCheck = isMockBackend ? 'SIMULATED' : 'PASS';
    } else {
      capabilities.webDesktopCheck = 'FAIL';
      throw new Error('WEB_DESKTOP_MISSING: No active remote desktop frame (#web-desktop-frame), canvas, or Web Desktop element found in Mission Control dashboard');
    }

    await page.screenshot({ path: screenshotPath });

    // Native RDP Auto-Login Verification on Windows
    if (process.platform === 'win32') {
      const rdpTarget = process.env.RDP_TARGET;
      if (!rdpTarget) {
        console.log(allowMock ? 'SKIPPED: Explicit RDP_TARGET environment variable not provided (Simulation mode).' : 'BLOCKED: Explicit RDP_TARGET environment variable not provided.');
        capabilities.rdpAutoLoginCheck = allowMock ? 'SKIPPED' : 'BLOCKED';
        if (!allowMock && !failureReason) {
          failureReason = 'MISSING_CONFIG: RDP_TARGET environment variable is required for live RDP auto-login verification on Windows.';
        }
      } else {
        console.log(`Testing Windows native RDP auto-login capability against target ${rdpTarget}...`);
        const mstscPath = 'C:\\Windows\\System32\\mstsc.exe';
        if (!fs.existsSync(mstscPath)) {
          capabilities.rdpAutoLoginCheck = 'FAIL';
          throw new Error('MSTSC_NOT_FOUND: Native mstsc.exe not found at C:\\Windows\\System32\\mstsc.exe');
        }

        const mstscProc = spawn('mstsc.exe', [`/v:${rdpTarget}`, '/w:800', '/h:600'], {
          detached: true,
          stdio: 'ignore'
        });

        await new Promise(r => setTimeout(r, 2000));
        const desktopCaptured = captureDesktopScreenshot(desktopScreenshotPath);
        console.log(`Native desktop screenshot captured: ${desktopCaptured}`);

        try {
          if (mstscProc.pid) process.kill(mstscProc.pid);
        } catch (e) {}

        if (!desktopCaptured) {
          capabilities.rdpAutoLoginCheck = 'FAIL';
          throw new Error('DESKTOP_SCREENSHOT_FAILED: Failed to capture native desktop screenshot after launching mstsc.');
        }

        capabilities.rdpAutoLoginCheck = 'PASS';
      }
    } else {
      capabilities.rdpAutoLoginCheck = 'SKIPPED';
    }

    // Determine overall status
    const values = Object.values(capabilities);
    if (values.includes('FAIL')) {
      overallStatus = 'FAIL';
    } else if (values.includes('BLOCKED')) {
      overallStatus = 'BLOCKED';
    } else if (values.includes('NOT_RUN')) {
      overallStatus = 'FAIL';
      if (!failureReason) failureReason = 'INCOMPLETE_VERIFICATION: One or more required capability checks were not run.';
    } else if (isMockBackend || values.includes('SIMULATED')) {
      if (allowMock) {
        overallStatus = 'SIMULATED';
        if (!failureReason) failureReason = 'SIMULATION_ONLY: Backend or dashboard was mock/simulated.';
      } else {
        overallStatus = 'FAIL';
        failureReason = 'MOCK_DISALLOWED: Simulation mode is not allowed for live acceptance.';
      }
    } else {
      overallStatus = 'PASS';
    }

  } catch (err) {
    if (!failureReason) {
      failureReason = err.message;
    }
    console.error(`Mission Control check result: ${failureReason}`);
    if (overallStatus !== 'BLOCKED') {
      overallStatus = 'FAIL';
    }
  } finally {
    if (page) try { await page.close(); } catch (e) {}
    if (context) try { await context.close(); } catch (e) {}
    if (browser) try { await browser.close(); } catch (e) {}
    if (serverInstance) try { serverInstance.close(); } catch (e) {}

    if (lockAcquired) registryUtils.releaseLock();
    try { registryUtils.unregisterProcess(process.pid); } catch (e) {}

    const results = {
      status: overallStatus,
      runId,
      runAttempt,
      commitSha,
      runnerName,
      serverUrl,
      capabilities,
      isMockBackend,
      backend: {
        identity: backendIdentity,
        sourceCommit: backendCommit,
        services: readinessServices
      },
      timestamps: {
        startTime: new Date(startTime).toISOString(),
        endTime: new Date().toISOString(),
        durationMs: Date.now() - startTime
      },
      evidence: {
        dashboardScreenshot: fs.existsSync(screenshotPath) ? screenshotPath : null,
        nativeDesktopScreenshot: fs.existsSync(desktopScreenshotPath) ? desktopScreenshotPath : null
      },
      failureReason
    };

    fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
    console.log(`Mission Control results saved to: ${resultsPath}`);

    // Exit non-zero for FAIL or BLOCKED, or when simulation is run without ALLOW_MOCK_MISSION_CONTROL=true
    if (overallStatus === 'FAIL' || overallStatus === 'BLOCKED' || (overallStatus === 'SIMULATED' && !allowMock)) {
      process.exit(1);
    }
  }
}

runMissionControlCheck().catch(err => {
  console.error('Fatal error in Mission Control check:', err);
  process.exit(1);
});
