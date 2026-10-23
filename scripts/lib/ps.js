'use strict';
// Bounded, asynchronous PowerShell helper runner.
//
// Why this module exists
// ----------------------
// Run 39548093609 attempt 2 failed the server job with
//     SUPERVISOR_ERROR: spawnSync powershell.exe ETIMEDOUT
// from scripts/lib/proc.js, which used execFileSync() with a 30s timeout to
// query process identity. execFileSync blocks the event loop, so while it ran:
//   * the overall startup deadline could not be enforced,
//   * backend liveness/readiness could not be checked,
//   * stdout/stderr of the helper were lost from the supervisor record,
//   * a slow diagnostic query was indistinguishable from a dead backend.
// A diagnostic timeout aborted startup verification and killed a backend that
// had in fact started (see backend-supervisor.js phase ordering).
//
// Contract of every call made through this module
// ----------------------------------------------
//   * asynchronous: spawn(), never execFileSync/execSync;
//   * explicit noninteractive PowerShell flags, executable resolved once and
//     reported (pwsh.exe vs powershell.exe is a deliberate, recorded choice);
//   * bounded: per-operation timeout clamped to the caller's remaining budget;
//   * lossless enough to diagnose: stdout, stderr, exit code, signal,
//     error.code, elapsed time, operation name and the JS call site are kept
//     even when the call times out;
//   * killable: a timed-out helper is terminated (no orphan stragglers), and
//     cancellation is observable through the returned promise.
//
// Test hook: LAB_PS_EXE + LAB_PS_ARGV_PREFIX (JSON array) replace the resolved
// executable and prepend arguments. Regression tests use it to inject a
// deliberately hanging helper on every platform.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { redact } = require('./redact');

const IS_WIN = process.platform === 'win32';
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_CAPTURE = 256 * 1024;
// PowerShell flags that make a helper incapable of prompting or reading stdin.
const BASE_FLAGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

const KILL_GRACE_MS = 2000;

/** "scripts/lib/proc.js:190 (listener-verify)" for a caller `depth` frames up. */
function callSite(depth = 3) {
  const old = Error.stackTraceLimit;
  Error.stackTraceLimit = depth + 4;
  const stack = String(new Error().stack || '').split('\n');
  Error.stackTraceLimit = old;
  // frame 0 = "Error", 1 = callSite, 2 = the caller we want by default
  const frame = stack[depth] || stack[stack.length - 1] || '';
  const m = frame.match(/\((.*?)\)\s*$/) || frame.match(/at\s+(.*)$/);
  const where = m ? m[1] : frame.trim().replace(/^at\s+/, '');
  const rel = where.replace(/^.*supreme-lamp-lab[\\/]/, '').replace(/\\/g, '/');
  return rel.replace(/^file:\/\//, '');
}

function whichSync(exe) {
  const exts = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map(s => s.toLowerCase()) : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = path.join(dir, exe + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch (e) { /* keep looking */ }
    }
  }
  return null;
}

let resolved = null;

/**
 * Resolve the PowerShell executable once.
 * On Windows we prefer pwsh.exe (PowerShell 7) when it is on PATH, because the
 * backend itself is launched with pwsh.exe when available; using the same
 * interpreter removes a class of "works with one, hangs with the other"
 * ambiguity. Whatever is chosen is recorded and reported.
 * Returns { exe, prefixArgs, source, isPwsh, found }.
 */
function resolvePowerShell(env) {
  const e = env || process.env;
  // An explicit per-call override is never cached: regression tests inject a
  // different helper for a single call.
  if (env && env !== process.env && (env.LAB_PS_EXE || env.LAB_PS_MODE !== process.env.LAB_PS_MODE)) {
    return resolveFrom(e);
  }
  if (resolved) return resolved;
  resolved = resolveFrom(e);
  return resolved;
}

function resolveFrom(e) {
  if (e.LAB_PS_EXE) {
    let prefixArgs = [];
    try { prefixArgs = JSON.parse(e.LAB_PS_ARGV_PREFIX || '[]'); } catch (err) { prefixArgs = []; }
    return { exe: e.LAB_PS_EXE, prefixArgs, source: 'LAB_PS_EXE', isPwsh: false, found: true };
  }
  const mode = e.LAB_PS_MODE || '';
  if (IS_WIN) {
    const pwshBin = mode === 'powershell' ? null : whichSync('pwsh');
    if (pwshBin) return { exe: pwshBin, prefixArgs: [], source: 'PATH:pwsh.exe', isPwsh: true, found: true };
    const legacy = whichSync('powershell');
    return { exe: legacy || 'powershell.exe', prefixArgs: [], source: legacy ? 'PATH:powershell.exe' : 'fallback:powershell.exe', isPwsh: false, found: Boolean(legacy) };
  }
  const pwshBin = whichSync('pwsh');
  return { exe: pwshBin || 'pwsh', prefixArgs: [], source: pwshBin ? 'PATH:pwsh' : 'fallback:pwsh', isPwsh: true, found: Boolean(pwshBin) };
}

function resetResolvedForTests() { resolved = null; }

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

function tail(s, n) {
  const t = String(s || '');
  return t.length > n ? `…(${t.length - n} chars dropped)…${t.slice(-n)}` : t;
}

/**
 * Run a PowerShell script file with a hard deadline.
 *
 * runPowerShell({ script, args, timeoutMs, deadlineAt, operation, env, cwd, site })
 *   script      absolute path to a .ps1 (falls back to a command when omitted)
 *   args        array of string arguments appended after -File <script>
 *   timeoutMs   per-operation budget (default 20s)
 *   deadlineAt  absolute Date.now() bound of the enclosing operation; the
 *               effective timeout is clamped to the remaining budget
 *   operation   short name used in diagnostics
 *   site        override for the reported call site
 *
 * Never rejects: a failed call is a resolved value with ok=false so a caller
 * can record evidence instead of losing the process state to an exception.
 */
