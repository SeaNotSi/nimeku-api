/**
 * nimeku web — hash-routed SPA over the static JSON in ../data.
 *
 * Routes:
 *   #/                      home
 *   #/anime  #/manga #/manhwa #/doujin      catalogues
 *   #/series/gomunime/:slug   #/series/samehadaku/:slug
 *   #/watch/gomunime/:slug    #/watch/samehadaku/:slug
 *   #/manga/:lane/:id         (lane=manga|manhwa)
 *   #/read/mangadex/:chapterId
 *   #/doujin/:id              #/read/nhentai/:id
 */

const DATA = new URL('data/', location.href).href;
const app = document.getElementById('app');
const content = document.getElementById('content');
const searchForm = document.getElementById('search-form');
const searchInput = document.getElementById('search-input');
const statusEl = document.getElementById('status');

/* ------------------------------------------------------------- utilities */

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

const bucketOf = (id) => (fnv1a(String(id)) % 256).toString(16).padStart(2, '0');

const jsonCache = new Map();
async function getJson(url) {
  if (jsonCache.has(url)) return jsonCache.get(url);
  const promise = fetch(url)
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status} ${url}`))))
    .catch((err) => {
      jsonCache.delete(url);
      throw err;
    });
  jsonCache.set(url, promise);
  return promise;
}

async function bucketRecord(dir, id) {
  try {
    const data = await getJson(`${DATA}${dir}/${bucketOf(id)}.json`);
    return data && data[id] !== undefined ? data[id] : null;
  } catch {
    return null;
  }
}

const listCache = new Map();
function getList(key, dir) {
  if (listCache.has(key)) return listCache.get(key);
  const state = { items: [], chunks: 0, perChunk: 500, loaded: 0, dir, ready: null };
  const api = {
    state,
    async init() {
      if (state.ready) return state.ready;
      state.ready = getJson(`${DATA}${dir}/index.json`)
        .then((idx) => {
          state.chunks = idx?.chunks ?? 0;
          state.perChunk = idx?.perChunk ?? 500;
          return state;
        })
        .catch(() => state);
      return state.ready;
    },
    async more(count = 1) {
      await api.init();
      for (let i = 0; i < count && state.loaded < state.chunks; i += 1) {
        const name = `${String(state.loaded).padStart(3, '0')}.json`;
        const chunk = await getJson(`${DATA}${dir}/${name}`).catch(() => []);
        state.items.push(...(Array.isArray(chunk) ? chunk : []));
        state.loaded += 1;
      }
      return state.items;
    },
    async all(maxChunks = 40) {
      await api.init();
      while (state.loaded < state.chunks && state.loaded < maxChunks) await api.more(4);
      return state.items;
    },
  };
  listCache.set(key, api);
  return api;
}

function fmtDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}

function card({ href, poster, title, meta = [], wide = false }) {
  return `
  <a class="card" href="${href}">
    ${poster
      ? `<img class="poster${wide ? ' landscape' : ''}" src="${esc(poster)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.style.opacity=.2" />`
      : `<div class="poster"></div>`}
    <div class="card-body">
      <div class="card-title">${esc(title)}</div>
      ${meta.length ? `<div class="card-meta">${meta.filter(Boolean).map((m) => `<span class="chip">${esc(m)}</span>`).join('')}</div>` : ''}
    </div>
  </a>`;
}

function section(title, note = '') {
  return `<div class="section-title"><h2>${esc(title)}</h2><span>${esc(note)}</span></div>`;
}

function loaderHtml(text = 'memuat…') {
  return `<div class="center muted">${esc(text)}</div>`;
}

function errorHtml(text) {
  return `<div class="center error">${esc(text)}</div>`;
}

function setActiveTab(tab) {
  for (const link of document.querySelectorAll('.tabs a')) {
    link.classList.toggle('active', link.dataset.tab === tab);
  }
}

/* ------------------------------------------------------------ list views */

const PAGE_SIZE = 60;

/* ------------------------------------------------------------- anime tab */

const gomunimeSeriesCard = (item) => card({
  href: `#/series/gomunime/${item.slug}`,
  poster: item.poster,
  title: item.title,
  meta: [item.type, item.status, item.rating ? `★ ${item.rating}` : null, item.totalEpisodes || item.episodes ? `${item.totalEpisodes || item.episodes} eps` : null],
});

