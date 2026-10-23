#!/usr/bin/env node
'use strict';
// Client side of the tailnet handshake. Uses the client machine's existing
// Tailscale installation (read-only: `tailscale status --json`), waits for the
// server peer of THIS run attempt (hostname slab-srv-<run_id>-<attempt>) and
// for its Mission Control port to accept TCP connections.
//
// Bounded; stops early when the server job of this attempt has already
// completed (nothing will ever appear). Emits capability tailnet_connectivity
// and the outputs peer_ip / client_ip.

const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFileSync } = require('child_process');
const { STATUS, CapabilitySet } = require('./lib/status');
const { request } = require('./lib/http');
const { writeCapabilities } = require('./lib/results');

function parseArgs(argv) {
  const a = { hostname: null, port: 7331, timeoutMs: 15 * 60000, serverJob: 'server' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--hostname') a.hostname = argv[++i];
    else if (argv[i] === '--port') a.port = Number(argv[++i]);
    else if (argv[i] === '--timeout-ms') a.timeoutMs = Number(argv[++i]);
    else if (argv[i] === '--server-job') a.serverJob = argv[++i];
  }
  return a;
}

function tailscaleCli() {
  const cands = [];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) cands.push(path.join(dir, process.platform === 'win32' ? 'tailscale.exe' : 'tailscale'));
  if (process.platform === 'win32') cands.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe'));
  return cands.find(c => fs.existsSync(c)) || null;
}

function ipv4(list) { return (list || []).find(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip)) || null; }

/** Pure: find the peer whose hostname / first DNS label matches exactly (tailscale may append -N). */
function findPeer(status, hostname) {
  const want = hostname.toLowerCase();
  const re = new RegExp(`^${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-\\d+)?$`);
  const peers = Object.values((status && status.Peer) || {});
  const matches = peers.filter(p => {
    const label = String(p.DNSName || '').split('.')[0].toLowerCase();
    return String(p.HostName || '').toLowerCase() === want || re.test(label);
  });
  matches.sort((x, y) => Number(Boolean(y.Online)) - Number(Boolean(x.Online)));
  return matches[0] || null;
}

function tcpProbe(host, port, timeoutMs = 4000) {
  return new Promise(resolve => {
    const s = net.connect({ host, port });
    const done = r => { s.destroy(); resolve(r); };
    s.setTimeout(timeoutMs, () => done({ ok: false, error: 'timeout' }));
    s.once('connect', () => done({ ok: true }));
    s.once('error', e => done({ ok: false, error: `${e.code || ''} ${e.message}`.trim() }));
  });
}

async function serverJobState(name) {
  const repo = process.env.GITHUB_REPOSITORY; const runId = process.env.GITHUB_RUN_ID; const attempt = process.env.GITHUB_RUN_ATTEMPT || '1';
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!repo || !runId || !token) return null;
  const r = await request(`${process.env.GITHUB_API_URL || 'https://api.github.com'}/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`, {
    timeoutMs: 15000, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'supreme-lamp-lab' }
  });
  const job = r.json && Array.isArray(r.json.jobs) ? r.json.jobs.find(j => j.name === name || j.name.startsWith(`${name} `)) : null;
  return job ? { status: job.status, conclusion: job.conclusion } : null;
}

function out(k, v) { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); }

async function main() {
  const a = parseArgs(process.argv);
  const caps = new CapabilitySet({ tailnet_connectivity: { required: true, contract: 'server peer of this run attempt online in client tailscale status AND Mission Control port reachable over the tailnet' } });
  const cli = tailscaleCli();
  const finish = () => { writeCapabilities('tailnet', caps); process.exit(caps.aggregate().accepted ? 0 : 1); };
  if (!a.hostname) { caps.set('tailnet_connectivity', STATUS.BLOCKED, 'MISSING_CONFIG: --hostname'); return finish(); }
  if (!cli) { caps.set('tailnet_connectivity', STATUS.BLOCKED, 'CLIENT_TAILSCALE_CLI_MISSING: tailscale is not installed on the self-hosted client'); return finish(); }

  const deadline = Date.now() + a.timeoutMs;
  let lastStatusErr = null; let peer = null; let self = null; let probe = null; let serverDone = null;
  while (Date.now() < deadline) {
    try {
      const st = JSON.parse(execFileSync(cli, ['status', '--json'], { encoding: 'utf8', timeout: 20000, windowsHide: true }));
      if (st.BackendState !== 'Running') { caps.set('tailnet_connectivity', STATUS.BLOCKED, `CLIENT_TAILSCALE_NOT_RUNNING: BackendState=${st.BackendState}`); return finish(); }
      self = ipv4(st.Self && st.Self.TailscaleIPs);
      peer = findPeer(st, a.hostname);
      lastStatusErr = null;
    } catch (e) {
      lastStatusErr = e.message.split('\n')[0];
    }
    if (peer && peer.Online && ipv4(peer.TailscaleIPs)) {
      probe = await tcpProbe(ipv4(peer.TailscaleIPs), a.port);
      if (probe.ok) break;
    }
    serverDone = await serverJobState(a.serverJob);
    if (serverDone && serverDone.status === 'completed') break;
    await new Promise(r => setTimeout(r, 10000));
  }
  const peerIp = peer ? ipv4(peer.TailscaleIPs) : null;
  const evidence = { hostname: a.hostname, peer: peer ? { HostName: peer.HostName, DNSName: peer.DNSName, Online: peer.Online, ip: peerIp } : null, clientIp: self, probe, serverJob: serverDone, lastStatusErr };
  if (probe && probe.ok) {
    out('peer_ip', peerIp); out('client_ip', self || '');
    caps.set('tailnet_connectivity', STATUS.PASS, `peer ${peer.DNSName || peer.HostName} ${peerIp} online; tcp ${a.port} reachable from ${self}`, evidence);
  } else if (serverDone && serverDone.status === 'completed' && !peer) {
    caps.set('tailnet_connectivity', STATUS.BLOCKED, `SERVER_NEVER_JOINED_TAILNET: server job ${serverDone.conclusion} without peer ${a.hostname} appearing (see server tailscale step / OIDC claims)`, evidence);
  } else if (!peer) {
    caps.set('tailnet_connectivity', STATUS.BLOCKED, `PEER_NOT_FOUND: ${a.hostname} absent from client tailnet within ${a.timeoutMs}ms${lastStatusErr ? `; status error: ${lastStatusErr}` : ''}`, evidence);
  } else {
    caps.set('tailnet_connectivity', STATUS.FAIL, `PEER_UNREACHABLE: ${a.hostname} online=${peer.Online} ip=${peerIp} tcp ${a.port}: ${probe ? probe.error : 'not probed'}`, evidence);
  }
  finish();
}

if (require.main === module) main();
module.exports = { findPeer, parseArgs, ipv4 };
