// This module receives public music URLs only. Never pass chat text to it.
export const PLATFORMS = {
  spotify: 'Spotify', appleMusic: 'Apple Music', youtube: 'YouTube',
  bandcamp: 'Bandcamp', deezer: 'Deezer', tidal: 'Tidal', soundcloud: 'SoundCloud',
};

export function normalizeMusicURL(input) {
  if (typeof input !== 'string' || input.length > 2048) return null;
  let u;
  try { u = new URL(input.trim()); } catch { return null; }
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  const path = u.pathname.replace(/\/+$/, '');
  let m;
  const result = (url, platform, kind, id = '') => ({ url, platform, kind, id });
  if (host === 'open.spotify.com' && (m = path.match(/^\/(?:intl-[a-z-]+\/)?(track|album)\/([A-Za-z0-9]{22})$/))) {
    return result(`https://open.spotify.com/${m[1]}/${m[2]}`, 'spotify', m[1], m[2]);
  }
  if (['spotify.link', 'spotify.app.link', 'apple.co'].includes(host) && /^\/[A-Za-z0-9_-]{3,100}$/.test(path)) {
    return result(`https://${host}${path}`, 'shortlink', 'track');
  }
  if (host === 'music.apple.com' && (m = path.match(/^\/[a-z]{2}\/(album|song)\/(?:[^/]+\/)?(\d+)$/))) {
    const songID = u.searchParams.get('i');
    if (songID && !/^\d+$/.test(songID)) return null;
    return result(`https://music.apple.com${path}${songID ? `?i=${songID}` : ''}`, 'appleMusic', songID || m[1] === 'song' ? 'track' : 'album', songID || m[2]);
  }
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(host)) {
    let id = host === 'youtu.be' ? path.slice(1) : path === '/watch' ? u.searchParams.get('v') : path.match(/^\/(?:shorts|live)\/([\w-]+)$/)?.[1];
    if (id && /^[\w-]{11}$/.test(id)) return result(`https://www.youtube.com/watch?v=${id}`, 'youtube', 'video', id);
  }
  if (/^[a-z0-9-]+\.bandcamp\.com$/.test(host) && (m = path.match(/^\/(track|album)\/([a-zA-Z0-9%_-]+)$/))) {
    return result(`https://${host}${path}`, 'bandcamp', m[1], m[2]);
  }
  if (['deezer.com', 'www.deezer.com'].includes(host) && (m = path.match(/^\/(?:[a-z]{2}\/)?(track|album)\/(\d+)$/))) {
    return result(`https://www.deezer.com/${m[1]}/${m[2]}`, 'deezer', m[1], m[2]);
  }
  if (['tidal.com', 'www.tidal.com', 'listen.tidal.com'].includes(host) && (m = path.match(/^\/(?:browse\/)?(track|album)\/(\d+)$/))) {
    return result(`https://tidal.com/browse/${m[1]}/${m[2]}`, 'tidal', m[1], m[2]);
  }
  if (['soundcloud.com', 'www.soundcloud.com'].includes(host) && /^\/[\w-]+\/(?:sets\/)?[\w-]+$/.test(path)) {
    return result(`https://soundcloud.com${path}`, 'soundcloud', path.includes('/sets/') ? 'album' : 'track', path);
  }
  return null;
}

