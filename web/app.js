/**
 * nimeku — SPA berbasis bundle universal terenkripsi.
 * Render murni lewat createElement/textContent; tidak ada innerHTML.
 * Semua URL pihak ketiga lewat safeUrl() sebelum menyentuh atribut.
 */

/* ------------------------------------------------------------------ config */

const CFG = window.NX || {};
const BUNDLE_URL = CFG.bundle || '/data/api.enc.json';
const MIRROR = CFG.mirror || 'https://r.jina.ai/https://api.mangadex.org/at-home/server/';
const UPLOADS = CFG.uploads || 'https://uploads.mangadex.org/data/';
const KEY_STORE = 'nimeku-key';
const FAV_STORE = 'nimeku-favorites';
const CITY_CACHE_PREFIX = 'nimeku-ch:';

/* ------------------------------------------------------------------ utils */

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const titleEl = $('#pageTitle');
const toastEl = $('#toast');
function setTitle(text) { $('#pageTitle').textContent = text; }
const KINDS = ['anime', 'manga', 'manhwa', 'doujin'];
const KIND_LABEL = { anime: 'Anime', manga: 'Manga', manhwa: 'Manhwa', doujin: 'Doujin' };
const SOURCE_LABEL = { gomunime: 'Gomunime', samehadaku: 'Samehadaku', mangadex: 'MangaDex', nhentai: 'NHentai' };
const PLACEHOLDER =
  'data:image/svg+xml,' +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2 3'><rect width='2' height='3' fill='#e4e2dd'/><text x='1' y='1.7' font-size='.4' font-family='Georgia' fill='#9a9d9f' text-anchor='middle'>nimeku</text></svg>",
  );

let toastTimer = 0;
function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2200);
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

/** URL hanya https dengan host nyata; javascript:/data://blok lain ditolak. */
function safeUrl(url) {
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return null;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('.')) return null;
    return parsed.toString();
  } catch { return null; }
}

function fmtNum(value) {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('id-ID').format(value);
}

function rating(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || value === null || value === undefined) return null;
  return el('span', { class: 'badge accent mono', text: `★ ${num.toFixed(2)}` });
}

function debounce(fn, ms) {
  let timer = 0;
  return () => { clearTimeout(timer); timer = setTimeout(fn, ms); };
}

/* ------------------------------------------------------------------ cache */

function storeGet(key) {
  try {
    const entry = JSON.parse(localStorage.getItem(key) || 'null');
    if (!entry) return null;
    if (entry.exp && Date.now() > entry.exp) { localStorage.removeItem(key); return null; }
    return entry.v;
  } catch { return null; }
}
function storeSet(key, value, ttlMs = 7 * 24 * 3600 * 1000) {
  try { localStorage.setItem(key, JSON.stringify({ v: value, exp: Date.now() + ttlMs })); } catch {}
}
function storeDel(key) { try { localStorage.removeItem(key); } catch {} }

/* --------------------------------------------------------------- favorit */

const favorites = new Set(JSON.parse(localStorage.getItem(FAV_STORE) || '[]'));
const favMeta = new Map(Object.entries(JSON.parse(localStorage.getItem(FAV_STORE + '-meta') || '{}')));

function persistFavorites() {
  localStorage.setItem(FAV_STORE, JSON.stringify([...favorites]));
  localStorage.setItem(FAV_STORE + '-meta', JSON.stringify(Object.fromEntries(favMeta)));
}
function toggleFavorite(key, meta) {
  if (favorites.has(key)) favorites.delete(key);
  else { favorites.add(key); if (meta) favMeta.set(key, meta); }
  persistFavorites();
  return favorites.has(key);
}

/* --------------------------------------------------------------- security */

function showCover() { $('#cover').hidden = false; }
function hideCover() { $('#cover').hidden = true; }

function onKeyDown(event) {
  const key = event.key.toLowerCase();
  const main = event.ctrlKey || event.metaKey;
  const blocked = [
    main && ['s', 'u', 'p', 'j'].includes(key),
    main && event.shiftKey && ['i', 'j', 'c', 'k'].includes(key),
    event.key === 'F12',
    main && event.altKey && key === 'k',
  ].some(Boolean);
  if (blocked) {
    event.preventDefault();
    event.stopPropagation();
    toast('Shortcut itu diblokir');
  }
}

function hookSecurity() {
  document.addEventListener('contextmenu', (event) => { event.preventDefault(); toast('Klik kanan dinonaktifkan'); });
  document.addEventListener('dragstart', (event) => event.preventDefault());
  document.addEventListener('selectstart', (event) => {
    if (!event.target.closest('input,textarea')) event.preventDefault();
  });
  document.addEventListener('copy', (event) => {
    if (!event.target.closest('input,textarea')) { event.preventDefault(); toast('Salin dinonaktifkan'); }
  });
  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('beforeprint', showCover);
  window.addEventListener('afterprint', () => setTimeout(hideCover, 200));
  document.addEventListener('visibilitychange', () => (document.hidden ? showCover() : hideCover()));
  try {
    if (navigator.mediaDevices?.getDisplayMedia) {
      navigator.mediaDevices.getDisplayMedia = () => Promise.reject(new Error('Tangkapan layar diblokir'));
    }
  } catch { /* mediaDevices bisa kosong */ }
  window.open = () => null;
}

/* ------------------------------------------------------------------- data */