function runPowerShell(opts = {}) {
  const started = Date.now();
  const childEnv = { ...process.env, ...(opts.env || {}) };
  const ps = resolvePowerShell(opts.env ? childEnv : undefined);
  const timeoutMs = clamp(Number(opts.timeoutMs || DEFAULT_TIMEOUT_MS), 250, 600000);
  const operation = opts.operation || 'powershell';
  const site = opts.site || callSite(3);
  const requested = opts.args ? opts.args.map(String) : [];
  const fullArgv = opts.script
    ? [...ps.prefixArgs, ...BASE_FLAGS, '-File', opts.script, ...requested]
    : [...ps.prefixArgs, ...BASE_FLAGS, ...requested];

  const base = {
    ok: false, operation, callSite: site, exe: ps.exe, exeSource: ps.source,
    args: fullArgv.map(a => redact(a)).join(' '), requestedArgs: requested.map(a => redact(a)),
    timeoutMs, effectiveTimeoutMs: timeoutMs, startedAt: new Date(started).toISOString(),
    stdout: '', stderr: '', code: null, signal: null, timedOut: false, cancelled: false,
    errorCode: null, errorMessage: null, elapsedMs: 0, budgetClamped: false
  };

  // Respect the enclosing budget: never start a helper we cannot afford to wait
  // for, and never let it outlive the overall deadline.
  let effective = timeoutMs;
  if (opts.deadlineAt) {
    const remaining = Number(opts.deadlineAt) - started;
    if (!Number.isFinite(remaining) || remaining <= 0) {
      return Promise.resolve({ ...base, errorCode: 'BUDGET_EXHAUSTED', errorMessage: `no time left for ${operation} (enclosing deadline already reached)`, elapsedMs: Date.now() - started, stdout: '', stderr: '' });
    }
    if (remaining < effective) { base.budgetClamped = true; effective = Math.max(250, Math.floor(remaining)); }
  }
  base.effectiveTimeoutMs = effective;

  return new Promise(resolve => {
    let child;
    try {
      child = spawn(ps.exe, fullArgv, {
        cwd: opts.cwd || process.cwd(),
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (err) {
      return resolve({ ...base, errorCode: 'POWERSHELL_SPAWN_FAILED', errorMessage: err.message, elapsedMs: Date.now() - started });
    }

    const out = []; const errOut = [];
    let outLen = 0; let errLen = 0;
    let settled = false;
    let killer = null;

    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killer) clearTimeout(killer);
      resolve({
        ...base,
        stdout: Buffer.concat(out).toString('utf8').slice(0, MAX_CAPTURE),
        stderr: Buffer.concat(errOut).toString('utf8').slice(0, MAX_CAPTURE),
        truncated: outLen > MAX_CAPTURE || errLen > MAX_CAPTURE,
        elapsedMs: Date.now() - started,
        ...extra
      });
    };

    const timer = setTimeout(() => {
      base.timedOut = true;
      try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
      // The child is a PowerShell helper we started: pid-scoped kill only, never
      // a name-wide kill. Give it a moment to be reaped, then resolve anyway so
      // a wedged handle cannot re-create the original hang.
      killer = setTimeout(() => finish({ errorCode: 'POWERSHELL_TIMEOUT', errorMessage: `timed out after ${effective}ms` }), KILL_GRACE_MS);
    }, effective);

    child.stdout.on('data', d => { outLen += d.length; if (outLen <= MAX_CAPTURE) out.push(d); });
    child.stderr.on('data', d => { errLen += d.length; if (errLen <= MAX_CAPTURE) errOut.push(d); });
    child.on('error', e => finish({ errorCode: 'POWERSHELL_SPAWN_FAILED', errorMessage: `${e.code || ''} ${e.message}`.trim() }));
    child.on('close', (code, signal) => {
      if (base.timedOut) {
        finish({ code, signal, errorCode: 'POWERSHELL_TIMEOUT', errorMessage: `timed out after ${effective}ms (killed, signal=${signal})` });
      } else if (code === 0) {
        finish({ ok: true, code, signal });
      } else {
        finish({ code, signal, errorCode: 'POWERSHELL_EXIT_NONZERO', errorMessage: `exit=${code} signal=${signal}` });
      }
    });
  });
}

/** One-line, sanitized description suitable for an annotation or a report. */
function describe(result, { maxDetail = 600 } = {}) {
  if (!result) return 'no result';
  const bits = [
    `${result.errorCode || 'OK'}`,
    `op=${result.operation}`,
    `site=${result.callSite}`,
    `exe=${result.exe}`,
    `elapsed=${result.elapsedMs}ms/${result.effectiveTimeoutMs}ms`,
    result.code !== null ? `exit=${result.code}` : null,
    result.signal ? `signal=${result.signal}` : null
  ].filter(Boolean);
  const err = tail((result.stderr || '').trim(), Math.max(120, maxDetail - bits.join(' ').length - 40));
  const out = tail((result.stdout || '').trim(), 200);
  return `${bits.join(' ')}${err ? ` stderr=${JSON.stringify(err)}` : ''}${out ? ` stdout=${JSON.stringify(out)}` : ''}`;
}

module.exports = {
  IS_WIN, DEFAULT_TIMEOUT_MS, BASE_FLAGS,
  resolvePowerShell, resetResolvedForTests, runPowerShell, describe, callSite, tail
};
