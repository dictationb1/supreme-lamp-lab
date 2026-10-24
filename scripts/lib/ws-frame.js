'use strict';
// RFC6455 client-side framing helpers and a tiny server-frame parser, shared by
// the real-backend R2 matrix (scripts/candidate/real-backend.js) and its
// hosted regression (scripts/test/ws-frame-regressions.js).
//
// Scope: this is a TEST harness utility. The production WebSocket endpoint is
// the PowerShell server (payloads/ghrdp-server.ps1); these helpers only let the
// Node harness speak the wire protocol to that real server. Nothing here is
// ever used as a fake backend for acceptance.
const crypto = require('crypto');

// Build a MASKED client frame (browsers/Node clients must mask; the PowerShell
// server expects masked client frames). opcode 0x1 = text, 0x8 = close.
function maskedFrame(textOrBuffer, opcode) {
  const payload = Buffer.isBuffer(textOrBuffer) ? textOrBuffer : Buffer.from(textOrBuffer, 'utf8');
  const op = opcode || 0x1;
  const mask = crypto.randomBytes(4);
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | op, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | op;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | op;
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

// Masked CLOSE frame carrying a 2-byte status code.
function closeFrame(status) {
  const body = Buffer.alloc(2);
  body.writeUInt16BE(status || 1000, 0);
  return maskedFrame(body, 0x8);
}

// Parse one buffer's worth of UNMASKED server frames. Heartbeat/close frames
// are far below 126 bytes; the short and 16/64-bit length paths are handled but
// continuation fragmentation is not needed for the server's small JSON frames.
function parseServerFrames(buf) {
  const out = [];
  let i = 0;
  while (i + 2 <= buf.length) {
    const b0 = buf[i];
    const b1 = buf[i + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0; // a server must never mask
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) {
      if (i + 4 > buf.length) break;
      len = buf.readUInt16BE(i + 2);
      off = 4;
    } else if (len === 127) {
      if (i + 10 > buf.length) break;
      len = Number(buf.readBigUInt64BE(i + 2));
      off = 10;
    }
    if (masked) off += 4;
    if (i + off + len > buf.length) break;
    const payload = buf.slice(i + off, i + off + len);
    out.push({
      fin,
      opcode,
      len,
      text: opcode === 0x1 ? payload.toString('utf8') : '',
      closeCode: opcode === 0x8 && len >= 2 ? payload.readUInt16BE(0) : null
    });
    i += off + len;
  }
  return out;
}

// Median/p95/max summary of a set of {ok,status,ms} request samples. A timeout
// or error is never silently folded into the latency distribution.
function latencyStats(samples) {
  const ok = samples.filter((x) => x.ok && x.status === 200).map((x) => x.ms).sort((a, b) => a - b);
  if (!ok.length) {
    return { count: samples.length, okCount: 0, median: null, p95: null, max: null, timeouts: samples.filter((x) => !x.ok).length };
  }
  return {
    count: samples.length,
    okCount: ok.length,
    median: ok[Math.floor(ok.length / 2)],
    p95: ok[Math.floor(ok.length * 0.95)],
    max: ok[ok.length - 1],
    timeouts: samples.filter((x) => !x.ok).length
  };
}

module.exports = { maskedFrame, closeFrame, parseServerFrames, latencyStats };
