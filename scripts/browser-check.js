const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function runBrowserCheck() {
  const outputDir = path.resolve(__dirname, '../artifacts');
  const videoDir = path.join(outputDir, 'videos');
  const screenshotPath = path.join(outputDir, 'screenshot.png');

  if (!fs.existsSync(videoDir)) {
    fs.mkdirSync(videoDir, { recursive: true });
  }

  console.log('Launching browser for capability check...');

  // Try launching Chromium (headed if interactive, or headless with video recording)
  let browser;
  try {
    browser = await chromium.launch({ headless: false });
  } catch (err) {
    console.log('Headed launch failed, falling back to headless chromium:', err.message);
    browser = await chromium.launch({ headless: true });
  }

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: {
      dir: videoDir,
      size: { width: 1280, height: 720 }
    }
  });

  const page = await context.newPage();
  console.log('Navigating to test page...');
  await page.goto('https://example.com', { waitUntil: 'networkidle' });

  // Take screenshot
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`Screenshot saved to: ${screenshotPath}`);

  // Short wait so video records interaction
  await page.waitForTimeout(3000);

  await page.close();
  await context.close();
  await browser.close();

  console.log(`Video recorded in directory: ${videoDir}`);
  console.log('Browser check completed successfully.');
}

runBrowserCheck().catch((error) => {
  console.error('Browser check failed:', error);
  process.exit(1);
});
