/**
 * Resolve Megaplay embed pages to direct HLS (no iframe ads).
 *
 * Flow:
 * 1. GET embed HTML → data-id
 * 2. GET /stream/getSources?id={data-id} → master.m3u8 + VTT tracks
 */
import axios from 'axios';

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

  const { data } = await http.get(`https://megaplay.buzz/stream/getSources?id=${dataId}`, {
    headers: {
      Referer: embedUrl,
      Origin: 'https://megaplay.buzz',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json',
    },
  });

  const file =
    (typeof data?.sources === 'object' && data.sources?.file) ||
    (Array.isArray(data?.sources) && data.sources[0]?.file) ||
    null;

  if (!file || !String(file).includes('.m3u8')) {
    throw new Error('Megaplay getSources returned no m3u8');
  }

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