export function normalizeText(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Version words remain significant: a live recording or remix is not the original.
export function isRecordingMatch(a, b) {
  if (!a.artist || !b.artist || !a.title || !b.title) return false;
  if (normalizeText(a.title) !== normalizeText(b.title)) return false;
  if (normalizeText(a.artist) !== normalizeText(b.artist)) return false;
  if (!Number.isFinite(a.durationMs) || !Number.isFinite(b.durationMs)) return false;
  return Math.abs(a.durationMs - b.durationMs) <= 2000;
}

export function safeArtwork(input) {
  try {
    const u = new URL(input);
    return u.protocol === 'https:' && /(^|\.)(scdn\.co|spotifycdn\.com|mzstatic\.com|dzcdn\.net|ytimg\.com)$/.test(u.hostname) ? u.href : null;
  } catch { return null; }
}

export function immediateArtwork(sourceURL) {
  const source = normalizeMusicURL(sourceURL);
  return source?.platform === 'youtube' ? `https://i.ytimg.com/vi/${source.id}/hqdefault.jpg` : null;
}

export class ProviderDeferredError extends Error {
  constructor(retryAt) { super('Provider lookup is waiting for its request budget.'); this.retryAt = retryAt; }
}

async function request(url, { json = true, timeout = 3500, ...options } = {}) {
  const response = await fetch(url, {
    ...options, signal: AbortSignal.timeout(timeout), redirect: 'manual',
    headers: { 'User-Agent': 'PassedAround/0.1 (+https://github.com/songadaymann/passed-around)', ...options.headers },
  });
  if (!response.ok) throw new Error(`Music provider returned ${response.status}`);
  // Limit responses before parsing. Never retain or log provider page state.
  const reader = response.body.getReader();
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 2_000_000) throw new Error('Provider response too large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const text = new TextDecoder().decode(bytes);
  return json ? JSON.parse(text) : text;
}

export async function expandMusicURL(source, beforeRequest) {
  let current = normalizeMusicURL(source);
  for (let step = 0; current?.platform === 'shortlink' && step < 4; step++) {
    const retryAt = await beforeRequest?.(new URL(current.url));
    if (retryAt) throw new ProviderDeferredError(retryAt);
    const response = await fetch(current.url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    await response.body?.cancel();
    if (![301, 302, 303, 307, 308].includes(response.status)) return null;
    const target = response.headers.get('location');
    if (!target) return null;
    current = normalizeMusicURL(new URL(target, current.url).href);
  }
  return current?.platform !== 'shortlink' ? current : null;
}

function fallback(source) {
  let title = source.id.replace(/[-_]/g, ' ');
  if (source.platform !== 'bandcamp' && source.platform !== 'soundcloud') title = `Shared ${source.kind === 'video' ? 'video' : source.kind} on ${PLATFORMS[source.platform] || 'a music service'}`;
  return { title: title.slice(0, 250), artist: '', durationMs: null, artwork: immediateArtwork(source.url), kind: source.kind };
}

async function spotify(source, lookup = request) {
  // Spotify's embed state is an undocumented enhancement. oEmbed is the fallback.
  try {
    const html = await lookup(`https://open.spotify.com/embed/${source.kind}/${source.id}`, { json: false });
    const script = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1];
    const entity = script && JSON.parse(script)?.props?.pageProps?.state?.data?.entity;
    if (entity?.title) {
      return {
        title: String(entity.title).slice(0, 250),
        artist: (entity.artists || []).map(a => a.name).filter(Boolean).join(', ').slice(0, 250),
        durationMs: Number.isFinite(entity.duration) ? entity.duration : null,
        artwork: safeArtwork(entity.visualIdentity?.image?.sort((a, b) => b.maxWidth - a.maxWidth)?.[0]?.url),
        kind: source.kind,
      };
    }
  } catch (error) { if (error instanceof ProviderDeferredError) throw error; }
  const data = await lookup(`https://open.spotify.com/oembed?url=${encodeURIComponent(source.url)}`);
  return { ...fallback(source), title: String(data.title || '').slice(0, 250) || fallback(source).title, artwork: safeArtwork(data.thumbnail_url) };
}

function appleResult(item) {
  return {
    title: item.trackName || item.collectionName,
    artist: item.artistName || '', durationMs: item.trackTimeMillis || null,
    artwork: safeArtwork(item.artworkUrl100?.replace('100x100bb', '600x600bb')),
    url: item.trackViewUrl || item.collectionViewUrl,
  };
}

async function apple(source, lookup = request) {
  const country = new URL(source.url).pathname.split('/')[1].toUpperCase();
  const data = await lookup(`https://itunes.apple.com/lookup?id=${encodeURIComponent(source.id)}&country=${country}`);
  const item = data.results?.find(r => String(r.trackId || r.collectionId) === source.id);
  if (!item) throw new Error('Apple metadata unavailable');
  return { ...appleResult(item), kind: source.kind };
}

function deezerResult(item) {
  return { title: item.title, artist: item.artist?.name || '', durationMs: item.duration ? item.duration * 1000 : null,
    artwork: safeArtwork(item.album?.cover_big || item.cover_big), url: item.link };
}

async function deezer(source, lookup = request) {
  const data = await lookup(`https://api.deezer.com/${source.kind}/${source.id}`);
  if (data.error) throw new Error('Deezer metadata unavailable');
  return { ...deezerResult(data), kind: source.kind };
}

async function youtube(source, lookup = request) {
  const data = await lookup(`https://www.youtube.com/oembed?url=${encodeURIComponent(source.url)}&format=json`);
  // The uploader is not necessarily the recording artist. Do not infer identity.
  return { ...fallback(source), title: String(data.title).slice(0, 250), artwork: safeArtwork(data.thumbnail_url) || immediateArtwork(source.url) };
}

async function soundcloud(source, lookup = request) {
  const data = await lookup(`https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(source.url)}`);
  return { ...fallback(source), title: String(data.title || fallback(source).title).slice(0, 250) };
}

export async function resolveMusic(sourceURL, { cachedMetadata, beforeRequest } = {}) {
  const source = await expandMusicURL(sourceURL, beforeRequest);
  if (!source) throw new Error('Unsupported music destination');
  const lookup = async (url, options) => {
    const retryAt = await beforeRequest?.(new URL(url));
    if (retryAt) throw new ProviderDeferredError(retryAt);
    return request(url, options);
  };
  const adapter = { spotify, appleMusic: apple, deezer, youtube, soundcloud }[source.platform];
  let metadata = cachedMetadata || fallback(source); let metadataFailed = false; let deferredUntil = 0;
  try { if (!cachedMetadata && adapter) metadata = await adapter(source, lookup); }
  catch (error) { metadataFailed = true; if (error instanceof ProviderDeferredError) deferredUntil = error.retryAt; }
  const links = [{ ...source, provenance: 'shared' }];
  // No catalog scraping, no retired Odesli API, no title-only matching.
  if (source.kind === 'track' && metadata.artist && metadata.durationMs) {
    const query = encodeURIComponent(`${metadata.artist} ${metadata.title}`);
    if (source.platform !== 'appleMusic') {
      try {
        const data = await lookup(`https://itunes.apple.com/search?term=${query}&entity=song&country=US&limit=10`);
        const candidates = (data.results || []).map(appleResult).filter(item => isRecordingMatch(metadata, item));
        if (candidates.length) {
          const match = normalizeMusicURL(candidates[0].url);
          if (match) links.push({ ...match, provenance: 'metadata' });
        }
      } catch (error) { metadataFailed = true; if (error instanceof ProviderDeferredError) deferredUntil = Math.max(deferredUntil, error.retryAt); }
    }
    if (source.platform !== 'deezer') {
      try {
        const data = await lookup(`https://api.deezer.com/search?q=${query}&limit=25`);
        const candidates = (data.data || []).map(deezerResult).filter(item => isRecordingMatch(metadata, item));
        if (candidates.length) {
          const match = normalizeMusicURL(candidates[0].url);
          if (match) links.push({ ...match, provenance: 'metadata' });
        }
      } catch (error) {
        if (error instanceof ProviderDeferredError) { metadataFailed = true; deferredUntil = Math.max(deferredUntil, error.retryAt); }
      }
    }
  }
  return { ...metadata, links, status: metadataFailed || !metadata.artist ? 'partial' : 'ready', retry: metadataFailed, deferredUntil };
}

export function platformSearches(title, artist = '') {
  const q = encodeURIComponent(`${artist} ${title}`.trim());
  return {
    spotify: `https://open.spotify.com/search/${q}`,
    appleMusic: `https://music.apple.com/us/search?term=${q}`,
    youtube: `https://www.youtube.com/results?search_query=${q}`,
    bandcamp: `https://bandcamp.com/search?q=${q}&item_type=t`,
    deezer: `https://www.deezer.com/search/${q}/track`,
    tidal: `https://listen.tidal.com/search?q=${q}`,
    soundcloud: `https://soundcloud.com/search/sounds?q=${q}`,
  };
}