let taxonomyCache = null;
async function samehadakuTaxonomy() {
  if (taxonomyCache) return taxonomyCache;
  taxonomyCache = await getJson(`${DATA}samehadaku/taxonomy.json`).catch(() => ({ genre: {} }));
  return taxonomyCache;
}

function samehadakuAnimeCard(item, taxonomy) {
  const genres = (item.genres || []).map((id) => taxonomy.genre?.[id]).filter(Boolean).slice(0, 2);
  return card({
    href: `#/series/samehadaku/${item.slug}`,
    poster: item.poster,
    title: item.title,
    meta: genres,
  });
}

function buildAnimeView() {
  return async function renderAnime(params) {
    setActiveTab('anime');
    const q = (params.get('q') || '').toLowerCase();
    const src = params.get('src') || 'gomunime';
    content.innerHTML = `
      <div class="section-title"><h2>Anime</h2><span id="count-note"></span></div>
      <div class="filters" id="source-chips">
        <button class="chip" data-src="gomunime">Gomunime</button>
        <button class="chip" data-src="samehadaku">Samehadaku</button>
      </div>
      <div class="grid" id="grid"></div>
      <div class="pager"><button class="btn" id="more">Muat lagi</button></div>`;

    for (const chip of document.querySelectorAll('#source-chips [data-src]')) {
      chip.classList.toggle('active', chip.dataset.src === src);
      chip.addEventListener('click', () => {
        location.hash = `#/anime?src=${chip.dataset.src}${q ? `&q=${encodeURIComponent(q)}` : ''}`;
      });
    }

    const grid = document.getElementById('grid');
    const noteEl = document.getElementById('count-note');
    const more = document.getElementById('more');

    if (src === 'samehadaku') {
      const taxonomy = await samehadakuTaxonomy();
      const list = getList('samehadaku-anime', 'samehadaku/anime/list');
      if (q) await list.all();
      else await list.more(2);
      const items = q ? list.state.items.filter((item) => item.title.toLowerCase().includes(q)) : list.state.items;
      let visible = PAGE_SIZE;
      const draw = () => {
        grid.innerHTML = items.slice(0, visible).map((item) => samehadakuAnimeCard(item, taxonomy)).join('') || errorHtml('kosong.');
        noteEl.textContent = `${items.length} judul`;
        more.style.display = visible < items.length ? '' : 'none';
      };
      more.onclick = async () => {
        visible += PAGE_SIZE;
        await list.more(1);
        draw();
      };
      draw();
    } else {
      const list = getList('gomunime-series', 'gomunime/list');
      if (q) await list.all();
      else await list.more(2);
      const items = q ? list.state.items.filter((item) => item.title.toLowerCase().includes(q)) : list.state.items;
      let visible = PAGE_SIZE;
      const draw = () => {
        grid.innerHTML = items.slice(0, visible).map(gomunimeSeriesCard).join('') || errorHtml('kosong.');
        noteEl.textContent = `${items.length} judul`;
        more.style.display = visible < items.length ? '' : 'none';
      };
      more.onclick = async () => {
        visible += PAGE_SIZE;
        await list.more(1);
        draw();
      };
      draw();
    }
  };
}

/* ----------------------------------------------------------- manga lanes */

function makeMangadexView(lane) {
  return async function renderMangadex(params) {
    setActiveTab(lane);
    const q = (params.get('q') || '').toLowerCase();
    content.innerHTML = `
      <div class="section-title"><h2>${lane === 'manga' ? 'Manga' : 'Manhwa'}</h2><span id="count-note"></span></div>
      <p class="muted" style="margin:0 0 14px">Sumber MangaDex. Chapter yang halamannya sudah di-cache bisa langsung dibaca; sisanya menyusul di refresh berikutnya.</p>
      <div class="grid" id="grid"></div>
      <div class="pager"><button class="btn" id="more">Muat lagi</button></div>`;
    const grid = document.getElementById('grid');
    const noteEl = document.getElementById('count-note');
    const more = document.getElementById('more');
    const list = getList(`mangadex-${lane}`, `mangadex/list/${lane}`);
    await list.all(12);
    const items = q ? list.state.items.filter((item) => item.title.toLowerCase().includes(q)) : list.state.items;
    let visible = PAGE_SIZE;
    const draw = () => {
      grid.innerHTML = items.slice(0, visible).map((item) => card({
        href: `#/manga/${lane}/${item.id}`,
        poster: item.poster,
        title: item.title,
        meta: [item.year, item.status, item.rating ? `★ ${item.rating}` : null, item.follows ? `${item.follows} follow` : null],
      })).join('') || errorHtml('kosong.');
      noteEl.textContent = `${items.length} judul`;
      more.style.display = visible < items.length ? '' : 'none';
    };
    more.onclick = () => {
      visible += PAGE_SIZE;
      draw();
    };
    draw();
  };
}

