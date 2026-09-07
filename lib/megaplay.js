/**
 * Resolve Megaplay embed pages to direct HLS (no iframe ads).
 *
 * Flow:
 * 1. GET embed HTML → data-id
 * 2. GET /stream/getSourcesNew?id={data-id} → master.m3u8 + VTT tracks
 *    (Megaplay renamed getSources; old endpoint now returns encrypted `enc` only)
 * 3. Fallback: decrypt `enc` with AES-256-CBC (keys from megaplay newclient.min.js)
 */
import crypto from 'crypto';
import axios from 'axios';

const http = axios.create({
  timeout: 20000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
  },
});

const AES_KEY_STR = 'i?LMTAx0Q6,:}50U';
const AES_IV_STR = "W0;27ToaUpl_P%'c";

const cache = new Map();
const CACHE_TTL_MS = 8 * 60 * 1000;

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

function getAesKey() {
  const key = Buffer.alloc(32);
  Buffer.from(AES_KEY_STR, 'utf8').copy(key, 0, 0, Math.min(32, AES_KEY_STR.length));
  return key;
}

function b64urlDecode(value) {
  let b64 = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  if (pad) b64 += '===='.slice(pad);
  return Buffer.from(b64, 'base64');
}

/** Decrypt Megaplay `enc` token → JSON with { file: m3u8Url } */
function decryptEncToken(enc) {
  const encrypted = b64urlDecode(enc);
  const iv = Buffer.from(AES_IV_STR, 'utf8');
  const decipher = crypto.createDecipheriv('aes-256-cbc', getAesKey(), iv);
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  const parsed = JSON.parse(plain);
  return parsed?.file || null;
}

function extractM3u8File(data) {
  if (!data) return null;

  const fromSources =
    (typeof data.sources === 'object' && data.sources?.file) ||
    (Array.isArray(data.sources) && data.sources[0]?.file) ||
    null;

  if (fromSources && String(fromSources).includes('.m3u8')) {
    return String(fromSources);
  }

  if (data.enc) {
    const decrypted = decryptEncToken(data.enc);
    if (decrypted && decrypted.includes('.m3u8')) return decrypted;
  }

  return null;
}

async function fetchGetSources(dataId, embedUrl) {
  const headers = {
    Referer: embedUrl,
    Origin: 'https://megaplay.buzz',
    'X-Requested-With': 'XMLHttpRequest',
    Accept: 'application/json',
  };

  // Prefer getSourcesNew — returns plain m3u8 (current Megaplay API)
  for (const endpoint of ['getSourcesNew', 'getSources']) {
    try {
      const { data } = await http.get(
        `https://megaplay.buzz/stream/${endpoint}?id=${dataId}`,
        { headers }
      );
      const file = extractM3u8File(data);
      if (file) return { file, data };
    } catch {
      /* try next endpoint */
    }
  }

  throw new Error('Megaplay getSources returned no m3u8');
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

  const { file, data } = await fetchGetSources(dataId, embedUrl);

  const tracks = Array.isArray(data.tracks) ? data.tracks : [];
  const result = {
    m3u8: file,
    tracks,
    intro: data.intro || null,
    outro: data.outro || null,
    headers: {
      Referer: 'https://megaplay.buzz/',
      Origin: 'https://megaplay.buzz',
    },
  };

  cacheSet(embedUrl, result);
  return result;
}
