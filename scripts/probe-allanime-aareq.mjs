/**
 * Prove AllAnime aaReq + episode sources decrypt works.
 */
import crypto from 'crypto';
import axios from 'axios';

const API = 'https://api.allanime.day/api';
const REF = 'https://youtu-chan.com';
const QUERY_HASH =
  'd405d0edd690624b66baba3068e0edc3ac90f1597d898a1ec8db4e5c43c00fec';
const EPOCH = 4128;
const BUILD_ID = '9';

function getKey() {
  const partA = Buffer.from(
    'b1a9a4d051988f1b1b12dbb747439d9bd64b09ea17835600a7eaa4de87c1ad87',
    'hex'
  );
  const partB = Buffer.from('k7DLdv5SGiuEyGUtcncl5wQOR7r4aenLfDV3AOBKlAU=', 'base64');
  const key = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) key[i] = partA[i] ^ partB[i];
  return key;
}

function makeAaReq(qh = QUERY_HASH) {
  const ts = Math.floor((Date.now() * 1) / 300_000) * 300_000;
  // match Python: floor((time.time()*1000)/300000)*300000
  const ts2 = Math.floor(Date.now() / 300_000) * 300_000;
  const useTs = ts2;
  const base = {
    v: 1,
    ts: useTs,
    epoch: EPOCH,
    buildId: BUILD_ID,
    qh,
  };
  const K = Buffer.from(`${EPOCH}:${BUILD_ID}:${qh}:${useTs}`);
  const IV = crypto.createHash('sha256').update(K).digest().subarray(0, 12);
  const KEY = getKey();
  const jsonBlob = JSON.stringify(base);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, IV);
  const enc = Buffer.concat([cipher.update(jsonBlob, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([0x01]), IV, enc, tag]).toString('base64');
}

function decryptTobeparsed(b64) {
  const KEY = getKey();
  const buf = Buffer.from(b64, 'base64');
  // blob = [1][12 IV][ciphertext][16 tag]
  const iv = buf.subarray(1, 13);
  const tag = buf.subarray(buf.length - 16);
  const ciphertext = buf.subarray(13, buf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

const HEX_MAP = {
  '79': 'A', '7a': 'B', '7b': 'C', '7c': 'D', '7d': 'E', '7e': 'F', '7f': 'G',
  '70': 'H', '71': 'I', '72': 'J', '73': 'K', '74': 'L', '75': 'M', '76': 'N', '77': 'O',
  '68': 'P', '69': 'Q', '6a': 'R', '6b': 'S', '6c': 'T', '6d': 'U', '6e': 'V', '6f': 'W',
  '60': 'X', '61': 'Y', '62': 'Z',
  '59': 'a', '5a': 'b', '5b': 'c', '5c': 'd', '5d': 'e', '5e': 'f', '5f': 'g',
  '50': 'h', '51': 'i', '52': 'j', '53': 'k', '54': 'l', '55': 'm', '56': 'n', '57': 'o',
  '48': 'p', '49': 'q', '4a': 'r', '4b': 's', '4c': 't', '4d': 'u', '4e': 'v', '4f': 'w',
  '40': 'x', '41': 'y', '42': 'z',
  '08': '0', '09': '1', '0a': '2', '0b': '3', '0c': '4', '0d': '5', '0e': '6', '0f': '7',
  '00': '8', '01': '9',
  '15': '-', '16': '.', '67': '_', '46': '~', '02': ':', '17': '/', '07': '?',
  '1b': '#', '63': '[', '65': ']', '78': '@', '19': '!', '1c': '$', '1e': '&',
  '10': '(', '11': ')', '12': '*', '13': '+', '14': ',', '03': ';', '05': '=', '1d': '%',
};

function decodeAllanimeUrl(src) {
  if (!src?.startsWith('--')) return src;
  const hex = src.slice(2);
  let out = '';
  for (let i = 0; i < hex.length; i += 2) {
    const pair = hex.slice(i, i + 2);
    if (pair === '--') {
      out += '\n';
      continue;
    }
    out += HEX_MAP[pair] ?? '';
  }
  return out.replaceAll('/clock', '/clock.json');
}

const http = axios.create({
  timeout: 30000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Referer: REF,
    Origin: REF,
  },
});

// Search for exact Naruto
const search = await http.post(
  API,
  {
    query: `query ($search: SearchInput, $limit: Int, $page: Int, $translationType: VaildTranslationTypeEnumType, $countryOrigin: VaildCountryOriginEnumType) {
      shows(search: $search, limit: $limit, page: $page, translationType: $translationType, countryOrigin: $countryOrigin) {
        edges { _id name availableEpisodes thumbnail }
      }
    }`,
    variables: {
      search: { query: 'Naruto', allowAdult: false, allowUnknown: false },
      limit: 15,
      page: 1,
      translationType: 'sub',
      countryOrigin: 'ALL',
    },
  },
  { headers: { 'Content-Type': 'application/json', Referer: 'https://allmanga.to' } }
);

const edges = search.data?.data?.shows?.edges || [];
const pick =
  edges.find((e) => e.name === 'Naruto' && (e.availableEpisodes?.sub || 0) >= 200) ||
  edges.find((e) => e.name === 'Naruto') ||
  edges[0];
console.log('pick', pick?.name, pick?._id, pick?.availableEpisodes);

const aaReq = makeAaReq();
const variables = JSON.stringify({
  showId: pick._id,
  translationType: 'sub',
  episodeString: '1',
});
const extensions = JSON.stringify({
  persistedQuery: { version: 1, sha256Hash: QUERY_HASH },
  aaReq,
});

const { data: raw } = await http.get(API, {
  params: { variables, extensions },
  headers: { Referer: REF, Origin: REF },
});

console.log('errors', raw?.errors?.[0]?.message || null);
console.log('has tobeparsed', Boolean(raw?.tobeparsed));
console.log('has data.episode', Boolean(raw?.data?.episode));

let episode = raw?.data?.episode;
if (raw?.tobeparsed) {
  const plain = decryptTobeparsed(raw.tobeparsed);
  console.log('decrypted snippet', plain.slice(0, 400));
  const parsed = JSON.parse(plain);
  episode = parsed?.data?.episode || parsed?.episode || parsed;
}

const sources = episode?.sourceUrls || [];
console.log('source count', sources.length);
for (const s of sources.slice(0, 8)) {
  const decoded = decodeAllanimeUrl(s.sourceUrl);
  console.log('-', s.sourceName, s.type, 'prio', s.priority);
  console.log('  raw', String(s.sourceUrl).slice(0, 80));
  console.log('  dec', String(decoded).slice(0, 120));
}

// Try resolve first clock.json style link
const clock = sources
  .map((s) => ({ ...s, url: decodeAllanimeUrl(s.sourceUrl) }))
  .find((s) => String(s.url).includes('clock.json') || String(s.url).includes('/clock'));
if (clock) {
  let url = clock.url;
  if (url.startsWith('/')) url = `https://allanime.day${url}`;
  console.log('fetch clock', url);
  try {
    const { data } = await http.get(url, { headers: { Referer: REF } });
    console.log('clock keys', Object.keys(data || {}));
    console.log('clock snippet', JSON.stringify(data).slice(0, 500));
  } catch (e) {
    console.log('clock err', e.message);
  }
}
