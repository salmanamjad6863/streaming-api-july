/**
 * HiAnime-compatible streaming API backed by Anikoto (megaplay embeds).
 * Drop-in for anime-world NEXT_PUBLIC_HIANIME_API_URL (default port 4000).
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  searchAnime,
  getAnimeInfo,
  getEpisodes,
  getEpisodeServers,
  getEpisodeSources,
} from './lib/anikoto.js';

const PORT = Number(process.env.PORT || process.env.ANIWATCH_API_PORT || 4000);

const app = new Hono();

app.use(
  '*',
  cors({
    origin: (origin) => origin || '*',
    allowMethods: ['GET', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  })
);

app.get('/health', (c) => c.text('daijoubu'));
app.get('/', (c) =>
  c.json({
    status: 'ok',
    provider: 'anikoto+megaplay-hls',
    message: 'HiAnime-compatible API — Anikoto catalog, Megaplay direct HLS (no iframe ads)',
    endpoints: {
      health: '/health',
      search: '/api/v2/hianime/search?q=',
      anime: '/api/v2/hianime/anime/{id}',
      episodes: '/api/v2/hianime/anime/{id}/episodes',
      servers: '/api/v2/hianime/episode/servers?animeEpisodeId=',
      sources: '/api/v2/hianime/episode/sources?animeEpisodeId=&category=sub&server=hd-1',
      proxy: '/api/v2/proxy?url=',
    },
  })
);

function ok(c, data) {
  return c.json({ status: 200, data });
}

function fail(c, err, status = 500) {
  console.error('[streaming-api]', err?.message || err);
  return c.json(
    { status, message: err?.message || 'Internal error' },
    status
  );
}

app.get('/api/v2/hianime/search', async (c) => {
  try {
    const q = c.req.query('q') || '';
    const page = Number(c.req.query('page') || 1) || 1;
    if (!q.trim()) return fail(c, new Error('q is required'), 400);
    return ok(c, await searchAnime(q.trim(), page));
  } catch (e) {
    return fail(c, e);
  }
});

app.get('/api/v2/hianime/anime/:animeId/episodes', async (c) => {
  try {
    const animeId = decodeURIComponent(c.req.param('animeId'));
    return ok(c, await getEpisodes(animeId));
  } catch (e) {
    return fail(c, e, e.message?.includes('not found') ? 404 : 500);
  }
});

app.get('/api/v2/hianime/anime/:animeId', async (c) => {
  try {
    const animeId = decodeURIComponent(c.req.param('animeId'));
    return ok(c, await getAnimeInfo(animeId));
  } catch (e) {
    return fail(c, e, e.message?.includes('not found') ? 404 : 500);
  }
});

app.get('/api/v2/hianime/episode/servers', async (c) => {
  try {
    const animeEpisodeId = decodeURIComponent(c.req.query('animeEpisodeId') || '');
    if (!animeEpisodeId) return fail(c, new Error('animeEpisodeId required'), 400);
    return ok(c, await getEpisodeServers(animeEpisodeId));
  } catch (e) {
    return fail(c, e);
  }
});

app.get('/api/v2/hianime/episode/sources', async (c) => {
  try {
    const animeEpisodeId = decodeURIComponent(c.req.query('animeEpisodeId') || '');
    const server = c.req.query('server') || 'hd-1';
    const category = (c.req.query('category') || 'sub');
    if (!animeEpisodeId) return fail(c, new Error('animeEpisodeId required'), 400);
    return ok(c, await getEpisodeSources(animeEpisodeId, server, category));
  } catch (e) {
    return fail(c, e);
  }
});

// Minimal stubs so older clients don't 404
app.get('/api/v2/hianime/home', (c) =>
  ok(c, {
    genres: [],
    spotlightAnimes: [],
    trendingAnimes: [],
    latestEpisodeAnimes: [],
    topUpcomingAnimes: [],
    top10Animes: { today: [], week: [], month: [] },
    topAiringAnimes: [],
    mostPopularAnimes: [],
    mostFavoriteAnimes: [],
    latestCompletedAnimes: [],
  })
);

app.get('/api/v2/proxy', async (c) => {
  const raw = c.req.query('url');
  if (!raw) return fail(c, new Error('url required'), 400);

  let targetUrl = raw;
  try {
    targetUrl = decodeURIComponent(raw);
    // eslint-disable-next-line no-new
    new URL(targetUrl);
  } catch {
    return fail(c, new Error('Invalid url'), 400);
  }

  const headerSets = [
    {
      Referer: 'https://megaplay.buzz/',
      Origin: 'https://megaplay.buzz',
    },
    {
      Referer: 'https://megaplay.buzz/',
    },
    {
      Referer: 'https://megacloud.blog/',
      Origin: 'https://megacloud.blog',
    },
    {
      Referer: 'https://anikototv.to/',
      Origin: 'https://anikototv.to',
    },
    {
      // last resort: no Referer/Origin (some CDNs only check UA)
    },
  ];

  const ua =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  let upstream = null;
  for (const headers of headerSets) {
    try {
      const res = await fetch(targetUrl, {
        headers: {
          ...headers,
          Accept: '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent': ua,
        },
        redirect: 'follow',
      });
      if (res.ok || res.status === 206) {
        upstream = res;
        break;
      }
      // Keep last non-OK so we can report real status (e.g. 403 from nexabloom)
      upstream = res;
      if (res.status !== 403) break;
    } catch (e) {
      console.error('[proxy] fetch failed', e.message);
    }
  }

  if (!upstream) return fail(c, new Error('Upstream fetch failed'), 502);
  if (!upstream.ok && upstream.status !== 206) {
    return c.json(
      { error: `Upstream ${upstream.status}`, url: targetUrl },
      502
    );
  }

  const contentType =
    upstream.headers.get('content-type') || 'application/octet-stream';
  const isM3u8 =
    targetUrl.includes('.m3u8') ||
    contentType.includes('mpegurl') ||
    contentType.includes('application/vnd.apple.mpegurl');

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  };

  if (isM3u8) {
    const text = await upstream.text();
    const base = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
    // Railway terminates TLS at the edge; c.req.url is often http:// inside the container.
    // Force https for public hosts so HTTPS sites don't get Mixed Content on rewritten URLs.
    const self = new URL(c.req.url);
    const fwdHost = (c.req.header('x-forwarded-host') || '').split(',')[0].trim();
    const host = fwdHost || self.host;
    const isLocal =
      host.startsWith('localhost') ||
      host.startsWith('127.0.0.1') ||
      host.startsWith('[::1]');
    const proto = isLocal ? 'http' : 'https';
    const proxyBase = `${proto}://${host}/api/v2/proxy?url=`;

    const rewritten = text
      .split('\n')
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
          // Rewrite URI="..." inside tags
          return line.replace(/URI="([^"]+)"/g, (_, u) => {
            const abs = u.startsWith('http') ? u : base + u;
            return `URI="${proxyBase}${encodeURIComponent(abs)}"`;
          });
        }
        const abs = trimmed.startsWith('http') ? trimmed : base + trimmed;
        return `${proxyBase}${encodeURIComponent(abs)}`;
      })
      .join('\n');

    return c.body(rewritten, 200, {
      ...cors,
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'public, max-age=60',
    });
  }

  const buf = await upstream.arrayBuffer();
  const headers = {
    ...cors,
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=3600',
  };
  const cl = upstream.headers.get('content-length');
  const cr = upstream.headers.get('content-range');
  const ar = upstream.headers.get('accept-ranges');
  if (cl) headers['Content-Length'] = cl;
  if (cr) headers['Content-Range'] = cr;
  if (ar) headers['Accept-Ranges'] = ar;

  return c.body(buf, upstream.status, headers);
});

console.log(`streaming-api (anikoto) listening on http://localhost:${PORT}`);
serve({ fetch: app.fetch, port: PORT });