/* ------------------------------------------------------------ doujin tab */

async function renderDoujin(params) {
  setActiveTab('doujin');
  const q = (params.get('q') || '').toLowerCase();
  content.innerHTML = `
    <div class="section-title"><h2>Doujin</h2><span id="count-note">18+</span></div>
    <div class="grid" id="grid"></div>
    <div class="pager"><button class="btn" id="more">Muat lagi</button></div>`;
  const grid = document.getElementById('grid');
  const more = document.getElementById('more');
  const list = getList('nhentai', 'nhentai/list');
  if (q) await list.all();
  else await list.more(2);
  const items = q ? list.state.items.filter((item) => String(item.title).toLowerCase().includes(q)) : list.state.items;
  let visible = PAGE_SIZE;
  const draw = () => {
    grid.innerHTML = items.slice(0, visible).map((item) => card({
      href: `#/doujin/${item.id}`,
      poster: item.cover,
      title: item.title,
      meta: [item.pages ? `${item.pages} hal` : null, item.favourites ? `♥ ${item.favourites}` : null, item.detailed ? null : '—'],
    })).join('') || errorHtml('kosong.');
    more.style.display = visible < items.length ? '' : 'none';
  };
  more.onclick = async () => {
    visible += PAGE_SIZE;
    await list.more(1);
    draw();
  };
  draw();
}

/* ------------------------------------------------------------ home view */

async function renderHome() {
  setActiveTab('');
  content.innerHTML = loaderHtml();
  const [gomuEps, sameEps, mangaList, manhwaList, doujinList] = await Promise.all([
    getList('gomunime-episodes', 'gomunime/episodes/list').more(1).catch(() => []),
    getList('samehadaku-episodes', 'samehadaku/episodes/list').more(1).catch(() => []),
    getList('mangadex-manga', 'mangadex/list/manga').more(2).catch(() => []),
    getList('mangadex-manhwa', 'mangadex/list/manhwa').more(2).catch(() => []),
    getList('nhentai', 'nhentai/list').more(1).catch(() => []),
  ]);

  const latest = [
    ...gomuEps.slice(0, 12).map((ep) => ({ ...ep, source: 'gomunime', at: ep.published })),
    ...sameEps.slice(0, 12).map((ep) => ({ ...ep, source: 'samehadaku', at: ep.published })),
  ].sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, 12);

  content.innerHTML = `
    <section class="hero">
      <p class="kicker">katalog anime · manga · manhwa · doujin</p>
      <h1>Baca &amp; nonton, <span>langsung</span> dari API statis.</h1>
      <p class="lede">Data di-scrape terjadwal tiap 6 jam, disajikan sebagai JSON statis dan halaman tanpa build step. Empat sumber, satu meja.</p>
    </section>
    ${latest.length ? `
      ${section('Episode terbaru', 'gomunime + samehadaku')}
      <div class="grid">${latest.map((ep) => card({
        href: `#/watch/${ep.source}/${ep.slug}`,
        poster: ep.poster,
        title: ep.title,
        meta: [ep.series || ep.seriesTitle, ep.servers ? `${ep.servers} server` : null, fmtDate(ep.at)],
      })).join('')}</div>` : ''}
    ${mangaList.length ? `
      ${section('Manga populer', 'MangaDex')}
      <div class="grid">${mangaList.slice(0, 12).map((item) => card({
        href: `#/manga/manga/${item.id}`,
        poster: item.poster,
        title: item.title,
        meta: [item.year, item.rating ? `★ ${item.rating}` : null],
      })).join('')}</div>` : ''}
    ${manhwaList.length ? `
      ${section('Manhwa populer', 'MangaDex')}
      <div class="grid">${manhwaList.slice(0, 12).map((item) => card({
        href: `#/manga/manhwa/${item.id}`,
        poster: item.poster,
        title: item.title,
        meta: [item.year, item.rating ? `★ ${item.rating}` : null],
      })).join('')}</div>` : ''}
    ${doujinList.length ? `
      ${section('Doujin terpopuler', 'nhentai · 18+')}
      <div class="grid">${doujinList.slice(0, 12).map((item) => card({
        href: `#/doujin/${item.id}`,
        poster: item.cover,
        title: item.title,
        meta: [item.pages ? `${item.pages} hal` : null, item.favourites ? `♥ ${item.favourites}` : null],
      })).join('')}</div>` : ''}
    ${!latest.length && !mangaList.length ? errorHtml('Data belum tersedia. Jalankan scraper dulu.') : ''}`;
}

