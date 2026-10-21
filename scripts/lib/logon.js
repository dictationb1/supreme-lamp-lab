'use strict';
// Pure evaluation of the app backend's RDP logon evidence. Kept dependency-
// free and exported so scripts/run-regressions.js can pin every branch with
// recorded response shapes (positive AND negative: a stale event, another
// source, or a console logon must never satisfy the RDP capability).
//
// Why "derived" proof exists (read this before "simplifying" it away):
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
//   filter is supplied, and the endpoint answers logonType:'' even for a
//   genuine type-10 logon. The remaining fields (connected, ts, sourceIp)
//   are set correctly from the matched event.
//
//   Derived proof does not lower the bar; it reconstructs the same fact
//   from fields that are not broken, at a pinned app SHA whose endpoint
//   semantics are known exactly:
//     * connected=true is ONLY set for a fresh 4624 whose LogonType is in
//       {2, 10, 11} and whose message names the requested user;
//     * ts is that event's TimeCreated and must be >= our baseline;
//     * sourceIp is that event's Source Network Address. Of the accepted
//       types only 10 (RemoteInteractive) carries a remote source address
//       (interactive/cached console logons report '-'), so
//       sourceIp == this run's client tailnet IP identifies the event as
//       the intended type-10 logon from this client.
//   mission-control-check additionally cross-checks the app's independent
//   XML-parsing collector (/api/native-status rdpListener.authLast, F28)
//   and fails on a contradiction; if a future app build reports
//   logonType:'10' correctly, the direct branch below takes over again.
//
//   The app-side one-line fix is to save $Matches[1] before the user
//   -notmatch (or parse the event XML <Data Name="LogonType"> like the
//   F28 collector already does). Until then, do not "fix" this evaluator
//   to require logonType==='10': that reintroduces a guaranteed FAIL for
//   every genuine logon (run 39560693766 attempt 2).

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
 * Evaluate one /api/logon-status body against the run's baseline.
 * Returns one of:
 *   { state: 'candidate', proof: 'direct'|'derived', detail }
 *   { state: 'wrong-source', detail }   terminal: a type-10 from elsewhere
 *   { state: 'type-mismatch', detail }  terminal: reported type contradicts
 *                                       a remote source address
 *   { state: 'not-observed', detail }   keep polling
 */
function evaluateLogonStatus(body, { baselineIso, clientIp } = {}) {
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
  const lt = body.logonType == null ? '' : String(body.logonType).trim();
  const src = normalizeIp(body.sourceIp);
  const cli = normalizeIp(clientIp);
  if (!src || src !== cli) {
    if (lt === '10') {
      return { state: 'wrong-source', detail: `sourceIp ${body.sourceIp} != client tailnet ip ${clientIp}` };
    }
    return { state: 'not-observed', detail: `source ${JSON.stringify(body.sourceIp)} is not the client ip (logonType=${JSON.stringify(lt)})` };
  }
  // sourceIp is exactly this run's client tailnet IP, event is fresh.
  if (lt === '10') return { state: 'candidate', proof: 'direct', detail: `logonType 10 from ${body.sourceIp} at ${body.ts}` };
  if (lt === '') {
    return {
      state: 'candidate', proof: 'derived',
      detail: `fresh 4624 (endpoint types 2/10/11) from client ip ${body.sourceIp} at ${body.ts}; ` +
        'remote source address is only carried by LogonType 10'
    };
  }
  return {
    state: 'type-mismatch',
    detail: `logonType=${lt} reported with sourceIp == client ip ${clientIp}; ` +
      'interactive (2) / cached (11) logons do not carry a remote source address'
  };
}

/**
 * Cross-check a candidate against the F28 collector exposed at
 * /api/native-status (rdpListener.authLast). That collector parses the
 * Security event XML <Data> fields by name (Get-RdpLogonEventFields), so
 * its logonType does not suffer the $Matches clobber. It does not filter
 * by user or source and only remembers the LATEST interactive success, so
 * it can confirm or veto a candidate but never replaces it:
 *   confirmed   - its latest success IS our event (same instant, type 10)
 *   contradicted- it scanned past our event and disagrees about that instant,
 *                 or has no interactive success at/after it at all
 *   unavailable - anything else (not scanned yet, superseded by a later
 *                 event, probe error, endpoint/shape missing)
 */
function evaluateNativeCrossCheck(authLast, candidateTsIso, { toleranceMs = 2500 } = {}) {
  if (!authLast || typeof authLast !== 'object') return { state: 'unavailable', detail: 'authLast absent' };
  if (authLast.probeError) return { state: 'unavailable', detail: `collector probeError=${authLast.probeError}` };
  const candMs = Date.parse(candidateTsIso || '');
  const scanMs = Date.parse(authLast.scanTs || '');
  if (!Number.isFinite(candMs)) return { state: 'unavailable', detail: 'candidate ts unparseable' };
  if (!Number.isFinite(scanMs) || scanMs < candMs) {
    return { state: 'unavailable', detail: `collector scanTs ${authLast.scanTs || '?'} predates candidate` };
  }
  const evMs = Date.parse(authLast.eventTs || '');
  const lt = authLast.logonType == null ? '' : String(authLast.logonType).trim();
  if (authLast.result === 'success' && Number.isFinite(evMs)) {
    if (Math.abs(evMs - candMs) <= toleranceMs) {
      return lt === '10'
        ? { state: 'confirmed', detail: `authLast success LogonType 10 at ${authLast.eventTs}` }
        : { state: 'contradicted', detail: `authLast success at candidate instant has LogonType ${JSON.stringify(lt)}` };
    }
    if (evMs < candMs - toleranceMs) {
      return {
        state: 'contradicted',
        detail: `collector scanned past candidate (scanTs ${authLast.scanTs}) but its latest interactive success is ${authLast.eventTs}`
      };
    }
    return { state: 'unavailable', detail: `collector latest success ${authLast.eventTs} supersedes candidate` };
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

module.exports = { normalizeIp, evaluateLogonStatus, evaluateNativeCrossCheck, digestLogonBody };
