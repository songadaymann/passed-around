import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const spotify = 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC';
const apple = 'https://music.apple.com/us/album/synthetic-song/123456?i=123457';
const deezer = 'https://www.deezer.com/track/98765';
const fixtureApple = { trackName: 'Synthetic Song', artistName: 'A Test Band', trackTimeMillis: 200000, trackId: 123457, trackViewUrl: apple };

test('private collection → URL-only ingestion → cross-platform identity → aggregate public feed → removal', async () => {
  const outgoing = [];
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'app',
    modules: [
      { type: 'ESModule', path: 'worker/index.mjs', contents: await readFile('worker/index.mjs', 'utf8') },
      { type: 'ESModule', path: 'worker/music.mjs', contents: await readFile('worker/music.mjs', 'utf8') },
    ], compatibilityDate: '2026-11-19',
    d1Databases: ['DB'], bindings: { PILOT_INVITE: 'synthetic-invitation', SOURCE_URL: 'https://github.com/songadaymann/passed-around' },
    outboundService: async request => {
      const u = new URL(request.url); outgoing.push(u.href);
      if (u.hostname === 'open.spotify.com' && u.pathname.includes('/embed/')) return new Response(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { state: { data: { entity: { title: 'Synthetic Song', artists: [{ name: 'A Test Band' }], duration: 200000, visualIdentity: { image: [] } } } } } } })}</script>`);
      if (u.hostname === 'itunes.apple.com') return Response.json({ results: [fixtureApple] });
      if (u.hostname === 'api.deezer.com') return Response.json({ data: [{ title: 'Synthetic Song', artist: { name: 'A Test Band' }, duration: 200, link: deezer }] });
      throw new Error(`Unexpected outbound host: ${u.hostname}`);
    },
  }] }));
  try {
    const db = await mf.getD1Database('DB');
    const migration = await readFile('migrations/0001_initial.sql', 'utf8');
    for (const sql of migration.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(sql).run();
    const call = async (path, { method = 'GET', body, token, origin } = {}) => {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (origin) headers.Origin = origin;
      return mf.dispatchFetch(`https://passed-around.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    };
    const makeGroup = async () => {
      const r = await call('/api/collections', { method: 'POST', body: { invite: 'synthetic-invitation' } });
      assert.equal(r.status, 201); return r.json();
    };
    assert.equal((await call('/api/shares', { method: 'POST', body: { urls: [spotify] } })).status, 401);
    assert.equal((await call('/api/collections', { method: 'POST', body: { invite: 'wrong' } })).status, 403);
    const a = await makeGroup(); const b = await makeGroup();
    const rejects = await call('/api/shares', { method: 'POST', token: a.token, body: { urls: [spotify], message: 'NEVER UPLOAD PRIVATE TEXT' } });
    assert.equal(rejects.status, 400);
    assert.equal((await call('/api/shares', { method: 'POST', token: a.token, body: { urls: [spotify] }, origin: 'https://evil.test' })).status, 403);
    assert.equal((await call('/api/shares', { method: 'POST', token: a.token, body: { urls: [spotify, 'https://example.com/private'] } })).status, 400);
    assert.equal((await call('/api/stats')).status, 200);
    assert.equal((await (await call('/api/stats')).json()).tracks, 0);
    const upload = await call('/api/shares', { method: 'POST', token: a.token, body: { urls: [`${spotify}?si=PRIVATE_TRACKING`] } });
    assert.equal(upload.status, 202);
    // Wait for the background resolver against deterministic provider fixtures.
    let feed;
    for (let i = 0; i < 100; i++) {
      feed = await (await call('/api/feed')).json();
      if (feed.tracks[0]?.links.length === 3) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(feed.tracks.length, 1);
    assert.equal(feed.tracks[0].title, 'Synthetic Song', JSON.stringify(outgoing));
    assert.equal(feed.tracks[0].groupCount, 1);
    assert.equal(feed.tracks[0].links.length, 3);
    assert.ok(feed.tracks[0].links.some(l => l.platform === 'appleMusic' && l.provenance === 'metadata'));
    // Reposting on Spotify or Apple from the same group is still one group.
    assert.equal((await call('/api/shares', { method: 'POST', token: a.token, body: { urls: [spotify, apple] } })).status, 202);
    assert.equal((await call('/api/shares', { method: 'POST', token: b.token, body: { urls: [apple, deezer] } })).status, 202);
    feed = await (await call('/api/feed?sort=popular')).json();
    assert.equal(feed.tracks.length, 1); assert.equal(feed.tracks[0].groupCount, 2);
    assert.ok(feed.tracks[0].links.some(l => l.platform === 'appleMusic' && l.provenance === 'shared'));
    const encoded = JSON.stringify(feed);
    for (const secret of [a.token, b.token, a.collectionId, b.collectionId, 'PRIVATE_TRACKING', 'NEVER UPLOAD']) assert.ok(!encoded.includes(secret));
    assert.equal((await (await call('/api/feed?q=synthetic')).json()).total, 1);
    assert.equal((await (await call('/api/feed?q=missing')).json()).total, 0);
    assert.equal((await (await call('/api/feed?q=%25')).json()).total, 0);
    assert.deepEqual(await (await call('/api/stats')).json(), { tracks: 1, groups: 2, rare: 0, connections: 2, pending: 0 });
    assert.ok(outgoing.every(u => !u.includes('PRIVATE') && !u.includes('NEVER')));
    assert.equal((await call('/api/collection', { method: 'DELETE', token: a.token })).status, 200);
    assert.equal((await (await call('/api/feed')).json()).tracks[0].groupCount, 1);
    assert.equal((await call('/api/collection', { token: a.token })).status, 401);
    assert.equal((await call('/api/collection', { method: 'DELETE', token: b.token })).status, 200);
    assert.equal((await (await call('/api/feed')).json()).tracks.length, 0);
    assert.equal((await db.prepare('SELECT COUNT(*) count FROM sources').first()).count, 0);
    assert.equal((await db.prepare('SELECT COUNT(*) count FROM resolution_jobs').first()).count, 0);
  } finally { await mf.dispose(); }
});