/* ---------------------------------------------------------- detail views */

async function renderGomunimeSeries(slug) {
  setActiveTab('anime');
  content.innerHTML = loaderHtml();
  const record = await bucketRecord('gomunime/series', slug);
  if (!record) {
    content.innerHTML = errorHtml('Series tidak ditemukan di cache. Jalankan refresh berikutnya.');
    return;
  }
  const episodes = (record.episodes || []).slice().sort((a, b) => (a.number || 0) - (b.number || 0));
  content.innerHTML = `
    <div class="detail">
      <div class="detail-poster"><img class="poster" src="${esc(record.poster)}" alt="" referrerpolicy="no-referrer" /></div>
      <div>
        <h1>${esc(record.title)}</h1>
        <div class="chips">${[record.type, record.status, record.rating ? `★ ${record.rating}` : null, `${episodes.length} episode`]
          .filter(Boolean).map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>
        <div class="chips">${(record.genres || []).map((g) => `<a class="chip" href="#/anime?q=${encodeURIComponent(g.replace(/-/g, ' '))}">${esc(g.replace(/-/g, ' '))}</a>`).join('')}</div>
        <p class="synopsis">${esc(record.synopsis || '')}</p>
      </div>
    </div>
    ${section('Daftar episode', `gomunime · ${episodes.length}`)}
    <div class="list">
      ${episodes.map((ep) => `<a class="row" href="#/watch/gomunime/${ep.slug}">
        <span class="num">Ep ${esc(ep.number ?? '')}</span>
        <span class="grow">${esc(record.title)} Episode ${esc(ep.number ?? '')}</span>
      </a>`).join('') || errorHtml('Belum ada episode di cache.')}
    </div>`;
}

async function renderSamehadakuSeries(slug) {
  setActiveTab('anime');
  content.innerHTML = loaderHtml();
  const [record, taxonomy] = await Promise.all([
    bucketRecord('samehadaku/anime', slug),
    samehadakuTaxonomy(),
  ]);
  if (!record) {
    content.innerHTML = errorHtml('Anime tidak ditemukan di cache. Jalankan refresh berikutnya.');
    return;
  }
  const series = await bucketRecord('samehadaku/series', slug);
  const episodes = (series?.episodes || []).slice().reverse();
  const genres = (record.genres || []).map((id) => taxonomy.genre?.[id]).filter(Boolean);
  content.innerHTML = `
    <div class="detail">
      <div class="detail-poster"><img class="poster" src="${esc(record.poster)}" alt="" referrerpolicy="no-referrer" /></div>
      <div>
        <h1>${esc(record.title)}</h1>
        <div class="chips">${[`${episodes.length} episode`, record.modified ? `update ${fmtDate(record.modified)}` : null]
          .filter(Boolean).map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>
        <div class="chips">${genres.map((g) => `<span class="chip">${esc(g)}</span>`).join('')}</div>
        <p class="synopsis">${esc(record.synopsis || '')}</p>
      </div>
    </div>
    ${section('Daftar episode', `samehadaku · ${episodes.length}`)}
    <div class="list">
      ${episodes.map((ep) => `<a class="row" href="#/watch/samehadaku/${ep.slug}">
        <span class="num">${esc(ep.slug.match(/-(\d+)$/)?.[1] ?? '')}</span>
        <span class="grow">${esc(ep.title)}</span>
        <span class="chip">${esc(fmtDate(ep.published))}</span>
      </a>`).join('') || errorHtml('Belum ada episode di cache untuk series ini.')}
    </div>`;
}

