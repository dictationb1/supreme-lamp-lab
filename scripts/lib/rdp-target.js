'use strict';
// Validation of the RDP target an OPERATOR is asked to type.
//
// Why this module exists
// ----------------------
// RUNBOOK §2.4 asks a human to run
//     node scripts/rdp-consent-bootstrap.js --host <lab-server-ip> ...
// on the client-runner machine. Two failure modes were observed/possible:
//
//   1. The placeholder was copied literally from the RUNBOOK into the command
//      (`--host <server-ip>`). mstsc then opens a file whose `full address` is
//      the literal string `<server-ip>`, which is not a target: the operator
//      answers a Windows dialog that proves nothing about the lab path and the
//      account consent may never be exercised on a real connection attempt.
//   2. A stale address from an older run's logs was reused. The lab server is
//      EPHEMERAL: `slab-srv-<run_id>-<attempt>` and its 100.x tailnet address
//      are released when that run's server job ends, so an address copied from
//      a previous run cannot be authorized (or reachable) now.
//
// This validator refuses the placeholder shapes and obviously-non-remote
// addresses, and it reports *why*, so the operator gets a correctable message
// instead of a silently wrong .rdp file. It does NOT decide authorization:
// whether a given address is the right server for the current attempt is a
// question only the current SETUP/verification run can answer (it prints it).
//
// Dependency-free and exported so scripts/run-regressions.js can pin every
// branch.

