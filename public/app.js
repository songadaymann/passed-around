const $ = selector => document.querySelector(selector);
const platforms = { spotify: 'Spotify', appleMusic: 'Apple Music', youtube: 'YouTube', bandcamp: 'Bandcamp', deezer: 'Deezer', tidal: 'Tidal', soundcloud: 'SoundCloud' };
const symbols = { spotify: '◉', appleMusic: '♫', youtube: '▶', bandcamp: '▰', deezer: '▥', tidal: '◆', soundcloud: '☁' };
let state = { sort: 'recent', query: '', demo: false, tracks: [], offset: 0, hasMore: false };
let controller; let demoTracks; let debounce;

function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

function externalLink(url, attributes, children = []) {
  return el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', ...attributes }, children);
}

const palette = [['#b9a1dd', '#8d86b9'], ['#e8a77c', '#bd6a5f'], ['#d6e780', '#8fa981'], ['#9db9da', '#657f9f'], ['#e4a9c6', '#bd6e8a'], ['#e5cd82', '#ba9656']];
function placeholder(track) {
  const index = [...track.id].reduce((sum, c) => sum + c.charCodeAt(0), 0) % palette.length;
  const cover = el('div', { class: 'artwork-placeholder' }, [el('div', { class: 'cover-record' }, [el('span', { text: '♫' })])]);
  cover.style.setProperty('--cover-a', palette[index][0]); cover.style.setProperty('--cover-b', palette[index][1]);
  return cover;
}

