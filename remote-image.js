// Safely download a picture from the internet so the server can make small thumbnails of it.
//
// Anyone can add a postcard with any image address, so this must never be tricked into reading
// things inside your own network (this is called SSRF). It therefore:
//   * only talks http/https on the normal ports (80/443), with no user:password in the address
//   * checks the real IP address at connection time and refuses private / internal ones
//     (127.x, 10.x, 192.168.x, 169.254.x cloud-metadata, localhost, IPv6 equivalents ...)
//   * re-checks every redirect (max 3)
//   * gives up after 10 seconds or 10 MB, and only accepts photo content types
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');

const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const OK_TYPES = /^image\/(jpeg|jpg|png|webp|gif|avif)\b/i;

// ---- IP address checks ------------------------------------------------------------------------
function v4ToNumber(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    n = n * 256 + Number(part);
  }
  return n;
}

// [a, b, c, d, prefix length] of every IPv4 range that must never be contacted.
const BLOCKED_V4_RANGES = [
  [0, 0, 0, 0, 8], [10, 0, 0, 0, 8], [100, 64, 0, 0, 10], [127, 0, 0, 0, 8], [169, 254, 0, 0, 16],
  [172, 16, 0, 0, 12], [192, 0, 0, 0, 24], [192, 0, 2, 0, 24], [192, 168, 0, 0, 16], [198, 18, 0, 0, 15],
  [198, 51, 100, 0, 24], [203, 0, 113, 0, 24], [224, 0, 0, 0, 3], // 224.x/3 = multicast + reserved
];
const BLOCKED_V4 = BLOCKED_V4_RANGES.map(([a, b, c, d, bits]) => [(((a * 256 + b) * 256 + c) * 256) + d, 2 ** (32 - bits)]);

function isBlockedV4(ip) {
  const n = v4ToNumber(ip);
  if (n === null) return true;
  return BLOCKED_V4.some(([base, size]) => Math.floor(n / size) === Math.floor(base / size));
}

// Turn an IPv6 address into 8 numbers (handles "::" and a trailing dotted IPv4 part).
function expandV6(ip) {
  let text = ip.toLowerCase().split('%')[0];
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const q = dotted[2].split('.').map(Number);
    text = `${dotted[1]}${((q[0] << 8) | q[1]).toString(16)}:${((q[2] << 8) | q[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const parts = [...head, ...Array.from({ length: fill }, () => '0'), ...tail].map((h) => Number.parseInt(h, 16));
  const valid = parts.length === 8 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff);
  return valid ? parts : null;
}

const dotted4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

// If an IPv6 address just wraps an IPv4 one (::ffff:1.2.3.4, NAT64, 6to4) return that IPv4 address.
function embeddedV4(g) {
  const zeros = (from, to) => g.slice(from, to).every((n) => n === 0);
  if (zeros(0, 5) && g[5] === 0xffff) return dotted4(g[6], g[7]);
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return dotted4(g[6], g[7]);
  if (g[0] === 0x2002) return dotted4(g[1], g[2]);
  return null;
}

// [mask, value] for the first 16 bits: fc00::/7 private, fe80::/10 link-local, ff00::/8 multicast.
const BLOCKED_V6_PREFIXES = [[0xfe00, 0xfc00], [0xffc0, 0xfe80], [0xff00, 0xff00]];

function isBlockedV6(ip) {
  const g = expandV6(ip);
  if (!g) return true;
  const wrapped = embeddedV4(g);
  if (wrapped) return isBlockedV4(wrapped);
  const unspecifiedOrLoopback = g.slice(0, 6).every((n) => n === 0);
  const teredo = g[0] === 0x2001 && g[1] === 0;
  return unspecifiedOrLoopback || teredo || BLOCKED_V6_PREFIXES.some(([mask, value]) => (g[0] & mask) === value);
}

function isBlockedIp(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return isBlockedV4(ip);
  if (kind === 6) return isBlockedV6(ip);
  return true;
}

// Used by Node when it connects: the address is checked at the moment of use, so a host name that
// changes its answer between "check" and "connect" cannot slip through.
function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err);
    const allowed = addresses.filter((a) => !isBlockedIp(a.address));
    if (allowed.length === 0) return callback(new Error('address not allowed'));
    if (options?.all) return callback(null, allowed);
    callback(null, allowed[0].address, allowed[0].family);
  });
}

// ---- Downloading ------------------------------------------------------------------------------
// Check an address before connecting. allowPrivate is for automated tests only; the server never sets it.
function parseTarget(address, allowPrivate) {
  let url;
  try { url = new URL(address); } catch { throw new Error('bad address'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http/https');
  if (url.username || url.password) throw new Error('credentials in address not allowed');
  if (allowPrivate) return url;
  const defaultPort = url.protocol === 'https:' ? 443 : 80;
  const port = url.port ? Number(url.port) : defaultPort;
  if (port !== 80 && port !== 443) throw new Error('port not allowed');
  const host = url.hostname.replaceAll(/^\[|\]$/g, '');
  if (net.isIP(host) && isBlockedIp(host)) throw new Error('address not allowed');
  return url;
}

// Why a response must be refused, or null if it is a normal photo.
function problemWith(res) {
  if (res.statusCode !== 200) return `HTTP ${res.statusCode}`;
  const type = String(res.headers['content-type'] || '');
  if (!OK_TYPES.test(type)) return `not an image: ${type.slice(0, 40)}`;
  if (Number(res.headers['content-length']) > MAX_BYTES) return 'too large';
  return null;
}

function collectBody(res, req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        req.destroy();
        reject(new Error('too large'));
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

// One request. Resolves with {redirect} or {buffer, contentType}.
function fetchOnce(url, allowPrivate) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get({
      hostname: url.hostname.replaceAll(/^\[|\]$/g, ''),
      port: url.port || undefined,
      path: url.pathname + url.search,
      agent: false,
      lookup: allowPrivate ? undefined : safeLookup,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PostcardThumbnailer/1.0)', Accept: 'image/avif,image/webp,image/*;q=0.8' },
    }, (res) => {
      const code = res.statusCode;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        resolve({ redirect: res.headers.location });
        return;
      }
      const problem = problemWith(res);
      if (problem) {
        res.resume();
        reject(new Error(problem));
        return;
      }
      collectBody(res, req).then((buffer) => resolve({ buffer, contentType: res.headers['content-type'] }), reject);
    });
    const timer = setTimeout(() => req.destroy(new Error('timeout')), TIMEOUT_MS);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
  });
}

async function download(address, { allowPrivate = false } = {}) {
  let current = address;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = parseTarget(current, allowPrivate);
    const result = await fetchOnce(url, allowPrivate);
    if (!result.redirect) return result;
    try { current = new URL(result.redirect, url).href; } catch { throw new Error('bad redirect'); }
  }
  throw new Error('too many redirects');
}

module.exports = { downloadImage: download, isBlockedIp };