const DATA = {
  bundle: null,
  tax: null,
  lists: { anime: [], manga: [], manhwa: [], doujin: [] },
  byKey: new Map(),
  genreNames: { anime: new Map(), manga: new Map(), manhwa: new Map(), doujin: new Map() },
};

function itemKey(kind, source, id) { return `${kind}:${source}:${encodeURIComponent(String(id))}`; }
function parseKey(key) {
  const [kind, source, id] = key.split(':').map(decodeURIComponent);
  return { kind, source, id };
}

function prettyGenre(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return raw;
  return String(raw)
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

function resolveGenres(item, kind) {
  if (kind === 'manga' || kind === 'manhwa') {
    return (item.tags || []).map((g) => prettyGenre(g)).filter(Boolean);
  }
  if (kind === 'doujin') {
    return (item.tags || [])
      .filter((tag) => tag && tag.type === 'tag' && tag.name)
      .map((tag) => prettyGenre(tag.name))
      .filter(Boolean);
  }
  const raw = item.genres || [];
  if (kind === 'anime') {
    return raw
      .map((g) => {
        if (typeof g === 'string' && /^\d+$/.test(g)) return DATA.tax?.genre?.[g] ?? null;
        return prettyGenre(g);
      })
      .filter(Boolean);
  }
  return raw.map((g) => prettyGenre(g)).filter(Boolean);
}

function ingest(bundle) {
  DATA.bundle = bundle;
  for (const item of bundle.anime?.gomunime ?? []) ingestItem(item, 'anime', 'gomunime', item.slug);
  for (const item of bundle.anime?.samehadaku ?? []) ingestItem(item, 'anime', 'samehadaku', item.slug ?? String(item.id));
  for (const item of bundle.manga ?? []) ingestItem(item, 'manga', 'mangadex', item.id);
  for (const item of bundle.manhwa ?? []) ingestItem(item, 'manhwa', 'mangadex', item.id);
  for (const item of bundle.doujin ?? []) ingestItem(item, 'doujin', 'nhentai', String(item.id));
}

function ingestItem(item, kind, source, id) {
  if (!item || !item.title || (!item.poster && !item.cover)) return;
  // samehadaku menyimpan sumber sebagai `servers`; satukan ke `players`
  if (kind === 'anime' && source === 'samehadaku') {
    item.episodes = (item.episodes ?? []).map((e) => ({
      ...e,
      players: (e.servers ?? [])
        .filter((s) => s?.embedUrl)
        .map((s) => ({ label: s.server ?? 'Server', kind: s.type ?? 'iframe', embed: s.embedUrl, live: undefined })),
    }));
  }
  const entry = {
    ...item,
    poster: item.poster || item.cover,
    key: itemKey(kind, source, id),
    kind,
    source,
    id: String(id),
    genres: resolveGenres(item, kind),
  };
  DATA.byKey.set(entry.key, entry);
  DATA.lists[kind].push(entry);
  const map = DATA.genreNames[kind];
  for (const genre of entry.genres) map.set(genre, (map.get(genre) || 0) + 1);
}

async function fetchTaxonomy() {
  try {
    const res = await fetch('/data/samehadaku/taxonomy.json');
    if (!res.ok) return null;
    const tax = await res.json();
    return tax?.genre && Object.keys(tax.genre).length > 0 ? tax : null;
  } catch { return null; }
}

class UnlockNeeded extends Error {}

async function unlockBundle(passphrase) {
  const response = await fetch(BUNDLE_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error(`api.enc.json ${response.status}`);
  const envelope = await response.json();
  if (envelope.alg !== 'AES-256-GCM') throw new Error('format bundle tidak dikenal');

  const b64 = (v) => Uint8Array.from(atob(v), (c) => c.charCodeAt(0));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'],
  );
  const cryptoKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64(envelope.kdf.salt), iterations: envelope.kdf.iterations, hash: 'SHA-256' },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
  );
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64(envelope.iv) }, cryptoKey, b64(envelope.data),
  );
  return JSON.parse(await new Response(
    new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip')),
  ).text());
}

async function bootData(pass = '', remember = true) {
  const passphrase = pass || storeGet(KEY_STORE) || CFG.passphrase || '';
  if (!passphrase) throw new UnlockNeeded();
  const bundle = await unlockBundle(passphrase);
  DATA.tax = await fetchTaxonomy();
  ingest(bundle);
  if (pass && remember) storeSet(KEY_STORE, pass, 30 * 24 * 3600 * 1000);
}

/* ----------------------------------------------------------- rekomendasi */

function likeCount(item) {
  if (item.kind === 'doujin') return item.favourites ?? 0;
  if (item.kind === 'anime') return item.episodes?.length ?? 0;
  return item.follows ?? 0;
}

function topRated(kind, count) {
  return DATA.lists[kind]
    .filter((item) => item.rating !== null && item.rating !== undefined)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, count);
}

function mostFollowed(kind, count) {
  return DATA.lists[kind].slice().sort((a, b) => likeCount(b) - likeCount(a)).slice(0, count);
}

function similar(key, kind, count = 12) {
  const base = DATA.byKey.get(key);
  if (!base) return [];
  const scored = DATA.lists[kind]
    .filter((item) => item.key !== key)
    .map((item) => {
      const shared = base.genres.filter((g) =>
        item.genres.some((h) => h.toLowerCase() === g.toLowerCase())).length;
      const overlap = base.genres.length ? shared / base.genres.length : 0;
      return { item, score: overlap * 3 + (item.rating ?? 0) / 20 + likeCount(item) / 120000 };
    })
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, count).map((pair) => pair.item);
}

