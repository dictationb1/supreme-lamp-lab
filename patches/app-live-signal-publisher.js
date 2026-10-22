#!/usr/bin/env node
'use strict';
// APP-SIDE PUBLISHER — add this file to the application repository
// (`dictationb1/supreme-lamp`) as `scripts/live-signal-publisher.js` and call
// it from the `rdp` job (see app-live-signal-check-run.snippet.yml).
//
// WHY: measured 2026-10-22 — the lab cannot read the origin run's log while the
// run is alive (run-level 404; per-job 302 -> blob 404 for queued/running jobs,
// six attempts from inside a runner). A public check-run output IS readable
// live (12 s in the harness). So the app publishes a small, versioned,
// NON-SECRET descriptor there; the only secret part (the dashboard key) is
// RSA-OAEP encrypted to the lab's public key and is never readable by anyone
// else. The job must never fail because of this publisher.
//
// Inputs (env):
//   LAB_SIGNAL_PUBKEY   PEM of the lab public key  (repo variable, not a secret)
//   GH_TOKEN            ${{ secrets.GITHUB_TOKEN }} (permissions: checks: write)
//   GH_REPO / GH_RUN_ID / GH_RUN_ATTEMPT / GH_SHA   from the workflow context
//   MC_SIGNAL_KEY       optional override (otherwise read from C:\ghrdp\config.json)
//   MC_SIGNAL_ENDPOINT  optional override (otherwise http://<tailscale ip -4>:7331/)
//   MC_SIGNAL_INTERVAL_MS (default 20000) · MC_SIGNAL_ONCE=1 · MC_SIGNAL_TTL_MS
//   MC_SIGNAL_MAX_MS    hard stop (default 6h) · MC_SIGNAL_WAIT_MS (default
//   15 min: how long to wait for the server to write its key) · GH_API_URL (tests)

const crypto = require('crypto');
const fs = require('fs');
const { execFileSync } = require('child_process');

const NAME = 'mission-control-live-signal';
const PREFIX = 'MC-SIGNAL v1 ';
const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function env(name, dflt) {
  const v = process.env[name];
  return v === undefined || v === '' ? dflt : v;
}
function log(msg) { console.log(`[live-signal] ${msg}`); }

function resolveKey() {
  if (env('MC_SIGNAL_KEY')) return String(process.env.MC_SIGNAL_KEY);
  const candidates = [env('GHRDP_CONFIG', 'C:\\ghrdp\\config.json'), '/etc/ghrdp/config.json'];
  for (const p of candidates) {
    try {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      const k = cfg.dashToken || cfg.dashboardToken || (cfg.auth && cfg.auth.dashToken);
      if (k) return String(k);
    } catch (e) { /* try next */ }
  }
  return '';
}
function resolveEndpoint() {
  if (env('MC_SIGNAL_ENDPOINT')) return String(process.env.MC_SIGNAL_ENDPOINT).replace(/\?.*$/, '');
  try {
    const ip = execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8' }).split(/\r?\n/).map(s => s.trim()).find(Boolean);
    if (ip) return `http://${ip}:7331/`;
  } catch (e) { /* fall through */ }
  return '';
}