function songCard(track) {
  const art = el('div', { class: 'artwork' });
  if (track.artwork) {
    const img = el('img', { src: track.artwork, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', width: 400, height: 400 });
    img.addEventListener('error', () => img.replaceWith(placeholder(track)), { once: true }); art.append(img);
  } else art.append(placeholder(track));
  if (track.kind !== 'track') art.append(el('span', { class: 'kind-badge', text: track.kind === 'album' ? 'Album' : 'Video' }));
  const count = `${track.groupCount} ${track.groupCount === 1 ? 'group' : 'groups'}`;
  const groupLabel = state.demo ? `Sample: ${count}` : track.groupCount === 1 ? 'A find from one group' : `Passed around ${count}`;
  const body = el('div', { class: 'card-body' }, [
    el('div', { class: 'group-count', text: groupLabel }),
    el('h3', { text: track.title }),
    el('p', { class: 'artist', text: track.artist || (track.status === 'pending' ? 'Finding the details…' : 'Shared as a music link') }),
  ]);
  const known = el('div', { class: 'known-links' });
  const byPlatform = new Map();
  for (const link of track.links || []) {
    if (!platforms[link.platform]) continue;
    if (!byPlatform.has(link.platform) || link.provenance === 'shared') byPlatform.set(link.platform, link);
  }
  for (const [platform, link] of byPlatform) {
    const provenance = link.provenance === 'shared' ? 'Shared' : 'Metadata match';
    known.append(externalLink(link.url, { class: 'listen-link', title: `${platforms[platform]} · ${provenance}`, 'aria-label': `Open ${track.title} on ${platforms[platform]} (${provenance.toLowerCase()})` }, [
      el('span', { class: 'platform-symbol', 'aria-hidden': 'true', text: symbols[platform] }),
      el('span', { text: platforms[platform] }), el('span', { class: 'link-provenance', text: `· ${provenance}` }),
    ]));
  }
  body.append(known);
  if (track.status === 'pending') body.append(el('p', { class: 'matching-note', text: 'Matching more listening links in the background.' }));
  else if (!track.artist) body.append(el('p', { class: 'matching-note', text: 'Original link kept. Other services are searches.' }));
  const searches = Object.entries(track.searches || {}).filter(([platform]) => platforms[platform] && !byPlatform.has(platform));
  if (searches.length) {
    const detail = el('details', { class: 'more-platforms' }, [el('summary', { text: 'Find on more services' })]);
    const links = el('div', { class: 'search-links' });
    for (const [platform, url] of searches) links.append(externalLink(url, { text: `Search ${platforms[platform]}` }));
    detail.append(links, el('p', { class: 'matching-note', text: 'Search results, not confirmed recording matches.' })); body.append(detail);
  }
  return el('article', { class: 'song-card' }, [art, body]);
}

function showMessage(text, retry = false) {
  const message = $('#feed-message'); message.replaceChildren(); message.hidden = false;
  message.append(el('span', { text }));
  if (retry) { const button = el('button', { class: 'text-button underlined', text: 'Try again' }); button.addEventListener('click', () => load()); message.append(button); }
}

async function fetchJSON(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error('The listening room could not be loaded.');
  return response.json();
}

async function updateStats(signal) {
  let stats;
  if (state.demo) stats = { tracks: demoTracks.length, groups: 18, rare: demoTracks.filter(t => t.groupCount === 1).length };
  else stats = await fetchJSON('/api/stats', signal);
  for (const key of ['tracks', 'groups', 'rare']) $(`#stat-${key}`).textContent = stats[key].toLocaleString();
}

async function load({ more = false, quietly = false } = {}) {
  controller?.abort(); controller = new AbortController(); const signal = controller.signal;
  $('#demo-banner').hidden = !state.demo;
  $('#feed-label').textContent = state.demo ? 'Illustrative sample collection' : 'The live collection';
  $('#feed-message').hidden = true; $('#load-more').disabled = true;
  if (!quietly) {
    $('#songs').setAttribute('aria-busy', 'true'); $('#empty-state').hidden = true;
    if (!more) $('#songs').replaceChildren(...Array.from({ length: 4 }, () => el('div', { class: 'skeleton', 'aria-hidden': 'true' })));
  }
  try {
    let result;
    if (state.demo) {
      demoTracks ||= await fetchJSON('/demo.json', signal);
      const q = state.query.toLocaleLowerCase();
      let tracks = demoTracks.filter(t => `${t.title} ${t.artist}`.toLocaleLowerCase().includes(q));
      tracks = [...tracks].sort((a, b) => state.sort === 'popular' ? b.groupCount - a.groupCount : state.sort === 'rare' ? a.groupCount - b.groupCount : b.publishedAt.localeCompare(a.publishedAt));
      result = { tracks, hasMore: false };
    } else {
      const params = new URLSearchParams({ sort: state.sort, q: state.query, offset: more ? state.offset : 0 });
      result = await fetchJSON(`/api/feed?${params}`, signal);
    }
    if (signal.aborted) return;
    state.tracks = more ? [...state.tracks, ...result.tracks] : result.tracks;
    state.offset = state.tracks.length; state.hasMore = result.hasMore;
    $('#songs').replaceChildren(...state.tracks.map(songCard));
    $('#empty-state').hidden = state.tracks.length > 0 || Boolean(state.query);
    if (!state.tracks.length && state.query) showMessage(`No songs or artists found for “${state.query}”.`);
    $('#load-more').hidden = !state.hasMore;
    await updateStats(signal);
  } catch (error) {
    if (error.name === 'AbortError') return;
    if (!more && !quietly) $('#songs').replaceChildren();
    showMessage('The collection couldn’t be loaded. Your music hasn’t gone anywhere.', true);
  } finally {
    if (!signal.aborted) { $('#songs').setAttribute('aria-busy', 'false'); $('#load-more').disabled = false; }
  }
}

const captions = {
  recent: 'The latest additions, shared by people with people.',
  popular: 'The same recording, finding its way into more contributing groups.',
  rare: 'Start with the songs shared by the fewest contributing groups.',
};
document.querySelectorAll('[data-sort]').forEach((button, index, all) => {
  button.tabIndex = index ? -1 : 0;
  button.addEventListener('click', () => {
    state.sort = button.dataset.sort;
    for (const tab of all) { tab.setAttribute('aria-selected', String(tab === button)); tab.tabIndex = tab === button ? 0 : -1; }
    $('#sort-caption').textContent = captions[state.sort]; load();
  });
  button.addEventListener('keydown', event => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? all.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length;
    all[next].focus(); all[next].click();
  });
});
$('#search').addEventListener('input', event => {
  clearTimeout(debounce); state.query = event.target.value.trim(); debounce = setTimeout(() => load(), 220);
});
$('#load-more').addEventListener('click', () => load({ more: true }));
function enterDemo() { state.demo = true; state.query = ''; $('#search').value = ''; load(); $('#collection').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); }
$('#try-demo').addEventListener('click', enterDemo); $('#empty-demo').addEventListener('click', enterDemo);
$('#leave-demo').addEventListener('click', () => { state.demo = false; load(); });
const dialog = $('#privacy-dialog');
document.querySelectorAll('[data-open-privacy]').forEach(button => button.addEventListener('click', () => dialog.showModal()));
$('.dialog-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => { if (event.target === dialog && (event.clientX < dialog.getBoundingClientRect().left || event.clientX > dialog.getBoundingClientRect().right || event.clientY < dialog.getBoundingClientRect().top || event.clientY > dialog.getBoundingClientRect().bottom)) dialog.close(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && !state.demo && !state.hasMore) load({ quietly: true }); });
setInterval(() => { if (!document.hidden && !state.demo && !state.query && state.offset <= 24) load({ quietly: true }); }, 30_000);
load();
