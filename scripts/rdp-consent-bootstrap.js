#!/usr/bin/env node
'use strict';
// One-time MANUAL RDP-file consent bootstrap (see RUNBOOK.md §2.4).
//
// Windows' April 2026 RDP-file protection shows a one-time educational consent
// dialog the first time a Windows ACCOUNT opens any .rdp file on a device:
//
//   "Opening Remote Desktop Connection"
//   [ ] I understand and allow RDP files to open on this device for my account
//   [ OK ]  (disabled until the box is checked)
//
// The consent is ACCOUNT-LEVEL security consent. This helper therefore never
// accepts it: it only writes a trusted, lab-generated .rdp file (the exact
// same production-launcher shape the lab uses: UTF-8/no-BOM, CRLF, read-back
// validated) and - with --open - hands it to mstsc so the dialog appears for
// the OPERATOR to answer. A human must check the box and press OK.
//
// This helper deliberately does NOT:
//   * click, auto-answer or time out the dialog;
//   * write RdpLaunchConsentAccepted (that would silently automate the
//     account-level consent);
//   * set RedirectionWarningDialogVersion (that disables the protection
//     globally);
//   * touch NLA/TLS/CredSSP policy or any credential.
//
// Usage:
//   node scripts/rdp-consent-bootstrap.js --host <target> [--user slabrdp] [--out <dir>] [--open]
//
// The target must be the address the CURRENT run printed (a SETUP run prints
// it; RUNBOOK §2.4). Placeholders like <server-ip>, loopback and expired
// addresses from previous runs are refused by lib/rdp-target.js.
//
// Prefer the bounded SETUP procedure (`workflow_dispatch` with
// mode=consent-setup) over running this by hand: it prints this exact command
// with a live target, holds the desktop window open for a bounded time and
// records dialog evidence. This helper is the manual fallback.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { writeRdpFile } = require('./mission-control-check');
const { validateTarget } = require('./lib/rdp-target');

const USAGE = 'usage: node scripts/rdp-consent-bootstrap.js --host <ip-or-host> [--user slabrdp] [--out <dir>] [--open]';

function parseArgs(argv) {
  const a = { host: null, user: 'slabrdp', out: null, open: false, errors: [], help: false };
  const needValue = new Set(['--host', '--user', '--out']);
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--open') { a.open = true; continue; }
    if (k === '--help' || k === '-h') { a.help = true; continue; }
    if (needValue.has(k)) {
      const v = argv[++i];
      if (v == null || v === '') { a.errors.push(`${k} needs a value`); continue; }
      if (k === '--host') a.host = v;
      else if (k === '--user') a.user = v;
      else a.out = v;
      continue;
    }
    // An unknown flag used to be ignored silently, so a typo such as
    // --hots 100.79.2.101 produced an .rdp with no target at all while the
    // operator believed it was fine. Refuse instead.
    a.errors.push(`unknown argument ${JSON.stringify(k)}`);
  }
  return a;
}

/** Directory this checkout lives in - printed so the operator can cd to it. */
function checkoutDir() {
  return path.resolve(__dirname, '..');
}

function accountName() {
  const host = process.env.COMPUTERNAME || os.hostname() || '?';
  const user = (process.env.USERNAME || (os.userInfo() && os.userInfo().username) || '?');
  return `${host}\\${user}`;
}

function main() {
  const a = parseArgs(process.argv);
  if (a.help) { console.log(USAGE); return; }
  if (a.errors.length) {
    for (const e of a.errors) console.error(`error: ${e}`);
    console.error(USAGE);
    process.exit(64);
  }
  if (!a.host) {
    console.error('error: --host is required (the address the current run printed; RUNBOOK §2.4)');
    console.error(USAGE);
    process.exit(64);
  }
  const target = validateTarget(a.host);
  if (!target.ok) {
    console.error(`error: --host ${JSON.stringify(a.host)} refused: ${target.error}`);
    console.error('Do not substitute a guess. The SETUP run prints the address of a live target for this attempt.');
    process.exit(64);
  }
  for (const w of target.warnings) console.error(`warning: ${w}`);

  const outDir = a.out || path.join(os.tmpdir(), 'slab-rdp-consent');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'slab-consent-bootstrap.rdp');
  let info;
  try {
    info = writeRdpFile(file, target.host, a.user);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(70);
  }
  const account = accountName();
  console.log(`lab-generated RDP file: ${file} (${info.bytes} bytes, ${info.directives} directives, UTF-8/CRLF, read-back validated)`);
  console.log(`target: ${target.host} (${target.kind})  user: ${a.user}`);
  console.log(`checkout: ${checkoutDir()}`);
  console.log(`current account: ${account}${process.env.SESSIONNAME ? `  session: ${process.env.SESSIONNAME}` : ''}`);
  console.log('');
  console.log('MANUAL BOOTSTRAP (one-time, per Windows account on this device):');
  console.log('  1. You must be signed in AS the account that runs the client runner');
  console.log(`     (this process reports: ${account}). The consent is per-account; a different account needs its own.`);
  console.log('  2. Open the file with mstsc (this script does it when you pass --open):');
  console.log(`       mstsc.exe "${file}"`);
  console.log('  3. In the "Opening Remote Desktop Connection" dialog, CHECK');
  console.log('     "I understand and allow RDP files to open on this device for my account",');
  console.log('     then press OK. OK is disabled until the box is checked - that is the blocker.');
  console.log('  4. If a per-connection "Remote Desktop Connection Security warning" appears for');
  console.log('     the unsigned .rdp file, that is a SEPARATE protection: read it, and report it');
  console.log('     if it blocks the unattended run (it is not the account consent).');
  console.log('');
  console.log('Confirm the setup action finished: the dialog disappears and mstsc continues to a');
  console.log('connection attempt (a credentials/connection result, not the checkbox dialog).');
  console.log('Cancel closes the dialog exactly like OK, so "the dialog went away" alone is not proof;');
  console.log('the proof is the next FULL unattended run completing with no manual clicks.');
  console.log('');
  console.log('This helper never answers the dialog for you and changes no security settings.');

  if (!a.open) return;
  if (process.platform !== 'win32') {
    console.error('--open requires Windows (mstsc.exe)');
    process.exit(69);
  }
  const mstsc = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'mstsc.exe');
  if (!fs.existsSync(mstsc)) {
    console.error(`mstsc.exe not found at ${mstsc}`);
    process.exit(69);
  }
  console.log(`\nlaunching: ${mstsc} "${file}" (answer the dialog yourself)`);
  const child = spawn(mstsc, [file], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  console.log(`mstsc pid=${child.pid} started; this helper exits without touching the dialog.`);
}

if (require.main === module) main();
module.exports = { parseArgs, checkoutDir, accountName };
