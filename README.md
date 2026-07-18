# Streaming API

HiAnime-compatible local API for `anime-world`.

**Catalog:** Anikoto  
**Playback:** Megaplay → **direct HLS** (`master.m3u8`) via native player (no iframe ads)

## Run

```bash
cd streaming-api
pnpm install
pnpm start   # http://localhost:4000
```

Point `anime-world` at it:

```
NEXT_PUBLIC_HIANIME_API_URL=http://localhost:4000
NEXT_PUBLIC_PROXY_URL=http://localhost:4000/api/v2/proxy
NEXT_PUBLIC_USE_PROXY=true
```

## How ad-free playback works

1. Search/episodes from Anikoto JSON API  
2. Episode embeds point at Megaplay  
3. API resolves `data-id` → `/stream/getSources` → `master.m3u8` + VTT subs  
4. Client plays HLS in your `VideoPlayer` (not the Megaplay iframe)  
5. `/api/v2/proxy` injects Megaplay Referer so the CDN allows segments  

If Megaplay HLS resolve fails, it falls back to the embed iframe.