function playerBlock(players, episode) {
  if (!players.length) return errorHtml('Tidak ada server untuk episode ini.');
  const tabs = players.map((p, i) => `<button class="chip${i === 0 ? ' active' : ''}" data-idx="${i}">${esc(p.label)}</button>`).join('');
  return `
    <div class="player-wrap" id="player-stage"></div>
    <div class="filters" id="player-tabs">${tabs}</div>
    <p class="muted" id="player-note"></p>`;
}

function mountPlayer(players, index) {
  const stage = document.getElementById('player-stage');
  const note = document.getElementById('player-note');
  const player = players[index];
  if (!stage || !player) {
    if (stage) stage.innerHTML = errorHtml('Server tidak tersedia.');
    return;
  }
  const direct = player.file || null;
  const embed = player.embed || null;
  if (player.kind === 'file' && direct) {
    stage.innerHTML = `<video src="${esc(direct)}" controls autoplay playsinline style="width:100%;height:100%"></video>`;
    note.innerHTML = `Sumber langsung (mp4). <a class="muted" href="${esc(direct)}" target="_blank" rel="noopener">buka di tab baru</a>`;
  } else if (embed) {
    stage.innerHTML = `<iframe src="${esc(embed)}" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>`;
    note.innerHTML = `Diputar lewat pemutar ${esc(player.label)}. ${direct ? `<a class="muted" href="${esc(direct)}" target="_blank" rel="noopener">tautan langsung</a>` : ''}`;
  } else {
    stage.innerHTML = errorHtml('Server ini tidak punya tautan.');
    note.textContent = '';
  }
}

async function renderGomunimeWatch(slug) {
  setActiveTab('anime');
  content.innerHTML = loaderHtml();
  const ep = await bucketRecord('gomunime/episodes', slug);
  if (!ep) {
    content.innerHTML = errorHtml('Episode belum ada di cache. Nanti setelah refresh berikutnya.');
    return;
  }
  const series = ep.seriesSlug ? await bucketRecord('gomunime/series', ep.seriesSlug) : null;
  const episodes = (series?.episodes || []).slice().sort((a, b) => (a.number || 0) - (b.number || 0));
  const idx = episodes.findIndex((item) => item.slug === slug);
  const prev = idx > 0 ? episodes[idx - 1] : null;
  const next = idx >= 0 && idx < episodes.length - 1 ? episodes[idx + 1] : null;
  const players = ep.players || [];

  content.innerHTML = `
    <div class="breadcrumbs muted">
      <a href="#/anime">Anime</a> › ${series ? `<a href="#/series/gomunime/${series.slug}">${esc(series.title)}</a> ›` : ''} <span>Episode ${esc(ep.episode ?? '')}</span>
    </div>
    <h1 class="watch-title">${esc(ep.title)}</h1>
    <p class="muted" style="margin:0 0 6px">${esc(ep.series || '')} ${ep.rating ? `· ★ ${esc(ep.rating)}` : ''} ${ep.published ? `· ${esc(fmtDate(ep.published))}` : ''}</p>
    ${playerBlock(players, ep)}
    <div class="row" style="justify-content:space-between;border:0;background:transparent;padding:8px 0">
      ${prev ? `<a class="btn" href="#/watch/gomunime/${prev.slug}">‹ Episode ${esc(prev.number)}</a>` : '<span></span>'}
      ${next ? `<a class="btn primary" href="#/watch/gomunime/${next.slug}">Episode ${esc(next.number)} ›</a>` : '<span></span>'}
    </div>
    ${series ? `
      ${section(`Episode lain — ${series.title}`, '')}
      <div class="list">${episodes.slice().reverse().map((item) => `
        <a class="row${item.slug === slug ? ' is-current' : ''}" href="#/watch/gomunime/${item.slug}">
          <span class="num">Ep ${esc(item.number)}</span>
          <span class="grow">${esc(series.title)} Episode ${esc(item.number)}</span>
        </a>`).join('')}</div>` : ''}`;

  if (players.length) {
    mountPlayer(players, 0);
    document.getElementById('player-tabs')?.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-idx]');
      if (!button) return;
      for (const chip of document.querySelectorAll('#player-tabs button')) chip.classList.remove('active');
      button.classList.add('active');
      mountPlayer(players, Number(button.dataset.idx));
    });
  }
}

