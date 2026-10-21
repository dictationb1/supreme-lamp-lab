#!/usr/bin/env node
'use strict';
// BOUNDED SETUP PROCEDURE - deliberately NOT a verification run.
//
//   node scripts/rdp-consent-setup.js --host <live-target> [--user slabrdp]
//        [--timeout-ms 600000] [--poll-ms 5000] [--out <dir>] [--no-launch] [--keep-open]
//
// Why this exists
// ---------------
// The verification run now recognises the one-time RDP-file consent dialog on
// its first poll and cleans up immediately (correct for an unattended run, but
// it gives a human roughly no time to act). This script is the separate,
// bounded window in which the operator can answer the dialog:
//
//   * it prints the real Windows account, session, checkout directory and the
//     exact command;
//   * it writes the SAME production-shaped .rdp the lab under test uses and
//     hands it to mstsc (the production launch path is preserved - this is not
//     a substitute launch method);
//   * it only READS dialog state (Get-RdpDialogState.ps1 -> lib/dialogs.js) and
//     takes screenshots; it never clicks, never answers the checkbox, never
//     writes RdpLaunchConsentAccepted, never sets RedirectionWarningDialogVersion,
//     never touches NLA/TLS/CredSSP or any credential;
//   * it ends at a bounded deadline and reports one of the SETUP_* states from
//     lib/consent-state.js.
//
// It produces NO capability verdicts and can never make anything VERIFIED.
// A manually assisted session is not unattended proof; the fresh full run is.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { validateTarget } = require('./lib/rdp-target');
const { evaluateSamples, EXIT } = require('./lib/consent-state');
const { classifyRdpAttempt } = require('./lib/dialogs');
const { writeRdpFile } = require('./mission-control-check');
const psLib = require('./lib/ps');
const proc = require('./lib/proc');
const annotate = require('./lib/annotate');
const { artifactDir } = require('./lib/results');

const USAGE = 'usage: node scripts/rdp-consent-setup.js --host <live-target> [--user slabrdp] [--timeout-ms 600000] [--poll-ms 5000] [--out <dir>] [--no-launch] [--keep-open]';

const PS_DIR = path.join(__dirname, 'ps');
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 15 * 60 * 1000;

function parseArgs(argv) {
  const a = {
    host: null, user: 'slabrdp', out: null, timeoutMs: DEFAULT_TIMEOUT_MS,
    pollMs: 5000, launch: true, keepOpen: false, errors: [], help: false
  };
  const numbered = { '--timeout-ms': 'timeoutMs', '--poll-ms': 'pollMs' };
  const valued = new Set(['--host', '--user', '--out', ...Object.keys(numbered)]);
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--no-launch') { a.launch = false; continue; }
    if (k === '--keep-open') { a.keepOpen = true; continue; }
    if (k === '--help' || k === '-h') { a.help = true; continue; }
    if (valued.has(k)) {
      const v = argv[++i];
      if (v == null || v === '') { a.errors.push(`${k} needs a value`); continue; }
      if (numbered[k]) {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) { a.errors.push(`${k} must be a positive number of milliseconds`); continue; }
        a[numbered[k]] = n;
      } else if (k === '--host') a.host = v;
      else if (k === '--user') a.user = v;
      else a.out = v;
      continue;
    }
    a.errors.push(`unknown argument ${JSON.stringify(k)}`);
  }
  if (a.timeoutMs > MAX_TIMEOUT_MS) {
    a.errors.push(`--timeout-ms ${a.timeoutMs} exceeds the bounded maximum ${MAX_TIMEOUT_MS} (15 min); the lab does not start indefinite hosted jobs`);
  }
  if (a.pollMs < 500) a.errors.push('--poll-ms must be at least 500');
  return a;
}

