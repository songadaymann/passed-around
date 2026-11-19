import { normalizeMusicURL, platformSearches, resolveMusic } from './music.mjs';

export const sha256 = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('');
const randomToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
class APIError extends Error { constructor(status, message) { super(message); this.status = status; } }

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://*.scdn.co https://*.spotifycdn.com https://*.mzstatic.com https://*.dzcdn.net https://*.ytimg.com data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Strict-Transport-Security': 'max-age=31536000',
};

async function bodyJSON(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new APIError(415, 'Send application/json.');
  if (Number(request.headers.get('content-length')) > 24_000) throw new APIError(413, 'Request too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new APIError(400, 'A JSON body is required.');
  let text = ''; let count = 0; const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      count += value.length;
      if (count > 24_000) throw new APIError(413, 'Request too large.');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(text); } catch { throw new APIError(400, 'Invalid JSON.'); }
}

function onlyKeys(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !allowed.includes(k))) {
    throw new APIError(400, 'Only the documented music-link fields are accepted.');
  }
}

async function rateLimit(env, key, maximum, seconds = 60) {
  const window = Math.floor(Date.now() / 1000 / seconds) * seconds;
  const row = await env.DB.prepare(`INSERT INTO rate_limits(key, window, count) VALUES (?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET window=excluded.window, count=CASE WHEN rate_limits.window=excluded.window THEN rate_limits.count+1 ELSE 1 END RETURNING count`)
    .bind(key, window).first();
  if (row.count > maximum) throw new APIError(429, 'Please wait a moment before trying again.');
}

async function authenticate(request, env) {
  const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (!token) throw new APIError(401, 'Connect your collection in the Mac app first.');
  const group = await env.DB.prepare('SELECT id FROM collections WHERE token_hash=?').bind(await sha256(token)).first();
  if (!group) throw new APIError(401, 'This collection key is invalid or has been removed.');
  return group;
}

async function register(request, env) {
  if (!env.PILOT_INVITE) throw new APIError(403, 'This pilot is invite-only. You can also run your own server.');
  const body = await bodyJSON(request); onlyKeys(body, ['invite']);
  await rateLimit(env, `registration:${await sha256(request.headers.get('CF-Connecting-IP') || 'local')}`, 8, 3600);
  if (typeof body.invite !== 'string' || body.invite.length > 200 || (await sha256(body.invite)) !== (await sha256(env.PILOT_INVITE))) throw new APIError(403, 'That pilot invitation is not valid.');
  const id = crypto.randomUUID(); const token = randomToken();
  await env.DB.prepare('INSERT INTO collections(id, token_hash) VALUES (?, ?)').bind(id, await sha256(token)).run();
  return json({ collectionId: id, token, siteURL: new URL(request.url).origin }, 201);
}

async function ingest(request, env, ctx) {
  const group = await authenticate(request, env);
  await rateLimit(env, `ingest:${group.id}`, 30);
  const body = await bodyJSON(request); onlyKeys(body, ['urls']);
  if (!Array.isArray(body.urls) || body.urls.length < 1 || body.urls.length > 10) throw new APIError(400, 'Send between 1 and 10 music URLs.');
  const sources = body.urls.map(normalizeMusicURL);
  if (sources.some(s => !s)) throw new APIError(400, 'One or more links are unsupported. No links were added.');
  const statements = [];
  for (const source of new Map(sources.map(s => [s.url, s])).values()) {
    const prior = await env.DB.prepare('SELECT track_id FROM sources WHERE url=?').bind(source.url).first();
    const id = prior?.track_id || (await sha256(source.url)).slice(0, 24);
    if (!prior) {
      const label = source.platform === 'bandcamp' ? source.id.replace(/-/g, ' ') : `Finding ${source.kind === 'video' ? 'video' : source.kind} details…`;
      statements.push(env.DB.prepare('INSERT OR IGNORE INTO tracks(id,title,kind) VALUES (?,?,?)').bind(id, label, source.kind));
      statements.push(env.DB.prepare("INSERT INTO sources(url,track_id,platform,provenance) VALUES (?,?,?,'shared') ON CONFLICT(url) DO UPDATE SET provenance='shared'").bind(source.url, id, source.platform));
      statements.push(env.DB.prepare('INSERT OR IGNORE INTO resolution_jobs(track_id,source_url) VALUES (?,?)').bind(id, source.url));
    } else {
      statements.push(env.DB.prepare("UPDATE sources SET provenance='shared' WHERE url=?").bind(source.url));
    }
    statements.push(env.DB.prepare('INSERT OR IGNORE INTO shares(collection_id,track_id) VALUES (?,?)').bind(group.id, id));
  }
  await env.DB.batch(statements);
  ctx.waitUntil(enrichPending(env));
  return json({ accepted: sources.length, message: 'Music links saved. Listening links are being matched in the background.' }, 202);
}

