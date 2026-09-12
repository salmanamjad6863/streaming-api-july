/**
 * Resolve Megaplay embed pages to direct HLS (no iframe ads).
 *
 * Flow:
 * 1. GET embed HTML → data-id
 * 2. Try /stream/getSourcesNew → plain sources.file (megap.* / formerly imgnex)
 * 3. Fallback /stream/getSources → AES-decrypt `enc` (often nexabloom)
 * 4. Probe media playlist — reject TikTok ad-poisoned playlists → caller uses embed
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

const AD_SEGMENT_RE =
  /tiktokcdn\.|ad-site|~tplv-|\.image(\?|$)|doubleclick|googlesyndication/i;

/**
 * Megaplay sometimes returns a master.m3u8 whose media playlist is only
 * TikTok CDN PNG "ads" — not playable video. Detect that so we fall back to embed.
 */
async function isAdPoisonedHls(m3u8Url) {
  try {
    const { data: master } = await http.get(m3u8Url, {
      headers: {
        Referer: 'https://megaplay.buzz/',
        Origin: 'https://megaplay.buzz',
        Accept: '*/*',
      },
      responseType: 'text',
      transformResponse: [(d) => d],
      validateStatus: (s) => s >= 200 && s < 500,
    });
    if (!master || typeof master !== 'string') return true;

    const base = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);
    const mediaLine = String(master)
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#') && l.includes('.m3u8'));
    if (!mediaLine) {
      // Single-variant playlist — check segments directly
      return samplePlaylistIsAds(master, base);
    }
    const nested = mediaLine.startsWith('http') ? mediaLine : base + mediaLine;
    const { data: media } = await http.get(nested, {
      headers: {
        Referer: 'https://megaplay.buzz/',
        Origin: 'https://megaplay.buzz',
        Accept: '*/*',
      },
      responseType: 'text',
      transformResponse: [(d) => d],
      validateStatus: (s) => s >= 200 && s < 500,
    });
    return samplePlaylistIsAds(media, nested.substring(0, nested.lastIndexOf('/') + 1));
  } catch (err) {
    console.warn('[megaplay] playlist probe failed:', err.message);
    // Unreachable / blocked playlist is not useful as native HLS
    return true;
  }
}

function samplePlaylistIsAds(playlistText, base) {
  if (!playlistText || typeof playlistText !== 'string') return true;
  const urls = String(playlistText)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .slice(0, 12)
    .map((l) => (l.startsWith('http') ? l : base + l));
  if (urls.length === 0) return true;
  const adHits = urls.filter((u) => AD_SEGMENT_RE.test(u)).length;
  // If a majority of early segments are ad CDNs / .image, treat as poisoned
  return adHits >= Math.ceil(urls.length * 0.5);
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

  // Collect candidate m3u8 URLs (getSourcesNew first, then encrypted getSources)
  const candidates = [];
  let data = null;
  try {
    data = await fetchGetSources(embedUrl, dataId, 'getSourcesNew');
    const file = extractPlainM3u8(data);
    if (file && String(file).includes('.m3u8')) {
      candidates.push({ file, data });
    }
  } catch (err) {
    console.warn('[megaplay] getSourcesNew failed:', err.message);
  }

  try {
    const encData = await fetchGetSources(embedUrl, dataId, 'getSources');
    let file = extractPlainM3u8(encData);
    if ((!file || !String(file).includes('.m3u8')) && encData?.enc) {
      file = decryptMegaplayEnc(encData.enc).file;
    }
    if (file && String(file).includes('.m3u8')) {
      // Prefer non-duplicate hosts
      if (!candidates.some((c) => c.file === file)) {
        candidates.push({ file, data: encData });
      }
    }
  } catch (err) {
    console.warn('[megaplay] getSources failed:', err.message);
  }

  for (const cand of candidates) {
    const host = (() => {
      try {
        return new URL(cand.file).hostname.toLowerCase();
      } catch {
        return '';
      }
    })();

    // nexabloom usually 403s via proxy — skip unless nothing else
    if (host.includes('nexabloom') && candidates.length > 1) continue;

    const poisoned = await isAdPoisonedHls(cand.file);
    if (poisoned) {
      console.warn(
        '[megaplay] rejecting ad-poisoned HLS:',
        host || cand.file.slice(0, 80)
      );
      continue;
    }

    const result = toResult(cand.file, cand.data);
    if (!host.includes('nexabloom')) {
      cacheSet(embedUrl, result);
    }
    return result;
  }

  throw new Error(
    'Megaplay HLS is ad-poisoned or unreachable — use embed fallback'
  );
}