async function renderSamehadakuWatch(slug) {
  setActiveTab('anime');
  content.innerHTML = loaderHtml();
  const ep = await bucketRecord('samehadaku/episodes', slug);
  if (!ep) {
    content.innerHTML = errorHtml('Episode belum ada di cache. Nanti setelah refresh berikutnya.');
    return;
  }
  const seriesSlug = ep.seriesUrl ? ep.seriesUrl.replace(/\/+$/, '').split('/').pop() : null;
  const series = seriesSlug ? await bucketRecord('samehadaku/series', seriesSlug) : null;
  const episodes = (series?.episodes || []).slice();
  const idx = episodes.findIndex((item) => item.slug === slug);
  const prev = idx > 0 ? episodes[idx - 1] : null;
  const next = idx >= 0 && idx < episodes.length - 1 ? episodes[idx + 1] : null;
  const servers = (ep.servers || []).filter((s) => s.embedUrl);

  content.innerHTML = `
    <div class="breadcrumbs muted">
      <a href="#/anime?src=samehadaku">Anime</a> › ${series ? `<a href="#/series/samehadaku/${series.slug}">${esc(series.title)}</a> ›` : ''}
      <span>${esc(ep.title)}</span>
    </div>
    <h1 class="watch-title">${esc(ep.title)}</h1>
    <p class="muted" style="margin:0 0 6px">${esc(ep.seriesTitle || '')} ${ep.published ? `· ${esc(fmtDate(ep.published))}` : ''} ${servers.length ? `· ${servers.length} server` : ''}</p>
    ${servers.length ? playerBlock(servers.map((s) => ({ label: s.server, kind: 'iframe', embed: s.embedUrl })), ep) : errorHtml('Server belum ke-scrape untuk episode ini.')}
    <div class="row" style="justify-content:space-between;border:0;background:transparent;padding:8px 0">
      ${prev ? `<a class="btn" href="#/watch/samehadaku/${prev.slug}">‹ Sebelumnya</a>` : '<span></span>'}
      ${next ? `<a class="btn primary" href="#/watch/samehadaku/${next.slug}">Berikutnya ›</a>` : '<span></span>'}
    </div>
    ${(ep.downloads || []).length ? `
      ${section('Download', 'samehadaku')}
      <div class="list">${ep.downloads.map((block) => `
        <div class="row" style="flex-direction:column;align-items:stretch;gap:6px">
          <strong>${esc(block.format)}</strong>
          ${block.qualities.map((q) => `<div class="card-meta"><span class="chip">${esc(q.quality)}</span>${q.links.map((l) => `<a class="chip" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.host)}</a>`).join('')}</div>`).join('')}
        </div>`).join('')}</div>` : ''}
    ${series ? `
      ${section(`Episode lain — ${series.title}`, '')}
      <div class="list">${episodes.slice().reverse().map((item) => `
        <a class="row${item.slug === slug ? ' is-current' : ''}" href="#/watch/samehadaku/${item.slug}">
          <span class="grow">${esc(item.title)}</span>
          <span class="chip">${esc(fmtDate(item.published))}</span>
        </a>`).join('')}</div>` : ''}`;

  const players = servers.map((s) => ({ label: s.server, kind: 'iframe', embed: s.embedUrl }));
  if (players.length) {
    mountPlayer(players, 0);
    document.getElementById('player-tabs')?.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-idx]');
      if (!button) return;
      for (const chip of document.querySelectorAll('#player-tabs button')) chip.classList.remove('active');
      button.classList.add('active');
      mountPlayer(players, Number(button.dataset.idx));
    });
  }
}

/* ---------------------------------------------------------- manga detail */

