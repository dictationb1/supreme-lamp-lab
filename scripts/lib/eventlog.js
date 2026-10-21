'use strict';
// Pure classification of Windows event-log query outcomes. Dependency-free
// and exported so scripts/run-regressions.js can pin the distinctions.
//
// Why this exists (run 39575343527 attempt 2): the client's
// Microsoft-Windows-TerminalServices-RDPClient/Operational probe was
// reported as `rdpClientLogReadable=false err="No events were found that
// match the specified selection criteria."` - conflating THREE very
// different facts:
//   * zero matching events  - the channel is readable and the query simply
//     matched nothing (Get-WinEvent throws this exact message in that case);
//   * channel unavailable   - the log channel does not exist on this host;
//   * access denied         - the channel exists but this account may not
//     read it.
// "No matching events" is NOT an unreadable channel, and missing events are
// NOT proof that no connection was attempted.

/**
 * Classify a thrown Get-WinEvent error from its message / error id /
 * exception type. Returns one of:
 *   'zero-matches' | 'channel-missing' | 'access-denied' | 'query-error'
 */
function classifyWinEventError(message, fullyQualifiedErrorId, exceptionType) {
  const msg = String(message || '');
  const fqid = String(fullyQualifiedErrorId || '');
  const xtype = String(exceptionType || '');
  if (/No events were found that match the specified selection criteria/i.test(msg) ||
      /^NoMatchingLogsFound\b/i.test(fqid)) {
    return 'zero-matches';
  }
  if (/Access is denied|UnauthorizedAccess|requested access is denied|privilege.*not held/i.test(msg) ||
      /UnauthorizedAccess/i.test(xtype) ||
      /UnauthorizedAccess/i.test(fqid)) {
    return 'access-denied';
  }
  if (/There is not an event log.*that matches|Cannot find.*event log|does not exist.*event log|The specified channel/i.test(msg) ||
      /ContainerNotFound|LogNotFound\b/i.test(fqid)) {
    return 'channel-missing';
  }
  return 'query-error';
}

/**
 * Classify one raw query record from the PS collector:
 *   {
 *     listed: bool, listLogError?, listLogErrorId?, listLogExceptionType?,
 *     queryError?, queryErrorId?, queryExceptionType?, eventsMatched?
 *   }
 * Returns:
 *   {
 *     channelState: 'readable'|'channel-missing'|'access-denied'|'query-error',
 *     eventsMatched: number,
 *     zeroMatchingEvents: boolean,
 *     queryError: string|null
 *   }
 */
function classifyEventQuery(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  if (r.listLogError) {
    const kind = classifyWinEventError(r.listLogError, r.listLogErrorId, r.listLogExceptionType);
    const channelState = kind === 'zero-matches'
      ? 'readable'
      : kind === 'channel-missing' ? 'channel-missing' : kind === 'access-denied' ? 'access-denied' : 'query-error';
    return { channelState, eventsMatched: 0, zeroMatchingEvents: false, queryError: String(r.listLogError).slice(0, 200) };
  }
  if (r.queryError) {
    const kind = classifyWinEventError(r.queryError, r.queryErrorId, r.queryExceptionType);
    if (kind === 'zero-matches') {
      return { channelState: 'readable', eventsMatched: 0, zeroMatchingEvents: true, queryError: null };
    }
    return {
      channelState: kind === 'channel-missing' ? 'channel-missing' : kind === 'access-denied' ? 'access-denied' : 'query-error',
      eventsMatched: 0,
      zeroMatchingEvents: false,
      queryError: String(r.queryError).slice(0, 200)
    };
  }
  const n = Number.isFinite(r.eventsMatched) ? Number(r.eventsMatched) : 0;
  return { channelState: 'readable', eventsMatched: n, zeroMatchingEvents: n === 0, queryError: null };
}

/** Bounded one-line digest that keeps the three states visibly distinct. */
function digestRdpClientLog(raw) {
  const c = classifyEventQuery(raw);
  const parts = [`channel=${c.channelState}`];
  if (c.channelState === 'readable') {
    parts.push(c.zeroMatchingEvents
      ? 'events=0 (zero matching events - the query executed and matched nothing)'
      : `events=${c.eventsMatched}`);
  } else if (c.channelState === 'channel-missing') {
    parts.push('events=unknown (event-log channel unavailable/absent on this host)');
  } else if (c.channelState === 'access-denied') {
    parts.push('events=unknown (event-log channel query refused - access denied)');
  } else {
    parts.push('events=unknown (event-log query failed)');
  }
  if (c.queryError) parts.push(`err=${c.queryError}`);
  return parts.join(' ');
}

module.exports = { classifyWinEventError, classifyEventQuery, digestRdpClientLog };
