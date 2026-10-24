'use strict';
// Pure state machine for the bounded SETUP procedure (scripts/rdp-consent-setup.js).
//
// The setup procedure exists because the *verification* run cannot wait: it now
// recognises the consent dialog on its first poll and cleans up immediately
// (that is the correct behaviour for an unattended run - RUNBOOK §2.4). So the
// operator needs a separate, clearly-labelled, bounded window in which the file
// is opened and left on screen for them to answer.
//
// This module only READS dialog samples and says what is on screen. It never
// clicks, never calls SendMessage/BM_SETCHECK, never writes the consent store
// and never concludes that consent persists.
//
// What the states are allowed to claim
// ------------------------------------
//   PENDING_CONSENT          the consent checkbox dialog is visible now.
//   CONSENT_DIALOG_CLEARED   the consent dialog was visible and is now gone
//                            for `requiredClears` consecutive samples. This is
//                            NOT proof of consent on its own: Cancel closes the
//                            same dialog. It only means "the operator answered
//                            something"; the fresh unattended run is the proof.
//   SESSION_CONNECTED        an RDP session window for the launched tree is on
//                            screen - the file got past the consent gate.
//   BLOCKED_*                a DIFFERENT dialog family is blocking; named
//                            separately from consent (publisher review,
//                            certificate warning, credentials, connection error).
//   NO_DIALOG_SEEN           no dialog in the whole window. Ambiguous: consent
//                            may already be granted, OR mstsc never got far
//                            enough to show one. Never treated as consent.
//   AWAITING_SAMPLES         not enough evidence yet (internal).
//
// Dependency-free and exported so scripts/run-regressions.js can pin every
// branch without Windows.

const EXIT = {
  OK: 0,
  USAGE: 64,
  NOT_WINDOWS: 69,
  BLOCKED: 4,
  NO_DIALOG: 5,
  UNCONFIRMED: 7
};

const BLOCKING_STATES = {
  rdp_file_security_review: {
    state: 'BLOCKED_SECURITY_REVIEW',
    exitCode: EXIT.BLOCKED,
    message: 'A per-connection "Remote Desktop Connection Security warning" (publisher/redirection review) is on screen. ' +
      'That is a DIFFERENT Windows protection from the account consent you just answered, and it can recur on every .rdp-file launch. ' +
      'It is not something this lab suppresses (no RedirectionTrust / RedirectionWarningDialogVersion policy, no silent acceptance).'
  },
  certificate_warning: {
    state: 'BLOCKED_CERTIFICATE_WARNING',
    exitCode: EXIT.BLOCKED,
    message: 'A server-certificate warning is on screen ("the identity of the remote computer cannot be verified"). ' +
      'The lab .rdp requires authentication level 2. A certificate/consent dialog is a blocker to report; do not click through it or weaken NLA/TLS for a pass.'
  },
  credentials_prompt: {
    state: 'BLOCKED_CREDENTIALS_PROMPT',
    exitCode: EXIT.BLOCKED,
    message: 'A credential prompt (Windows Security / CredentialUIBroker / LogonUI) is on screen. ' +
      'The unattended run must connect with the stored TERMSRV credential; a prompt here is a real finding, not a setup step.'
  },
  connection_error: {
    state: 'BLOCKED_CONNECTION_ERROR',
    exitCode: EXIT.BLOCKED,
    message: 'A Remote Desktop connection/authentication error dialog is on screen. The target may be unreachable or the credential rejected - read the dialog text before re-running.'
  }
};

/**
 * Fold an ordered list of dialog samples into a state.
 *
 * sample: { at, kind, code, blocking, connectedSession? }
 *   kind is the classification from lib/dialogs.js ('rdp_file_consent',
 *   'rdp_file_security_review', 'certificate_warning', 'credentials_prompt',
 *   'connection_error', 'connected_session', 'unknown', or null/absent).
 *
 * opts: { requiredClears = 2, minSamplesForNoDialog = 3, mstscAlive = true }
 */