// Placeholder / documentation shapes that are never a real lab target.
const PLACEHOLDER_PATTERNS = [
  /^<.*>$/,                       // <server-ip>, <lab-server-ip>
  /^\[.*\]$/,
  /^server-ip$/i,
  /\bYOUR[_-]|MY[_-]?SERVER/i,
  /^x{2,}/i,
  /^\$\{?/,                       // ${SERVER_IP}, $SERVER_IP
  /^%.*%$/,                       // %SERVER_IP% (cmd expansion left unexpanded)
  /^TODO$|^TBD$|^CHANGEME$/i
];

// Addresses that can never be the outbound RDP target under test.
const LOOPBACK_V4 = /^127\./;
const DOC_V4 = /^(192\.0\.2|198\.51\.100|203\.0\.113)\./;      // RFC 5737 TEST-NET
const DOC_V6 = /^(2001:db8|3fff:)/i;                            // RFC 3849 / doc

// IPv4 toolnet ranges: CGNAT 100.64/10 is exactly where Tailscale lives, so it
// is ALLOWED and expected; link-local 169.254/16 is not a lab target.
const V4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;
const V6_RE = /^[0-9a-f:]+$/i;

function isIPv6(s) {
  if (!s.includes(':')) return false;
  if (!V6_RE.test(s)) return false;
  // at least two colons or a '::' - keeps ':7331' style typos out
  return (s.match(/:/g) || []).length >= 2;
}

/**
 * Validate one operator-supplied `--host` value.
 * Returns { ok, host, kind, error, warnings }.
 *   kind: 'ipv4' | 'ipv6' | 'hostname'
 * Never throws.
 */
function validateTarget(raw) {
  const warnings = [];
  const original = String(raw == null ? '' : raw);
  let host = original.trim();

  if (!host) return { ok: false, host: '', kind: null, warnings, error: 'empty target' };
  if (/\s/.test(host)) return { ok: false, host, kind: null, warnings, error: `whitespace inside the target: ${JSON.stringify(host)}` };
  if (host.includes('/')) return { ok: false, host, kind: null, warnings, error: `a CIDR/URL path is not an RDP host: ${JSON.stringify(host)}` };
  if (/^[a-z]+:\/\//i.test(host)) return { ok: false, host, kind: null, warnings, error: `pass a host, not a URL: ${JSON.stringify(host)}` };
  if (host.includes(':')) {
    // allow [v6] :port and host:port, but strip an explicit port - the lab
    // target is always TCP 3389 and `full address:s:` must carry the host.
    const bracketed = host.match(/^\[([0-9a-f:]+)\](?::(\d+))?$/i);
    if (bracketed) { host = bracketed[1]; if (bracketed[2] && bracketed[2] !== '3389') warnings.push(`port ${bracketed[2]} ignored; RDP is 3389`); }
    else if (!isIPv6(host)) {
      const withPort = host.match(/^([^:]+):(\d+)$/);
      if (!withPort) return { ok: false, host, kind: null, warnings, error: `not a valid IPv6 literal or host:port: ${JSON.stringify(host)}` };
      host = withPort[1];
      if (withPort[2] !== '3389') warnings.push(`port ${withPort[2]} ignored; RDP is 3389`);
    }
  }

  for (const re of PLACEHOLDER_PATTERNS) {
    if (re.test(host)) {
      return {
        ok: false, host, kind: null, warnings,
        error: `unresolved placeholder ${JSON.stringify(host)}: replace it with the target the current SETUP run printed ` +
          '(RUNBOOK §2.4). A previous run\'s address is expired - the lab server is ephemeral.'
      };
    }
  }

  if (V4_RE.test(host)) {
    if (host === '0.0.0.0' || host === '255.255.255.255') return { ok: false, host, kind: 'ipv4', warnings, error: `${host} is not a unicast target` };
    if (LOOPBACK_V4.test(host)) return { ok: false, host, kind: 'ipv4', warnings, error: `${host} is loopback: an RDP file aimed at this machine cannot exercise the lab path` };
    if (DOC_V4.test(host)) return { ok: false, host, kind: 'ipv4', warnings, error: `${host} is a documentation (TEST-NET) address, not the lab server` };
    if (/^169\.254\./.test(host)) return { ok: false, host, kind: 'ipv4', warnings, error: `${host} is link-local (APIPA), not the lab server` };
    if (!/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) && !/^10\./.test(host) && !/^192\.168\./.test(host) && !/^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
      warnings.push(`${host} is not a tailnet (100.64/10) or private address - confirm the current run printed it`);
    }
    return { ok: true, host, kind: 'ipv4', warnings, error: null };
  }

  if (isIPv6(host)) {
    const lc = host.toLowerCase();
    if (lc === '::1' || lc === '::') return { ok: false, host, kind: 'ipv6', warnings, error: `${host} is loopback/unspecified` };
    if (DOC_V6.test(lc)) return { ok: false, host, kind: 'ipv6', warnings, error: `${host} is a documentation address, not the lab server` };
    if (/^fe80:/.test(lc)) return { ok: false, host, kind: 'ipv6', warnings, error: `${host} is link-local, not the lab server` };
    return { ok: true, host, kind: 'ipv6', warnings, error: null };
  }

  if (HOSTNAME_RE.test(host)) {
    const lc = host.toLowerCase().replace(/\.$/, '');
    if (lc === 'localhost') return { ok: false, host, kind: 'hostname', warnings, error: 'localhost is loopback: an RDP file aimed at this machine cannot exercise the lab path' };
    if (!lc.includes('.')) return { ok: false, host, kind: 'hostname', warnings, error: `bare hostname ${JSON.stringify(host)} is not resolvable from the lab context; use the address the run printed` };
    if (/\.(invalid|test|example|localhost)$/.test(lc)) return { ok: false, host, kind: 'hostname', warnings, error: `${host} is a reserved/documentation domain, not the lab server` };
    if (!/(^|\.)ts\.net$/.test(lc) && !/^[a-z0-9.-]+\.(local|lan|internal)$/.test(lc)) {
      warnings.push(`${host} is not a *.ts.net tailnet name - confirm the current run printed it`);
    }
    return { ok: true, host, kind: 'hostname', warnings, error: null };
  }

  return { ok: false, host, kind: null, warnings, error: `not a valid IPv4/IPv6 address or hostname: ${JSON.stringify(host)}` };
}

module.exports = { validateTarget, PLACEHOLDER_PATTERNS };
