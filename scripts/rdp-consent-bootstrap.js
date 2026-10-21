#!/usr/bin/env node
'use strict';
// One-time MANUAL RDP-file consent bootstrap (see RUNBOOK.md §2.4).
//
// Windows' April 2026 RDP-file protection (CVE-2026-26151) shows a one-time
// educational consent dialog the first time a Windows ACCOUNT opens any .rdp
// file on a device:
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
//   node scripts/rdp-consent-bootstrap.js --host <server-ip> --user slabrdp [--out <dir>] [--open]
//
// Run it ON the client-runner machine, AS the account that runs the client
// runner (the identity printed in the "Client runner" annotation and by
// Set-RdpCredential.ps1, e.g. WIN-NFU1JG4VESE\User). After the operator has
// answered the dialog, verify with a fresh full workflow run: no manual
// clicks and no credential entry are allowed in that run.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { writeRdpFile } = require('./mission-control-check');

function parseArgs(argv) {
  const a = { host: null, user: 'slabrdp', out: null, open: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--host') a.host = argv[++i];
    else if (k === '--user') a.user = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--open') a.open = true;
  }
  return a;
}

function main() {
  const a = parseArgs(process.argv);
  if (!a.host) {
    console.error('usage: node scripts/rdp-consent-bootstrap.js --host <server-ip-or-name> [--user slabrdp] [--out <dir>] [--open]');
    process.exit(64);
  }
  const outDir = a.out || path.join(os.tmpdir(), 'slab-rdp-consent');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'slab-consent-bootstrap.rdp');
  const info = writeRdpFile(file, a.host, a.user);
  const account = `${process.env.COMPUTERNAME || os.hostname()}\\${process.env.USERNAME || (os.userInfo() && os.userInfo().username) || '?'}`;
  console.log(`lab-generated RDP file: ${file} (${info.bytes} bytes, ${info.directives} directives, UTF-8/CRLF, read-back validated)`);
  console.log(`current account: ${account}`);
  console.log('');
  console.log('MANUAL BOOTSTRAP (one-time, per Windows account on this device):');
  console.log('  1. Make sure you are running this AS the account that runs the client runner');
  console.log(`     (here: ${account}). The consent is per-account - a different account needs its own.`);
  console.log(`  2. Open the file above with mstsc (this script will do it with --open):`);
  console.log(`       mstsc.exe "${file}"`);
  console.log('  3. In the "Opening Remote Desktop Connection" dialog, CHECK');
  console.log('     "I understand and allow RDP files to open on this device for my account",');
  console.log('     then press OK. (OK is disabled until the box is checked - that is the blocker.)');
  console.log('  4. If a per-connection "Remote Desktop Connection Security warning" appears for');
  console.log('     the unsigned .rdp file, read it and close it. It is a separate, per-connection');
  console.log('     Windows protection; the lab reports it by name if it blocks an unattended run.');
  console.log('');
  console.log('This helper never answers the dialog for you and changes no security settings.');
  console.log('Afterwards, trigger a fresh FULL verification run - it must complete with no manual');
  console.log('clicks and no credential entry before anything is reported as VERIFIED.');

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
module.exports = { parseArgs };