/* ------------------------------------------------------------ komponen UI */

function card(item) {
  const img = el('img', {
    src: safeUrl(item.poster) || PLACEHOLDER, alt: '', loading: 'lazy',
    decoding: 'async', referrerpolicy: 'no-referrer',
  });
  img.onerror = () => { img.src = PLACEHOLDER; };
  const badgeText = item.kind === 'doujin'
    ? `${item.numPages ?? '?'} hal`
    : `${fmtNum(item.episodes?.length ?? item.chapterCount ?? item.totalEpisodes)} ${item.kind === 'manga' || item.kind === 'manhwa' ? 'ch' : 'ep'}`;
  return el('a', { class: 'card', href: `#/item/${encodeURIComponent(item.key)}` },
    img,
    el('div', { class: 'card-badge' },
      rating(item.rating) ?? el('span', { class: 'badge', text: badgeText })),
    el('h3', { text: item.title }),
  );
}

function rail(label, items, linkHref) {
  if (items.length === 0) return null;
  return el('section', { class: 'rail' },
    el('div', { class: 'rail-head' },
      el('h2', { text: label }),
      linkHref ? el('a', { class: 'link', href: linkHref, text: 'lihat semua →' }) : null,
    ),
    el('div', { class: 'cards' }, ...items.map(card)),
  );
}

function synBlock(text) {
  const syn = el('p', { class: 'detail-syn clamp', text });
  const btn = el('button', {
    type: 'button', class: 'syn-toggle', text: 'baca selengkapnya',
    onclick: () => {
      const open = syn.classList.toggle('open');
      syn.classList.toggle('clamp', !open);
      btn.textContent = open ? 'tutup' : 'baca selengkapnya';
    },
  });
  return [syn, btn];
}

/* ---------------------------------------------------------------- sidebar */

const NAV = [
  { label: 'katalog', head: true },
  { label: 'Beranda', href: '#/', icon: '⌂' },
  { label: 'Anime', href: '#/browse/anime', icon: '◗' },
  { label: 'Manga', href: '#/browse/manga', icon: '▤' },
  { label: 'Manhwa', href: '#/browse/manhwa', icon: '▥' },
  { label: 'Doujin', href: '#/browse/doujin', icon: '♥' },
  { label: 'Genre', href: '#/genres', icon: '≡' },
  { label: 'koleksi', head: true },
  { label: 'Favorit', href: '#/favorites', icon: '♥' },
  { label: 'Pengaturan', href: '#/settings' },
];

function renderSidebar() {
  const current = location.hash.split('#')[0] || '#/';
  const nav = $('#nav');
  nav.textContent = '';
  for (const entry of NAV) {
    if (entry.head) { nav.append(el('div', { class: 'nav-head', text: entry.label })); continue; }
    const link = el('a', { href: entry.href, text: entry.label });
    if (current === entry.href) link.setAttribute('aria-current', 'true');
    nav.append(link);
  }

  const counts = DATA.bundle?.counts ?? {};
  $('#sidebarFoot').textContent =
    `${fmtNum(counts.anime)} anime · ${fmtNum(counts.manga)} manga · ${fmtNum(counts.manhwa)} manhwa · ${fmtNum(counts.doujin)} doujin`;

  const tabbar = $('#tabbar');
  if (tabbar) {
    tabbar.textContent = '';
    for (const entry of [...NAV.slice(1, 7)]) {
      const link = el('a', { href: entry.href },
        el('span', { class: 'ic', text: entry.icon ?? '▤' }),
        el('span', { text: entry.label }),
      );
      if (current === entry.href) link.setAttribute('aria-current', 'true');
      tabbar.append(link);
    }
  }
}

/* ----------------------------------------------------------------- render */

function route() {
  const raw = location.hash.slice(1) || '/';
  const [, query] = raw.split('#');
  const params = new URLSearchParams(query || '');
  const args = raw.split('#')[0].split('/').filter(Boolean);
  document.body.removeAttribute('data-nav-open');
  window.scrollTo({ top: 0 });
  view.textContent = '';
  renderSidebar();

  const handlers = {
    '': () => viewHome(),
    browse: () => viewBrowse(args[1]),
    genre: () => viewGenre(args[1], decodeURIComponent(args[2] || '')),
    genres: () => viewGenres(),
    item: () => viewItem(decodeURIComponent(args[1])),
    watch: () => viewWatch(decodeURIComponent(args[1]), decodeURIComponent(args[2] ?? '')),
    read: () => viewRead(decodeURIComponent(args[1]), decodeURIComponent(args[2] ?? '-')),
    search: () => viewSearch(params.get('q') || ''),
    favorites: () => viewFavorites(),
    settings: () => viewSettings(),
  };
  (handlers[args[0] === undefined ? '' : args[0]] || handlers[''])();
  view.focus({ preventScroll: true });
}

/* ------------------------------------------------------------------ home */

function interleave(groups) {
  const pool = [];
  const max = Math.max(...groups.map((g) => g.length));
  for (let i = 0; i < max; i += 1) for (const group of groups) if (group[i]) pool.push(group[i]);
  return pool;
}

