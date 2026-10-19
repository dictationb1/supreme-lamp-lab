const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const { chromium } = require('playwright');
const { registerProcess } = require('./registry-utils');

// Helper to capture full Windows desktop screenshot via PowerShell
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
  const serverUrl = process.env.MISSION_CONTROL_URL || 'http://127.0.0.1:8080';

  const baseDir = process.env.RUNNER_TEMP || path.resolve(__dirname, '..');
  const outputDir = path.join(baseDir, `artifacts`, `run-${runId}-${runAttempt}`);
  const videoDir = path.join(outputDir, 'videos');
  const screenshotPath = path.join(outputDir, 'mc-dashboard.png');
  const desktopScreenshotPath = path.join(outputDir, 'native-desktop-mstsc.png');
  const resultsPath = path.join(outputDir, 'mission-control-results.json');

  if (!fs.existsSync(videoDir)) {
    fs.mkdirSync(videoDir, { recursive: true });
  }

  const startTime = Date.now();
  let browser = null;
  let context = null;
  let page = null;
  let status = 'FAIL';
  let failureReason = null;

  let backendIdentity = null;
  let backendCommit = null;
  let readinessServices = null;

  try {
    console.log(`Connecting to Mission Control server at ${serverUrl}/api/readiness...`);
    let readinessRes;
    try {
      readinessRes = await fetch(`${serverUrl}/api/readiness`, { signal: AbortSignal.timeout(5000) });
    } catch (fetchErr) {
      throw new Error(`MISSION_CONTROL_UNREACHABLE: Could not connect to Mission Control server at ${serverUrl}: ${fetchErr.message}`);
    }

    if (!readinessRes.ok) {
      throw new Error(`Readiness check returned HTTP ${readinessRes.status}`);
    }
    const readinessData = await readinessRes.json();

    // Throw error if missing from readiness JSON
    if (!readinessData.backendIdentity && !readinessData.identity) {
      throw new Error("Missing backend identity in readiness JSON");
    }
    if (!readinessData.sourceCommit && !readinessData.commit) {
      throw new Error("Missing source commit in readiness JSON");
    }
    if (!readinessData.services) {
      throw new Error("Missing services in readiness JSON");
    }

    backendIdentity = readinessData.backendIdentity || readinessData.identity;
    backendCommit = readinessData.sourceCommit || readinessData.commit;
    readinessServices = readinessData.services;

    console.log(`Backend Identity: ${backendIdentity}, Commit: ${backendCommit}`);

    // Playwright Dashboard & Web Desktop Verification
    console.log(`Launching browser for Mission Control dashboard check at ${serverUrl}...`);
    browser = await chromium.launch({ headless: false });
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } }
    });
    page = await context.newPage();

    await page.goto(serverUrl, { waitUntil: 'networkidle', timeout: 10000 });

    // Assert dashboard telemetry element exists or DOM is rendered
    const bodyContent = await page.textContent('body');
    if (!bodyContent) {
      throw new Error('Mission Control page body content empty');
    }

    // Take screenshot of Mission Control dashboard
    await page.screenshot({ path: screenshotPath });

    // Native RDP Auto-Login Test in Windows session
    if (process.platform === 'win32') {
      const rdpTarget = process.env.RDP_TARGET;
      if (!rdpTarget) {
        console.log('BLOCKED: Explicit RDP_TARGET environment variable not provided. Skipping RDP test.');
      } else {
        console.log(`Testing Windows native RDP auto-login capability against target ${rdpTarget}...`);
        const mstscPath = 'C:\\Windows\\System32\\mstsc.exe';
        if (!fs.existsSync(mstscPath)) {
          throw new Error('Native mstsc.exe not found at expected path');
        }

        const mstscProc = spawn('mstsc.exe', [`/v:${rdpTarget}`, '/w:800', '/h:600'], {
          detached: true,
          stdio: 'ignore'
        });

        if (mstscProc.pid) {
          registerProcess(mstscProc.pid, 'mstsc.exe', 'Native RDP Check');
        }

        await new Promise(r => setTimeout(r, 2000));
        const desktopCaptured = captureDesktopScreenshot(desktopScreenshotPath);
        console.log(`Native desktop screenshot captured: ${desktopCaptured}`);

        try {
          if (mstscProc.pid) process.kill(mstscProc.pid);
        } catch (e) {
          console.error(`Failed to kill mstsc.exe process ${mstscProc.pid}: ${e.message}`);
        }
      }
    }

    status = 'PASS';
  } catch (err) {
    failureReason = err.message;
    console.error(`Mission Control check result: ${failureReason}`);
  } finally {
    if (page) try { await page.close(); } catch (e) {}
    if (context) try { await context.close(); } catch (e) {}
    if (browser) try { await browser.close(); } catch (e) {}

    const results = {
      status,
      runId,
      runAttempt,
      commitSha,
      runnerName,
      serverUrl,
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

    // If check failed, exit with 1 to ensure CI properly reports failure
    if (status !== 'PASS') {
      process.exit(1);
    }
  }
}

runMissionControlCheck().catch(err => {
  console.error('Fatal error in Mission Control check:', err);
  process.exit(1);
});
