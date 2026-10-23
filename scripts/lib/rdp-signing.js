'use strict';
// RDP FILE SIGNING — the supported path out of the per-connection
// "Remote Desktop Connection security warning" (Publisher: Unknown publisher).
//
// OBSERVED (lab run 39819073772, job `client`, mstsc pid 3820, session 1):
//   the RDP-file security review appeared for every unsigned .rdp the lab
//   wrote, with both "Don't ask me again" boxes unchecked. Accepting the
//   one-time consent does not help: the review is per connection and keyed to
//   the SIGNING IDENTITY of the file, not to a user acknowledgement.
//
// SUPPORTED PATH (Microsoft Learn: "RDP file security in Group Policy"):
//   sign each final .rdp with a dedicated code-signing certificate, and pin that
//   certificate's thumbprint in
//     Computer Configuration > Administrative Templates > Windows Components >
//     Remote Desktop Services > Remote Desktop Connection Client >
//     "Specify thumbprints of certificates representing trusted .rdp publishers"
//   The identity + policy are created and proven by
//   scripts/ps/Initialize-RdpFileSigning.ps1 (Status/Bootstrap/Probe/Sign/Rollback).
//
// WHAT THIS MODULE WILL NOT DO
//   * trust all publishers, or clear the trusted list;
//   * set RedirectionWarningDialogVersion (the stopgap that DISABLES the
//     protection instead of satisfying it);
//   * weaken NLA/TLS/CredSSP or certificate verification;
//   * launch an unsigned file while claiming the review is handled. When a
//     signing identity IS configured and signing fails, the caller must fail
//     with a named reason instead of proceeding.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_STATE_DIR_WIN = 'C:\\ProgramData\\slab-rdp-signing';
const SCRIPT_REL = path.join('scripts', 'ps', 'Initialize-RdpFileSigning.ps1');

/** Uppercase hex, 40 (SHA-1) or 64 (SHA-256); anything else is invalid. */
function normalizeThumbprint(value) {
  const hex = String(value == null ? '' : value).replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  return hex;
}

function isValidThumbprint(value) {
  const hex = normalizeThumbprint(value);
  return hex.length === 40 || hex.length === 64;
}

function thumbprintAlgorithm(value) {
  const hex = normalizeThumbprint(value);
  if (hex.length === 40) return 'SHA1';
  if (hex.length === 64) return 'SHA256';
  return null;
}

/**
 * The exact registry entry mstsc compares against: the ADMX `valuePrefix` (if
 * the build requires one) followed by the normalized thumbprint.
 */
function policyEntry(thumbprint, valuePrefix = '') {
  if (!isValidThumbprint(thumbprint)) throw new Error(`INVALID_THUMBPRINT: ${JSON.stringify(thumbprint)}`);
  return `${valuePrefix || ''}${normalizeThumbprint(thumbprint)}`;
}

function stateDir(opts = {}) {
  return opts.stateDir || process.env.SLAB_RDP_SIGNING_DIR ||
    (process.platform === 'win32' ? DEFAULT_STATE_DIR_WIN : path.join(os.homedir(), '.slab-rdp-signing'));
}

/** Identity recorded by `-Mode Bootstrap`, or null. Never throws. */
function readIdentity(opts = {}) {
  const file = path.join(stateDir(opts), 'identity.json');
  try {
    // Windows PowerShell 5.1's Set-Content -Encoding UTF8 writes a BOM. A BOM
    // makes JSON.parse throw, which is exactly how a signed, bootstrapped VM was
    // reported as "no recorded identity" (capability run 39878430507).
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const rec = JSON.parse(raw);
    if (!rec || !isValidThumbprint(rec.thumbprint)) return null;
    return {
      thumbprint: normalizeThumbprint(rec.thumbprint),
      algorithm: thumbprintAlgorithm(rec.thumbprint),
      subject: rec.subject || null,
      notAfter: rec.notAfter || null,
      policyKey: rec.policyKey || null,
      policyValue: rec.policyValue || null,
      computer: rec.computer || null,
      createdAt: rec.createdAt || null,
      rollback: rec.rollback || null,
      source: file
    };
  } catch (e) { return null; }
}

/**
 * Is a signing identity available for the launcher?
 *   configured=false -> the caller records the fact and expects the Windows
 *                       security review (never a silent claim that it is handled)
 *   configured=true  -> signing is REQUIRED for the launch; failure is a FAIL
 */
