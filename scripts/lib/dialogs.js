'use strict';
// Pure classification of the Windows dialog evidence captured during an RDP
// attempt (scripts/ps/Get-RdpDialogState.ps1 / Get-RdpClientDiagnostics.ps1).
// Dependency-free and exported so scripts/run-regressions.js can pin every
// branch against recorded shapes from live runs.
//
// Why this exists (run 39575343527 attempt 2): mstsc sat for the whole 90s
// window behind the one-time RDP-file consent dialog ("Opening Remote Desktop
// Connection" / "I understand and allow RDP files to open on this device for
// my account", April 2026 cumulative update, CVE-2026-26151). The verdict
// burned the full budget on a generic RDP_LOGON_NOT_OBSERVED timeout while a
// KNOWN blocking dialog was on screen. One probe (Get-Process's
// MainWindowHandle heuristic) even reported hasWindow=false for the same
// mstsc that another probe saw hosting the dialog: MainWindowHandle only
// tracks an unowned top-level "main window", so an owned/modal dialog is
// invisible to it. Process liveness, main-window state and connection
// progress are three different facts; only window enumeration scoped to the
// launched process tree in the right session finds the dialog.
//
// Windows RDP-file dialog families (April 2026 protection, CVE-2026-26151):
//   rdp_file_consent         - the one-time, per-account educational consent:
//                              heading "Opening Remote Desktop Connection",
//                              checkbox "I understand and allow RDP files to
//                              open on this device for my account", OK
//                              disabled until checked. Account-level security
//                              consent: a human must grant it once per
//                              Windows account on that device. The lab NEVER
//                              clicks it, never writes RdpLaunchConsentAccepted
//                              and never suppresses it.
//   rdp_file_security_review - the per-connection review of an opened .rdp
//                              file ("Remote Desktop Connection Security
//                              warning", "Caution: Unknown remote connection"
//                              / "Verify the publisher of this remote
//                              connection", resource redirection checkboxes).
//   certificate_warning      - the classic TLS identity prompt ("The identity
//                              of the remote computer cannot be verified").
//   credentials_prompt       - Windows Security / CredentialUIBroker /
//                              LogonUI credential collection.
//   connection_error         - a Remote Desktop connection/authentication
//                              failure dialog (error codes, "can't connect").

const DIALOG_PRIORITY = [
  'rdp_file_consent',
  'rdp_file_security_review',
  'credentials_prompt',
  'certificate_warning',
  'connection_error',
  'unknown'
];

const TEXT_RULES = [
  {
    kind: 'rdp_file_consent',
    test: t => /allow\s+RDP\s+files\s+to\s+open/i.test(t) ||
      (/opening\s+(an\s+)?RDP\s+file/i.test(t) && /opening\s+Remote\s+Desktop\s+Connection/i.test(t)) ||
      (/Opening Remote Desktop Connection/i.test(t) && /RDP file/i.test(t))
  },
  {
    kind: 'rdp_file_security_review',
    test: t => /Caution:\s*Unknown remote connection/i.test(t) ||
      /Verify the publisher of this remote connection/i.test(t) ||
      /Remote Desktop Connection Security warning/i.test(t) ||
      (/publisher/i.test(t) && /remote connection/i.test(t) && /connect/i.test(t))
  },
  {
    kind: 'credentials_prompt',
    test: t => /enter your credentials/i.test(t) || /windows security/i.test(t) ||
      /type your password/i.test(t) || /password/i.test(t) && /user\s*name/i.test(t)
  },
  {
    kind: 'certificate_warning',
    test: t => /identity of the remote computer cannot be verified/i.test(t) ||
      /can't verify the identity/i.test(t) || /cannot be verified/i.test(t) ||
      /remote computer that/i.test(t) && /certificate/i.test(t) ||
      /\bcertificate\b/i.test(t) && /verify|verification|warning/i.test(t)
  },
  {
    kind: 'connection_error',
    test: t => /can't connect|cannot connect|could not connect|failed to connect/i.test(t) ||
      /error code:?\s*0x[0-9a-f]+/i.test(t) || /internal error/i.test(t) ||
      /connection was (lost|closed|interrupted)/i.test(t) ||
      /remote desktop can't find/i.test(t) || /the logon attempt failed/i.test(t) ||
      /authentication failed/i.test(t)
  }
];