async function renderMangaDetail(lane, id) {
  setActiveTab(lane);
  content.innerHTML = loaderHtml();
  const item = await bucketRecord('mangadex/items', id);
  if (!item) {
    content.innerHTML = errorHtml('Judul belum ada di cache detail. Coba lagi setelah refresh.');
    return;
  }
  const chapters = (item.chapters || []).slice().sort((a, b) => (parseFloat(a.number) || 0) - (parseFloat(b.number) || 0));
  const baked = chapters.filter((ch) => ch.baked).length;
  content.innerHTML = `
    <div class="detail">
      <div class="detail-poster"><img class="poster" src="${esc(item.poster)}" alt="" referrerpolicy="no-referrer" /></div>
      <div>
        <h1>${esc(item.title)}</h1>
        ${item.altTitle ? `<p class="muted" style="margin:0 0 6px">${esc(item.altTitle)}</p>` : ''}
        <div class="chips">${[item.status, item.year, item.rating ? `★ ${item.rating}` : null, item.follows ? `${item.follows} follow` : null, `${chapters.length} chapter di cache · ${baked} siap baca`]
          .filter(Boolean).map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>
        <div class="chips">${(item.tags || []).map((t) => `<a class="chip" href="#/${lane}?q=${encodeURIComponent(t)}">${esc(t)}</a>`).join('')}</div>
        <p class="synopsis">${esc(item.description || '')}</p>
      </div>
    </div>
    ${section('Daftar chapter', 'terbaru di atas')}
    <div class="list">
      ${chapters.slice().reverse().map((ch) => ch.baked ? `
        <a class="row" href="#/read/mangadex/${ch.id}">
          <span class="num">Ch ${esc(ch.number ?? '?')}</span>
          <span class="grow">${esc(ch.title || item.title)}</span>
          <span class="chip">${esc(ch.lang)}</span>
          <span class="chip">${esc(ch.pages)} hal</span>
        </a>` : `
        <div class="row soon">
          <span class="num">Ch ${esc(ch.number ?? '?')}</span>
          <span class="grow">${esc(ch.title || item.title)}</span>
          <span class="chip">menyusul</span>
        </div>`).join('') || errorHtml('Chapter belum ada di cache.')}
    </div>`;
}

async function renderMangaReader(chapterId) {
  content.innerHTML = loaderHtml();
  const chapter = await bucketRecord('mangadex/chapters', chapterId);
  if (!chapter) {
    content.innerHTML = errorHtml('Chapter ini belum di-cache. Buka lagi setelah refresh berikutnya.');
    return;
  }
  const item = await bucketRecord('mangadex/items', chapter.mangaId);
  const chapters = (item?.chapters || []).filter((ch) => ch.baked).slice().sort((a, b) => (parseFloat(a.number) || 0) - (parseFloat(b.number) || 0));
  const idx = chapters.findIndex((ch) => ch.id === chapterId);
  const prev = idx > 0 ? chapters[idx - 1] : null;
  const next = idx >= 0 && idx < chapters.length - 1 ? chapters[idx + 1] : null;

  content.innerHTML = `
    <div class="breadcrumbs muted">
      <a href="#/${chapter.lane || 'manga'}">${esc((chapter.lane || 'manga').toUpperCase())}</a> ›
      <a href="#/manga/${chapter.lane || 'manga'}/${chapter.mangaId}">${esc(chapter.mangaTitle || '')}</a> ›
      <span>Chapter ${esc(chapter.number ?? '')}</span>
    </div>
    <div class="reader">
      ${chapter.pages.map((url, i) => `<img src="${esc(url)}" alt="halaman ${i + 1}" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`).join('')}
    </div>
    <div class="reader-nav">
      ${prev ? `<a href="#/read/mangadex/${prev.id}">‹ Ch ${esc(prev.number)}</a>` : '<span>‹ Ch —</span>'}
      <a href="#/manga/${chapter.lane || 'manga'}/${chapter.mangaId}">Daftar chapter</a>
      ${next ? `<a href="#/read/mangadex/${next.id}">Ch ${esc(next.number)} ›</a>` : '<span>Ch — ›</span>'}
    </div>`;
}

/* --------------------------------------------------------- doujin detail */

async function renderDoujinDetail(id) {
  setActiveTab('doujin');
  content.innerHTML = loaderHtml();
  const item = await bucketRecord('nhentai/items', id);
  if (!item) {
    content.innerHTML = errorHtml('Galeri belum ada di cache.');
    return;
  }
  const title = item.titlePretty || item.titleEnglish || item.titleJapanese || item.id;
  const tags = (item.tags || []).filter((tag) => tag.type === 'tag' || tag.type === 'parody' || tag.type === 'artist');
  content.innerHTML = `
    <div class="detail">
      <div class="detail-poster"><img class="poster" src="${esc(item.thumbnail || item.cover)}" alt="" referrerpolicy="no-referrer" /></div>
      <div>
        <h1>${esc(title)}</h1>
        <div class="chips">${[`${item.numPages || 0} halaman`, item.favourites ? `♥ ${item.favourites}` : null, item.uploadDate ? fmtDate(Number(item.uploadDate) * 1000) : null, item.scanlator || null]
          .filter(Boolean).map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>
        <div class="chips">${tags.slice(0, 14).map((t) => `<span class="chip">${esc(t.name)}</span>`).join('')}</div>
        <p style="margin:16px 0 0">
          ${item.pages?.length
            ? `<a class="btn primary" href="#/read/nhentai/${item.id}">Baca sekarang (${item.pages.length} hal)</a>`
            : `<span class="muted">Halaman belum di-cache. Coba lagi setelah refresh berikutnya.</span>`}
        </p>
      </div>
    </div>`;
}

