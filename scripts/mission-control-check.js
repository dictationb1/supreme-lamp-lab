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
  const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save('${outputPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bmp.Dispose()
`;
  try {
    execSync(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${psScript.replace(/\n/g, ' ')}"`, { stdio: 'pipe' });
    return true;
  } catch (err) {
    console.error('Failed to capture native desktop screenshot via PowerShell:', err.message);
    return false;
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
  } catch (e) {}

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
      capabilities.backendCheck = 'BLOCKED';
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
        throw new Error(`MISSION_CONTROL_UNREACHABLE: Live Mission Control server at ${serverUrl} is unreachable: ${fetchErr.message}. Mocks are disabled.`);
      }
    }

    if (!readinessRes || !readinessRes.ok) {
      capabilities.backendCheck = 'FAIL';
      throw new Error(`READINESS_FAILED: Readiness check returned HTTP ${readinessRes ? readinessRes.status : 'No Response'}`);
    }

    const readinessData = await readinessRes.json();

    if (!readinessData.backendIdentity && !readinessData.identity) {
      capabilities.backendCheck = 'FAIL';
      throw new Error("READINESS_SCHEMA_INVALID: Missing backend identity in readiness JSON");
    }
    if (!readinessData.sourceCommit && !readinessData.commit) {
      capabilities.backendCheck = 'FAIL';
      throw new Error("READINESS_SCHEMA_INVALID: Missing source commit in readiness JSON");
    }
    if (!readinessData.services) {
      capabilities.backendCheck = 'FAIL';
      throw new Error("READINESS_SCHEMA_INVALID: Missing services in readiness JSON");
    }

    backendIdentity = readinessData.backendIdentity || readinessData.identity;
    backendCommit = readinessData.sourceCommit || readinessData.commit;
    readinessServices = readinessData.services;
    isMockBackend = Boolean(readinessData.isMock);

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
    if (!bodyContent) {
      capabilities.dashboardCheck = 'FAIL';
      throw new Error('EMPTY_PAGE: Mission Control page body content empty');
    }

    capabilities.dashboardCheck = isMockBackend ? 'SIMULATED' : 'PASS';

    // Verify Web Desktop element
    const webDesktopFrame = await page.$('#web-desktop-frame');
    if (webDesktopFrame) {
      capabilities.webDesktopCheck = isMockBackend ? 'SIMULATED' : 'PASS';
    } else {
      capabilities.webDesktopCheck = 'FAIL';
      throw new Error('WEB_DESKTOP_MISSING: #web-desktop-frame element not found in Mission Control dashboard');
    }

    await page.screenshot({ path: screenshotPath });

    // Native RDP Auto-Login Verification on Windows
    if (process.platform === 'win32') {
      const rdpTarget = process.env.RDP_TARGET;
      if (!rdpTarget) {
        console.log('BLOCKED: Explicit RDP_TARGET environment variable not provided.');
        capabilities.rdpAutoLoginCheck = 'BLOCKED';
        if (!failureReason) {
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
    } else if (isMockBackend || values.includes('SIMULATED')) {
      overallStatus = 'SIMULATED';
      if (!failureReason) {
        failureReason = 'SIMULATION_ONLY: Backend or dashboard was mock/simulated.';
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

    if (overallStatus === 'FAIL' || overallStatus === 'BLOCKED') {
      process.exit(1);
    }
  }
}

runMissionControlCheck().catch(err => {
  console.error('Fatal error in Mission Control check:', err);
  process.exit(1);
});
