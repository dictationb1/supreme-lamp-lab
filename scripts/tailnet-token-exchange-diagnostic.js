#!/usr/bin/env node
'use strict';
// Classifies the ACTUAL tailnet join failure from direct API + CLI evidence.
//
// Why two-stage probing is essential:
//   1. `POST https://api.tailscale.com/api/v2/oauth/token-exchange`
//      (`client_id=<id>&jwt=<oidc_jwt>`) tests whether the Tailscale Federated
//      Identity trust credential accepts this GitHub OIDC token (issuer,
//      audience, subject pattern, custom claims).
//   2. When token exchange succeeds (HTTP 200, as observed in live CI on PR #15
//      run 39555536075) yet `tailscale up` fails with exit code 1, the failure
//      is downstream of OIDC subject/audience matching: either auth-key creation
//      (`POST /api/v2/tailnet/-/keys` with `tags: ["tag:ci"]` — missing
//      `auth_keys` write scope or unpermitted `tag:ci` in ACL `tagOwners`), OR
//      local client/service execution (`tailscaled` Windows service state,
//      installed client version, or CLI flags).
//
// Security invariants:
//   * No raw JWT, access token, auth key, OAuth secret, client ID or audience
//     value is ever logged, annotated, exported to outputs or written to disk.
//   * If the ephemeral preflight key probe issues a key (HTTP 200), its key
//     material is discarded unread and the key ID is deleted immediately via
//     `DELETE /api/v2/tailnet/-/keys/<id>`.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { request, summarize } = require('./lib/http');
const annotate = require('./lib/annotate');
const { artifactDir } = require('./lib/results');
const { redact, redactDeep, knownSecrets } = require('./lib/redact');

const DEFAULT_EXCHANGE_URL = 'https://api.tailscale.com/api/v2/oauth/token-exchange';
const DEFAULT_KEYS_URL = 'https://api.tailscale.com/api/v2/tailnet/-/keys';

const CATEGORY = Object.freeze({
  JOIN_OK: 'JOIN_OK',
  MISSING_CONFIG: 'MISSING_CONFIG',
  OIDC_UNAVAILABLE: 'OIDC_UNAVAILABLE',
  TOKEN_EXCHANGE_REJECTED: 'TRUST_CREDENTIAL_REJECTED',
  TOKEN_EXCHANGE_SERVER_ERROR: 'TAILSCALE_API_ERROR',
  TOKEN_EXCHANGE_UNREACHABLE: 'TAILSCALE_API_UNREACHABLE',
  TAG_NOT_PERMITTED: 'TAG_NOT_PERMITTED',
  MISSING_AUTH_KEYS_PERMISSION: 'MISSING_AUTH_KEYS_PERMISSION',
  TAILSCALE_SERVICE_NOT_READY: 'TAILSCALE_SERVICE_NOT_READY',
  CLIENT_VERSION_UNSUPPORTED: 'CLIENT_VERSION_UNSUPPORTED',
  JOIN_FAILED_AFTER_SUCCESSFUL_EXCHANGE: 'JOIN_FAILED_AFTER_SUCCESSFUL_EXCHANGE',
  JOIN_FAILED_UNCLASSIFIED: 'JOIN_FAILED_UNCLASSIFIED'
});

function decodeClaims(jwt) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch (e) {
    return null;
  }
}

function cleanText(value, secrets = [], max = 350) {
  if (!value) return null;
  const s = redact(String(value), secrets).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

/** Pull a non-secret, human-useful message out of a provider response body. */
function providerMessage(r, secrets = []) {
  const j = r && r.json;
  if (j && typeof j === 'object') {
    for (const k of ['message', 'error', 'error_description', 'detail']) {
      if (typeof j[k] === 'string' && j[k]) return cleanText(j[k], secrets, 300);
    }
  }
  if (r && typeof r.text === 'string' && r.text.trim()) return cleanText(r.text, secrets, 300);
  return null;
}

/** Async, bounded child-process helper (never blocks the event loop). */
function execBounded(exe, args, { timeoutMs = 15000, secrets = [] } = {}) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let child;
    try {
      child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
    } catch (err) {
      resolve({
        ok: false, exitCode: null, signal: null, timedOut: false,
        elapsedMs: Date.now() - t0, spawnError: cleanText(err.message, secrets, 240),
        stdout: '', stderr: ''
      });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch (e) { /* ignore */ }
    }, timeoutMs);
    if (timer.unref) timer.unref();

    child.stdout.on('data', d => { if (stdout.length < 16384) stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { if (stderr.length < 16384) stderr += d.toString('utf8'); });
    const done = (exitCode, signal, spawnErr) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: !spawnErr && !timedOut && exitCode === 0,
        exitCode,
        signal: signal || null,
        timedOut,
        elapsedMs: Date.now() - t0,
        spawnError: spawnErr ? cleanText(spawnErr.message, secrets, 240) : null,
        stdout: redact(stdout, secrets).trim(),
        stderr: redact(stderr, secrets).trim()
      });
    };
    child.on('error', err => done(null, null, err));
    child.on('close', (code, sig) => done(code, sig, null));
  });
}

