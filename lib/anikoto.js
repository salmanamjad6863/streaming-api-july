/**
 * Anikoto backend: HTML search + anikotoapi.site series JSON (megaplay embeds).
 */
import axios from 'axios';
import * as cheerio from 'cheerio';
import { resolveMegaplayEmbed } from './megaplay.js';

const SITE = process.env.ANIKOTO_SITE || 'https://anikototv.to';
const API = process.env.ANIKOTO_API || 'https://anikotoapi.site';

const http = axios.create({
  timeout: 20000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  },
});

const seriesCache = new Map();
const SERIES_TTL_MS = 10 * 60 * 1000;

function extractId(href) {
  if (!href) return null;
  return (
    href
      .replace(/^https?:\/\/[^/]+\/watch\//, '')
      .replace(/^\/watch\//, '')
      .replace(/\/ep-\d+.*$/, '')
      .replace(/^\//, '')
      .trim() || null
  );
}

function parseEpisodesMeta($, el) {
  const subText = $(el).find('.ep-status.sub span').text().trim();
  const dubText = $(el).find('.ep-status.dub span').text().trim();
  return {
    sub: subText ? parseInt(subText, 10) || 1 : null,
    dub: dubText ? parseInt(dubText, 10) || 1 : null,
  };
}

export async function searchAnime(q, page = 1) {
  const { data: html } = await http.get(`${SITE}/filter`, {
    params: { keyword: q, page },
  });
  const $ = cheerio.load(html);
  const animes = [];

  $('#list-items .item').each((_, el) => {
    const posterLink = $(el).find('.ani.poster a, a.poster').first();
    const href = posterLink.attr('href') || $(el).find('a').first().attr('href');
    const slug = extractId(href);
    const tipId =
      $(el).find('.ani.poster').attr('data-tip') ||
      $(el).find('[data-tip]').first().attr('data-tip') ||
      null;
    const nameEl = $(el).find('.name.d-title');
    const name = nameEl.attr('data-jp') || nameEl.text().trim() || '';
    if (!slug && !tipId) return;

    // Prefer numeric tipId so /series/{id} works; keep slug readable.
    const id = tipId ? `${slug || 'anime'}-${tipId}` : slug;
    animes.push({
      id,
      name,
      jname: nameEl.attr('data-jp') || null,
      poster: $(el).find('img').attr('src') || null,
      type: $(el).find('.meta .right').first().text().trim() || null,
      duration: null,
      rating: null,
      episodes: parseEpisodesMeta($, el),
      _tipId: tipId,
      _slug: slug,
    });
  });

  let currentPage = 1;
  const active = $('nav .pagination .page-item.active .page-link').text().trim();
  if (active) currentPage = parseInt(active, 10) || 1;

  let totalPages = currentPage;
  $('nav .pagination .page-item .page-link').each((_, el) => {
    const n = parseInt($(el).text().trim(), 10);
    if (!Number.isNaN(n) && n > totalPages) totalPages = n;
  });

  return {
    animes,
    mostPopularAnimes: [],
    searchQuery: q,
    searchFilters: {},
    totalPages,
    hasNextPage: currentPage < totalPages,
    currentPage,
  };
}

function numericIdFromAnimeId(animeId) {
  if (!animeId) return null;
  if (/^\d+$/.test(animeId)) return animeId;
  const m = String(animeId).match(/-(\d+)$/);
  return m ? m[1] : null;
}

async function resolveNumericId(animeId) {
  const direct = numericIdFromAnimeId(animeId);
  if (direct) return direct;

  const slug = String(animeId).replace(/\?ep=.*$/, '');
  const { data: html } = await http.get(`${SITE}/watch/${slug}`);
  const $ = cheerio.load(html);
  const id = $('#watch-main').attr('data-id');
  if (!id) throw new Error(`Could not resolve numeric id for ${animeId}`);
  return id;
}

export async function getSeries(animeId) {
  const numericId = await resolveNumericId(animeId);
  const cached = seriesCache.get(numericId);
  if (cached && Date.now() - cached.at < SERIES_TTL_MS) return cached.data;

  const { data } = await http.get(`${API}/series/${numericId}`, {
    headers: { Accept: 'application/json' },
  });
  if (!data?.ok) throw new Error(`Series not found: ${numericId}`);

  seriesCache.set(numericId, { at: Date.now(), data });
  return data;
}

export async function getAnimeInfo(animeId) {
  const series = await getSeries(animeId);
  const a = series.data.anime;
  const slug = a.slug || String(animeId);
  const id = `${slug}-${a.id}`;
  const epCount = (series.data.episodes || []).length;

  return {
    anime: [
      {
        info: {
          id,
          name: a.title,
          poster: a.poster,
          description: (a.description || '').replace(/<[^>]+>/g, ''),
          stats: {
            rating: a.rating || '',
            quality: 'HD',
            episodes: {
              sub: a.is_sub ? epCount : 0,
              dub: a.is_dub ? epCount : 0,
            },
            type: a.terms_by_type?.type?.[0] || '',
            duration: a.duration || '',
            malscore: null,
          },
        },
        moreInfo: {
          genres: a.terms_by_type?.genre || [],
          studios: (a.terms_by_type?.studios || []).join(', ') || undefined,
          status: a.status || undefined,
          aired: a.aired || undefined,
          score: null,
        },
        seasons: [],
        relatedAnimes: [],
      },
    ],
  };
}

export async function getEpisodes(animeId) {
  const series = await getSeries(animeId);
  const a = series.data.anime;
  const slug = a.slug || String(animeId).replace(/-\d+$/, '');
  const baseId = `${slug}-${a.id}`;

  const episodes = (series.data.episodes || []).map((ep) => ({
    title: ep.title || `Episode ${ep.number}`,
    episodeId: `${baseId}?ep=${ep.episode_embed_id}`,
    number: ep.number,
    isFiller: false,
  }));

  return {
    totalEpisodes: episodes.length,
    episodes,
  };
}

export async function getEpisodeServers(animeEpisodeId) {
  const { embed } = await resolveEpisodeEmbed(animeEpisodeId, 'sub');
  const hasSub = Boolean(embed?.sub);
  const hasDub = Boolean(embed?.dub);

  const server = (name) => [{ serverName: name, serverId: name === 'hd-1' ? 1 : 2 }];

  return {
    episodeId: animeEpisodeId,
    episodeNo: Number(String(animeEpisodeId).match(/[?&]ep=(\d+)/)?.[1]) || 0,
    sub: hasSub ? server('hd-1').concat(server('hd-2')) : [],
    dub: hasDub ? server('hd-1').concat(server('hd-2')) : [],
    raw: [],
  };
}

async function resolveEpisodeEmbed(animeEpisodeId, category = 'sub') {
  const [animePart, epQuery] = String(animeEpisodeId).split('?ep=');
  const embedId = epQuery || '';
  if (!animePart || !embedId) {
    throw new Error('Invalid episode id (expected animeId?ep=embedId)');
  }

  const series = await getSeries(animePart);
  const ep = (series.data.episodes || []).find(
    (e) => String(e.episode_embed_id) === String(embedId)
  );
  if (!ep) throw new Error(`Episode embed ${embedId} not found`);

  const embed = ep.embed_url || {};
  const url =
    embed[category] ||
    embed.sub ||
    embed.dub ||
    Object.values(embed).find(Boolean) ||
    null;

  return { embed, url, ep, anime: series.data.anime };
}

export async function getEpisodeSources(animeEpisodeId, _server = 'hd-1', category = 'sub') {
  const { url, embed } = await resolveEpisodeEmbed(animeEpisodeId, category);
  if (!url) throw new Error('No embed URL for this episode/category');

  // Prefer direct HLS (native player, no Megaplay iframe ads)
  try {
    const resolved = await resolveMegaplayEmbed(url);
    const tracks = (resolved.tracks || [])
      .filter((t) => t?.file && t.kind !== 'thumbnails')
      .map((t) => ({
        url: t.file,
        file: t.file,
        lang: t.label || t.lang || 'en',
        label: t.label || t.lang || 'English',
        kind: t.kind || 'captions',
        default: Boolean(t.default),
      }));

    const intro =
      resolved.intro && Number(resolved.intro.end) > Number(resolved.intro.start)
        ? resolved.intro
        : undefined;
    const outro =
      resolved.outro &&
      Number(resolved.outro.end) > Number(resolved.outro.start)
        ? resolved.outro
        : undefined;

    return {
      headers: resolved.headers,
      sources: [
        {
          url: resolved.m3u8,
          type: 'hls',
          quality: 'default',
        },
      ],
      tracks,
      subtitles: tracks,
      // Keep embed as soft fallback when CDN blocks native HLS / proxy
      embedURL: url,
      anilistID: null,
      malID: null,
      intro,
      outro,
      _embeds: embed,
    };
  } catch (err) {
    console.warn('[megaplay] HLS resolve failed, falling back to embed:', err.message);
    return {
      headers: { Referer: 'https://megaplay.buzz/' },
      sources: [],
      tracks: [],
      subtitles: [],
      embedURL: url,
      anilistID: null,
      malID: null,
      _embeds: embed,
    };
  }
}