async function renderDoujinReader(id) {
  content.innerHTML = loaderHtml();
  const item = await bucketRecord('nhentai/items', id);
  if (!item || !(item.pages || []).length) {
    content.innerHTML = errorHtml('Halaman galeri belum di-cache.');
    return;
  }
  content.innerHTML = `
    <div class="breadcrumbs muted">
      <a href="#/doujin">Doujin</a> › <a href="#/doujin/${item.id}">${esc(item.titlePretty || item.id)}</a>
    </div>
    <div class="reader">
      ${item.pages.map((url, i) => `<img src="${esc(url)}" alt="halaman ${i + 1}" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`).join('')}
    </div>
    <div class="reader-nav">
      <a href="#/doujin/${item.id}">Info</a>
      <a href="#/doujin">Doujin lain</a>
    </div>`;
}

/* ----------------------------------------------------------------- router */

const animeView = buildAnimeView();
const mangadexMangaView = makeMangadexView('manga');
const mangadexManhwaView = makeMangadexView('manhwa');

async function route() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, queryString] = raw.split('?');
  const params = new URLSearchParams(queryString || '');
  const parts = path.split('/').filter(Boolean);
  window.scrollTo(0, 0);

  try {
    if (parts.length === 0) return await renderHome();
    const [a, b, c] = parts;
    if (a === 'anime' && !b) return await animeView(params);
    if (a === 'manga' && !b) return await mangadexMangaView(params);
    if (a === 'manhwa' && !b) return await mangadexManhwaView(params);
    if (a === 'doujin' && !b) return await renderDoujin(params);
    if (a === 'series' && b === 'gomunime') return await renderGomunimeSeries(c);
    if (a === 'series' && b === 'samehadaku') return await renderSamehadakuSeries(c);
    if (a === 'watch' && b === 'gomunime') return await renderGomunimeWatch(c);
    if (a === 'watch' && b === 'samehadaku') return await renderSamehadakuWatch(c);
    if (a === 'manga' && (b === 'manga' || b === 'manhwa') && c) return await renderMangaDetail(b, c);
    if (a === 'read' && b === 'mangadex') return await renderMangaReader(c);
    if (a === 'doujin' && b) return await renderDoujinDetail(b);
    if (a === 'read' && b === 'nhentai') return await renderDoujinReader(c);
    content.innerHTML = errorHtml('Halaman tidak dikenal.');
  } catch (err) {
    console.error(err);
    content.innerHTML = errorHtml(`Gagal memuat: ${err.message}`);
  }
}

searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const q = searchInput.value.trim();
  const raw = location.hash.replace(/^#/, '') || '/';
  const tab = raw.split('?')[0].split('/').filter(Boolean)[0] || 'anime';
  const allowed = ['anime', 'manga', 'manhwa', 'doujin'];
  const target = allowed.includes(tab) ? tab : 'anime';
  location.hash = `#/${target}${q ? `?q=${encodeURIComponent(q)}` : ''}`;
});

window.addEventListener('hashchange', route);

(async function boot() {
  try {
    const meta = await getJson(`${DATA}meta.json`);
    const counts = meta?.state || {};
    const parts = [
      counts.gomunime ? `${counts.gomunime.series} series / ${counts.gomunime.episodes} episode` : null,
      counts.samehadaku ? `${counts.samehadaku.anime} anime / ${counts.samehadaku.episodes} episode` : null,
      counts.mangadex ? `${counts.mangadex.items} manga · ${counts.mangadex.chaptersBaked} chapter siap` : null,
      counts.nhentai ? `${counts.nhentai.items} doujin` : null,
      meta?.generatedAt ? `refresh ${fmtDate(meta.generatedAt)}` : null,
    ].filter(Boolean);
    statusEl.textContent = parts.join(' · ') || 'siap';
  } catch {
    statusEl.textContent = 'data belum tersedia';
  }
  route();
})();