function resolveTailscaleExe() {
  if (process.platform === 'win32') {
    const winExe = 'C:\\Program Files\\Tailscale\\tailscale.exe';
    if (fs.existsSync(winExe)) return winExe;
  }
  return 'tailscale';
}

function readDaemonLogTail(secrets = []) {
  const candidates = [];
  if (process.platform === 'win32') {
    const logDir = 'C:\\ProgramData\\Tailscale\\Logs';
    try {
      for (const f of fs.readdirSync(logDir)) {
        if (/^tailscale-service.*\.txt$/i.test(f)) {
          const full = path.join(logDir, f);
          try { candidates.push({ full, mtime: fs.statSync(full).mtimeMs }); } catch (e) { /* ignore */ }
        }
      }
    } catch (e) { /* ignore */ }
  } else {
    const linuxLog = path.join(os.homedir(), 'tailscaled.log');
    try {
      if (fs.existsSync(linuxLog)) candidates.push({ full: linuxLog, mtime: fs.statSync(linuxLog).mtimeMs });
    } catch (e) { /* ignore */ }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  try {
    const raw = fs.readFileSync(candidates[0].full, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const interesting = lines.filter(l => /error|denied|not permitted|invalid|unauthorized|forbidden|failed|tag:|token-exchange|status [45]\d\d/i.test(l));
    const picked = (interesting.length ? interesting.slice(-8) : lines.slice(-6)).join(' | ');
    return cleanText(picked, secrets, 500);
  } catch (e) {
    return null;
  }
}

async function probeKeyCreation({ keysUrl, accessToken, tag, secrets }) {
  const body = JSON.stringify({
    capabilities: {
      devices: {
        create: {
          reusable: false,
          ephemeral: true,
          preauthorized: true,
          tags: [tag]
        }
      }
    },
    expirySeconds: 60,
    description: 'supreme-lamp-lab diagnostic preflight'
  });
  const res = await request(keysUrl, {
    method: 'POST',
    timeoutMs: 20000,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body
  });
  if (res.json && typeof res.json.key === 'string') {
    secrets.push(res.json.key);
  }
  const keyIssued = Boolean(res.transport === 'ok' && res.status === 200 && res.json && res.json.key);
  let revokedImmediately = null;
  let listStatus = null;
  if (keyIssued && res.json && res.json.id) {
    const del = await request(`${keysUrl.replace(/\/$/, '')}/${encodeURIComponent(res.json.id)}`, {
      method: 'DELETE',
      timeoutMs: 10000,
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    });
    revokedImmediately = del.transport === 'ok' && (del.status === 200 || del.status === 204);
  } else if (res.transport === 'ok' && res.status === 404) {
    // Tailscale's REST API returns 404 {"message":"not found"} on POST /keys
    // when a token lacks `auth_keys` write scope (even if it has read scope or
    // another scope). A read-only GET /keys distinguishes `auth_keys:read`
    // (GET=200, POST=404) from no `auth_keys` scope at all (GET=404, POST=404).
    const rd = await request(keysUrl, {
      method: 'GET',
      timeoutMs: 10000,
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    });
    listStatus = rd.transport === 'ok' ? rd.status : null;
  }
  return {
    transport: res.transport,
    status: res.status,
    listStatus,
    durationMs: res.durationMs,
    requestedTags: [tag],
    keyIssued,
    revokedImmediately,
    message: providerMessage(res, secrets),
    errorChain: res.transport !== 'ok' ? cleanText(res.errorChain, secrets, 240) : null
  };
}

async function mintOidcToken(audience) {
  const sep = process.env.ACTIONS_ID_TOKEN_REQUEST_URL.includes('?') ? '&' : '?';
  return request(`${process.env.ACTIONS_ID_TOKEN_REQUEST_URL}${sep}audience=${encodeURIComponent(audience)}`, {
    timeoutMs: 15000,
    headers: { Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`, Accept: 'application/json' }
  });
}

async function probeLocalCli({ clientId, audience, tag, hostname, secrets }) {
  const exe = resolveTailscaleExe();
  const ver = await execBounded(exe, ['version'], { timeoutMs: 8000, secrets });
  const versionLine = ver.stdout ? ver.stdout.split(/\r?\n/)[0].trim() : null;

  let serviceState = null;
  if (process.platform === 'win32') {
    const sc = await execBounded('sc.exe', ['query', 'Tailscale'], { timeoutMs: 6000, secrets });
    const m = sc.stdout.match(/STATE\s*:\s*\d+\s+([A-Z_]+)/i);
    serviceState = m ? m[1] : (sc.exitCode !== 0 ? `sc_exit_${sc.exitCode}` : 'unknown');
  }

  const st = await execBounded(exe, ['status', '--json'], { timeoutMs: 8000, secrets });
  let backendState = null;
  let health = null;
  if (st.stdout) {
    try {
      const parsed = JSON.parse(st.stdout);
      backendState = parsed.BackendState || null;
      health = Array.isArray(parsed.Health) && parsed.Health.length ? parsed.Health.map(h => cleanText(h, secrets, 200)) : null;
    } catch (e) { /* keep stderr */ }
  }

  let upProbe = null;
  if (process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    const fresh = await mintOidcToken(audience);
    if (fresh.transport === 'ok' && fresh.status === 200 && fresh.json && fresh.json.value) {
      const freshJwt = fresh.json.value;
      secrets.push(freshJwt);
      const upArgs = [
        'up',
        `--advertise-tags=${tag}`,
        `--hostname=${hostname}`,
        '--accept-routes',
        ...(process.platform === 'win32' ? ['--unattended'] : []),
        '--timeout=25s',
        `--client-id=${clientId}?preauthorized=true&ephemeral=true`,
        `--id-token=${freshJwt}`
      ];
      const up = await execBounded(exe, upArgs, { timeoutMs: 30000, secrets });
      upProbe = {
        exitCode: up.exitCode,
        timedOut: up.timedOut,
        elapsedMs: up.elapsedMs,
        spawnError: up.spawnError,
        stderr: cleanText(up.stderr, secrets, 400),
        stdout: cleanText(up.stdout, secrets, 300)
      };
    }
  }

  const logTail = readDaemonLogTail(secrets);
  return {
    exe,
    version: versionLine,
    versionExitCode: ver.exitCode,
    versionSpawnError: ver.spawnError,
    serviceState,
    backendState,
    health,
    statusExitCode: st.exitCode,
    statusStderr: cleanText(st.stderr, secrets, 240),
    upProbe,
    daemonLogTail: logTail
  };
}

function semverBefore1901(versionLine) {
  const m = String(versionLine || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  const [maj, min, pat] = m.slice(1).map(Number);
  if (maj !== 1) return maj < 1;
  if (min !== 90) return min < 90;
  return pat < 1;
}

function classify({ configured, oidcOk, exchange, joinOutcome, keyProbe, cliProbe }) {
  if (!configured) return { category: CATEGORY.MISSING_CONFIG, detail: 'TS_OAUTH_CLIENT_ID and/or TS_AUDIENCE not provided to this step' };
  if (!oidcOk) return { category: CATEGORY.OIDC_UNAVAILABLE, detail: 'could not obtain a GitHub OIDC identity token (id-token: write / event context)' };
  const ex = exchange || {};
  if (ex.transport !== 'ok') return { category: CATEGORY.TOKEN_EXCHANGE_UNREACHABLE, detail: `exchange transport ${ex.transport}: ${ex.errorChain || ''}`.slice(0, 300) };
  if (ex.status === 200 && ex.tokenIssued) {
    if (joinOutcome === 'success') return { category: CATEGORY.JOIN_OK, detail: 'identity token exchanged and tailscale up succeeded' };
    if (joinOutcome === 'skipped') return { category: CATEGORY.JOIN_OK, detail: `identity token exchanged successfully; join step ${joinOutcome}` };

    if (keyProbe && keyProbe.transport === 'ok' && keyProbe.status >= 400 && keyProbe.status < 500) {
      const msg = keyProbe.message || `HTTP ${keyProbe.status} with no error text`;
      if (/tag/i.test(msg)) {
        return {
          category: CATEGORY.TAG_NOT_PERMITTED,
          detail: `federated identity accepted this token (HTTP 200, NOT a subject/audience mismatch), and auth-key creation for tags=[${(keyProbe.requestedTags || ['tag:ci']).join(',')}] failed with HTTP ${keyProbe.status}: ${msg}`
        };
      }
      return {
        category: CATEGORY.MISSING_AUTH_KEYS_PERMISSION,
        detail: `federated identity accepted this token (HTTP 200, NOT a subject/audience mismatch; grantedScope=${JSON.stringify(ex.grantedScope ?? null)} grantedTags=${JSON.stringify(ex.grantedTags ?? null)}), and auth-key creation POST /api/v2/tailnet/-/keys returned HTTP ${keyProbe.status}: ${msg}${keyProbe.listStatus ? ` (GET /keys=${keyProbe.listStatus})` : ''} — in Tailscale API v2, missing Keys > Auth keys (Write) scope or missing tag permission returns HTTP 404/403`
      };
    }

    if (cliProbe) {
      const upErr = (cliProbe.upProbe && (cliProbe.upProbe.stderr || cliProbe.upProbe.stdout || cliProbe.upProbe.spawnError)) || cliProbe.statusStderr || cliProbe.daemonLogTail || '';
      const diagSummary = [
        cliProbe.version ? `version=${cliProbe.version}` : null,
        cliProbe.serviceState ? `service=${cliProbe.serviceState}` : null,
        cliProbe.backendState ? `backendState=${cliProbe.backendState}` : null,
        keyProbe && keyProbe.status ? `keyProbeStatus=${keyProbe.status}` : null,
        cliProbe.upProbe ? `upExit=${cliProbe.upProbe.exitCode}` : null,
        upErr ? `cli="${upErr}"` : null
      ].filter(Boolean).join(' ');

      if (semverBefore1901(cliProbe.version)) {
        return {
          category: CATEGORY.CLIENT_VERSION_UNSUPPORTED,
          detail: `federated identity accepted this token (HTTP 200, NOT a subject/audience mismatch), and installed Tailscale ${cliProbe.version} predates 1.90.1 workload identity support (${diagSummary})`
        };
      }
      if (/requested tags|invalid.*tag|tag.*not permitted/i.test(upErr)) {
        return {
          category: CATEGORY.TAG_NOT_PERMITTED,
          detail: `federated identity accepted this token (HTTP 200, NOT a subject/audience mismatch), and tailscale up rejected tag permission (${diagSummary})`
        };
      }
      if (/failed to connect to local Tailscale|tailscaled.*not running/i.test(upErr) || cliProbe.serviceState === 'STOPPED') {
        return {
          category: CATEGORY.TAILSCALE_SERVICE_NOT_READY,
          detail: `federated identity accepted this token (HTTP 200, NOT a subject/audience mismatch), and local Tailscale service was not ready (${diagSummary})`
        };
      }
      return {
        category: CATEGORY.JOIN_FAILED_AFTER_SUCCESSFUL_EXCHANGE,
        detail: `federated identity accepted this token (HTTP 200) but tailscale up reported outcome=${joinOutcome || 'unknown'}: the join failure is NOT a subject/audience mismatch (${diagSummary})`.slice(0, 650)
      };
    }

    return {
      category: CATEGORY.JOIN_FAILED_AFTER_SUCCESSFUL_EXCHANGE,
      detail: `federated identity accepted this token (HTTP 200) but tailscale up reported outcome=${joinOutcome || 'unknown'}: the join failure is NOT a subject/audience mismatch - inspect tailscaled startup, --advertise-tags=tag:ci permission, node limit or client version`
    };
  }
  if (ex.status >= 400 && ex.status < 500) {
    return {
      category: CATEGORY.TOKEN_EXCHANGE_REJECTED,
      detail: `exchange rejected HTTP ${ex.status}${ex.message ? `: ${ex.message}` : ' (no provider message in the response)'}`
    };
  }
  if (ex.status >= 500) return { category: CATEGORY.TOKEN_EXCHANGE_SERVER_ERROR, detail: `exchange HTTP ${ex.status}${ex.message ? `: ${ex.message}` : ''}` };
  return { category: CATEGORY.JOIN_FAILED_UNCLASSIFIED, detail: `exchange returned an unexpected status ${ex.status}` };
}

function resolutionHintFor(category) {
  switch (category) {
    case CATEGORY.TOKEN_EXCHANGE_REJECTED:
      return 'Tailscale docs: token-exchange rejection details for a federated identity are shown in the admin console -> Trust credentials. Verify issuer=https://token.actions.githubusercontent.com, audience, and subject pattern against the observed OIDC subject.';
    case CATEGORY.TAG_NOT_PERMITTED:
      return 'Trust subject & audience ALREADY MATCH (token exchange HTTP 200). Fix in Tailscale Admin: (1) ensure `tagOwners` in the ACL policy defines `"tag:ci"`, and (2) ensure this federated Trust Credential has `Keys > Auth keys` write permission scoped to `tag:ci`.';
    case CATEGORY.MISSING_AUTH_KEYS_PERMISSION:
      return 'Trust subject & audience ALREADY MATCH (token exchange HTTP 200). Fix in Tailscale Admin -> Trust credentials: edit this federated credential and grant `Keys > Auth keys` (Write) permission with tag `tag:ci` (read-only or non-key scopes exchange tokens successfully yet cannot mint node auth keys).';
    case CATEGORY.TAILSCALE_SERVICE_NOT_READY:
      return 'Trust subject & audience ALREADY MATCH (token exchange HTTP 200). Local `tailscaled` daemon/service was not ready when `tailscale up` executed.';
    case CATEGORY.CLIENT_VERSION_UNSUPPORTED:
      return 'Workload identity (`--client-id` + `--id-token`) requires Tailscale >= 1.90.1.';
    case CATEGORY.JOIN_FAILED_AFTER_SUCCESSFUL_EXCHANGE:
      return 'Trust subject & audience ALREADY MATCH (token exchange HTTP 200) — DO NOT modify the trust subject unless changing repo/workflow. Inspect keyProbe / cliProbe details for exact tag, scope, device policy or local client error.';
    default:
      return null;
  }
}

async function main() {
  const exchangeUrl = process.env.TAILNET_EXCHANGE_URL || DEFAULT_EXCHANGE_URL;
  const keysUrl = process.env.TAILNET_KEYS_URL || (exchangeUrl === DEFAULT_EXCHANGE_URL ? DEFAULT_KEYS_URL : '');
  const tag = process.env.TAILSCALE_TAG || 'tag:ci';
  const hostname = process.env.TAILSCALE_HOSTNAME || `slab-diag-${process.env.GITHUB_RUN_ID || 'local'}-${process.env.GITHUB_RUN_ATTEMPT || '1'}`;
  const secrets = [...knownSecrets()];

  const out = {
    at: new Date().toISOString(),
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    event: process.env.GITHUB_EVENT_NAME || null,
    job: process.env.GITHUB_JOB || null,
    exchangeUrl,
    joinOutcome: process.env.TAILSCALE_JOIN_OUTCOME || null
  };
  const clientId = process.env.TS_OAUTH_CLIENT_ID || '';
  const audience = process.env.TS_AUDIENCE || '';
  const configured = Boolean(clientId && audience);
  out.config = {
    oidcClientIdPresent: Boolean(clientId),
    audiencePresent: Boolean(audience),
    idTokenEndpointPresent: Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_URL),
    idTokenRequestTokenPresent: Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
  };

  let oidcOk = false;
  let accessToken = '';
  if (configured && process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    const r = await mintOidcToken(audience);
    if (r.transport === 'ok' && r.status === 200 && r.json && r.json.value) {
      oidcOk = true;
      const jwt = r.json.value;
      secrets.push(jwt);
      const claims = decodeClaims(jwt) || {};
      const now = Math.floor(Date.now() / 1000);
      out.oidc = {
        subject: claims.sub || null,
        issuer: claims.iss || null,
        eventName: claims.event_name || null,
        ref: claims.ref || null,
        workflowRef: claims.workflow_ref || null,
        audienceMatchesConfigured: typeof claims.aud === 'string' ? claims.aud === audience : null,
        expiresInSeconds: typeof claims.exp === 'number' ? claims.exp - now : null
      };
      const body = new URLSearchParams({ client_id: clientId, jwt }).toString();
      const ex = await request(exchangeUrl, {
        method: 'POST',
        timeoutMs: 20000,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body
      });
      const tokenIssued = Boolean(ex.transport === 'ok' && ex.status === 200 && ex.json && ex.json.access_token);
      if (tokenIssued) {
        accessToken = ex.json.access_token;
        secrets.push(accessToken);
      }
      out.exchange = {
        transport: ex.transport,
        status: ex.status,
        durationMs: ex.durationMs,
        tokenIssued,
        grantedScope: ex.json && ex.json.scope !== undefined ? ex.json.scope : null,
        grantedTags: ex.json && ex.json.tags !== undefined ? ex.json.tags : null,
        expiresIn: ex.json && typeof ex.json.expires_in === 'number' ? ex.json.expires_in : null,
        responseFields: ex.json && typeof ex.json === 'object' ? Object.keys(ex.json).sort() : null,
        message: providerMessage(ex, secrets),
        errorChain: ex.transport !== 'ok' ? cleanText(ex.errorChain, secrets, 300) : null
      };

      // Only run downstream post-exchange diagnostics when token exchange succeeded
      // AND the workflow's own Tailscale join step did not succeed.
      if (tokenIssued && out.joinOutcome !== 'success' && out.joinOutcome !== 'skipped') {
        if (keysUrl) {
          out.keyProbe = await probeKeyCreation({ keysUrl, accessToken, tag, secrets });
        }
        if (process.env.TAILSCALE_SKIP_CLI_PROBE !== '1') {
          out.cliProbe = await probeLocalCli({ clientId, audience, tag, hostname, secrets });
        }
      }
    } else {
      out.oidc = { error: `OIDC request failed: ${cleanText(summarize(r), secrets, 240)}` };
    }
  }

  const verdict = classify({
    configured,
    oidcOk,
    exchange: out.exchange,
    joinOutcome: out.joinOutcome,
    keyProbe: out.keyProbe,
    cliProbe: out.cliProbe
  });
  out.category = verdict.category;
  out.detail = verdict.detail;
  out.resolutionHint = resolutionHintFor(verdict.category);

  const sanitized = redactDeep(out, secrets);
  const file = path.join(artifactDir(), 'tailnet-diagnostic.json');
  fs.writeFileSync(file, JSON.stringify(sanitized, null, 2));
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `tailnet_category=${sanitized.category}\ntailnet_detail=${String(sanitized.detail).replace(/[\r\n]+/g, ' ')}\ntailnet_exchange_status=${sanitized.exchange ? sanitized.exchange.status : ''}\n`
    );
  }

  const msg = `${sanitized.category}: ${sanitized.detail}`;
  if (sanitized.category === CATEGORY.JOIN_OK) annotate.notice('tailnet classification', msg);
  else annotate.error('tailnet classification', msg);
  if (sanitized.exchange) {
    annotate.notice(
      'tailnet token exchange',
      `status=${sanitized.exchange.status} transport=${sanitized.exchange.transport} tokenIssued=${sanitized.exchange.tokenIssued} scope=${JSON.stringify(sanitized.exchange.grantedScope)} tags=${JSON.stringify(sanitized.exchange.grantedTags)} fields=${JSON.stringify(sanitized.exchange.responseFields)} elapsed=${sanitized.exchange.durationMs}ms`
    );
  }
  if (sanitized.keyProbe) {
    annotate.notice('tailnet key probe', `status=${sanitized.keyProbe.status} listStatus=${sanitized.keyProbe.listStatus} transport=${sanitized.keyProbe.transport} keyIssued=${sanitized.keyProbe.keyIssued} revoked=${sanitized.keyProbe.revokedImmediately} msg=${sanitized.keyProbe.message || 'none'}`);
  }
  if (sanitized.cliProbe) {
    const up = sanitized.cliProbe.upProbe || {};
    annotate.notice(
      'tailnet cli probe',
      `version=${sanitized.cliProbe.version || 'unknown'} service=${sanitized.cliProbe.serviceState || 'n/a'} backendState=${sanitized.cliProbe.backendState || 'unknown'} upExit=${up.exitCode === undefined ? 'n/a' : up.exitCode} stderr=${up.stderr || 'empty'} stdout=${up.stdout || 'empty'} log=${sanitized.cliProbe.daemonLogTail || 'empty'}`
    );
  }
  console.log(JSON.stringify({ category: sanitized.category, detail: sanitized.detail, exchange: sanitized.exchange, keyProbe: sanitized.keyProbe, oidc: sanitized.oidc }, null, 2));
  return 0;
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(e => {
    annotate.error('tailnet classification', `DIAGNOSTIC_ERROR: ${redact(e.message)}`);
    console.error(e);
    process.exit(0);
  });
}

module.exports = { classify, CATEGORY, decodeClaims, semverBefore1901 };