async function artworkHarness(outboundService) {
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'artwork', modules: [
      { type: 'ESModule', path: 'worker/index.mjs', contents: await readFile('worker/index.mjs', 'utf8') },
      { type: 'ESModule', path: 'worker/music.mjs', contents: await readFile('worker/music.mjs', 'utf8') },
    ], compatibilityDate: '2026-11-19', d1Databases: ['DB'], bindings: { PILOT_INVITE: 'synthetic-invitation' }, outboundService,
  }] }));
  const db = await mf.getD1Database('DB');
  for (const sql of (await readFile('migrations/0001_initial.sql', 'utf8')).split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(sql).run();
  const registration = await mf.dispatchFetch('https://test/api/collections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invite: 'synthetic-invitation' }) });
  const group = await registration.json();
  const upload = urls => mf.dispatchFetch('https://test/api/shares', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${group.token}` }, body: JSON.stringify({ urls }) });
  const waitFor = async predicate => {
    for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 30)); }
    throw new Error('Artwork work did not finish within the test deadline.');
  };
  return { mf, db, group, upload, waitFor };
}

test('bulk import processes more than eight videos and supplies thumbnails without provider image metadata', async () => {
  let lookups = 0;
  const { mf, db, group, upload, waitFor } = await artworkHarness(async request => {
    assert.equal(new URL(request.url).hostname, 'www.youtube.com'); lookups++;
    return Response.json({ title: 'Synthetic video', thumbnail_url: '' });
  });
  try {
    const urls = [];
    for (let i = 0; i < 25; i++) {
      const id = String(i).padStart(11, '0'); const url = `https://www.youtube.com/watch?v=${id}`; urls.push(url);
      await db.batch([
        db.prepare("INSERT INTO tracks(id,title,kind) VALUES (?,'Finding video details…','video')").bind(id),
        db.prepare("INSERT INTO sources(url,track_id,platform,provenance) VALUES (?,?,'youtube','shared')").bind(url, id),
        db.prepare('INSERT INTO shares(collection_id,track_id) VALUES (?,?)').bind(group.collectionId, id),
        db.prepare('INSERT INTO resolution_jobs(track_id,source_url) VALUES (?,?)').bind(id, url),
      ]);
    }
    const before = await (await mf.dispatchFetch('https://test/api/feed?limit=60')).json();
    assert.equal(before.tracks.filter(t => t.artwork?.startsWith('https://i.ytimg.com/vi/')).length, 25);
    assert.equal((await (await mf.dispatchFetch('https://test/api/stats')).json()).pending, 25);
    assert.equal((await upload([urls[0]])).status, 202);
    await waitFor(async () => (await db.prepare('SELECT COUNT(*) count FROM resolution_jobs').first()).count === 0);
    assert.equal(lookups, 25);
    const after = await (await mf.dispatchFetch('https://test/api/feed?limit=60')).json();
    assert.ok(after.tracks.every(t => t.artwork && t.title === 'Synthetic video' && t.groupCount === 1));
    assert.equal((await (await mf.dispatchFetch('https://test/api/stats')).json()).pending, 0);
  } finally { await mf.dispose(); }
});