function hero(item) {
  const actions = el('div', { class: 'hero-actions' });
  if (item.kind === 'anime') {
    const first = item.episodes?.[0];
    if (first) actions.append(el('a', { class: 'btn primary', href: `#/watch/${encodeURIComponent(item.key)}/${encodeURIComponent(first.id)}`, text: '▶ Tonton ep 1' }));
  } else {
    const target = item.kind === 'doujin' ? '-' : item.chapters?.[0]?.id ?? null;
    if (target) actions.append(el('a', { class: 'btn primary', href: `#/read/${encodeURIComponent(item.key)}/${encodeURIComponent(target)}`, text: '📖 Baca sekarang' }));
  }
  actions.append(el('a', { class: 'btn', href: `#/item/${encodeURIComponent(item.key)}`, text: 'Detail' }));

  return el('section', { class: 'hero' },
    el('img', { class: 'hero-poster', src: safeUrl(item.poster) || PLACEHOLDER, alt: '', referrerpolicy: 'no-referrer' }),
    el('div', {},
      el('h2', { class: 'hero-title', text: item.title }),
      el('div', {
        class: 'hero-meta',
      },
        rating(item.rating) ?? el('span', { class: 'badge', text: 'tanpa rating' }),
        el('span', { class: 'badge', text: KIND_LABEL[item.kind] }),
        el('span', { class: 'badge', text: SOURCE_LABEL[item.source] }),
        item.year ? el('span', { class: 'badge mono', text: String(item.year) }) : null,
      ),
      ...synBlock(item.synopsis ?? item.description ?? '—'),
      actions,
    ),
  );
}

function statCard(num, label) {
  return el('div', { class: 'stat' },
    el('div', { class: 'num', text: fmtNum(num) }),
    el('div', { class: 'lbl', text: label }));
}

function statsRow() {
  const counts = DATA.bundle?.counts ?? {};
  const episodeSum = DATA.lists.anime.reduce((total, item) => total + (item.episodes?.length ?? 0), 0);
  return el('div', { class: 'stats' },
    statCard(episodeSum, 'episode streaming'),
    statCard(counts.manga, 'manga'),
    statCard(counts.manhwa, 'manhwa'),
    statCard(counts.doujin, 'doujin (halaman)'),
    statCard(counts.chapters, 'chapter manga+manhwa'),
  );
}

function viewHome() {
  setTitle('Beranda');
  view.textContent = '';
  const heroPool = topRated('manga', 12)[0] ?? mostFollowed('anime', 1)[0];
  if (heroPool) view.append(hero(heroPool));
  view.append(statsRow());
  view.append(
    rail('Rekomendasi untukmu', interleave([
      topRated('anime', 5), topRated('manga', 5), topRated('manhwa', 5), mostFollowed('doujin', 5),
    ]), '#/genres'),
    rail('Anime terpopuler', mostFollowed('anime', 18), '#/browse/anime'),
    rail('Manga terpopuler', mostFollowed('manga', 18), '#/browse/manga'),
    rail('Manhwa terpopuler', mostFollowed('manhwa', 18), '#/browse/manhwa'),
    rail('Doujin terpopuler', mostFollowed('doujin', 18), '#/browse/doujin'),
  );
}

/* ----------------------------------------------------------------- browse */

const SORTS = {
  rating: (a, b) => (b.rating ?? -1) - (a.rating ?? -1),
  like: (a, b) => likeCount(b) - likeCount(a),
  title: (a, b) => a.title.localeCompare(b.title),
  chapters: (a, b) => (b.chapterCount ?? 0) - (a.chapterCount ?? 0),
};

function browseOptions(kind) {
  if (kind === 'doujin') return [['like', 'Terfavorit'], ['rating', 'Rating'], ['title', 'Judul A→Z']];
  if (kind === 'anime') return [['rating', 'Rating'], ['like', 'Episode terbanyak'], ['title', 'Judul A→Z']];
  return [['rating', 'Rating'], ['like', 'Followers'], ['chapters', 'Chapter terbanyak'], ['title', 'Judul A→Z']];
}

function matches(item, query) {
  if (!query) return true;
  return `${item.title} ${item.altTitle ?? ''}`.toLowerCase().includes(query);
}

function checkKind(kind) {
  return KINDS.includes(kind) ? kind : 'anime';
}

