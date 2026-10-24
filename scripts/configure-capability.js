'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { deriveDashboardToken, tokenFingerprint } = require('./lib/capability-auth');

const CGNAT = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.(\d{1,3})\.(\d{1,3})$/;
const FQDN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+\.ts\.net$/;

function tailscaleExe() {
  const candidate = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe');
  return process.platform === 'win32' && fs.existsSync(candidate) ? candidate : 'tailscale';
}

function run(exe, args, { allowFailure = false } = {}) {
  try {
    const stdout = execFileSync(exe, args, {
      encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    return { ok: true, stdout, code: 0 };
  } catch (e) {
    if (!allowFailure) throw new Error(`COMMAND_FAILED: ${path.basename(exe)} ${args[0] || ''} (exit ${e.status === undefined ? 'unknown' : e.status})`);
    return { ok: false, stdout: String(e.stdout || ''), stderr: String(e.stderr || ''), code: e.status === undefined ? null : e.status };
  }
}

function protectFile(file) {
  // Windows SIDs avoid localized group names. The backend runs as the hosted
  // administrator; SYSTEM and Administrators need read/write, everyone else
  // does not. icacls output is intentionally discarded (paths only, no data).
  const r = run('icacls.exe', [file, '/inheritance:r', '/grant:r', '*S-1-5-18:F', '*S-1-5-32-544:F'], { allowFailure: true });
  if (!r.ok) throw new Error(`CONFIG_ACL_FAILED: ${path.basename(file)}`);
}

function main() {
  if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
    throw new Error('REFUSED: configure-capability only runs on an ephemeral GitHub-hosted Windows server');
  }
  const root = process.env.CAPABILITY_STAGE_ROOT || 'C:\\ghrdp';
  const sha = String(process.env.APP_SHA || '');
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('MISSING_CONFIG: APP_SHA must be the exact application commit');
  const password = String(process.env.RDP_LAB_PASSWORD || '');
  const runId = String(process.env.GITHUB_RUN_ID || '');
  const runAttempt = String(process.env.GITHUB_RUN_ATTEMPT || '1');
  const token = deriveDashboardToken({ secret: password, runId, runAttempt });

  const ts = tailscaleExe();
  const status = JSON.parse(run(ts, ['status', '--json']).stdout);
  const self = status.Self || {};
  const dnsName = String(self.DNSName || '').replace(/\.$/, '');
  const ip = (self.TailscaleIPs || []).find(v => CGNAT.test(String(v)));
  if (!FQDN.test(dnsName)) throw new Error('MAGIC_DNS_UNAVAILABLE: Self.DNSName is not a valid ts.net FQDN');
  if (!ip) throw new Error('TAILNET_IP_UNAVAILABLE: no CGNAT address on the disposable server');
  if (!fs.existsSync(root)) throw new Error(`STAGE_ROOT_MISSING: ${root}`);

  // Use the production Tailscale HTTPS proxy to the production /webdesk page.
  // Do not reset or replace an existing serve configuration silently. A failed
  // setup leaves webdeskUrl empty; the later UI check reports BLOCKED rather
  // than clicking a URL that was never configured.
  const serve = run(ts, ['serve', '--bg', '--https=443', 'http://127.0.0.1:7331'], { allowFailure: true });
  const webdeskUrl = serve.ok ? `https://${dnsName}/webdesk` : '';
  const webdeskReason = serve.ok ? '' : `TAILSCALE_SERVE_SETUP_FAILED(exit=${serve.code})`;

  const configPath = path.join(root, 'config.json');
  let cfg = {};
  if (fs.existsSync(configPath)) {
    try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
    catch (e) { throw new Error('CONFIG_EXISTING_UNPARSEABLE: refusing to overwrite it'); }
    if (!cfg || Array.isArray(cfg) || typeof cfg !== 'object') throw new Error('CONFIG_EXISTING_INVALID: expected an object');
  }
  const launcherSource = path.join(root, 'ghrdp-rdp-launcher.cs');
  const launcherText = fs.existsSync(launcherSource) ? fs.readFileSync(launcherSource, 'utf8') : '';
  const versionMatch = launcherText.match(/private const string Ver = "(\d+(\.\d+){1,3})"/);
  if (!versionMatch) throw new Error('LAUNCHER_VERSION_MISSING: staged production launcher constant not found');

  const now = new Date().toISOString();
  cfg = {
    ...cfg,
    rdpIp: ip,
    rdpUser: 'slabrdp',
    rdpPass: password,
    ghrdp: `slab-srv-${runId}-${runAttempt}`,
    dnsName,
    hostKind: 'ephemeral',
    buildSha: sha,
    repo: 'dictationb1/supreme-lamp',
    dashToken: token,
    mirror: false,
    runnerResolvedIP: ip,
    launcherVersion: versionMatch[1],
    startedAt: now,
    runStartedAt: now,
    sessionId: `capability-${runId}-${runAttempt}`,
    webdeskUrl,
    webdeskReason,
    // [CANDIDATE] The search lane (F56-d/F59, default ON in production
    // main.yml via search_enable=true) is enabled on the lab candidate so the
    // federated search lifecycle can be functionally verified through the real
    // UI. The ephemeral hosted server has internet access; the adapters hit
    // public APIs only (arxiv/wikipedia/ia/gutenberg), never credentials.
    searchEnabled: true
  };
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
  const tokenPath = path.join(root, 'dash-token.txt');
  fs.writeFileSync(tokenPath, token, { encoding: 'utf8', mode: 0o600 });
  protectFile(configPath);
  protectFile(tokenPath);

  // Read back only non-secret fields. Never deserialize and print the config.
  const back = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (back.dnsName !== dnsName || back.rdpIp !== ip || back.rdpUser !== 'slabrdp' || back.buildSha !== sha || back.webdeskUrl !== webdeskUrl) {
    throw new Error('CONFIG_READBACK_MISMATCH');
  }
  if (String(back.dashToken || '') !== token || fs.readFileSync(tokenPath, 'utf8') !== token) throw new Error('TOKEN_READBACK_MISMATCH');

  const report = {
    schema: 'slab-capability-config/1', generatedAt: now, appSha: sha,
    identity: { dnsName, rdpIp: ip, user: 'slabrdp', hostKind: 'ephemeral' },
    dashboardToken: { derivation: 'HMAC-SHA256(run-attempt-bound)', fingerprint: tokenFingerprint(token), runId, runAttempt },
    webDesktop: { configured: Boolean(webdeskUrl), url: webdeskUrl || null, reason: webdeskReason || null, proxy: 'Tailscale HTTPS 443 -> loopback 7331' },
    acl: { config: 'SYSTEM+Administrators only', token: 'SYSTEM+Administrators only' }
  };
  const out = path.join(process.env.RUNNER_TEMP || root, 'capability-config.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(`::error title=Capability configuration::${String(e.message || e).replace(/[\r\n]+/g, ' ').slice(0, 400)}`); process.exit(1); }
}

module.exports = { CGNAT, FQDN, protectFile };