test('catalog quota never discards artwork or consumes retry attempts, and retries reuse saved metadata', async () => {
  let spotifyLookups = 0; let appleLookups = 0;
  const artwork = 'https://i.scdn.co/image/synthetic-cover';
  const { mf, db, upload, waitFor } = await artworkHarness(async request => {
    const host = new URL(request.url).hostname;
    if (host === 'open.spotify.com') {
      spotifyLookups++;
      return new Response(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { state: { data: { entity: { title: 'Synthetic Song', artists: [{ name: 'A Test Band' }], duration: 200000, visualIdentity: { image: [{ url: artwork, maxWidth: 640 }] } } } } } } })}</script>`);
    }
    if (host === 'itunes.apple.com') { appleLookups++; return Response.json({ results: [fixtureApple] }); }
    if (host === 'api.deezer.com') return Response.json({ data: [] });
    throw new Error('Unexpected provider');
  });
  try {
    const window = Math.floor(Date.now() / 60_000) * 60;
    await db.prepare("INSERT INTO rate_limits(key,window,count) VALUES ('provider:apple',?,16)").bind(window).run();
    assert.equal((await upload([spotify])).status, 202);
    await waitFor(async () => (await db.prepare('SELECT artwork_url FROM tracks LIMIT 1').first())?.artwork_url === artwork);
    const job = await db.prepare('SELECT * FROM resolution_jobs LIMIT 1').first();
    assert.equal(job.attempts, 0); assert.ok(job.available_at >= (window + 60) * 1000);
    assert.equal(spotifyLookups, 1); assert.equal(appleLookups, 0);
    await db.batch([
      db.prepare("UPDATE rate_limits SET window=0,count=0 WHERE key IN ('resolver','provider:apple')"),
      db.prepare('UPDATE resolution_jobs SET available_at=0'),
    ]);
    await upload([spotify]);
    await waitFor(async () => (await db.prepare('SELECT COUNT(*) count FROM resolution_jobs').first()).count === 0);
    assert.equal(spotifyLookups, 1); assert.equal(appleLookups, 1);
    assert.equal((await db.prepare('SELECT artwork_url FROM tracks LIMIT 1').first()).artwork_url, artwork);
  } finally { await mf.dispose(); }
});

test('original Apple Music artwork uses the link’s storefront instead of assuming US availability', async () => {
  let lookupCountry;
  const { mf, db, upload, waitFor } = await artworkHarness(async request => {
    const url = new URL(request.url);
    if (url.hostname === 'itunes.apple.com') {
      lookupCountry = url.searchParams.get('country');
      return Response.json({ results: [{ ...fixtureApple, artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/synthetic/100x100bb.jpg' }] });
    }
    return Response.json({ data: [] });
  });
  try {
    await upload(['https://music.apple.com/gb/album/synthetic-song/123456?i=123457']);
    await waitFor(async () => (await db.prepare('SELECT COUNT(*) count FROM resolution_jobs').first()).count === 0);
    assert.equal(lookupCountry, 'GB');
    assert.equal((await db.prepare('SELECT artwork_url FROM tracks LIMIT 1').first()).artwork_url, 'https://is1-ssl.mzstatic.com/image/thumb/synthetic/600x600bb.jpg');
  } finally { await mf.dispose(); }
});
