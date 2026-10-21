#!/usr/bin/env node
'use strict';
// Classifies the ACTUAL tailnet join failure instead of guessing.
//
// Run 39548093609 attempt 2: the "Join tailnet (workload identity)" step failed
// (action warning: "tailscale failed with exit code 1") and the later gate
// annotated "sub must match" — but neither the join step's stderr nor the
// provider's verdict was visible, so the subject theory was untested. The
// documented exchange endpoint is:
//
//   POST https://api.tailscale.com/api/v2/oauth/token-exchange
//   Content-Type: application/x-www-form-urlencoded
//   client_id=<federated identity client id>&jwt=<OIDC identity token>
//
// (Tailscale docs, "Workload identity federation" -> "Token exchange API".)
// Exchanging the same OIDC token here isolates *trust* from *join*:
//   * exchange rejected  -> the federated identity does not accept this token
//                           (issuer / subject / audience / custom claim / scope);
//                           the HTTP status and the provider's message are kept;
//   * exchange accepted  -> trust is fine; a failing `tailscale up` is then a
//                           daemon / tag / node-limit / version problem.
// That distinction is what the report must carry.
//
// Secrets: the OIDC token and any returned access token are NEVER printed,
// written or annotated. Only non-secret claims (sub/iss/aud presence), the HTTP
// status, the redacted provider message and booleans are recorded. Note that
// Tailscale documents that detailed token-exchange rejection reasons are only
// shown in the admin console "Trust credentials" page, so an opaque 4xx here
// genuinely means "insufficient information available to this workflow".
//
// Env in:  ACTIONS_ID_TOKEN_REQUEST_URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN,
//          TS_OAUTH_CLIENT_ID, TS_AUDIENCE, TAILSCALE_JOIN_OUTCOME,
//          TAILNET_EXCHANGE_URL (override, tests only)
// Out:     <artifact>/tailnet-diagnostic.json, $GITHUB_OUTPUT tailnet_* keys,
//          annotations carrying the category (readable via the checks API).

const fs = require('fs');
const path = require('path');
const { request, summarize } = require('./lib/http');
const annotate = require('./lib/annotate');
const { artifactDir } = require('./lib/results');
const { redact, redactDeep } = require('./lib/redact');

const EXCHANGE_URL = process.env.TAILNET_EXCHANGE_URL || 'https://api.tailscale.com/api/v2/oauth/token-exchange';