function buildSignal({ repo, runId, attempt, appSha, endpoint, key, pub, expiresAt }) {
  const ciphertext = crypto.publicEncrypt(
    { key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(String(key), 'utf8')
  );
  const der = crypto.createPublicKey(pub).export({ type: 'spki', format: 'der' });
  const env = {
    v: 1, repo, runId: Number(runId), attempt: Number(attempt), appSha,
    endpoint, issuedAt: new Date().toISOString(), expiresAt,
    enc: { alg: 'RSA-OAEP-256', keyId: crypto.createHash('sha256').update(der).digest('hex').slice(0, 32), ciphertext: ciphertext.toString('base64') }
  };
  return PREFIX + b64u(JSON.stringify(env));
}

function api(method, path, body) {
  const base = env('GH_API_URL', 'https://api.github.com').replace(/\/+$/, '');
  const url = new URL(base + path);
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${env('GH_TOKEN', '')}`,
    'user-agent': 'supreme-lamp-live-signal',
    'x-github-api-version': '2022-11-28'
  };
  if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = String(data.length); }
  return new Promise((resolve) => {
    const req = require(url.protocol === 'http:' ? 'http' : 'https').request(url, { method, headers }, (res) => {
      let text = '';
      res.on('data', d => { text += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (e) { json = null; }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json, text: text.slice(0, 300) });
      });
    });
    req.on('error', e => resolve({ ok: false, status: 0, error: String(e.message || e) }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ ok: false, status: 0, error: 'timeout' }); });
    if (data) req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async function main() {
  const pub = env('LAB_SIGNAL_PUBKEY', '');
  if (!pub.includes('BEGIN PUBLIC KEY')) { log('no LAB_SIGNAL_PUBKEY configured — publisher disabled (this is not an error)'); return; }
  // The publisher may be started before the server exists; wait (bounded) for
  // the run's own key + tailnet address instead of failing the job.
  const waitMs = Number(env('MC_SIGNAL_WAIT_MS', String(15 * 60 * 1000)));
  const waitStart = Date.now();
  let key = '';
  let endpoint = '';
  let notified = false;
  while (Date.now() - waitStart < waitMs) {
    key = resolveKey();
    endpoint = resolveEndpoint();
    if (key && endpoint) break;
    if (!notified) {
      log(`waiting for the server (key=${key ? 'yes' : 'no'} endpoint=${endpoint ? 'yes' : 'no'})`);
      notified = true;
    }
    await sleep(10000);
  }
  if (!key || !endpoint) { log(`nothing to publish (key=${key ? 'yes' : 'no'} endpoint=${endpoint ? 'yes' : 'no'}) — publisher stopped`); return; }
  const repo = env('GH_REPO', ''), runId = env('GH_RUN_ID', ''), attempt = env('GH_RUN_ATTEMPT', '1'), appSha = env('GH_SHA', '');
  if (!repo || !runId || !appSha) { log('missing GH_REPO/GH_RUN_ID/GH_SHA'); return; }
  const ttl = Number(env('MC_SIGNAL_TTL_MS', String(6 * 60 * 60 * 1000)));
  const interval = Number(env('MC_SIGNAL_INTERVAL_MS', '20000'));
  const maxMs = Number(env('MC_SIGNAL_MAX_MS', String(6 * 60 * 60 * 1000)));
  let text = buildSignal({ repo, runId, attempt, appSha, endpoint, key, pub, expiresAt: new Date(Date.now() + ttl).toISOString() });
  const created = await api('POST', `/repos/${repo}/check-runs`, {
    name: NAME, head_sha: appSha, status: 'in_progress',
    started_at: new Date().toISOString(),
    output: { title: 'Mission Control live', summary: text }
  });
  if (!created.ok || !created.json || !created.json.id) {
    log(`could not create the check run (${created.status || created.error}) — publisher disabled`);
    return;
  }
  const id = created.json.id;
  log(`published (check-run ${id}, ${Buffer.byteLength(text)} bytes, endpoint ${endpoint.replace(/\?.*$/, '')})`);
  if (env('MC_SIGNAL_ONCE', '') === '1') return;
  const started = Date.now();
  let ticks = 0;
  while (Date.now() - started < maxMs) {
    await sleep(interval);
    ticks++;
    // The app can rotate its dashboard key mid-run (dashTokenRefresh); if the
    // key changes the published ciphertext must change with it.
    const k = resolveKey();
    if (k && k !== key) {
      key = k;
      text = buildSignal({ repo, runId, attempt, appSha, endpoint, key, pub, expiresAt: new Date(Date.now() + ttl).toISOString() });
      log('key rotated — republishing the encrypted signal');
    }
    const upd = await api('PATCH', `/repos/${repo}/check-runs/${id}`, { status: 'in_progress', output: { title: 'Mission Control live', summary: text } });
    if (!upd.ok) log(`update ${ticks} failed (${upd.status || upd.error})`);
  }
  await api('PATCH', `/repos/${repo}/check-runs/${id}`, { status: 'completed', conclusion: 'success', completed_at: new Date().toISOString(), output: { title: 'Mission Control finished', summary: text } });
  log('publisher stopped');
})().catch(e => log(`publisher error (ignored): ${String(e && e.message || e).slice(0, 200)}`));
