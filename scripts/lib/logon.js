'use strict';
// Pure evaluation of the app backend's RDP logon evidence. Kept dependency-
// free and exported so scripts/run-regressions.js can pin every branch with
// recorded response shapes (positive AND negative: a stale event, another
// source, a console logon, or an unproven logon type must never satisfy the
// RDP capability).
//
// EVIDENCE CONTRACT (tightened after run 39575343527 attempt 2):
//   Accept ONLY direct, correlated evidence for ONE fresh event:
//     * intended user  - the user-filtered /api/logon-status query matched a
//       4624 whose message names the requested user (connected=true);
//     * source address - that event's Source Network Address equals this
//       run's client tailnet IP (reported, never assumed);
//     * actual logon type - LogonType 10 is taken DIRECTLY from whichever
//       channel honestly parses it, and cross-correlated to the SAME event
//       instant. It is NEVER inferred from the presence of a remote IP.
//   A remote source address alone does not make a type-10 logon. A stale
//   type-2 record (e.g. the runner's own console logon before the attempt
//   baseline) or any unrelated authLast record is not evidence of a fresh
//   RemoteInteractive logon and can neither create nor replace proof.
//
// WHY TWO CHANNELS ARE CORRELATED AT THE PINNED APP SHA (read before
// "simplifying" this away):
//   The pinned app build (dictationb1/supreme-lamp @978a837,
//   payloads/ghrdp-server.ps1, the /api/logon-status route) parses the 4624
//   candidate like this:
//
//       if ($msg -notmatch 'Logon Type:\s+(2|10|11)\b') { continue }
//       if ($userQ -and $msg -notmatch [regex]::Escape($userQ)) { continue }
//       $connected = $true
//       $ltSeen = [string]$Matches[1]
//
//   Per Microsoft's about_Comparison_Operators, -notmatch overwrites
//   $Matches whenever it *detects* a match (returns False), so the second
//   -notmatch (the user filter, which has no capture group) clobbers the
//   capture from the first. $ltSeen is therefore ALWAYS '' when a user
//   filter is supplied - and a user filter is always supplied: the route
//   falls back to the server config's rdpUser when the query omits it. The
//   remaining fields (connected, ts, sourceIp, user) are set correctly from
//   the matched event. This is a PENDING APPLICATION DEFECT; the precise
//   one-line fix lives in patches/ (never silently applied to the staged
//   app, whose SHA is reported unchanged).
//
//   The app's independent F28 collector (/api/native-status
//   rdpListener.authLast) parses the Security event XML <Data> fields by
//   name (Get-RdpLogonEventFields), so its logonType is honest. It does not
//   filter by user or source and only remembers the LATEST interactive
//   success, so it can confirm or veto a candidate but never replaces it:
//     confirmed    - its latest success IS our event (same instant, type 10)
//     contradicted - it scanned past our event and disagrees about it
//     unavailable  - anything else (not scanned yet, superseded by a later
//                    event, probe error, endpoint/shape missing)
//   Acceptance of a body whose own logonType is missing therefore REQUIRES
//   the collector to confirm type 10 at the same event instant. If that
//   never happens the honest verdict is "type unknown", not "derived".

// How long after the attempt baseline an event may still belong to the
// attempt. The capability polls for 90s; anything older than this is a
// different session's event, anything later is clock skew.
const DEFAULT_MAX_AFTER_BASELINE_MS = 30 * 60 * 1000;

/** Trim, lowercase, and fold an IPv4-mapped IPv6 literal to its IPv4 form. */
function normalizeIp(ip) {
  let s = String(ip == null ? '' : ip).trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone > 0) s = s.slice(0, zone);
  if (s.startsWith('::ffff:')) s = s.slice('::ffff:'.length);
  return s;
}

/**
 * Evaluate one user-filtered /api/logon-status body against the run's
 * baseline. Returns one of:
 *   { state: 'candidate', proof: 'direct', detail }
 *       - the body itself reports LogonType 10 for a fresh event whose
 *         source is this run's client (a future app build that reports the
 *         type correctly lands here immediately)
 *   { state: 'needs-type-proof', detail }
 *       - user + source are proven on a fresh event, but the body reports no
 *         logon type (the pinned app's $Matches clobber). The type must now
 *         be proven at the same event instant by the XML-parsing collector;
 *         it is never inferred from the remote IP.
 *   { state: 'wrong-source', detail }   terminal: a type-10 from elsewhere
 *   { state: 'type-mismatch', detail }  terminal: reported type contradicts
 *                                       a remote source address
 *   { state: 'not-observed', detail }   keep polling
 */