function viewBrowse(rawKind) {
  const kind = checkKind(rawKind);
  setTitle(KIND_LABEL[kind]);
  const state = { q: '', sort: kind === 'doujin' ? 'like' : 'rating', shown: 48, genre: '' };
  const grid = el('div', { class: 'cards' });
  const countEl = el('span', { class: 'count' });
  const moreBtn = el('button', { class: 'btn', text: 'Tampilkan lebih banyak', onclick: () => { state.shown += 48; draw(); } });

  const sortSel = el('select', { onchange: () => { state.sort = sortSel.value; draw(); } });
  for (const [value, label] of browseOptions(kind)) sortSel.append(el('option', { value, text: label }));

  const genreSel = el('select', { onchange: () => { state.genre = genreSel.value; draw(); } },
    el('option', { value: '', text: 'Semua genre' }));
  const genres = [...DATA.genreNames[kind].entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
  for (const [genre, count] of genres) {
    genreSel.append(el('option', { value: genre, text: `${genre} (${count})` }));
  }

  function draw() {
    const pool = DATA.lists[kind]
      .filter((item) => matches(item, state.q))
      .filter((item) => state.genre === '' || item.genres?.includes(state.genre))
      .sort(SORTS[state.sort] ?? SORTS.rating);
    countEl.textContent = `${fmtNum(pool.length)} judul`;
    grid.textContent = '';
    for (const item of pool.slice(0, state.shown)) grid.append(card(item));
    if (pool.length === 0) grid.append(el('div', { class: 'empty', text: 'Tidak cocok.' }));
    moreBtn.hidden = state.shown >= pool.length;
  }

  const search = el('input', {
    type: 'search', placeholder: 'Saring cepat…',
    oninput: debounce(() => { state.q = search.value.trim().toLowerCase(); draw(); }, 220),
  });

  view.append(
    el('div', { class: 'page-head' }, el('h2', { text: KIND_LABEL[kind] }), countEl),
    el('div', { class: 'toolbar' }, search, sortSel, genreSel),
    grid,
    moreBtn,
  );
  draw();
}

/* ------------------------------------------------------------------- genre */

function viewGenres() {
  setTitle('Genre');
  view.textContent = '';
  const cols = el('div', { class: 'genre-cols' });
  for (const kind of KINDS) {
    const entries = [...DATA.genreNames[kind].entries()].sort((a, b) => b[1] - a[1]).slice(0, 80);
    if (entries.length === 0) continue;
    cols.append(el('section', { class: 'genre-panel' },
      el('h2', { text: KIND_LABEL[kind] }),
      el('div', { class: 'genre-flow' },
        ...entries.map(([genre, count]) =>
          el('a', { class: 'badge clickable', href: `#/genre/${kind}/${encodeURIComponent(genre)}`, text: `${genre} · ${count}` }))),
    ));
  }
  view.append(el('div', { class: 'page-head' }, el('h2', { text: 'Genre per jenis' })), cols);
}

function viewGenre(kind, genreName) {
  kind = checkKind(kind);
  setTitle(`${KIND_LABEL[kind]} · ${genreName}`);
  const items = DATA.lists[kind]
    .filter((item) => item.genres?.includes(genreName))
    .sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
  view.append(
    el('div', { class: 'page-head' },
      el('h2', { text: genreName }),
      el('span', { class: 'count', text: `${fmtNum(items.length)} judul · ${KIND_LABEL[kind]}` }),
      el('a', { class: 'link', href: '#/genres', text: '← genre lain' }),
    ),
    el('div', { class: 'cards' }, ...items.slice(0, 240).map(card)),
  );
}

/* ------------------------------------------------------------ detail item */

function diamond(item) {
  const rows = [];
  if (item.totalEpisodes) rows.push(['Total episode', fmtNum(item.totalEpisodes)]);
  if (item.chapterCount) rows.push(['Total chapter', fmtNum(item.chapterCount)]);
  const follows = item.follows ?? item.favourites;
  if (follows !== null && follows !== undefined) rows.push(['Pengikut', fmtNum(follows)]);
  if (item.status) rows.push(['Status', String(item.status)]);
  if (item.year) rows.push(['Tahun', String(item.year)]);
  if (rows.length === 0) return null;
  return el('dl', { class: 'kv' },
    ...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]),
  );
}

function episodeList(item) {
  const pool = (item.episodes ?? []).slice().sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  if (pool.length === 0) return el('div', { class: 'empty', text: 'Belum ada episode di bundle.' });
  const grid = el('div', { class: 'list-grid' });
  for (const episode of pool) {
    const liveCount = (episode.players ?? []).filter((p) => p.live !== false).length;
    grid.append(el('a', { class: 'ep-link', href: `#/watch/${encodeURIComponent(item.key)}/${encodeURIComponent(episode.id)}` },
      el('span', { text: `Ep ${episode.number ?? '?'}` }),
      el('span', { class: 'badge', text: `${liveCount} src` }),
    ));
  }
  return el('section', { class: 'rel' },
    el('div', { class: 'rail-head' },
      el('h2', { text: 'Episode' }),
      el('span', { class: 'count', text: `1–${pool[pool.length - 1]?.number ?? pool.length} · ${fmtNum(pool.length)} entri` })),
    grid,
  );
}

function chapterList(item) {
  const pool = (item.chapters ?? []).slice().sort((a, b) => Number(a.number) - Number(b.number));
  if (pool.length === 0) return el('div', { class: 'empty', text: 'Belum ada chapter.' });
  const grid = el('div', { class: 'list-grid' });
  for (const chapter of pool) {
    grid.append(el('a', { class: 'ep-link', href: `#/read/${encodeURIComponent(item.key)}/${encodeURIComponent(chapter.id)}` },
      el('span', { text: `Ch ${textOr(chapter.number)}` }),
      el('span', { class: 'badge', text: chapter.baked ? 'di cache' : 'live' }),
    ));
  }
  return el('section', { class: 'rel' },
    el('div', { class: 'rail-head' },
      el('h2', { text: 'Chapter' }),
      el('span', { class: 'count', text: `${fmtNum(pool.length)} · terakhir ${textOr(pool[pool.length - 1]?.number)}` })),
    grid,
  );
}

function doujinPanel(item) {
  const pages = item.pages ?? [];
  const body = pages.length
    ? el('a', { class: 'btn primary', href: `#/read/${encodeURIComponent(item.key)}/-`, text: `📖 Baca ${pages.length} halaman` })
    : el('span', { class: 'badge', text: 'Halaman belum tersedia' });
  return el('section', { class: 'rel' },
    el('div', { class: 'rail-head' }, el('h2', { text: 'Isi' })),
    body,
  );
}

function textOr(value, fallback = '?') {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}

