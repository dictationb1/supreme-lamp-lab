const http = require('http');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { registerProcess } = require('./registry-utils');

function startLocalServer(port = 0) {
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Supreme Lamp Lab Test Page</title>
    <style>
        body { font-family: sans-serif; margin: 40px; background: #f0f4f8; color: #102a43; }
        #status { font-weight: bold; font-size: 1.2em; color: #243b53; }
        #output { padding: 10px; background: #d9e2ec; border-radius: 4px; margin-top: 10px; }
        button { padding: 8px 16px; font-size: 1em; cursor: pointer; }
    </style>
</head>
<body>
    <h1>Supreme Lamp Lab - Capability Verification</h1>
    <p id="status">Status: Ready</p>
    <button id="action-btn">Run Interaction Test</button>
    <div id="output">Initial</div>

    <script>
        document.getElementById('action-btn').addEventListener('click', () => {
            document.getElementById('output').innerText = 'Interaction Successful - Lab Verified';
            document.getElementById('status').innerText = 'Status: Verified';
        });
    </script>
</body>
</html>`;

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(htmlContent);
  });

  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      console.log(`Local test server listening at http://127.0.0.1:${actualPort}`);
      resolve({ server, url: `http://127.0.0.1:${actualPort}` });
    });
    server.on('error', reject);
  });
}

async function runBrowserCheck() {
  const runId = process.env.GITHUB_RUN_ID || 'local-run';
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT || '1';
  const commitSha = process.env.GITHUB_SHA || 'local-sha';
  const runnerName = process.env.RUNNER_NAME || process.env.COMPUTERNAME || 'local-runner';

  const baseDir = process.env.RUNNER_TEMP || path.resolve(__dirname, '..');
  const outputDir = path.join(baseDir, `artifacts`, `run-${runId}-${runAttempt}`);
  const videoDir = path.join(outputDir, 'videos');
  const screenshotPath = path.join(outputDir, 'screenshot.png');
  const resultsPath = path.join(outputDir, 'results.json');

  if (!fs.existsSync(videoDir)) {
    fs.mkdirSync(videoDir, { recursive: true });
  }

  const startTime = Date.now();
  const consoleErrors = [];
  const pageErrors = [];

  let serverInstance = null;
  let browser = null;
  let context = null;
  let page = null;
  let testStatus = 'FAIL';
  let failureReason = null;

  try {
    const { server, url } = await startLocalServer(0);
    serverInstance = server;
    registerProcess(process.pid, process.execPath, 'Browser Check Local Server');

    console.log('Launching browser in HEADED mode for interactive capability check...');
    // Interactive profile strictly requires headed mode. Do not fall back to headless.
    try {
      browser = await chromium.launch({ headless: false });
    } catch (launchErr) {
      console.error('Headed browser launch failed! Interactive profile requires headed browser desktop session.', launchErr);
      failureReason = `HEADED_LAUNCH_FAILED: ${launchErr.message}`;
      throw new Error(failureReason);
    }

    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: {
        dir: videoDir,
        size: { width: 1280, height: 720 }
      }
    });

    page = await context.newPage();

    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    page.on('pageerror', err => {
      pageErrors.push(err.message);
    });

    console.log(`Navigating to local test page: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 10000 });

    // Assert initial state
    const initialText = await page.textContent('#output');
    if (initialText.trim() !== 'Initial') {
      throw new Error(`Unexpected initial state: "${initialText}"`);
    }

    // Perform interaction
    console.log('Clicking action button...');
    await page.click('#action-btn');

    // Assert updated state
    await page.waitForFunction(() => {
      return document.getElementById('output').innerText === 'Interaction Successful - Lab Verified';
    }, { timeout: 5000 });

    const updatedText = await page.textContent('#output');
    console.log(`DOM assertion passed: "${updatedText}"`);

    // Capture screenshot
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`Screenshot saved to: ${screenshotPath}`);

    // Wait 1 second so video records final state
    await page.waitForTimeout(1000);

    testStatus = 'PASS';
  } catch (err) {
    if (!failureReason) {
      failureReason = err.message;
    }
    console.error(`Browser capability check failed: ${failureReason}`);
  } finally {
    const endTime = Date.now();
    const durationMs = endTime - startTime;

    // Gracefully close Playwright objects to flush video file
    if (page) {
      try { await page.close(); } catch (e) {}
    }
    if (context) {
      try { await context.close(); } catch (e) {}
    }
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
    if (serverInstance) {
      try { serverInstance.close(); } catch (e) {}
    }

    // Find recorded video file
    let videoFile = null;
    if (fs.existsSync(videoDir)) {
      const files = fs.readdirSync(videoDir);
      const webmFile = files.find(f => f.endsWith('.webm'));
      if (webmFile) {
        videoFile = path.join(videoDir, webmFile);
      }
    }

    const resultsData = {
      status: testStatus,
      runId,
      runAttempt,
      commitSha,
      runnerName,
      browserMode: 'headed',
      toolVersions: {
        node: process.version,
        playwright: require('playwright/package.json').version
      },
      timestamps: {
        startTime: new Date(startTime).toISOString(),
        endTime: new Date(endTime).toISOString(),
        durationMs
      },
      evidence: {
        screenshotExists: fs.existsSync(screenshotPath),
        screenshotPath: fs.existsSync(screenshotPath) ? screenshotPath : null,
        videoExists: Boolean(videoFile && fs.existsSync(videoFile)),
        videoPath: videoFile
      },
      errors: {
        failureReason,
        consoleErrors,
        pageErrors
      }
    };

    fs.writeFileSync(resultsPath, JSON.stringify(resultsData, null, 2));
    console.log(`Structured results saved to: ${resultsPath}`);

    if (testStatus !== 'PASS') {
      process.exit(1);
    }
  }
}

runBrowserCheck().catch(err => {
  console.error('Fatal error in browser check:', err);
  process.exit(1);
});