function evaluateSamples(samples, opts = {}) {
  const requiredClears = Number.isFinite(opts.requiredClears) ? opts.requiredClears : 2;
  const minSamplesForNoDialog = Number.isFinite(opts.minSamplesForNoDialog) ? opts.minSamplesForNoDialog : 3;
  const mstscAlive = opts.mstscAlive !== false;
  const rows = (Array.isArray(samples) ? samples : []).filter(Boolean);
  const kinds = rows.map(s => (s.kind == null ? null : String(s.kind)));

  const seenConsent = kinds.includes('rdp_file_consent');
  const lastConsentIdx = kinds.lastIndexOf('rdp_file_consent');
  const trailing = lastConsentIdx >= 0 ? kinds.slice(lastConsentIdx + 1) : [];
  const clearedStreak = trailing.filter(k => k !== 'rdp_file_consent').length;
  const last = kinds.length ? kinds[kinds.length - 1] : null;
  const seenConnected = kinds.includes('connected_session') ||
    rows.some(s => s.connectedSession === true);

  // 1. Consent dialog on screen right now.
  if (last === 'rdp_file_consent') {
    return {
      state: 'PENDING_CONSENT',
      exitCode: EXIT.BLOCKED,
      done: false,
      seenConsent,
      clearedStreak,
      message: 'The one-time account consent is on screen and still ungranted.',
      detail: 'Check the box and press OK on the client desktop. Nothing in the lab will answer it.'
    };
  }

  // 1b. An RDP session window for the launched tree is DIRECT evidence that
  // the .rdp-file path got past whatever gate was in front of it. It does not
  // need a second "clear" sample to be reported (the session window itself
  // replaces the dialog), and it is never downgraded back to "waiting".
  if (seenConnected && last !== 'rdp_file_consent') {
    return {
      state: 'SESSION_CONNECTED',
      exitCode: EXIT.OK,
      done: true,
      seenConsent,
      clearedStreak,
      message: `An RDP session window for the launched process is on screen${seenConsent ? ' and the consent dialog is gone' : ''}.`,
      detail: 'This is evidence the .rdp-file path got past the account consent gate. The acceptance proof is still the fresh unattended run - this SETUP run proves nothing about auto-login.'
    };
  }

  // 2. Consent was seen and has now been gone for enough samples.
  if (seenConsent && clearedStreak >= requiredClears) {
    if (seenConnected) {
      return {
        state: 'SESSION_CONNECTED',
        exitCode: EXIT.OK,
        done: true,
        seenConsent,
        clearedStreak,
        message: 'The consent dialog cleared and an RDP session window for the launched process is on screen.',
        detail: 'This is evidence the .rdp-file path got past the account consent gate. The acceptance proof is still the fresh unattended run - this SETUP run proves nothing about auto-login.'
      };
    }
    const other = last && BLOCKING_STATES[last];
    if (other) {
      return {
        state: other.state,
        exitCode: other.exitCode,
        done: false,
        seenConsent,
        clearedStreak,
        message: other.message,
        detail: `Consent dialog cleared, then ${last} appeared.`
      };
    }
    if (!mstscAlive) {
      return {
        state: 'CONSENT_DIALOG_CLOSED_UNCONFIRMED',
        exitCode: EXIT.UNCONFIRMED,
        done: false,
        seenConsent,
        clearedStreak,
        message: 'The consent dialog is gone, but the launched mstsc has also exited without a session.',
        detail: 'Cancel closes that dialog exactly like OK does, so this is NOT evidence that consent was granted. Re-run the SETUP procedure and press OK (not Cancel), or check the desktop for a leftover dialog.'
      };
    }
    return {
      state: 'CONSENT_DIALOG_CLEARED',
      exitCode: EXIT.OK,
      done: false,
      seenConsent,
      clearedStreak,
      message: 'The consent dialog was visible and has now been gone for several samples; mstsc is still running.',
      detail: 'Treat this as "the operator answered something". Only a fresh unattended run can show that consent is granted and that auto-login works.'
    };
  }

  // 3. No consent dialog in the whole window: ambiguous, never a grant.
  if (!seenConsent && rows.length >= minSamplesForNoDialog) {
    const other = last && BLOCKING_STATES[last];
    if (other) {
      return {
        state: other.state,
        exitCode: other.exitCode,
        done: false,
        seenConsent,
        clearedStreak,
        message: other.message,
        detail: 'No consent dialog was observed; this different dialog was.'
      };
    }
    if (seenConnected) {
      return {
        state: 'SESSION_CONNECTED',
        exitCode: EXIT.OK,
        done: true,
        seenConsent,
        clearedStreak,
        message: 'No consent dialog was observed and an RDP session window is on screen.',
        detail: 'Consent for this account/device was most likely already granted. Only the fresh unattended run proves it.'
      };
    }
    return {
      state: 'NO_DIALOG_SEEN',
      exitCode: EXIT.NO_DIALOG,
      done: false,
      seenConsent,
      clearedStreak,
      message: 'No consent dialog appeared in this window.',
      detail: 'Either consent was already granted for this account, or mstsc never reached the gate (bad host, mstsc exited early). This is NOT proof that consent is granted.'
    };
  }

  // 4. Not enough samples yet.
  return {
    state: 'AWAITING_SAMPLES',
    exitCode: EXIT.OK,
    done: false,
    seenConsent,
    clearedStreak,
    message: 'Waiting for the first dialog samples.',
    detail: `samples=${rows.length}`
  };
}

module.exports = { EXIT, BLOCKING_STATES, evaluateSamples };