function evaluateLogonStatus(body, { baselineIso, clientIp, expectedUser, maxAfterBaselineMs } = {}) {
  if (!body || typeof body !== 'object') return { state: 'not-observed', detail: 'no logon-status body' };
  if (body.connected !== true) {
    return { state: 'not-observed', detail: `connected=${body.connected} checked=${body.checked == null ? '?' : body.checked}` };
  }
  const tsMs = Date.parse(body.ts || '');
  const baseMs = Date.parse(baselineIso || '');
  if (!Number.isFinite(tsMs)) return { state: 'not-observed', detail: `ts unparseable: ${JSON.stringify(body.ts)}` };
  if (Number.isFinite(baseMs) && tsMs < baseMs) {
    return { state: 'not-observed', detail: `stale event: ts ${body.ts} < baseline ${baselineIso}` };
  }
  // UPPER bound of the attempt window. The endpoint's own query is
  // `StartTime=since`, so a timestamp far beyond the baseline can only come
  // from a negative-duration/parse quirk or severe clock skew - not from the
  // attempt under test. A window needs both ends to be "the correct attempt
  // time window".
  const maxAfter = Number.isFinite(maxAfterBaselineMs) ? maxAfterBaselineMs : DEFAULT_MAX_AFTER_BASELINE_MS;
  if (Number.isFinite(baseMs) && tsMs > baseMs + maxAfter) {
    return {
      state: 'not-observed',
      detail: `event ts ${body.ts} is ${Math.round((tsMs - baseMs) / 1000)}s after the attempt baseline ${baselineIso}, ` +
        `outside the ${Math.round(maxAfter / 60000)}-minute attempt window (clock skew or a foreign event)`
    };
  }
  // INTENDED USER. The event was selected server-side by this user filter, so
  // the echo is the app's own statement of which filter it applied. A missing
  // echo means we cannot show that our filter was applied at all, and a
  // different echo means it filtered for someone else - neither proves the
  // intended identity, so neither may contribute to acceptance. (The pinned
  // app always echoes the requested/config rdpUser.)
  if (expectedUser) {
    const echo = body.user == null ? '' : String(body.user).trim();
    if (!echo) {
      return {
        state: 'not-observed',
        detail: `user echo is empty: the endpoint did not report which user filter selected this event, so ${JSON.stringify(String(expectedUser))} is unproven`
      };
    }
    if (echo.toLowerCase() !== String(expectedUser).trim().toLowerCase()) {
      return { state: 'not-observed', detail: `user echo ${JSON.stringify(body.user)} != expected ${JSON.stringify(expectedUser)}` };
    }
  }
  const lt = body.logonType == null ? '' : String(body.logonType).trim();
  const src = normalizeIp(body.sourceIp);
  const cli = normalizeIp(clientIp);
  if (lt === '10') {
    if (!src || src !== cli) {
      return { state: 'wrong-source', detail: `sourceIp ${body.sourceIp} != client tailnet ip ${clientIp}` };
    }
    return { state: 'candidate', proof: 'direct', detail: `logonType 10 for ${body.user || 'user'} from ${body.sourceIp} at ${body.ts}` };
  }
  if (lt === '2' || lt === '11') {
    // Interactive/cached console logons carry no remote source address. One
    // that claims our client IP contradicts event semantics; one that does
    // not is simply not the outbound RDP logon under test.
    if (src && src === cli) {
      return {
        state: 'type-mismatch',
        detail: `logonType=${lt} reported with sourceIp == client ip ${clientIp}; ` +
          'interactive (2) / cached (11) logons do not carry a remote source address'
      };
    }
    return { state: 'not-observed', detail: `logonType=${lt} source ${JSON.stringify(body.sourceIp)} is not the client ip (console/cached logon)` };
  }
  if (lt === '') {
    if (src && src === cli) {
      return {
        state: 'needs-type-proof',
        detail: `fresh 4624 for ${body.user || 'the requested user'} from client ip ${body.sourceIp} at ${body.ts}, ` +
          'but logonType is missing (pinned app $Matches clobber); the type must be proven at this event instant, never inferred from the source address'
      };
    }
    return { state: 'not-observed', detail: `source ${JSON.stringify(body.sourceIp)} is not the client ip (logonType=${JSON.stringify(lt)})` };
  }
  return {
    state: 'type-mismatch',
    detail: `unrecognized logonType=${JSON.stringify(lt)} with sourceIp=${JSON.stringify(body.sourceIp)}`
  };
}

/**
 * Correlate a 'needs-type-proof' body with the F28 collector
 * (/api/native-status rdpListener.authLast). The collector's logonType comes
 * from the event XML and is therefore honest; acceptance requires its latest
 * interactive success to BE this event (same instant) and to be type 10.
 *   confirmed    - same instant, LogonType 10, collector has scanned past it
 *   contradicted - scanned past the candidate and disagrees (wrong type at
 *                  that instant, or no interactive success at/after it)
 *   unavailable  - anything else (not scanned yet, superseded by a later
 *                  event, probe error, shape missing)
 * A stale record (eventTs before the attempt baseline) is UNRELATED: it can
 * neither confirm nor veto, and is called out as unrelated in the detail.
 */
