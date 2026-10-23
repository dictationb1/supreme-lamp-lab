'use strict';
// PUBLISH SANITIZED EVIDENCE INTO THE REPOSITORY.
//
// Why this exists (measured 2026-10-23, lab run 40025875096):
//   * `GET /repos/.../actions/artifacts/<id>/zip` answers 302 to
//     productionresultssa9.blob.core.windows.net and
//     `GET /repos/.../actions/runs/<id>/logs` answers 302 to
//     results-receiver.actions.githubusercontent.com. From an automation
//     environment whose egress allowlist contains only github.com,
//     codeload.github.com, api.github.com, registry.npmjs.org and pypi, BOTH
//     redirects end in `EOF`: artifacts and raw step logs are NOT retrievable.
//   * Consequently a run whose only evidence is an artifact is unreadable to the
//     operator's automation, and the 14-day retention is the least of the
//     problems.
//
// So the client VM job publishes its already-sanitized report into the branch it
// ran from, through the contents API (no git credential, no force push, one
// commit per file, 409 retried). The lab is public: `assertSanitized()` is a
// HARD gate, not a warning - any credential-shaped string aborts the publish.

const fs = require('fs');
const path = require('path');
const https = require('https');

const API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const REPO = process.env.GITHUB_REPOSITORY || 'dictationb1/supreme-lamp-lab';

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

/** Files we are willing to publish. Everything else stays out of the repo. */
const ALLOW = [
  /\.json$/i, /\.md$/i, /\.csv$/i, /\.txt$/i, /\.png$/i, /\.log\.sanitized$/i
];

/**
 * Credential-shaped content is refused. The patterns are deliberately broad:
 * a false positive costs one manual look, a false negative publishes a secret.
 */
const FORBIDDEN = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/,
  /[?&]key=[A-Za-z0-9_-]{16,}/,
  /\bdash-?token\b\s*[:=]\s*"[A-Za-z0-9_-]{16,}"/i,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /"?(wrappedKey|ct|tag|nonce|aadB64)"?\s*:\s*"[A-Za-z0-9+/=]{24,}"/,
  /"?(windowsPass|rdpPass|vncPass)"?\s*:\s*"[^"*][^"]{3,}"/i
];

function scan(text, name) {
  for (const re of FORBIDDEN) {
    if (re.test(text)) return { ok: false, code: 'REFUSED_CREDENTIAL_SHAPE', detail: `${name} matches ${re}` };
  }
  return { ok: true };
}

function request(method, urlPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = https.request(API + urlPath, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'supreme-lamp-lab-publish-evidence',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...extraHeaders
      },
      timeout: 30000
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function putFile(repo, branch, repoPath, content, message) {
  let sha;
  const b64 = Buffer.from(content).toString('base64');
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await request('GET', `/repos/${repo}/contents/${encodeURI(repoPath)}?ref=${encodeURIComponent(branch)}`);
    if (cur.status === 200 && cur.json && cur.json.sha) {
      sha = cur.json.sha;
      // IDEMPOTENT: an unchanged file is not rewritten, so a re-run of the same
      // job cannot produce an endless commit/trigger loop on the PR head branch.
      const old = cur.json.content ? String(cur.json.content).replace(/\s+/g, '') : '';
      if (old && old === b64) return { ok: true, status: 200, repoPath, unchanged: true };
    } else if (cur.status !== 404) return { ok: false, code: 'READ_FAILED', status: cur.status, repoPath };
    const body = {
      message,
      content: b64,
      branch,
      ...(sha ? { sha } : {})
    };
    const put = await request('PUT', `/repos/${repo}/contents/${encodeURI(repoPath)}`, body);
    if (put.status === 200 || put.status === 201) return { ok: true, status: put.status, repoPath, commit: put.json && put.json.commit ? put.json.commit.sha : null };
    if (put.status === 409 || put.status === 422) { await new Promise(r => setTimeout(r, 400 + attempt * 700)); continue; }
    return { ok: false, code: 'WRITE_FAILED', status: put.status, repoPath, detail: (put.text || '').slice(0, 200) };
  }
  return { ok: false, code: 'CONFLICT_RETRIES_EXHAUSTED', repoPath };
}

async function main() {
  const srcDir = arg('dir', '');
  const dest = (arg('dest', '') || '').replace(/^\/+|\/+$/g, '');
  const branch = arg('branch', '');
  const message = arg('message', 'evidence: publish sanitized run evidence [skip ci]');
  if (!srcDir || !dest || !branch) { console.error('usage: publish-evidence.js --dir <dir> --dest <repo/path> --branch <branch>'); process.exit(64); }
  if (!TOKEN) { console.error('publish-evidence: no GH_TOKEN'); process.exit(65); }
  if (!fs.existsSync(srcDir)) { console.log('publish-evidence: nothing to publish (' + srcDir + ' missing)'); process.exit(0); }

  const picked = [];
  for (const name of fs.readdirSync(srcDir)) {
    const full = path.join(srcDir, name);
    if (!fs.statSync(full).isFile()) continue;
    if (!ALLOW.some(re => re.test(name))) { console.log('skip (not an evidence type): ' + name); continue; }
    picked.push({ name, full });
  }
  if (!picked.length) { console.log('publish-evidence: no eligible files'); process.exit(0); }

  const results = [];
  for (const f of picked) {
    const buf = fs.readFileSync(f.full);
    const isText = !/\.png$/i.test(f.name);
    if (isText) {
      const s = scan(buf.toString('utf8'), f.name);
      if (!s.ok) {
        console.error(`::error title=publish refused::${s.detail}`);
        fs.writeFileSync(path.join(srcDir, 'PUBLISH-REFUSED.json'), JSON.stringify({ file: f.name, ...s }, null, 2));
        results.push({ file: f.name, ok: false, ...s });
        continue;
      }
    }
    const r = await putFile(REPO, branch, `${dest}/${f.name}`, buf, `${message}: ${f.name}`);
    results.push({ file: f.name, ...r });
    console.log(`${r.ok ? 'published' : 'FAILED'} ${f.name} -> ${dest}/${f.name}${r.commit ? ' @' + String(r.commit).slice(0, 12) : ''}`);
  }
  const manifest = {
    schema: 'slab-evidence-publish/1',
    publishedAt: new Date().toISOString(),
    repository: REPO,
    branch,
    dest,
    results
  };
  fs.writeFileSync(path.join(srcDir, 'publish-manifest.json'), JSON.stringify(manifest, null, 2));
  const failed = results.filter(r => !r.ok);
  if (failed.length) { console.error(`::error title=evidence publish::${failed.length} file(s) not published`); process.exit(1); }
  console.log(`::notice title=evidence publish::${results.length} file(s) published to ${branch}:${dest}`);
}

if (require.main === module) main().catch(e => { console.error('publish-evidence failed: ' + (e && e.message)); process.exit(1); });

module.exports = { scan, FORBIDDEN, ALLOW };
