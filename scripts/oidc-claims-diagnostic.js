#!/usr/bin/env node
'use strict';
// Requests a GitHub Actions OIDC token (same mechanism tailscale/github-action
// uses), decodes ONLY the non-secret claims and compares the subject against
// the subject pattern a Tailscale workload-identity credential must match.
// The raw token is never printed or written anywhere.
//
// Why: run 39526409955 failed with "token exchange failed with status 403".
// This repository uses GitHub's immutable subject format
//   repo:<owner>@<owner_id>/<repo>@<repo_id>:...
// so a Tailscale credential configured for the documented name-only pattern
// "repo:dictationb1/supreme-lamp-lab:*" can never match.

const fs = require('fs');
const path = require('path');
const { request } = require('./lib/http');
const annotate = require('./lib/annotate');
const { artifactDir } = require('./lib/results');

const DOCUMENTED_LEGACY_PATTERN = 'repo:dictationb1/supreme-lamp-lab:*';

function globMatch(pattern, value) {
  const re = new RegExp(`^${pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(value);
}

function decodePayload(jwt) {
  const parts = String(jwt).split('.');
  if (parts.length !== 3) throw new Error('OIDC_TOKEN_MALFORMED');
  return JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

function analyse(claims) {
  const sub = String(claims.sub || '');
  const immutable = /^repo:[^/@]+@\d+\/[^:@]+@\d+:/.test(sub);
  const recommended = claims.repository_owner_id && claims.repository_id
    ? `repo:${claims.repository_owner}@${claims.repository_owner_id}/${String(claims.repository || '').split('/')[1]}@${claims.repository_id}:*`
    : null;
  return {
    subject: sub,
    immutableSubjectFormat: immutable,
    matchesDocumentedLegacyPattern: globMatch(DOCUMENTED_LEGACY_PATTERN, sub),
    recommendedSubjectPattern: recommended,
    matchesRecommendedPattern: recommended ? globMatch(recommended, sub) : null
  };
}

async function main() {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const reqToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  const out = { at: new Date().toISOString(), runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT };
  if (!url || !reqToken) {
    out.status = 'BLOCKED';
    out.reason = 'OIDC_UNAVAILABLE: id-token: write permission is not granted to this job (or event has no OIDC, e.g. fork PR)';
    annotate.error('OIDC claims', out.reason);
  } else {
    const audience = process.env.OIDC_AUDIENCE || 'supreme-lamp-lab-claims-diagnostic';
    const r = await request(`${url}&audience=${encodeURIComponent(audience)}`, { timeoutMs: 15000, headers: { Authorization: `Bearer ${reqToken}`, Accept: 'application/json' } });
    if (!r.json || !r.json.value) {
      out.status = 'FAIL';
      out.reason = `OIDC_REQUEST_FAILED: HTTP ${r.status} ${r.errorChain || ''}`.trim();
      annotate.error('OIDC claims', out.reason);
    } else {
      const c = decodePayload(r.json.value);
      out.status = 'OK';
      out.audienceSource = process.env.OIDC_AUDIENCE ? 'TS_AUDIENCE secret' : 'diagnostic default (TS_AUDIENCE not set)';
      out.audienceConfigured = Boolean(process.env.OIDC_AUDIENCE);
      out.claims = {
        sub: c.sub, iss: c.iss, repository: c.repository, repository_id: c.repository_id,
        repository_owner: c.repository_owner, repository_owner_id: c.repository_owner_id,
        ref: c.ref, event_name: c.event_name, workflow_ref: c.workflow_ref, job_workflow_ref: c.job_workflow_ref,
        runner_environment: c.runner_environment, environment: c.environment || null
      };
      out.analysis = analyse(c);
      const a = out.analysis;
      annotate.notice('OIDC subject', `sub=${a.subject} immutableFormat=${a.immutableSubjectFormat}`);
      if (a.immutableSubjectFormat && !a.matchesDocumentedLegacyPattern) {
        annotate.warning('OIDC subject mismatch', `The documented Tailscale subject "${DOCUMENTED_LEGACY_PATTERN}" CANNOT match "${a.subject}" (immutable subject format). A Tailscale tailnet admin must set the trust credential subject to "${a.recommendedSubjectPattern}" (or a narrower ref-specific form).`);
      }
    }
  }
  fs.writeFileSync(path.join(artifactDir(), 'oidc-claims.json'), JSON.stringify(out, null, 2));
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `oidc_sub=${(out.claims && out.claims.sub) || ''}\noidc_status=${out.status}\nrecommended_subject=${(out.analysis && out.analysis.recommendedSubjectPattern) || ''}\naudience_configured=${Boolean(out.audienceConfigured)}\n`);
  }
  console.log(JSON.stringify(out, null, 2));
}

if (require.main === module) main().catch(e => { annotate.error('OIDC claims', e.message); process.exit(1); });
module.exports = { analyse, globMatch, decodePayload, DOCUMENTED_LEGACY_PATTERN };