function evaluateNativeCrossCheck(authLast, candidateTsIso, { toleranceMs = 2500, baselineIso, expectedUser } = {}) {
  if (!authLast || typeof authLast !== 'object') return { state: 'unavailable', detail: 'authLast absent' };
  if (authLast.probeError) return { state: 'unavailable', detail: `collector probeError=${authLast.probeError}` };
  const candMs = Date.parse(candidateTsIso || '');
  const scanMs = Date.parse(authLast.scanTs || '');
  const baseMs = Date.parse(baselineIso || '');
  if (!Number.isFinite(candMs)) return { state: 'unavailable', detail: 'candidate ts unparseable' };
  if (!Number.isFinite(scanMs) || scanMs < candMs) {
    return { state: 'unavailable', detail: `collector scanTs ${authLast.scanTs || '?'} predates candidate` };
  }
  const evMs = Date.parse(authLast.eventTs || '');
  const lt = authLast.logonType == null ? '' : String(authLast.logonType).trim();
  const stale = Number.isFinite(evMs) && Number.isFinite(baseMs) && evMs < baseMs;
  // The collector parses TargetUserName from the event XML but the pinned app
  // does not surface it yet (Get-RdpLogonAuthLast allowlists only result/sub/
  // eventTs/scanTs/counts/logonType). When a build does report it, a
  // same-instant record for a DIFFERENT account is not our logon: the
  // cross-check must never confirm through someone else's event.
  const reportedUser = authLast.targetUserName != null ? String(authLast.targetUserName)
    : (authLast.user != null ? String(authLast.user) : '');
  const wantUser = expectedUser ? String(expectedUser).trim().toLowerCase() : '';
  if (authLast.result === 'success' && Number.isFinite(evMs) && Math.abs(evMs - candMs) <= toleranceMs &&
      wantUser && reportedUser && reportedUser.trim().toLowerCase() !== wantUser) {
    return {
      state: 'contradicted',
      detail: `authLast success at the candidate instant is for ${JSON.stringify(reportedUser)}, not the intended ${JSON.stringify(String(expectedUser))}`
    };
  }
  if (authLast.result === 'success' && Number.isFinite(evMs)) {
    if (Math.abs(evMs - candMs) <= toleranceMs) {
      const who = reportedUser ? ` for ${JSON.stringify(reportedUser)}` : ' (collector does not report the account; identity rests on the user-filtered endpoint query)';
      return lt === '10'
        ? { state: 'confirmed', detail: `authLast success LogonType 10 at ${authLast.eventTs}${who} (same event instant)` }
        : { state: 'contradicted', detail: `authLast success at the candidate instant has LogonType ${JSON.stringify(lt)} (XML-parsed), not 10` };
    }
    if (evMs < candMs - toleranceMs) {
      // The collector scanned past the candidate and still reports no
      // interactive success at/after it. That contradicts the candidate
      // event being an interactive logon - regardless of what the older
      // record itself is (it may well be an unrelated stale type-2).
      return {
        state: 'contradicted',
        detail: `collector scanned past candidate (scanTs ${authLast.scanTs}) but its latest interactive success is ${authLast.eventTs}` +
          (stale ? ' (an unrelated record from before the attempt baseline)' : '')
      };
    }
    return { state: 'unavailable', detail: `collector latest success ${authLast.eventTs} supersedes the candidate` };
  }
  if (authLast.result === 'none') {
    return {
      state: 'contradicted',
      detail: `collector scanned past candidate (scanTs ${authLast.scanTs}) and saw no interactive logon (4624=${authLast.count4624} 4625=${authLast.count4625})`
    };
  }
  // result === 'failed': a later 4625 is the collector's headline; it does
  // not time-correlate with (and cannot veto) our earlier candidate.
  return { state: 'unavailable', detail: `collector latest is a failed logon (sub=${authLast.sub || ''} ${authLast.subMeaning || ''})`.trim() };
}

/** Bounded, secret-free one-line digest of a logon-status body for reasons. */
function digestLogonBody(body) {
  if (!body) return 'no-response';
  if (body.error) return `transport=${String(body.error).slice(0, 120)}`;
  const lt = body.logonType == null ? '' : String(body.logonType);
  return (`connected=${body.connected} checked=${body.checked == null ? '?' : body.checked} ` +
    `logonType=${JSON.stringify(lt)} sourceIp=${body.sourceIp || ''} ts=${body.ts || ''} ageSec=${body.ageSeconds == null ? '?' : body.ageSeconds}`).slice(0, 180);
}

module.exports = { normalizeIp, evaluateLogonStatus, evaluateNativeCrossCheck, digestLogonBody, DEFAULT_MAX_AFTER_BASELINE_MS };
