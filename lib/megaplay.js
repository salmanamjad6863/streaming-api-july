/**
 * Resolve Megaplay embed pages to direct HLS (no iframe ads).
 *
 * Flow:
 * 1. GET embed HTML → data-id
 * 2. Prefer /stream/getSourcesNew → plain sources.file (ncdn.imgnex.top)
 * 3. Fallback /stream/getSources → AES-decrypt `enc` (often nexabloom, harder to play)
 */
import axios from 'axios';
import crypto from 'crypto';

const http = axios.create({
  timeout: 20000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
  },
});

const cache = new Map();
const CACHE_TTL_MS = 8 * 60 * 1000;

/** Megaplay client trust AES material (from public newclient.js) */
const TRUST_AES_KEY = "i?LMTAx0Q6,:}50U";
const TRUST_AES_IV = "W0;27ToaUpl_P%'c";

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
}

function padBuffer(str, len) {
  const out = Buffer.alloc(len);
  const src = Buffer.from(String(str), 'utf8');
  src.copy(out, 0, 0, Math.min(len, src.length));
  return out;
}

function b64urlToBuffer(s) {
  let o = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const pad = o.length % 4;
  if (pad) o += '===='.slice(pad);
  return Buffer.from(o, 'base64');
}

/**
 * Decrypt Megaplay getSources `enc` field → JSON (usually { file: m3u8 }).
 */
export function decryptMegaplayEnc(enc) {
  if (!enc || typeof enc !== 'string') {
    throw new Error('Missing Megaplay enc token');
  }
  const key = padBuffer(TRUST_AES_KEY, 32);
  const iv = padBuffer(TRUST_AES_IV, 16);
  const ct = b64urlToBuffer(enc);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  const parsed = JSON.parse(pt);
  if (!parsed?.file || !String(parsed.file).includes('.m3u8')) {
    throw new Error('Decrypted enc has no m3u8 file');
  }
  return parsed;
}

function extractPlainM3u8(data) {
  if (!data) return null;
  if (typeof data?.sources === 'object' && data.sources?.file) {
    return data.sources.file;
  }
  if (Array.isArray(data?.sources) && data.sources[0]?.file) {
    return data.sources[0].file;
  }
  if (typeof data?.file === 'string') return data.file;
  return null;
}

async function fetchGetSources(embedUrl, dataId, endpoint) {
  const { data } = await http.get(
    `https://megaplay.buzz/stream/${endpoint}?id=${dataId}`,
    {
      headers: {
        Referer: embedUrl,
        Origin: 'https://megaplay.buzz',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json',
      },
    }
  );
  return data;
}

function toResult(file, data) {
  const tracks = Array.isArray(data?.tracks) ? data.tracks : [];
  return {
    m3u8: file,
    tracks,
    intro: data?.intro || null,
    outro: data?.outro || null,
    headers: {
      Referer: 'https://megaplay.buzz/',
      Origin: 'https://megaplay.buzz',
    },
  };
}

/**
 * @param {string} embedUrl e.g. https://megaplay.buzz/stream/s-2/12352/sub
 */
export async function resolveMegaplayEmbed(embedUrl) {
  if (!embedUrl || !embedUrl.includes('megaplay')) {
    throw new Error('Not a Megaplay embed URL');
  }

  const cached = cacheGet(embedUrl);
  if (cached) return cached;

  const { data: html } = await http.get(embedUrl, {
    headers: {
      Referer: 'https://anikototv.to/',
      Accept: 'text/html,application/xhtml+xml',
    },
  });

  const idMatch = String(html).match(/data-id=["'](\d+)["']/);
  if (!idMatch) throw new Error('Megaplay data-id not found in embed page');
  const dataId = idMatch[1];

  // Prefer getSourcesNew — returns ncdn.imgnex.top (proxy-friendly) over nexabloom
  let data = null;
  let file = null;
  try {
    data = await fetchGetSources(embedUrl, dataId, 'getSourcesNew');
    file = extractPlainM3u8(data);
  } catch (err) {
    console.warn('[megaplay] getSourcesNew failed:', err.message);
  }

  if (!file || !String(file).includes('.m3u8')) {
    data = await fetchGetSources(embedUrl, dataId, 'getSources');
    file = extractPlainM3u8(data);
    if ((!file || !String(file).includes('.m3u8')) && data?.enc) {
      file = decryptMegaplayEnc(data.enc).file;
    }
  }

  if (!file || !String(file).includes('.m3u8')) {
    throw new Error('Megaplay getSources returned no m3u8');
  }

  const result = toResult(file, data);
  cacheSet(embedUrl, result);
  return result;
}