async function feed(url, env) {
  const sort = ['recent', 'popular', 'rare'].includes(url.searchParams.get('sort')) ? url.searchParams.get('sort') : 'recent';
  const query = (url.searchParams.get('q') || '').slice(0, 150).trim();
  const platform = (url.searchParams.get('platform') || '').slice(0, 30);
  const limit = Math.min(60, Math.max(1, Math.trunc(Number(url.searchParams.get('limit'))) || 24));
  const offset = Math.min(100_000, Math.max(0, Math.trunc(Number(url.searchParams.get('offset'))) || 0));
  const conditions = ["EXISTS (SELECT 1 FROM shares WHERE track_id=t.id)"];
  const parameters = [];
  if (query) {
    conditions.push("(t.title LIKE ? ESCAPE '\\' OR t.artist LIKE ? ESCAPE '\\')");
    const escaped = query.replace(/[\\%_]/g, '\\$&'); parameters.push(`%${escaped}%`, `%${escaped}%`);
  }
  if (platform) { conditions.push('EXISTS (SELECT 1 FROM sources WHERE track_id=t.id AND platform=?)'); parameters.push(platform); }
  const order = sort === 'popular' ? 'group_count DESC,latest DESC,t.id' : sort === 'rare' ? 'group_count ASC,latest DESC,t.id' : 'latest DESC,t.id';
  const where = conditions.join(' AND ');
  const result = await env.DB.prepare(`SELECT t.*, (SELECT COUNT(*) FROM shares WHERE track_id=t.id) group_count,
    (SELECT MAX(published_at) FROM shares WHERE track_id=t.id) latest FROM tracks t WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .bind(...parameters, limit, offset).all();
  const total = await env.DB.prepare(`SELECT COUNT(*) count FROM tracks t WHERE ${where}`).bind(...parameters).first();
  const ids = result.results.map(row => row.id);
  const links = ids.length ? (await env.DB.prepare(`SELECT track_id,platform,url,provenance FROM sources WHERE track_id IN (${ids.map(() => '?').join(',')}) ORDER BY provenance DESC`).bind(...ids).all()).results : [];
  return json({ tracks: result.results.map(row => ({
    id: row.id, title: row.title, artist: row.artist, artwork: row.artwork_url,
    kind: row.kind, durationMs: row.duration_ms, status: row.status, groupCount: row.group_count,
    publishedAt: row.latest, links: links.filter(l => l.track_id === row.id).map(({ platform, url, provenance }) => ({ platform, url, provenance })),
    searches: platformSearches(row.title, row.artist),
  })), total: total.count, hasMore: offset + ids.length < total.count });
}

async function stats(env) {
  const row = await env.DB.prepare(`SELECT
    (SELECT COUNT(DISTINCT track_id) FROM shares) tracks,
    (SELECT COUNT(DISTINCT collection_id) FROM shares) groups,
    (SELECT COUNT(*) FROM (SELECT track_id FROM shares GROUP BY track_id HAVING COUNT(*)=1)) rare,
    (SELECT COUNT(*) FROM shares) connections`).first();
  return json(row);
}

async function removeCollection(request, env) {
  const group = await authenticate(request, env);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM collections WHERE id=?').bind(group.id),
    env.DB.prepare('DELETE FROM tracks WHERE NOT EXISTS (SELECT 1 FROM shares WHERE track_id=tracks.id)'),
  ]);
  return json({ removed: true });
}

async function saveResolution(env, job, result) {
  const present = await env.DB.prepare('SELECT id FROM tracks WHERE id=?').bind(job.track_id).first();
  if (!present) return;
  const placeholders = result.links.map(() => '?').join(',');
  const existing = await env.DB.prepare(`SELECT DISTINCT track_id FROM sources WHERE url IN (${placeholders})`).bind(...result.links.map(l => l.url)).all();
  const otherIDs = existing.results.map(r => r.track_id).filter(id => id !== job.track_id).sort();
  const target = otherIDs[0] || job.track_id;
  const statements = [];
  for (const id of [...new Set([job.track_id, ...otherIDs])].filter(id => id !== target)) {
    statements.push(env.DB.prepare('INSERT OR IGNORE INTO shares(collection_id,track_id,published_at) SELECT collection_id,?,published_at FROM shares WHERE track_id=?').bind(target, id));
    statements.push(env.DB.prepare('UPDATE sources SET track_id=? WHERE track_id=?').bind(target, id));
    statements.push(env.DB.prepare('DELETE FROM tracks WHERE id=?').bind(id));
  }
  statements.push(env.DB.prepare(`UPDATE tracks SET title=CASE WHEN artist='' OR ?<>'' THEN ? ELSE title END,
    artist=CASE WHEN ?<>'' THEN ? ELSE artist END,artwork_url=COALESCE(?,artwork_url),duration_ms=COALESCE(?,duration_ms),
    status=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
    .bind(result.artist, result.title, result.artist, result.artist, result.artwork, result.durationMs, result.status, target));
  for (const link of result.links) {
    statements.push(env.DB.prepare(`INSERT INTO sources(url,track_id,platform,provenance) VALUES (?,?,?,?)
      ON CONFLICT(url) DO UPDATE SET track_id=excluded.track_id,provenance=CASE WHEN sources.provenance='shared' THEN 'shared' ELSE excluded.provenance END`)
      .bind(link.url, target, link.platform, link.provenance));
  }
  if (result.retry && job.attempts < 3 && target === job.track_id) {
    statements.push(env.DB.prepare('UPDATE resolution_jobs SET available_at=?,locked_until=0 WHERE track_id=?').bind(Date.now() + 300_000 * job.attempts, job.track_id));
  } else statements.push(env.DB.prepare('DELETE FROM resolution_jobs WHERE track_id=?').bind(job.track_id));
  await env.DB.batch(statements);
}