async function runPs(script, args, { timeoutMs = 60000, operation = script } = {}) {
  const r = await psLib.runPowerShell({
    script: path.join(PS_DIR, script), args, timeoutMs, operation, site: `rdp-consent-setup.js:${operation}`
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (!r.ok) return { code: r.errorCode === 'POWERSHELL_TIMEOUT' ? 124 : 125, out: `${r.errorCode}: ${out || r.errorMessage}` };
  return { code: 0, out };
}

function parseJsonLoose(text) {
  const s = String(text || '');
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(s.slice(i, j + 1)); } catch (e) { return null; }
}

function accountName() {
  const host = process.env.COMPUTERNAME || os.hostname() || '?';
  const user = process.env.USERNAME || (os.userInfo() && os.userInfo().username) || '?';
  return `${host}\\${user}`;
}

function printHeader(target, user, file, account) {
  console.log('');
  console.log('================ SETUP - NOT A VERIFICATION RUN ================');
  console.log(`account        : ${account}${process.env.SESSIONNAME ? `  (${process.env.SESSIONNAME})` : ''}`);
  console.log(`checkout       : ${path.resolve(__dirname, '..')}`);
  console.log(`target         : ${target.host} (${target.kind})`);
  console.log(`rdp file       : ${file}`);
  console.log(`user directive : ${user}`);
  console.log('----------------------------------------------------------------');
  console.log('What to do now, on this desktop:');
  console.log('  1. Wait for the window "Opening Remote Desktop Connection".');
  console.log('  2. CHECK  "I understand and allow RDP files to open on this device for my account".');
  console.log('  3. Press OK (it is disabled until the box is checked).');
  console.log('  4. Leave this window open; it reports what it saw and exits at its deadline.');
  console.log('This procedure never clicks the dialog and changes no security settings.');
  console.log('================================================================');
  console.log('');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { console.log(USAGE); return 0; }
  if (args.errors.length) {
    for (const e of args.errors) console.error(`error: ${e}`);
    console.error(USAGE);
    return EXIT.USAGE;
  }
  if (!args.host) {
    console.error(`error: --host is required\n${USAGE}`);
    return EXIT.USAGE;
  }
  const target = validateTarget(args.host);
  if (!target.ok) {
    console.error(`error: --host ${JSON.stringify(args.host)} refused: ${target.error}`);
    return EXIT.USAGE;
  }
  for (const w of target.warnings) console.error(`warning: ${w}`);

  if (process.platform !== 'win32') {
    console.error('error: the consent setup procedure must run on the Windows client runner (interactive session); mstsc.exe is required');
    return EXIT.NOT_WINDOWS;
  }

  const outDir = args.out || artifactDir();
  fs.mkdirSync(outDir, { recursive: true });
  const rdpFile = path.join(outDir, 'slab-consent-setup.rdp');
  let fileInfo;
  try {
    fileInfo = writeRdpFile(rdpFile, target.host, args.user);
  } catch (e) {
    console.error(`error: ${e.message}`);
    return EXIT.USAGE;
  }
  const account = accountName();
  printHeader(target, args.user, rdpFile, account);
  annotate.notice('SETUP consent bootstrap', `account=${account} target=${target.host} file=${rdpFile} (${fileInfo.bytes}B/${fileInfo.directives} directives)`);

  const mstscExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'mstsc.exe');
  let mstsc = null;
  if (args.launch) {
    if (!fs.existsSync(mstscExe)) {
      console.error(`error: mstsc.exe not found at ${mstscExe}`);
      return EXIT.NOT_WINDOWS;
    }
    const child = spawn(mstscExe, [rdpFile], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    await new Promise(res => setTimeout(res, 1500));
    const live = await proc.getProcessAsync(child.pid, { timeoutMs: 20000, operation: 'setup-mstsc-identity' }).catch(() => null);
    if (live) {
      mstsc = { pid: live.pid, createTime: live.createTime };
      console.log(`mstsc started: pid=${mstsc.pid}`);
    } else {
      console.error('error: mstsc exited immediately after launch - the .rdp file or the target is unusable');
      return EXIT.NO_DIALOG;
    }
  } else {
    console.log('--no-launch: the .rdp file above was written but mstsc was not started.');
  }

  const samples = [];
  const deadline = Date.now() + args.timeoutMs;
  let state = evaluateSamples(samples, { mstscAlive: Boolean(mstsc) });
  let dialogScreenshot = null;

  while (mstsc && Date.now() < deadline) {
    const ds = await runPs('Get-RdpDialogState.ps1', ['-ProcessId', String(mstsc.pid)], { operation: 'setup-dialog-state', timeoutMs: 60000 });
    const dlg = parseJsonLoose(ds.out);
    const rows = (dlg && dlg.windows) || [];
    const cls = classifyRdpAttempt({ windows: rows, account, sessionId: dlg && dlg.sessionId });
    const aliveP = await proc.getProcessAsync(mstsc.pid, { timeoutMs: 15000, operation: 'setup-mstsc-liveness' }).catch(() => null);
    const alive = Boolean(aliveP && aliveP.createTime === mstsc.createTime);
    const sample = {
      at: new Date().toISOString(),
      kind: cls.kind || null,
      code: cls.code || null,
      blocking: Boolean(cls.blocking),
      processAlive: alive,
      evidenceDigest: String(cls.evidenceDigest || '').slice(0, 600),
      parseError: ds.code === 0 ? null : ds.out.slice(0, 200)
    };
    samples.push(sample);
    console.log(`[${sample.at}] kind=${sample.kind || 'none'}${sample.code ? ` code=${sample.code}` : ''} mstscAlive=${alive}`);
    if (sample.kind) console.log(`    evidence: ${sample.evidenceDigest.slice(0, 300)}`);
    annotate.notice('SETUP dialog sample', `${sample.kind || 'none'}${sample.code ? ` (${sample.code})` : ''} mstscAlive=${alive} ${sample.evidenceDigest}`.slice(0, 500));

    // One sanitized screenshot the first time the consent dialog is seen -
    // captured during the procedure, before any cleanup.
    if (cls.kind === 'rdp_file_consent' && !dialogScreenshot) {
      dialogScreenshot = path.join(outDir, 'setup-consent-dialog.png');
      const cap = await runPs('Capture-Desktop.ps1', ['-Path', dialogScreenshot], { operation: 'setup-consent-capture', timeoutMs: 30000 });
      console.log(`    screenshot: ${cap.out || dialogScreenshot}`);
      annotate.notice('SETUP consent screenshot', cap.out || dialogScreenshot);
    }

    state = evaluateSamples(samples, { mstscAlive: alive });
    if (state.done || state.state === 'CONSENT_DIALOG_CLEARED' || state.state === 'CONSENT_DIALOG_CLOSED_UNCONFIRMED') break;
    if (!alive) break;
    await new Promise(res => setTimeout(res, args.pollMs));
  }

  state = evaluateSamples(samples, { mstscAlive: Boolean(mstsc) && samples.length > 0 && samples[samples.length - 1].processAlive });
  if (state.state === 'AWAITING_SAMPLES' && samples.length === 0) {
    state = {
      state: 'NO_SAMPLES', exitCode: EXIT.NO_DIALOG, done: false,
      message: 'No dialog sample could be collected (the enumerator returned nothing).',
      detail: 'Treat the consent state as unknown; inspect the screenshots and the helper output.'
    };
  }

  const result = {
    mode: 'SETUP',
    note: 'SETUP procedure only - this is not a verification run and produces no capability verdict',
    startedAtUtc: samples.length ? samples[0].at : null,
    finishedAtUtc: new Date().toISOString(),
    account, target: target.host, targetKind: target.kind, user: args.user,
    checkout: path.resolve(__dirname, '..'),
    rdpFile: { path: rdpFile, bytes: fileInfo.bytes, directives: fileInfo.directives },
    mstscPid: mstsc ? mstsc.pid : null,
    samples: samples.map(s => ({ at: s.at, kind: s.kind, code: s.code, blocking: s.blocking, processAlive: s.processAlive, evidenceDigest: s.evidenceDigest })),
    state: state.state, exitCode: state.exitCode, message: state.message, detail: state.detail,
    dialogScreenshot
  };
  const jsonPath = path.join(outDir, 'setup-consent.json');
  try { fs.writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`); } catch (e) { /* artifact only */ }

  console.log('');
  console.log(`SETUP RESULT: ${state.state}`);
  console.log(`  ${state.message}`);
  console.log(`  ${state.detail}`);
  console.log(`  evidence: ${jsonPath}${dialogScreenshot ? ` + ${dialogScreenshot}` : ''}`);
  if (state.state === 'CONSENT_DIALOG_CLEARED' || state.state === 'SESSION_CONNECTED') {
    console.log('');
    console.log('Next: run the full verification (workflow_dispatch, mode=full). It must complete with');
    console.log('NO manual clicks and NO credential entry. Only that run can be VERIFIED.');
  }
  console.log('This procedure produced no verification verdict.');
  annotate.notice('SETUP result', `${state.state}: ${state.message}`.slice(0, 480));

  // Identity-verified close of the mstsc WE launched; never a blind pid kill and
  // never an unrelated window. --keep-open leaves it for the operator.
  if (mstsc && !args.keepOpen) {
    const p = await proc.getProcessAsync(mstsc.pid, { timeoutMs: 15000, operation: 'setup-cleanup-identity' }).catch(() => null);
    if (p && p.createTime === mstsc.createTime) {
      proc.terminate(p.pid);
      console.log(`closed the mstsc this procedure launched (pid=${p.pid})`);
    }
  }
  return state.exitCode;
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(e => {
    console.error(`error: ${e && e.message ? e.message : e}`);
    process.exit(70);
  });
}
module.exports = { parseArgs, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS };
