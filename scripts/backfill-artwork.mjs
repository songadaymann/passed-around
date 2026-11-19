// Repair public catalog metadata only. This never opens Messages, reads collection
// credentials, or changes shares/collection membership. Dry-run unless --apply.
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { resolveMusic } from '../worker/music.mjs';

const site = process.argv.find(arg => arg.startsWith('https://'));
if (!site) throw new Error('Usage: node scripts/backfill-artwork.mjs https://your-site [--apply]');
const getPage = async offset => {
  const response = await fetch(new URL(`/api/feed?limit=60&offset=${offset}`, site));
  if (!response.ok) throw new Error(`Public catalog returned ${response.status}`);
  return response.json();
};
const first = await getPage(0);
if (first.total > 10_000) throw new Error('Use a paginated maintenance run for a catalog over 10,000 records.');
const pages = await Promise.all(Array.from({ length: Math.ceil(first.total / 60) - 1 }, (_, i) => getPage((i + 1) * 60)));
const candidates = [first, ...pages].flatMap(page => page.tracks).filter(track => !track.artwork || track.status === 'pending' || track.title.startsWith('Finding '));
const updates = []; let next = 0; let missing = 0;
const beforeRequest = url => {
  // This repair is for source metadata/artwork. Leave cross-service matching to
  // the Worker's globally paced resolver, not a second independent quota user.
  if (url.hostname === 'api.deezer.com' && url.pathname === '/search') return Date.now() + 60_000;
  if (url.hostname === 'itunes.apple.com' && url.pathname === '/search') return Date.now() + 60_000;
  return 0;
};
await Promise.all(Array.from({ length: 3 }, async () => {
  while (next < candidates.length) {
    const track = candidates[next++];
    const source = track.links.find(link => link.provenance === 'shared');
    if (!source) { missing++; continue; }
    try {
      const result = await resolveMusic(source.url, { beforeRequest });
      if (!result.artwork) { missing++; continue; }
      const hasTitle = !/^(Finding |Shared (?:track|album|video) on )/.test(result.title);
      updates.push({ id: track.id, artwork: result.artwork, title: hasTitle || track.title.startsWith('Finding ') ? result.title : null,
        artist: result.artist || null, duration: result.durationMs, status: hasTitle ? result.artist ? 'ready' : 'partial' : 'partial' });
    } catch { missing++; }
    await new Promise(done => setTimeout(done, 350));
  }
}));

const quote = value => value === null || value === undefined ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
const sql = updates.map(item => `UPDATE tracks SET artwork_url=${quote(item.artwork)},title=COALESCE(${quote(item.title)},title),artist=COALESCE(${quote(item.artist)},artist),duration_ms=COALESCE(${quote(item.duration)},duration_ms),status=${quote(item.status)},updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=${quote(item.id)};`).join('\n');
await mkdir('.local', { recursive: true, mode: 0o700 });
const path = resolve('.local/artwork-backfill.sql');
await writeFile(path, sql, { mode: 0o600 });
console.log(JSON.stringify({ reviewed: candidates.length, artworkUpdates: updates.length, noProviderArtwork: missing, apply: process.argv.includes('--apply') }));
if (process.argv.includes('--apply') && updates.length) {
  const child = spawn(resolve('node_modules/.bin/wrangler'), ['d1', 'execute', 'DB', '--remote', '--file', path, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stdout.on('data', () => {}); child.stderr.on('data', bytes => { errors += bytes.toString(); });
  const code = await new Promise((done, reject) => { child.on('error', reject); child.on('close', done); });
  if (code !== 0) throw new Error(`Artwork update failed (${code}); inspect the local SQL file and Wrangler logs.`);
  console.log('Updated public song metadata and artwork. Group contributions were not modified.');
}