export async function enrichPending(env) {
  const started = Date.now();
  // One resolver per minute, at most eight Apple calls per pass. This keeps the
  // no-key catalog lookup below its documented approximate 20 calls/minute.
  const lock = await env.DB.prepare(`INSERT INTO rate_limits(key,window,count) VALUES ('resolver',?,1)
    ON CONFLICT(key) DO UPDATE SET window=excluded.window WHERE rate_limits.window<? RETURNING key`)
    .bind(started + 60_000, started).first();
  if (!lock) return;
  for (let i = 0; i < 8 && Date.now() - started < 13_000; i++) {
    const now = Date.now();
    const job = await env.DB.prepare(`UPDATE resolution_jobs SET locked_until=?,attempts=attempts+1
      WHERE track_id=(SELECT track_id FROM resolution_jobs WHERE available_at<=? AND locked_until<? ORDER BY attempts,available_at LIMIT 1)
      RETURNING *`).bind(now + 120_000, now, now).first();
    if (!job) break;
    try { await saveResolution(env, job, await resolveMusic(job.source_url)); }
    catch {
      await env.DB.prepare("UPDATE tracks SET status='partial' WHERE id=?").bind(job.track_id).run();
      if (job.attempts >= 3) await env.DB.prepare('DELETE FROM resolution_jobs WHERE track_id=?').bind(job.track_id).run();
      else await env.DB.prepare('UPDATE resolution_jobs SET available_at=?,locked_until=0 WHERE track_id=?').bind(Date.now() + 300_000 * job.attempts, job.track_id).run();
    }
  }
  await env.DB.prepare("DELETE FROM rate_limits WHERE key<>'resolver' AND window<?").bind(Math.floor(Date.now() / 1000) - 86_400).run();
}

async function route(request, env, ctx) {
  const url = new URL(request.url); const path = url.pathname;
  if (['POST', 'DELETE'].includes(request.method)) {
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) throw new APIError(403, 'Cross-origin writes are not allowed.');
  }
  if (path === '/api/health' && request.method === 'GET') return json({ ok: true, version: '0.1.0' });
  if (path === '/api/config' && request.method === 'GET') return json({ sourceURL: env.SOURCE_URL, version: '0.1.0', inviteRequired: true });
  if (path === '/api/collections' && request.method === 'POST') return register(request, env);
  if (path === '/api/shares' && request.method === 'POST') return ingest(request, env, ctx);
  if (path === '/api/feed' && request.method === 'GET') return feed(url, env);
  if (path === '/api/stats' && request.method === 'GET') return stats(env);
  if (path === '/api/collection' && request.method === 'DELETE') return removeCollection(request, env);
  if (path === '/api/collection' && request.method === 'GET') {
    const group = await authenticate(request, env);
    const row = await env.DB.prepare('SELECT COUNT(*) tracks FROM shares WHERE collection_id=?').bind(group.id).first();
    return json({ connected: true, tracks: row.tracks });
  }
  if (path.startsWith('/api/')) return json({ error: 'Endpoint not found.' }, 404);
  if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'Method not allowed.' }, 405);
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env, ctx) {
    let response;
    try { response = await route(request, env, ctx); }
    catch (error) { response = json({ error: error instanceof APIError ? error.message : 'Something went wrong. Please try again.' }, error instanceof APIError ? error.status : 500); }
    const secured = new Response(response.body, response);
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) secured.headers.set(key, value);
    return secured;
  },
  async scheduled(_controller, env, ctx) { ctx.waitUntil(enrichPending(env)); },
};