function resolveSigningIdentity(opts = {}) {
  const explicit = opts.thumbprint || process.env.RDP_SIGN_THUMBPRINT || '';
  if (explicit) {
    if (!isValidThumbprint(explicit)) {
      return { configured: false, error: `INVALID_THUMBPRINT: ${JSON.stringify(explicit)}`, source: 'env:RDP_SIGN_THUMBPRINT' };
    }
    return { configured: true, thumbprint: normalizeThumbprint(explicit), algorithm: thumbprintAlgorithm(explicit), source: 'env:RDP_SIGN_THUMBPRINT' };
  }
  const rec = readIdentity(opts);
  if (rec) return { configured: true, ...rec, source: rec.source };
  return { configured: false, source: null };
}

function signerScriptPath(root) {
  return path.join(root || path.join(__dirname, '..', '..'), SCRIPT_REL);
}

/** Extract the single JSON object the script prints on its last line. */
function parseScriptJson(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.startsWith('{')) continue;
    try { return JSON.parse(l); } catch (e) { /* keep looking */ }
  }
  return null;
}

/**
 * Sign one final .rdp file and verify its Authenticode signature.
 * Windows only; returns a result object, never throws.
 */
function signRdpFile(file, opts = {}) {
  const ident = opts.thumbprint ? { configured: true, thumbprint: normalizeThumbprint(opts.thumbprint) } : resolveSigningIdentity(opts);
  if (!ident.configured) {
    return { ok: false, code: 'NO_SIGNING_IDENTITY', detail: ident.error || 'no recorded signing identity (run Initialize-RdpFileSigning.ps1 -Mode Bootstrap)' };
  }
  if (process.platform !== 'win32' && !opts.force) {
    return { ok: false, code: 'PLATFORM_NOT_WINDOWS', detail: 'rdpsign.exe/Authenticode verification need Windows' };
  }
  const script = signerScriptPath(opts.root);
  if (!fs.existsSync(script)) return { ok: false, code: 'SIGNER_SCRIPT_MISSING', detail: script };
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-Mode', 'Sign', '-File', file, '-Thumbprint', ident.thumbprint
    ], { encoding: 'utf8', timeout: opts.timeoutMs || 60000, windowsHide: true });
    const parsed = parseScriptJson(out);
    if (!parsed) return { ok: false, code: 'SIGNER_OUTPUT_UNPARSEABLE', detail: String(out).slice(0, 200) };
    return {
      ok: parsed.ok === true,
      code: parsed.code || (parsed.ok ? 'SIGNED_VALID' : 'SIGN_OR_VERIFY_FAILED'),
      status: parsed.signature ? parsed.signature.status : null,
      signer: parsed.signature ? parsed.signature.signer : null,
      hashAlg: parsed.signature ? parsed.signature.hashAlg : null,
      thumbprint: ident.thumbprint,
      detail: String(parsed.detail || '').slice(0, 200)
    };
  } catch (e) {
    return { ok: false, code: 'SIGNER_EXEC_FAILED', detail: String(e.message || e).slice(0, 200) };
  }
}

/**
 * A short, sanitized statement of the signing posture for reports and
 * annotations. Contains no key material: a thumbprint is a public identifier.
 */
function describePosture(ident) {
  if (!ident || !ident.configured) {
    return {
      signed: false,
      code: 'RDP_FILE_SIGNING_NOT_CONFIGURED',
      detail: 'no dedicated signing identity on this client; the per-connection RDP-file security review is expected and the launch is NOT unattended'
    };
  }
  return {
    signed: true,
    code: 'RDP_FILE_SIGNING_CONFIGURED',
    thumbprint: ident.thumbprint,
    algorithm: ident.algorithm || thumbprintAlgorithm(ident.thumbprint),
    subject: ident.subject || null,
    notAfter: ident.notAfter || null,
    detail: 'each final .rdp is signed with the dedicated lab identity and the trust is pinned to that thumbprint'
  };
}

/** Deterministic fingerprint for logs: never the certificate itself. */
function identityFingerprint(thumbprint) {
  return crypto.createHash('sha256').update(normalizeThumbprint(thumbprint)).digest('hex').slice(0, 16);
}

module.exports = {
  DEFAULT_STATE_DIR_WIN,
  SCRIPT_REL,
  normalizeThumbprint,
  isValidThumbprint,
  thumbprintAlgorithm,
  policyEntry,
  stateDir,
  readIdentity,
  resolveSigningIdentity,
  signRdpFile,
  signerScriptPath,
  parseScriptJson,
  describePosture,
  identityFingerprint
};