function viewItem(key) {
  const item = DATA.byKey.get(key);
  if (!item) { viewHome(); return; }
  setTitle(item.title);

  const favBtn = el('button', {
    class: 'fav-btn',
    'aria-pressed': String(favorites.has(key)),
    text: favorites.has(key) ? '★' : '☆',
    title: favorites.has(key) ? 'Hapus dari favorit' : 'Tambah favorit',
    onclick: () => {
      const on = toggleFavorite(key, { title: item.title, poster: item.poster, kind: item.kind });
      favBtn.textContent = on ? '★' : '☆';
      favBtn.setAttribute('aria-pressed', String(on));
      toast(on ? 'Masuk favorit' : 'Keluar dari favorit');
    },
  });

  const chips = (item.genres ?? []).slice(0, 12).map((genre) =>
    el('a', { class: 'badge clickable', href: `#/genre/${item.kind}/${encodeURIComponent(genre)}`, text: genre }));

  view.append(
    el('div', { class: 'detail-top' },
      el('img', { class: 'detail-poster', src: safeUrl(item.poster) || PLACEHOLDER, alt: '', referrerpolicy: 'no-referrer' }),
      el('div', {},
        el('h2', { class: 'hero-title', text: item.title }),
        el('div', { class: 'hero-meta' },
          favBtn,
          rating(item.rating) ?? el('span', { class: 'badge', text: 'tanpa rating' }),
          el('span', { class: 'badge', text: SOURCE_LABEL[item.source] }),
          el('span', { class: 'badge', text: KIND_LABEL[item.kind] }),
        ),
        chips.length ? el('div', { class: 'chip-row' }, ...chips) : null,
        ...synBlock(item.synopsis ?? item.description ?? '—'),
        diamond(item),
      ),
    ),
    item.kind === 'anime' ? episodeList(item) : null,
    item.kind === 'manga' || item.kind === 'manhwa' ? chapterList(item) : null,
    item.kind === 'doujin' ? doujinPanel(item) : null,
    el('section', { class: 'rel' },
      el('div', { class: 'rail-head' }, el('h2', { text: `Serupa · ${KIND_LABEL[item.kind]}` })),
      el('div', { class: 'cards' }, ...similar(item.key, item.kind, 12).map(card)),
    ),
  );
}

/* ------------------------------------------------------------------ watch */

function sourcesFor(entry) {
  const out = [];
  for (const source of entry.players ?? []) {
    if (source.live === false) continue;
    if (source.kind === 'file' || source.kind === 'hls') {
      const url = safeUrl(source.file) ?? safeUrl(source.hls);
      if (url) out.push({ label: source.label || 'Video', kind: source.kind, src: url, media: true });
    } else {
      const embed = safeUrl(source.embed);
      if (embed) out.push({ label: source.label || 'Embed', kind: source.kind, src: embed, media: false });
    }
  }
  return out;
}

function viewWatch(key, epId) {
  const item = DATA.byKey.get(key);
  const episode = item?.episodes?.find((e) => String(e.id) === epId);
  if (!item || !episode) { viewHome(); return; }
  setTitle(`${item.title} · Ep ${textOr(episode.number)}`);

  const pool = (item.episodes ?? []).slice().sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  const index = pool.findIndex((e) => String(e.id) === String(episode.id));
  const goEpisode = (e) => `#/watch/${encodeURIComponent(item.key)}/${encodeURIComponent(e.id)}`;

  const sources = sourcesFor(episode);
  const tabs = el('div', { class: 'player-tabs' });
  const frame = el('div', { class: 'player-wrap' });
  const navIndex = el('input', { type: 'hidden', value: String(index) });

  if (sources.length === 0) {
    frame.append(el('div', { class: 'empty', text: 'Semua sumber episode ini terdeteksi mati. Coba episode lain.' }));
  } else {
    let active = Math.min(Number(localStorage.getItem(`nimeku-p:${episode.id}`) ?? 0), sources.length - 1);
    if (Number.isNaN(active) || active < 0) active = 0;

    const renderSource = () => {
      for (const node of tabs.children) node.setAttribute('aria-selected', 'false');
      tabs.children[active]?.setAttribute('aria-selected', 'true');
      localStorage.setItem(`nimeku-p:${episode.id}`, String(active));
      frame.textContent = '';
      const source = sources[active];
      if (source.media) {
        const video = el('video', { controls: true, playsinline: true, src: source.src, referrerpolicy: 'no-referrer' });
        video.onerror = () => {
          frame.textContent = '';
          frame.append(el('div', { class: 'empty', text: 'Video langsung gagal dimuat. Coba tab lain.' }));
        };
        frame.append(video);
      } else {
        frame.append(el('iframe', {
          src: source.src,
          referrerpolicy: 'no-referrer',
          allow: 'autoplay; fullscreen; encrypted-media; picture-in-picture',
          sandbox: 'allow-scripts allow-same-origin allow-presentation allow-forms allow-popups-to-escape-sandbox',
        }));
      }
    };

    sources.forEach((source, index2) => {
      tabs.append(el('button', {
        type: 'button', class: 'tab', text: source.label,
        onclick: () => { active = index2; renderSource(); },
      }));
    });
    renderSource();
  }

  view.append(
    el('div', { class: 'page-head' },
      el('h2', { text: `Episode ${textOr(episode.number)} · ${item.title}` }),
      el('a', { class: 'link', href: `#/item/${encodeURIComponent(item.key)}`, text: '← daftar episode' }),
      el('span', { class: 'badge', text: SOURCE_LABEL[item.source] }),
    ),
    frame,
    tabs,
    el('div', { class: 'chapter-bar' },
      index > 0
        ? el('a', { class: 'btn', href: goEpisode(pool[index - 1]), text: `← Ep ${textOr(pool[index - 1].number)}` })
        : el('span'),
      el('span'),
      index < pool.length - 1
        ? el('a', { class: 'btn', href: goEpisode(pool[index + 1]), text: `Ep ${textOr(pool[index + 1].number)} →` })
        : el('span'),
    ),
    navIndex,
  );
}

