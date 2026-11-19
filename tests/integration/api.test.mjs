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
    assert.deepEqual(await (await call('/api/stats')).json(), { tracks: 1, groups: 2, rare: 0, connections: 2 });
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