const DIALOG_HOSTS = new Set(['logonui', 'credentialuibroker', 'consent']);

/**
 * A window is dialog-like when it is a dialog class, an owned/modal window,
 * or hosted by a system credential/consent process. A plain unowned mstsc
 * top-level window is the session/start surface, not a dialog.
 */
function looksLikeDialog(row) {
  if (!row) return false;
  const cls = String(row.className || '');
  if (cls === '#32770') return true;
  if (row.ownerPid != null && row.ownerPid !== row.pid) return true;
  if (row.ownerHwnd != null && row.ownerHwnd !== 0 && row.ownerHwnd !== row.hwnd) return true;
  return DIALOG_HOSTS.has(String(row.process || '').toLowerCase());
}

/** Combine one window's title + control texts into a classification. */
function classifyWindowRow(row) {
  const texts = [];
  if (row && row.title) texts.push(String(row.title));
  if (row && Array.isArray(row.controls)) {
    for (const c of row.controls) if (c && c.text) texts.push(String(c.text));
  }
  const joined = texts.join('\n');
  for (const rule of TEXT_RULES) {
    if (rule.test(joined)) {
      return { kind: rule.kind, matchedText: texts.find(t => rule.test(String(t))) || row && row.title || '' };
    }
  }
  // A live RDP session window ("<host> - Remote Desktop Connection") is the
  // connection surface, not a dialog - keep the distinction visible.
  if (row && /^[^\s].*\s-\sRemote Desktop Connection$/i.test(String(row.title || ''))) {
    return { kind: 'connected_session', matchedText: row.title };
  }
  // Process-identity fallback: a credential broker is a credentials prompt
  // even when its texts are sparse.
  const procName = String((row && row.process) || '').toLowerCase();
  if (DIALOG_HOSTS.has(procName)) {
    return { kind: 'credentials_prompt', matchedText: row && row.title || procName };
  }
  return { kind: 'unknown', matchedText: '' };
}

/**
 * Classify a set of enumerated windows (the lab-launched process tree, the
 * right session). Returns the highest-priority BLOCKING dialog kind plus
 * everything seen; non-dialog surfaces (e.g. a connected session window) are
 * recorded but never block.
 */
function classifyWindowRows(rows) {
  const seen = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const c = classifyWindowRow(row);
    seen.push({
      kind: c.kind,
      dialogLike: looksLikeDialog(row),
      pid: row && row.pid != null ? row.pid : null,
      process: row && row.process ? String(row.process) : '',
      sessionId: row && row.sessionId != null ? row.sessionId : null,
      title: String((row && row.title) || '').slice(0, 120),
      ownerPid: row && row.ownerPid != null ? row.ownerPid : null,
      matchedText: String(c.matchedText || '').slice(0, 160),
      controlStates: (row && Array.isArray(row.controls) ? row.controls : [])
        .map(x => (x && x.state ? String(x.state) : '')).filter(Boolean).slice(0, 6)
    });
  }
  const candidates = seen.filter(s =>
    (s.kind !== 'unknown' && s.kind !== 'connected_session') || (s.kind === 'unknown' && s.dialogLike));
  const kind = DIALOG_PRIORITY.find(k => candidates.some(s => s.kind === k)) || null;
  return { kind, seen };
}

/**
 * Outcome for an RDP attempt in which enumerated dialog windows were
 * captured. `account` is the Windows account that runs the client runner
 * (the account that must hold the consent). `consentGranted` (optional) is
 * only informational - the lab never reads or writes the consent store; a
 * visible consent dialog is the ground truth that consent is missing.
 */
