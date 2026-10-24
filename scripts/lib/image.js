'use strict';
// Minimal, dependency-free validation of captured images. A screenshot only
// counts as evidence when the file decodes as the claimed format with sane
// dimensions - an empty or truncated file must never satisfy a capability.

const fs = require('fs');
const zlib = require('zlib');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function validatePngBuffer(buf, { minWidth = 16, minHeight = 16, minBytes = 200 } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < minBytes) return { valid: false, reason: `TOO_SMALL: ${buf ? buf.length : 0} bytes` };
  if (!buf.subarray(0, 8).equals(PNG_SIG)) return { valid: false, reason: 'BAD_SIGNATURE' };
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') return { valid: false, reason: 'MISSING_IHDR' };
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width < minWidth || height < minHeight) return { valid: false, reason: `DIMENSIONS_TOO_SMALL: ${width}x${height}`, width, height };
  // walk chunks: require IDAT and IEND, and verify the IDAT stream inflates
  let off = 8; let sawIend = false; const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('ascii');
    if (off + 12 + len > buf.length) return { valid: false, reason: `TRUNCATED_CHUNK: ${type}`, width, height };
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    if (type === 'IEND') { sawIend = true; break; }
    off += 12 + len;
  }
  if (!idat.length) return { valid: false, reason: 'NO_IDAT', width, height };
  if (!sawIend) return { valid: false, reason: 'NO_IEND', width, height };
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch (e) { return { valid: false, reason: `IDAT_INFLATE_FAILED: ${e.message}`, width, height }; }
  // detect a uniformly constant image (all scanline bytes identical after the filter byte)
  let distinct = new Set();
  for (let i = 0; i < raw.length && distinct.size < 3; i += Math.max(1, Math.floor(raw.length / 4096))) distinct.add(raw[i]);
  return { valid: true, format: 'png', width, height, bytes: buf.length, nearUniform: distinct.size < 2 };
}

function validateJpegBuffer(buf, { minWidth = 16, minHeight = 16, minBytes = 200 } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < minBytes) return { valid: false, reason: `TOO_SMALL: ${buf ? buf.length : 0} bytes` };
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return { valid: false, reason: 'BAD_SIGNATURE' };
  if (buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9) return { valid: false, reason: 'MISSING_EOI' };
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) { off++; continue; }
    const marker = buf[off + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      const height = buf.readUInt16BE(off + 5);
      const width = buf.readUInt16BE(off + 7);
      if (width < minWidth || height < minHeight) return { valid: false, reason: `DIMENSIONS_TOO_SMALL: ${width}x${height}`, width, height };
      return { valid: true, format: 'jpeg', width, height, bytes: buf.length };
    }
    const segLen = buf.readUInt16BE(off + 2);
    off += 2 + segLen;
  }
  return { valid: false, reason: 'NO_SOF_MARKER' };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decode the non-interlaced 8-bit PNGs emitted by Playwright/Chromium. */
function decodePng(buf) {
  const valid = validatePngBuffer(buf, { minWidth: 1, minHeight: 1, minBytes: 32 });
  if (!valid.valid) throw new Error(`PNG_DECODE_${valid.reason}`);
  const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
  const depth = buf[24], color = buf[25], interlace = buf[28];
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 })[color];
  if (depth !== 8 || !channels || interlace !== 0 || buf[26] !== 0) throw new Error(`PNG_DECODE_UNSUPPORTED(depth=${depth},color=${color},interlace=${interlace})`);
  const idat = [];
  let off = 8;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off), type = buf.subarray(off + 4, off + 8).toString('ascii');
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length !== height * (stride + 1)) throw new Error('PNG_DECODE_BAD_RAW_LENGTH');
  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) throw new Error(`PNG_DECODE_BAD_FILTER_${filter}`);
    for (let x = 0; x < stride; x++) {
      const source = raw[y * (stride + 1) + 1 + x];
      const left = x >= channels ? data[y * stride + x - channels] : 0;
      const up = y > 0 ? data[(y - 1) * stride + x] : 0;
      const upperLeft = y > 0 && x >= channels ? data[(y - 1) * stride + x - channels] : 0;
      const add = filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? paeth(left, up, upperLeft) : 0;
      data[y * stride + x] = (source + add) & 255;
    }
  }
  return { width, height, channels, data };
}

function comparePng(before, after, { channelThreshold = 24 } = {}) {
  const a = decodePng(before), b = decodePng(after);
  if (a.width !== b.width || a.height !== b.height) return { comparable: false, reason: `DIMENSIONS_CHANGED:${a.width}x${a.height}->${b.width}x${b.height}` };
  let changed = 0, sum = 0, samples = 0;
  for (let p = 0; p < a.width * a.height; p++) {
    let maxDelta = 0;
    for (let c = 0; c < 3; c++) {
      const ca = c < a.channels ? a.data[p * a.channels + c] : 255;
      const cb = c < b.channels ? b.data[p * b.channels + c] : 255;
      const d = Math.abs(ca - cb);
      if (d > maxDelta) maxDelta = d;
      sum += d; samples++;
    }
    if (maxDelta >= channelThreshold) changed++;
  }
  return { comparable: true, width: a.width, height: a.height, changedPixels: changed, totalPixels: a.width * a.height, changedRatio: changed / (a.width * a.height), meanChannelDelta: sum / samples };
}

function validateImageFile(file, opts) {
  if (!file || !fs.existsSync(file)) return { valid: false, reason: 'MISSING_FILE', file };
  const buf = fs.readFileSync(file);
  const res = buf[0] === 0x89 ? validatePngBuffer(buf, opts) : validateJpegBuffer(buf, opts);
  return { ...res, file };
}

module.exports = { validatePngBuffer, validateJpegBuffer, validateImageFile, decodePng, comparePng };
