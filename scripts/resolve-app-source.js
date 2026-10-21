#!/usr/bin/env node
'use strict';
// Resolves the app commit under test ONCE per run and proves it is stageable:
//   * input SOURCE_SHA (40-hex) or SOURCE_REF (branch/tag) overrides
//     config/app-source.json;
//   * the commit must exist in the app repository;
//   * the ui-dist release must hold ui-dist-<sha>.zip AND its .sha256 sidecar
//     (Stage-F60UiBundle refuses anything else).
// There is no "main.zip"/"unknown" fallback: an unresolvable source fails here.

const fs = require('fs');
const path = require('path');
const { request, summarize } = require('./lib/http');
const annotate = require('./lib/annotate');

const API = process.env.GITHUB_API_URL || 'https://api.github.com';

async function gh(pathname) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'supreme-lamp-lab' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return request(`${API}${pathname}`, { timeoutMs: 20000, headers });
}

async function resolve({ input, config }) {
  const repo = config.repository;
  let requested = (input || '').trim();
  let source = 'config/app-source.json';
  if (requested) source = 'workflow_dispatch input source_sha';
  else requested = config.sha;
  if (!requested) throw new Error('APP_SOURCE_UNSET: neither input nor config pin provided');
  if (!/^[0-9a-f]{40}$/.test(requested) && !/^[A-Za-z0-9._/-]{1,200}$/.test(requested)) throw new Error(`APP_SOURCE_INVALID: ${JSON.stringify(requested)}`);
  const c = await gh(`/repos/${repo}/commits/${encodeURIComponent(requested)}`);
  if (c.status !== 200 || !c.json || !/^[0-9a-f]{40}$/.test(c.json.sha || '')) throw new Error(`APP_COMMIT_NOT_FOUND: ${repo}@${requested}: ${summarize(c)}`);
  const sha = c.json.sha;
  if (/^[0-9a-f]{40}$/.test(requested) && sha !== requested) throw new Error(`APP_COMMIT_MISMATCH: requested ${requested} resolved ${sha}`);
  const rel = await gh(`/repos/${repo}/releases/tags/${config.uiReleaseTag}`);
  if (rel.status !== 200 || !rel.json) throw new Error(`UI_RELEASE_UNREADABLE: ${config.uiReleaseTag}: ${summarize(rel)}`);
  const names = new Set((rel.json.assets || []).map(a => a.name));
  const zip = `ui-dist-${sha}.zip`;
  const missing = [zip, `${zip}.sha256`].filter(n => !names.has(n));
  if (missing.length) throw new Error(`UI_BUNDLE_MISSING: release ${config.uiReleaseTag} has no ${missing.join(' / ')} for ${sha}; pick a commit with a published bundle (see config/app-source.json reason)`);
  return { repository: repo, sha, requested, source, uiBundle: zip, committedAt: c.json.commit && c.json.commit.committer && c.json.commit.committer.date };
}

async function main() {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'app-source.json'), 'utf8'));
  try {
    const r = await resolve({ input: process.env.SOURCE_SHA, config });
    console.log(JSON.stringify(r, null, 2));
    annotate.notice('App source', `${r.repository}@${r.sha} (${r.source}); bundle ${r.uiBundle}`);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `app_sha=${r.sha}\napp_repo=${r.repository}\napp_source=${r.source}\n`);
  } catch (e) {
    annotate.error('App source', e.message);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { resolve };