// Categories are deliberately disjoint: only TRUST_CREDENTIAL_REJECTED is a
// credential problem. Everything else says what it actually was.
const CATEGORY = Object.freeze({
  JOIN_OK: 'JOIN_OK',
  MISSING_CONFIG: 'MISSING_CONFIG',
  OIDC_UNAVAILABLE: 'OIDC_UNAVAILABLE',
  TOKEN_EXCHANGE_REJECTED: 'TRUST_CREDENTIAL_REJECTED',
  TOKEN_EXCHANGE_SERVER_ERROR: 'TAILSCALE_API_ERROR',
  TOKEN_EXCHANGE_UNREACHABLE: 'TAILSCALE_API_UNREACHABLE',
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

/** Pull a non-secret, human-useful message out of a provider error body. */
function providerMessage(r) {
  const j = r && r.json;
  if (j && typeof j === 'object') {
    for (const k of ['message', 'error', 'error_description', 'detail']) {
      if (typeof j[k] === 'string' && j[k]) return redact(j[k]).slice(0, 300);
    }
  }
  if (r && typeof r.text === 'string' && r.text.trim()) return redact(r.text.trim()).slice(0, 300);
  return null;
}

function classify({ configured, oidcOk, exchange, joinOutcome }) {
  if (!configured) return { category: CATEGORY.MISSING_CONFIG, detail: 'TS_OAUTH_CLIENT_ID and/or TS_AUDIENCE not provided to this step' };
  if (!oidcOk) return { category: CATEGORY.OIDC_UNAVAILABLE, detail: 'could not obtain a GitHub OIDC identity token (id-token: write / event context)' };
  const ex = exchange || {};
  if (ex.transport !== 'ok') return { category: CATEGORY.TOKEN_EXCHANGE_UNREACHABLE, detail: `exchange transport ${ex.transport}: ${ex.errorChain || ''}`.slice(0, 300) };
  if (ex.status === 200 && ex.tokenIssued) {
    if (joinOutcome === 'success') return { category: CATEGORY.JOIN_OK, detail: 'identity token exchanged and tailscale up succeeded' };
    if (joinOutcome === 'skipped') return { category: CATEGORY.JOIN_OK, detail: `identity token exchanged successfully; join step ${joinOutcome}` };
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

async function main() {
  const out = {
    at: new Date().toISOString(),
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    event: process.env.GITHUB_EVENT_NAME || null,
    job: process.env.GITHUB_JOB || null,
    exchangeUrl: EXCHANGE_URL,
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
  if (configured && process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    const sep = process.env.ACTIONS_ID_TOKEN_REQUEST_URL.includes('?') ? '&' : '?';
    const r = await request(`${process.env.ACTIONS_ID_TOKEN_REQUEST_URL}${sep}audience=${encodeURIComponent(audience)}`, {
      timeoutMs: 15000,
      headers: { Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`, Accept: 'application/json' }
    });
    if (r.transport === 'ok' && r.status === 200 && r.json && r.json.value) {
      oidcOk = true;
      const claims = decodeClaims(r.json.value) || {};
      const now = Math.floor(Date.now() / 1000);
      out.oidc = {
        subject: claims.sub || null,
        issuer: claims.iss || null,
        eventName: claims.event_name || null,
        ref: claims.ref || null,
        workflowRef: claims.workflow_ref || null,
        // the aud claim is the configured audience value: report the MATCH, not the value
        audienceMatchesConfigured: typeof claims.aud === 'string' ? claims.aud === audience : null,
        expiresInSeconds: typeof claims.exp === 'number' ? claims.exp - now : null
      };
      const body = new URLSearchParams({ client_id: clientId, jwt: r.json.value }).toString();
      const ex = await request(EXCHANGE_URL, {
        method: 'POST',
        timeoutMs: 20000,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body
      });
      const tokenIssued = Boolean(ex.transport === 'ok' && ex.status === 200 && ex.json && ex.json.access_token);
      out.exchange = {
        transport: ex.transport, status: ex.status, durationMs: ex.durationMs,
        tokenIssued, // boolean only: the token itself is never retained
        message: providerMessage(ex),
        errorChain: ex.transport !== 'ok' ? redact(ex.errorChain || '').slice(0, 300) : null
      };
    } else {
      out.oidc = { error: `OIDC request failed: ${summarize(r)}` };
    }
  }

  const verdict = classify({ configured, oidcOk, exchange: out.exchange, joinOutcome: out.joinOutcome });
  out.category = verdict.category;
  out.detail = verdict.detail;
  out.resolutionHint = verdict.category === CATEGORY.TOKEN_EXCHANGE_REJECTED
    ? 'Tailscale docs: token-exchange rejection details for a federated identity are shown in the admin console (Trust credentials). Verify issuer=https://token.actions.githubusercontent.com, the configured subject pattern against the decoded sub above, and the audience of this credential. The workflow cannot see more than the HTTP status.'
    : verdict.category === CATEGORY.JOIN_FAILED_AFTER_SUCCESSFUL_EXCHANGE
      ? 'Trust is proven; inspect tailscaled service start, tag ownership/permissions for tag:ci, node limit and Tailscale client version (workload identity requires >= 1.90.1).'
      : null;

  const file = path.join(artifactDir(), 'tailnet-diagnostic.json');
  fs.writeFileSync(file, JSON.stringify(redactDeep(out), null, 2));
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `tailnet_category=${out.category}\ntailnet_detail=${String(out.detail).replace(/\n/g, ' ')}\ntailnet_exchange_status=${out.exchange ? out.exchange.status : ''}\n`);
  }

  const msg = `${out.category}: ${out.detail}`;
  if (out.category === CATEGORY.JOIN_OK) annotate.notice('tailnet classification', msg);
  else annotate.error('tailnet classification', msg);
  if (out.exchange) {
    annotate.notice('tailnet token exchange', `status=${out.exchange.status} transport=${out.exchange.transport} tokenIssued=${out.exchange.tokenIssued} elapsed=${out.exchange.durationMs}ms`);
  }
  console.log(JSON.stringify({ category: out.category, detail: out.detail, exchange: out.exchange, oidc: out.oidc }, null, 2));
  // Informational step: the workflow's Tailnet gate decides pass/fail so that a
  // diagnostic failure never masks the real join outcome.
  return 0;
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(e => {
    annotate.error('tailnet classification', `DIAGNOSTIC_ERROR: ${redact(e.message)}`);
    console.error(e);
    // never fail the job from a diagnostic: the join step/gate is authoritative
    process.exit(0);
  });
}
module.exports = { classify, CATEGORY, decodeClaims };