/* ------------------------------------------------------------------- read */

const CH_CACHE = (chapterId) => `${CITY_CACHE_PREFIX}${chapterId}`;
const DAY_MS = 24 * 3600 * 1000;

async function chapterImages(chapterId) {
  const cached = storeGet(CH_CACHE(chapterId));
  if (Array.isArray(cached) && cached.length) return { urls: cached, via: 'cache' };

  try {
    const bucket = await fetch(`data/mangadex/chapters/${bucketOf(chapterId)}.json`);
    if (bucket.ok) {
      const record = (await bucket.json())[chapterId];
      if (record?.hash && record?.files?.length) {
        const urls = record.files.map((file) => `${UPLOADS}${record.hash}/${file}`);
        storeSet(CH_CACHE(chapterId), urls);
        return { urls, via: 'manifest' };
      }
    }
  } catch { /* lanjut ke mirror */ }

  // MangaDex API tidak mengirim ACAO; r.jina.ai wrapper JSON untuk browser.
  const mirrorRes = await fetch(`${MIRROR}${chapterId}`, { headers: { Accept: 'application/json' } });
  if (mirrorRes.ok) {
    const wrapper = await mirrorRes.json();
    const payload = JSON.parse(wrapper?.data?.content ?? '{}');
    const hash = payload?.chapter?.hash;
    const files = payload?.chapter?.data ?? [];
    if (hash && files.length) {
      const urls = files.map((file) => `${UPLOADS}${hash}/${file}`);
      storeSet(CH_CACHE(chapterId), urls);
      return { urls, via: 'mirror' };
    }
  }
  throw new Error('Modul gambar tidak tersedia di bucket maupun mirror.');
}

function pagesGrid(urls) {
  const grid = el('div', { class: 'reader' });
  for (const url of urls) {
    const safe = safeUrl(url);
    if (!safe) continue;
    const img = el('img', { loading: 'lazy', decoding: 'async', alt: '', src: safe, referrerpolicy: 'no-referrer' });
    img.onerror = () => { img.src = PLACEHOLDER; };
    grid.append(img);
  }
  return grid;
}

function viewRead(key, chapterId) {
  const item = DATA.byKey.get(key);
  if (!item) { viewHome(); return; }
  setTitle(`Baca · ${item.title}`);

  if (item.kind === 'doujin') {
    const pages = item.pages ?? [];
    view.append(
      el('div', { class: 'reader-bar' },
        el('a', { class: 'btn ghost', href: `#/item/${encodeURIComponent(item.key)}`, text: '←' }),
        el('span', { text: `${fmtNum(pages.length)} halaman · ${item.title}` }),
      ),
      pagesGrid(pages),
    );
    return;
  }

  const pool = (item.chapters ?? []).slice().sort((a, b) => Number(a.number) - Number(b.number));
  const chapter = pool.find((c) => String(c.id) === chapterId);
  const navFromPool = (delta) => {
    if (!chapter) return null;
    const index = pool.findIndex((c) => String(c.id) === String(chapter.id));
    const target = pool[index + delta];
    return target ? `#/read/${encodeURIComponent(item.key)}/${encodeURIComponent(target.id)}` : null;
  };

  const picker = el('select', { onchange: (event) => { location.hash = `#/read/${encodeURIComponent(item.key)}/${event.target.value}`; } });
  for (const c of pool) {
    picker.append(el('option', { value: c.id, text: `Ch ${c.number}${c.volume ? ` · v${c.volume}` : ''}${c.title ? ` — ${c.title}` : ''}` }));
  }
  if (chapter) picker.value = chapter.id;

  const info = el('span', { class: 'count', text: chapter ? `Ch ${textOr(chapter.number)}` : 'Chapter tidak ada di bundle' });
  const reader = el('div', { class: 'reader' });

  view.append(
    el('div', { class: 'reader-bar' },
      el('a', { class: 'btn ghost', href: `#/item/${encodeURIComponent(item.key)}`, text: '←' }),
      picker,
      info,
    ),
    reader,
    el('div', { class: 'chapter-bar' },
      navFromPool(-1) ? el('a', { class: 'btn', href: navFromPool(-1), text: '← Prev' }) : el('span'),
      el('span'),
      navFromPool(1) ? el('a', { class: 'btn', href: navFromPool(1), text: 'Next →' }) : el('span'),
    ),
  );

  if (!chapter) {
    reader.append(el('div', { class: 'empty', text: 'Chapter tidak ada di bundle. Balik ke daftar chapter.' }));
    return;
  }
  info.textContent = 'memuat…';
  chapterImages(chapter.id)
    .then(({ urls, via }) => {
      info.textContent = `${fmtNum(urls.length)} hal · via ${via}`;
      reader.append(pagesGrid(urls));
    })
    .catch((error) => {
      info.textContent = 'gagal';
      reader.append(el('div', { class: 'empty', text: error.message }));
      reader.append(el('button', {
        class: 'btn primary', text: 'Coba lagi',
        onclick: () => { storeDel(CH_CACHE(chapter.id)); route(); },
      }));
    });
}

/* -------------------------------------------------------------- search dll */

