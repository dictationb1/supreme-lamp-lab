const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function getRegistryPath() {
  if (process.env.REGISTRY_PATH) {
    return path.resolve(process.env.REGISTRY_PATH);
  }
  const baseDir = process.env.RUNNER_TOOL_CACHE || process.env.TEMP || path.resolve(__dirname, '..');
  return path.join(baseDir, 'lab-process-registry.json');
}

function getLockDir() {
  if (process.env.LOCK_DIR) {
    return path.resolve(process.env.LOCK_DIR);
  }
  const baseDir = process.env.RUNNER_TOOL_CACHE || process.env.TEMP || path.resolve(__dirname, '..');
  return path.join(baseDir, 'lab-lock.lock');
}

function getProcessCreationTime(pid) {
  if (!pid || isNaN(pid)) return null;
  try {
    if (process.platform === 'win32') {
      const cmd = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { try { $p.StartTime.ToString('o') } catch { $c = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction SilentlyContinue; if ($c -and $c.CreationDate) { $c.CreationDate.ToString('o') } } }"`;
      const out = execSync(cmd, { stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000 }).toString().trim();
      return out || null;
    } else {
      const out = execSync(`ps -p ${pid} -o lstart=`, { stdio: ['pipe', 'pipe', 'ignore'], timeout: 3000 }).toString().trim();
      if (!out) return null;
      return new Date(out).toISOString();
    }
  } catch (err) {
    return null;
  }
}

function readRegistryFile(regPath = getRegistryPath()) {
  if (!fs.existsSync(regPath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(regPath, 'utf8').replace(/^\uFEFF/, '').trim();
    if (!raw) return [];
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) {
      throw new Error(`Registry content is not an array: ${typeof data}`);
    }
    return data;
  } catch (err) {
    console.warn(`[REGISTRY_WARN] Failed to parse registry file at ${regPath}: ${err.message}`);
    const corruptPath = `${regPath}.corrupt.${Date.now()}`;
    try { fs.copyFileSync(regPath, corruptPath); } catch (e) {}
    throw new Error(`REGISTRY_CORRUPT: Failed to parse registry file at ${regPath}. Backup saved to ${corruptPath}. Error: ${err.message}`);
  }
}

function writeRegistryFile(records, regPath = getRegistryPath()) {
  if (!Array.isArray(records)) {
    throw new Error('Registry records must be an Array');
  }
  const dir = path.dirname(regPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const jsonContent = JSON.stringify(records, null, 2);
  const tmpPath = `${regPath}.tmp.${Date.now()}.${Math.random().toString(36).substring(2, 8)}`;

  fs.writeFileSync(tmpPath, jsonContent, { encoding: 'utf8' });
  try {
    fs.renameSync(tmpPath, regPath);
  } catch (err) {
    fs.copyFileSync(tmpPath, regPath);
    fs.unlinkSync(tmpPath);
  }
}

function registerProcess({ pid, processName, exePath, runId, runAttempt, regPath = getRegistryPath() }) {
  if (!pid) throw new Error('PID is required to register process');
  const createTime = getProcessCreationTime(pid);
  if (!createTime) {
    throw new Error(`Cannot register process PID ${pid}: Process not running or creation time unavailable.`);
  }

  const currentRunId = runId || process.env.GITHUB_RUN_ID || 'local-run';
  const currentRunAttempt = runAttempt || process.env.GITHUB_RUN_ATTEMPT || '1';
  const owner = process.env.USERNAME || process.env.USER || 'unknown';

  const record = {
    runId: String(currentRunId),
    runAttempt: String(currentRunAttempt),
    pid: Number(pid),
    processName: processName || 'unknown',
    createTime,
    exePath: exePath || '',
    owner,
    registeredAt: new Date().toISOString()
  };

  const registry = readRegistryFile(regPath);
  const filtered = registry.filter(r => r.pid !== Number(pid));
  filtered.push(record);
  writeRegistryFile(filtered, regPath);
  return record;
}

function unregisterProcess(pid, regPath = getRegistryPath()) {
  const registry = readRegistryFile(regPath);
  const filtered = registry.filter(r => r.pid !== Number(pid));
  writeRegistryFile(filtered, regPath);
}

function isProcessAlive(pid, expectedCreateTime) {
  if (!pid) return false;
  const currentCreateTime = getProcessCreationTime(pid);
  if (!currentCreateTime) return false;
  if (!expectedCreateTime) return true;

  const t1 = new Date(currentCreateTime).getTime();
  const t2 = new Date(expectedCreateTime).getTime();
  return Math.abs(t1 - t2) < 2000;
}

function acquireLock({ runId, runAttempt, timeoutMs = 5000, retryIntervalMs = 250, lockDir = getLockDir() } = {}) {
  const currentRunId = String(runId || process.env.GITHUB_RUN_ID || 'local-run');
  const currentRunAttempt = String(runAttempt || process.env.GITHUB_RUN_ATTEMPT || '1');
  const pid = process.pid;
  const createTime = getProcessCreationTime(pid);
  const startTime = Date.now();

  const metaPath = path.join(lockDir, 'lock-meta.json');

  while (true) {
    if (!fs.existsSync(lockDir)) {
      try {
        fs.mkdirSync(lockDir, { recursive: true });
        const meta = {
          runId: currentRunId,
          runAttempt: currentRunAttempt,
          pid,
          createTime,
          acquiredAt: new Date().toISOString()
        };
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
        return { lockDir, meta };
      } catch (err) {
        // Concurrent creation collision, loop and retry
      }
    } else {
      let lockMeta = null;
      try {
        if (fs.existsSync(metaPath)) {
          lockMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        }
      } catch (e) {}

      if (lockMeta) {
        if (lockMeta.pid === pid && lockMeta.runId === currentRunId) {
          return { lockDir, meta: lockMeta };
        }

        const ownerAlive = isProcessAlive(lockMeta.pid, lockMeta.createTime);
        if (!ownerAlive) {
          console.warn(`[LOCK_RECOVERY] Lock owner process PID ${lockMeta.pid} (Run ${lockMeta.runId}) is dead. Recovering stale lock.`);
          try {
            fs.rmSync(lockDir, { recursive: true, force: true });
            continue;
          } catch (e) {}
        }
      }

      if (Date.now() - startTime >= timeoutMs) {
        const holderInfo = lockMeta ? `Run ${lockMeta.runId} (PID ${lockMeta.pid})` : 'Unknown Process';
        throw new Error(`LOCK_ACQUISITION_FAILED: Timed out waiting for lock held by ${holderInfo} after ${timeoutMs}ms.`);
      }

      const sleepEnd = Date.now() + retryIntervalMs;
      while (Date.now() < sleepEnd) {}
    }
  }
}

function releaseLock(lockDir = getLockDir()) {
  const metaPath = path.join(lockDir, 'lock-meta.json');
  if (fs.existsSync(lockDir)) {
    try {
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (meta.pid === process.pid) {
          fs.rmSync(lockDir, { recursive: true, force: true });
        }
      } else {
        fs.rmSync(lockDir, { recursive: true, force: true });
      }
    } catch (e) {}
  }
}

module.exports = {
  getRegistryPath,
  getLockDir,
  getProcessCreationTime,
  readRegistryFile,
  writeRegistryFile,
  registerProcess,
  unregisterProcess,
  isProcessAlive,
  acquireLock,
  releaseLock
};
