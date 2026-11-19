import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMusicURL, isRecordingMatch, safeArtwork, platformSearches, immediateArtwork } from '../worker/music.mjs';

test('URL boundary strips tracking while retaining actual recording IDs', () => {
  assert.equal(normalizeMusicURL('https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC?si=private#fragment').url, 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC');
  assert.equal(normalizeMusicURL('https://music.apple.com/us/album/song/123?i=456&uo=4').url, 'https://music.apple.com/us/album/song/123?i=456');
  assert.equal(normalizeMusicURL('https://youtu.be/dQw4w9WgXcQ?t=30').url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(normalizeMusicURL('https://artist.bandcamp.com/track/a-song?from=private').url, 'https://artist.bandcamp.com/track/a-song');
});

test('only catalog links on exact approved hosts are accepted', () => {
  for (const url of [
    'file:///etc/passwd', 'https://localhost/track/test', 'https://open.spotify.com.evil.test/track/4uLU6hMCjMI75M1A2tKUQC',
    'https://user:secret@open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
    'https://open.spotify.com:8443/track/4uLU6hMCjMI75M1A2tKUQC',
    'https://open.spotify.com/playlist/4uLU6hMCjMI75M1A2tKUQC', 'https://bandcamp.com/search?q=private',
    'https://music.apple.com/us/album/a/123?i=not-an-id', 'https://www.youtube.com/watch?v=bad',
  ]) assert.equal(normalizeMusicURL(url), null, url);
});

test('recording matching rejects remixes, live versions, wrong artists and unknown durations', () => {
  const song = { title: 'A Beautiful Song', artist: 'The Artist', durationMs: 200_000 };
  assert.ok(isRecordingMatch(song, { ...song, title: 'A beautiful song', durationMs: 201_500 }));
  assert.ok(!isRecordingMatch(song, { ...song, title: 'A Beautiful Song (Live)' }));
  assert.ok(!isRecordingMatch(song, { ...song, title: 'A Beautiful Song - Remix' }));
  assert.ok(!isRecordingMatch(song, { ...song, artist: 'Someone Else' }));
  assert.ok(!isRecordingMatch(song, { ...song, durationMs: 210_000 }));
  assert.ok(!isRecordingMatch(song, { ...song, durationMs: null }));
});

test('searches are encoded separately and image hosts are restricted', () => {
  const searches = platformSearches('A Song & More', 'An Artist');
  assert.ok(searches.bandcamp.startsWith('https://bandcamp.com/search?q='));
  assert.ok(searches.youtube.includes('%26'));
  assert.equal(safeArtwork('https://evil.test/spy'), null);
  assert.equal(safeArtwork('javascript:alert(1)'), null);
  assert.equal(safeArtwork('https://i.scdn.co/image/abc'), 'https://i.scdn.co/image/abc');
});

test('YouTube artwork is available from the canonical ID before metadata finishes', () => {
  assert.equal(immediateArtwork('https://youtu.be/dQw4w9WgXcQ?si=private'), 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  assert.equal(immediateArtwork('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  assert.equal(immediateArtwork('https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(immediateArtwork('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'), null);
});
