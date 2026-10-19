const fs = require('fs');
const path = require('path');
const os = require('os');

const registryDir = path.join(os.tmpdir(), 'supreme-lamp-lab-registry');
const registryPath = path.join(registryDir, 'lab-registry.json');

function registerProcess(pid, execPath, identity) {
  if (!fs.existsSync(registryDir)) fs.mkdirSync(registryDir, { recursive: true });

  const lockPath = registryPath + '.lock';
  const maxRetries = 30;
  let attempts = 0;
  let acquired = false;

  while (attempts < maxRetries) {
    try {
      fs.mkdirSync(lockPath);
      acquired = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > 300000) {
          console.warn("Stale lock detected. Overriding.");
          fs.rmdirSync(lockPath);
          continue;
        }
      } catch (err) {}
      attempts++;
      require('child_process').execSync('powershell -NoProfile -Command "Start-Sleep -Seconds 1"', { stdio: 'ignore' });
    }
  }

  if (!acquired) {
    console.error("Failed to acquire registry lock after 30 attempts.");
    return;
  }

  try {
    let registry = [];
    if (fs.existsSync(registryPath)) {
      try { registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')); } catch (e) {}
    }
    const runId = process.env.GITHUB_RUN_ID || 'local-run';
    const runAttempt = process.env.GITHUB_RUN_ATTEMPT || '1';
    let creationTime = Date.now();
    try {
      if (process.platform === 'win32') {
        const psCmd = `powershell -NoProfile -Command "$proc = Get-Process -Id ${pid} -ErrorAction Stop; [int][double]::Parse((Get-Date $proc.StartTime -UFormat %s)) * 1000"`;
        const psOutput = require('child_process').execSync(psCmd, { encoding: 'utf8' });
        const ms = parseInt(psOutput.trim(), 10);
        if (!isNaN(ms)) {
            creationTime = ms;
        }
      }
    } catch (e) {
      console.error("Could not determine exact creation time from OS, falling back to spawn time.");
    }
    registry.push({ runId, runAttempt, pid, creationTime, execPath, identity });
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
  } finally {
    fs.rmdirSync(lockPath);
  }
}

module.exports = { registerProcess };