function viewSearch(query) {
  const q = query.trim().toLowerCase();
  setTitle(q ? `Cari “${query}”` : 'Cari');
  view.textContent = '';
  if (q.length < 2) {
    view.append(el('div', { class: 'empty', text: 'Ketik minimal 2 karakter di kotak atas.' }));
    return;
  }
  let total = 0;
  for (const kind of KINDS) {
    const hits = DATA.lists[kind].filter((item) => matches(item, q));
    if (hits.length === 0) continue;
    total += hits.length;
    view.append(el('section', { class: 'hit-group' },
      el('h2', { text: `${KIND_LABEL[kind]} · ${fmtNum(hits.length)}` }),
      el('div', { class: 'cards' }, ...hits.slice(0, 24).map(card)),
    ));
  }
  if (total === 0) view.append(el('div', { class: 'empty', text: 'Tidak ada hasil.' }));
}

function viewFavorites() {
  setTitle('Favorit');
  view.textContent = '';
  const items = [...favorites].map((key) => DATA.byKey.get(key) ?? favFallback(key)).filter(Boolean);
  if (items.length === 0) {
    view.append(el('div', { class: 'empty', text: 'Belum ada favorit. Tekan ☆ di halaman judul.' }));
    return;
  }
  view.append(
    el('div', { class: 'page-head' }, el('h2', { text: 'Favoritku' }), el('span', { class: 'count', text: `${fmtNum(items.length)}` })),
    el('div', { class: 'cards' }, ...items.map(card)),
  );
}
function favFallback(key) {
  const meta = favMeta.get(key);
  if (!meta) return null;
  return { key, title: meta.title, poster: meta.poster, kind: meta.kind ?? 'anime', rating: null };
}

/* ---------------------------------------------------------------- settings */

function viewSettings() {
  setTitle('Pengaturan');
  const bundle = DATA.bundle;
  const counts = bundle?.counts ?? {};
  view.textContent = '';
  view.append(
    el('div', { class: 'page-head' }, el('h2', { text: 'Pengaturan' })),
    panel('Bundle', [
      `dibangun: ${bundle?.generatedAt ?? '—'}`,
      `${fmtNum(counts.anime)} anime · ${fmtNum(counts.manga)} manga · ${fmtNum(counts.manhwa)} manhwa · ${fmtNum(counts.doujin)} doujin`,
      `cache chapter: 7 hari`,
    ]),
    panel('Kunci', [
      btnAction('Tukar passphrase…', () => { storeDel(KEY_STORE); location.reload(); }),
      storeGet(KEY_STORE) ? null : el('span', { class: 'badge', text: 'belum tersimpan' }),
      btnAction('Ganti tema terang/gelap', () => {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        storeSet('nimeku-theme', next, 365 * 24 * 3600 * 1000);
        toast(`Tema: ${next === 'dark' ? 'gelap' : 'terang'}`);
      }),
    ]),
    panel('Data lokal', [
      btnAction('Hapus cache gambar', () => {
        Object.keys(localStorage).filter((key) => key.startsWith('nimeku-ch:')).forEach(storeDel);
        toast('Cache chapter dihapus');
      }),
      btnAction('Reset web storage', () => { localStorage.clear(); location.reload(); }),
    ]),
  );
}

function panel(title, lines) {
  const flow = el('div', { class: 'genre-flow' });
  for (const line of lines) {
    if (typeof line === 'string') flow.append(el('span', { class: 'badge', text: line }));
    else if (line) flow.append(line);
  }
  return el('section', { class: 'genre-panel' }, el('h2', { text: title }), flow);
}
function btnAction(label, fn) { return el('button', { class: 'btn', text: label, onclick: fn }); }

/* --------------------------------------------------------------- gerbang */

function showUnlock(message) {
  const root = $('#unlock');
  root.hidden = false;
  $('#unlockErr').textContent = message ?? '';
  const form = $('#unlockForm');
  if (form.dataset.wired) return;
  form.dataset.wired = '1';
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const pass = $('#unlockInput').value.trim();
    const remember = $('#unlockRemember').checked;
    try {
      await bootData(pass, remember);
      hideUnlock();
      route();
    } catch (error) {
      $('#unlockErr').textContent = error.message;
    }
  });
}
function hideUnlock() { $('#unlock').hidden = true; }

/* ------------------------------------------------------------- shell & boot */

function setupShell() {
  window.addEventListener('hashchange', route);
  $('#menuBtn').addEventListener('click', () => document.body.toggleAttribute('data-nav-open'));
  document.addEventListener('click', (event) => {
    if (document.body.hasAttribute('data-nav-open') && !event.target.closest('#sidebar, #menuBtn')) {
      document.body.removeAttribute('data-nav-open');
    }
  });
  const input = $('#searchInput');
  const go = () => {
    const q = input.value.trim();
    location.hash = `#/search#q=${encodeURIComponent(q)}`;
    route();
  };
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); go(); } });
  $('#searchGo').addEventListener('click', go);

  document.body.append(el('div', { class: 'tabbar', id: 'tabbar', role: 'navigation' }));
  const scrim = el('div', { class: 'scrim' });
  document.body.append(scrim);
  scrim.addEventListener('click', () => document.body.removeAttribute('data-nav-open'));
}

async function start() {
  document.documentElement.dataset.theme = storeGet('nimeku-theme') || 'light';
  hookSecurity();
  setupShell();
  try {
    await bootData();
    route();
  } catch (error) {
    showUnlock(error instanceof UnlockNeeded ? '' : error.message);
  }
}

start();
