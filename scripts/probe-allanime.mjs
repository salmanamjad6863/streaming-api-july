/**
 * Quick AllAnime episode source probe (persisted query + decrypt).
 * Based on ani-cli's approach.
 */
import crypto from 'crypto';
import axios from 'axios';

const API = 'https://api.allanime.day/api';
const REF = 'https://youtu-chan.com';
const QUERY_HASH =
  'd405d0edd690624b66baba3068e0edc3ac90f1597d898a1ec8db4e5c43c00fec';
const KEY = crypto.createHash('sha256').update('Xot36i3lK3:v1').digest();

const http = axios.create({
  timeout: 25000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Referer: REF,
    Origin: REF,
  },
});

function decryptTobeparsed(b64) {
  const buf = Buffer.from(b64, 'base64');
  // ani-cli: skip 1 byte version?, then 12-byte IV/ctr, then ciphertext
  // From script: dd skip=13 — first byte + 12 byte ctr
  const ctr = buf.subarray(1, 13);
  const ciphertext = buf.subarray(13);
  const iv = Buffer.concat([ctr, Buffer.from([0, 0, 0, 2])]);
  // Actually ani-cli: ctr from bytes 1-12, then openssl -iv "$ctr" — need check
  // process_response: dd skip=13, openssl -K key -iv ctr
  // Looking again at lines 243-248:
  // printf tobeparsed | base64 -d > tmp
  // dd if=tmp bs=1 skip=13 | openssl enc -d -aes-256-ctr -K key -iv ctr -nosalt -nopad
  // And ctr extracted somehow... Read more carefully from file
  const decipher = crypto.createDecipheriv('aes-256-ctr', KEY, Buffer.concat([buf.subarray(1, 13), Buffer.alloc(4)]));
  // Try standard: IV = first 16 bytes after version?
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// Hex decode map from ani-cli decrypt_allanime
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
  if (!src.startsWith('--')) return src;
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
  return out.replace(/\/clock/g, '/clock.json');
}

async function getEpisodeSources(showId, ep = '1', translationType = 'sub') {
  const variables = JSON.stringify({ showId, translationType, episodeString: String(ep) });
  const extensions = JSON.stringify({
    persistedQuery: { version: 1, sha256Hash: QUERY_HASH },
  });
  const { data } = await http.get(API, {
    params: { variables, extensions },
    headers: { Referer: REF, Origin: REF },
  });
  return data;
}

// Find a show with "Naruto" exact-ish via search POST
const search = await http.post(
  API,
  {
    query: `query ($search: SearchInput, $limit: Int, $page: Int, $translationType: VaildTranslationTypeEnumType, $countryOrigin: VaildCountryOriginEnumType) {
      shows(search: $search, limit: $limit, page: $page, translationType: $translationType, countryOrigin: $countryOrigin) {
        edges { _id name availableEpisodes }
      }
    }`,
    variables: {
      search: { query: 'Naruto', allowAdult: false, allowUnknown: false },
      limit: 10,
      page: 1,
      translationType: 'sub',
      countryOrigin: 'ALL',
    },
  },
  { headers: { 'Content-Type': 'application/json', Referer: 'https://allmanga.to' } }
);

const edges = search.data?.data?.shows?.edges || [];
const pick =
  edges.find((e) => e.name === 'Naruto') ||
  edges.find((e) => (e.availableEpisodes?.sub || 0) > 100) ||
  edges[0];
console.log('pick', pick);

const raw = await getEpisodeSources(pick._id, '1', 'sub');
console.log('raw keys', Object.keys(raw || {}), 'errors', raw?.errors?.[0]?.message);
console.log('snippet', JSON.stringify(raw).slice(0, 300));

if (raw?.tobeparsed) {
  let plain;
  try {
    plain = decryptTobeparsed(raw.tobeparsed);
    console.log('decrypted len', plain.length, plain.slice(0, 400));
  } catch (e) {
    console.log('decrypt fail', e.message);
  }
}

// Also try alternate decrypt: IV = bytes 0..15
if (raw?.tobeparsed) {
  const buf = Buffer.from(raw.tobeparsed, 'base64');
  console.log('buf len', buf.length, 'first16', buf.subarray(0, 16).toString('hex'));
  for (const [label, iv, start] of [
    ['iv1-12+pad', Buffer.concat([buf.subarray(1, 13), Buffer.alloc(4)]), 13],
    ['iv0-16', buf.subarray(0, 16), 16],
    ['iv1-17', buf.subarray(1, 17), 17],
  ]) {
    try {
      const d = crypto.createDecipheriv('aes-256-ctr', KEY, iv);
      const ct = buf.subarray(start);
      const out = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
      console.log(label, 'ok?', out.includes('sourceUrl') || out.includes('{'), out.slice(0, 200));
    } catch (e) {
      console.log(label, 'err', e.message);
    }
  }
}