function classifyRdpAttempt({ windows, account, sessionId } = {}) {
  const { kind, seen } = classifyWindowRows(windows);
  const evidenceDigest = seen.length
    ? seen.map(w => `${w.process}(${w.pid}${w.ownerPid != null ? ` owner=${w.ownerPid}` : ''} sess=${w.sessionId}):${JSON.stringify(w.title)}${w.matchedText ? ` [${w.matchedText.slice(0, 90)}]` : ''}${w.controlStates && w.controlStates.length ? ` {${w.controlStates.join(',')}}` : ''}`).join(' | ')
    : 'no relevant windows enumerated';
  const base = { kind, windows: seen, evidenceDigest };
  if (!kind) return { ...base, blocking: false, status: null, code: null, reason: null, manualAction: null };
  if (kind === 'rdp_file_consent') {
    const acct = account || 'the account running the client runner';
    const sess = sessionId != null ? ` (session ${sessionId})` : '';
    return {
      ...base,
      blocking: true,
      status: 'BLOCKED',
      code: 'RDP_FILE_CONSENT_REQUIRED',
      reason:
        `RDP_FILE_CONSENT_REQUIRED: the one-time RDP-file consent dialog is open and ungranted for ${acct}${sess}: ` +
        '"Opening Remote Desktop Connection" / "I understand and allow RDP files to open on this device for my account". ' +
        'This is an account-level Windows security consent (April 2026 RDP-file protection); the lab never clicks it for you.',
      manualAction:
        `On the Windows client runner, signed in as ${acct}${sess}: open a trusted lab-generated .rdp file once ` +
        '(node scripts/rdp-consent-bootstrap.js --host <server-ip> --user slabrdp --open), check ' +
        '"I understand and allow RDP files to open on this device for my account", and press OK. ' +
        'The consent is per-account and per-device - it must be repeated if a different Windows account runs the client runner. ' +
        'Do not automate this checkbox, do not write RdpLaunchConsentAccepted, and do not disable the warning globally.'
    };
  }
  if (kind === 'unknown') {
    // An unidentified dialog-like surface is evidence, not a classification:
    // never fabricate a verdict for it. It is kept in the digest and the
    // attempt's outcome falls through to the evidence-based logon result.
    return {
      ...base,
      blocking: false,
      status: null,
      code: 'RDP_UNCLASSIFIED_DIALOG_VISIBLE',
      reason: null,
      manualAction: 'Inspect the sanitized window evidence (process, title, control texts) captured during the attempt.'
    };
  }
  const byKind = {
    rdp_file_security_review: {
      status: 'FAIL',
      code: 'RDP_FILE_SECURITY_REVIEW_BLOCKING',
      reason: 'RDP_FILE_SECURITY_REVIEW_BLOCKING: the per-connection "Remote Desktop Connection Security warning" (publisher/redirection review for the opened .rdp file) is on screen; the unattended launch is blocked by Windows\' RDP-file protection, not by the lab.',
      manualAction: 'Review the dialog on the client runner desktop. This per-connection review is a Windows security feature for .rdp files; the lab does not suppress it (no RedirectionWarningDialogVersion policy, no silent acceptance).'
    },
    credentials_prompt: {
      status: 'FAIL',
      code: 'RDP_CREDENTIALS_PROMPT_UNATTENDED',
      reason: 'RDP_CREDENTIALS_PROMPT_UNATTENDED: a credential prompt (Windows Security / CredentialUIBroker / LogonUI) is on screen; the stored TERMSRV credential contract was not honoured.',
      manualAction: 'Check the TERMSRV/<host> credential written by Set-RdpCredential.ps1 and the client policies that force prompts (DisablePasswordSaving / fPromptForPassword).'
    },
    certificate_warning: {
      status: 'FAIL',
      code: 'RDP_CERT_WARNING_BLOCKING',
      reason: 'RDP_CERT_WARNING_BLOCKING: a server-certificate warning dialog is on screen ("identity of the remote computer cannot be verified"); the attempt did not proceed unattended.',
      manualAction: 'The lab .rdp pins authentication level 0 for the ephemeral self-signed target only; NLA/TLS are not weakened. If this dialog appears, capture it and treat it as a lab misconfiguration to fix, never as a pass.'
    },
    connection_error: {
      status: 'FAIL',
      code: 'RDP_CONNECTION_ERROR_DIALOG',
      reason: 'RDP_CONNECTION_ERROR_DIALOG: a Remote Desktop connection/authentication error dialog is on screen.',
      manualAction: 'Read the dialog text captured in the evidence (error code, authentication failure) and correlate with the server-side 4624/4625 ground truth.'
    }
  };
  const m = byKind[kind];
  return { ...base, blocking: true, status: m.status, code: m.code, reason: m.reason, manualAction: m.manualAction };
}

module.exports = { DIALOG_PRIORITY, classifyWindowRow, classifyWindowRows, classifyRdpAttempt };
