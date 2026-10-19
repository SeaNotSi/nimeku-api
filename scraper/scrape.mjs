#!/usr/bin/env node
/**
 * Static API builder.
 *
 *   node scrape.mjs --source=gomunime|samehadaku|mangadex|nhentai|all
 *                  --mode=full|incremental
 *                  --limit=N            hard ceiling on detail fetches this run
 *                  --offset=N           resume point for backfills
 *                  --chapters=N         mangadex: chapters per title per run
 *                  --pagebudget=N       mangadex: at-home page fetches per run
 *
 * Output lands in ../data and is committed by the Action; GitHub Pages serves
 * it as a read-only JSON API (raw.githubusercontent.com and jsDelivr also
 * serve it with Access-Control-Allow-Origin: *).
 */

import { join } from 'node:path';
import { HttpClient } from './lib/http.mjs';
import { GomunimeClient } from './lib/gomunime.mjs';
import { SamehadakuClient } from './lib/samehadaku.mjs';
import { MangadexClient } from './lib/mangadex.mjs';
import { NhentaiClient } from './lib/nhentai.mjs';
import { BucketStore, writeChunkedList } from './lib/store.mjs';
import { DATA_DIR, isoNow, log, mapLimit, readJson, writeJson } from './lib/util.mjs';

const args = new Map();
for (const raw of process.argv.slice(2)) {
  const [key, value = 'true'] = raw.replace(/^--/, '').split('=');
  args.set(key, value);
}

const SOURCE = args.get('source') || 'all';
const MODE = args.get('mode') || 'incremental';
const LIMIT = Number(args.get('limit') || 0);
const OFFSET = Number(args.get('offset') || 0);
const DRY = args.has('dry');

const http = new HttpClient({ concurrency: Number(args.get('concurrency') || 6), delayMs: 70 });
// samehadaku sits behind Cloudflare and rejects undici's TLS fingerprint; curl passes.
const curlHttp = new HttpClient({
  concurrency: Number(args.get('concurrency') || 5),
  delayMs: 90,
  transport: 'curl',
});
// MangaDex asks for moderation; their limits are per-IP token buckets.
const mdxHttp = new HttpClient({ concurrency: 3, delayMs: 220 });
// nhentai answers through Cloudflare and starts handing out 429s after a
// short burst, so this client stays slow and backs off hard on rate limits.
const nhHttp = new HttpClient({ concurrency: 2, delayMs: 700, retries: 4, rateLimitMs: 15000 });
const STATE_PATH = join(DATA_DIR, 'state.json');

function outPath(...parts) {
  return join(DATA_DIR, ...parts);
}

function indexRecord(item) {
  return {
    id: item.id,
    slug: item.slug,
    title: item.title,
    poster: item.poster || item.cover || item.thumbnail || null,
    type: item.type || null,
    status: item.status || null,
    rating: item.rating ?? null,
    followers: item.follows ?? item.favourites ?? null,
    episodes: item.episode_count ?? item.totalEpisodes ?? null,
    updatedAt: item.updated_at || item.published || item.modified || item.detailAt || item.scrapedAt || null,
  };
}

/* ---------------------------------------------------------------- gomunime */

async function scrapeGomunime(state) {
  const client = new GomunimeClient(http);
  const store = new BucketStore(outPath('gomunime', 'series'));
  await store.load();

  const seriesSlugs = await client.seriesIndex();
  log(`gomunime series in sitemap: ${seriesSlugs.length}`);

  const todo = seriesSlugs.filter((slug) => MODE === 'full' || !store.has(slug));
  const limit = LIMIT || (MODE === 'full' ? todo.length : 400);
  const slice = todo.slice(0, limit);
  log(`gomunime series to fetch: ${slice.length} (of ${todo.length})`);

  await mapLimit(slice, 5, async (slug) => {
    try {
      const record = await client.series(`https://gomunime.top/${slug}`);
      store.set(slug, record);
    } catch (err) {
      log('gomunime series failed', slug, err.message);
    }
  });
  if (!DRY) await store.flush();

  const series = store.values().sort((a, b) => String(a.title).localeCompare(String(b.title)));
  await writeChunkedList(outPath('gomunime', 'list'), series.map((item) => ({
    ...indexRecord(item),
    genres: item.genres || [],
    totalEpisodes: item.totalEpisodes ?? null,
  })));

  // Episode detail pass: newest first, only unseen episodes.
  const epStore = new BucketStore(outPath('gomunime', 'episodes'));
  await epStore.load();
  const epUrls = await client.episodeIndex();
  const pending = epUrls
    .filter((url) => !epStore.has(url.replace('https://gomunime.top/', '')))
    .sort()
    .reverse();
  const epLimit = LIMIT || (MODE === 'full' ? 1200 : 300);
  const epSlice = pending.slice(OFFSET, OFFSET + epLimit);
  log(`gomunime episodes pending=${pending.length} fetching=${epSlice.length}`);

  await mapLimit(epSlice, 5, async (url) => {
    try {
      const record = await client.episode(url);
      epStore.set(record.slug, record);
    } catch (err) {
      log('gomunime episode failed', url, err.message);
    }
  });
  if (!DRY) await epStore.flush();

  const episodes = epStore.values().sort((a, b) => String(b.published || '').localeCompare(String(a.published || '')));
  await writeChunkedList(outPath('gomunime', 'episodes', 'list'), episodes.map((ep) => ({
    id: ep.slug,
    slug: ep.slug,
    title: ep.title,
    series: ep.series,
    seriesSlug: ep.seriesSlug,
    episode: ep.episode,
    poster: ep.poster,
    published: ep.published,
    servers: (ep.players || []).length,
  })));

  state.gomunime = {
    series: series.length,
    episodes: episodes.length,
    pendingSeries: Math.max(0, todo.length - slice.length),
    pendingEpisodes: Math.max(0, pending.length - epSlice.length),
    updatedAt: isoNow(),
  };
  return state.gomunime;
}

/* -------------------------------------------------------------- samehadaku */

async function scrapeSamehadaku(state) {
  const client = new SamehadakuClient(curlHttp);
  const animeStore = new BucketStore(outPath('samehadaku', 'anime'));
  await animeStore.load();

  // Anime catalogue: small (≈800) and cheap.
  let page = 1;
  let totalPages = 1;
  const animeCeiling = MODE === 'full' ? Infinity : 10;
  while (page <= totalPages && page <= animeCeiling) {
    try {
      const { data, totalPages: tp } = await client.rest('anime', {
        page: String(page),
        per_page: '100',
        _embed: 'wp:featuredmedia',
      });
      totalPages = tp || totalPages;
      for (const item of data) animeStore.set(item.slug, client.mapAnime(item));
      log(`samehadaku anime page ${page}/${totalPages}`);
    } catch (err) {
      log('samehadaku anime page failed', page, err.message);
      break;
    }
    page += 1;
  }
  if (!DRY) await animeStore.flush();

  // term ids -> names once, so the frontend never needs samehadaku itself.
  const animeRecords = animeStore.values();
  const idsOf = (key) => animeRecords.flatMap((item) => item[key] || []);
  const taxonomy = {
    genre: await client.taxonomyNames('genre', idsOf('genres')).catch(() => ({})),
    season: await client.taxonomyNames('season', idsOf('season')).catch(() => ({})),
    studio: await client.taxonomyNames('studio', idsOf('studio')).catch(() => ({})),
    generatedAt: isoNow(),
  };
  await writeJson(outPath('samehadaku', 'taxonomy.json'), taxonomy);

  const anime = animeRecords.sort((a, b) => String(a.title).localeCompare(String(b.title)));
  await writeChunkedList(outPath('samehadaku', 'anime', 'list'), anime.map((item) => ({
    id: item.id,
    slug: item.slug,
    title: item.title,
    poster: item.poster,
    url: item.url,
    genres: item.genres || [],
    season: item.season || [],
    studio: item.studio || [],
    modified: item.modified || null,
  })));

  // Episodes: REST list for metadata, HTML only for records that need servers.
  const epStore = new BucketStore(outPath('samehadaku', 'episodes'));
  await epStore.load();

  const pagesToScan = MODE === 'full' ? 200 : 4;
  let scanned = 0;
  let epPage = 1;
  let epTotalPages = 1;
  while (epPage <= epTotalPages && epPage <= pagesToScan) {
    try {
      const { items, totalPages: tp } = await client.posts({ page: epPage, perPage: 100 });
      epTotalPages = tp || epTotalPages;
      for (const item of items) {
        const existing = epStore.get(item.slug);
        epStore.set(item.slug, {
          ...item,
          seriesId: null,
          servers: existing?.servers || [],
          downloads: existing?.downloads || [],
          detailAt: existing?.detailAt || null,
        });
      }
      scanned += items.length;
      log(`samehadaku posts page ${epPage}/${epTotalPages}`);
    } catch (err) {
      log('samehadaku posts failed', epPage, err.message);
      break;
    }
    epPage += 1;
  }

  const epLimit = LIMIT || (MODE === 'full' ? 800 : 250);
  const needDetail = epStore
    .values()
    .filter((ep) => !ep.detailAt && ep.url)
    .sort((a, b) => String(b.published || '').localeCompare(String(a.published || '')))
    .slice(0, epLimit);
  log(`samehadaku episode detail fetching=${needDetail.length}`);

  await mapLimit(needDetail, 4, async (ep) => {
    try {
      const detail = await client.episode(ep.url);
      epStore.set(ep.slug, {
        ...ep,
        seriesTitle: detail.seriesTitle,
        seriesUrl: detail.seriesUrl,
        servers: detail.servers,
        downloads: detail.downloads,
        detailAt: isoNow(),
      });
    } catch (err) {
      log('samehadaku episode failed', ep.slug, err.message);
    }
  });
  if (!DRY) await epStore.flush();

  const episodes = epStore.values().sort((a, b) => String(b.published || '').localeCompare(String(a.published || '')));
  await writeChunkedList(outPath('samehadaku', 'episodes', 'list'), episodes.map((ep) => ({
    id: ep.id,
    slug: ep.slug,
    title: ep.title,
    poster: ep.poster,
    published: ep.published,
    seriesTitle: ep.seriesTitle || null,
    seriesUrl: ep.seriesUrl || null,
    servers: (ep.servers || []).length,
  })));

  // Per-series episode index so detail pages never scan the full catalogue.
  const seriesStore = new BucketStore(outPath('samehadaku', 'series'));
  for (const ep of episodes) {
    if (!ep.seriesUrl) continue;
    const slug = ep.seriesUrl.replace(/\/+$/, '').split('/').pop();
    if (!slug) continue;
    const record = seriesStore.get(slug) || {
      slug,
      title: ep.seriesTitle || slug,
      url: ep.seriesUrl,
      episodes: [],
    };
    if (!record.episodes.some((item) => item.slug === ep.slug)) {
      record.episodes.push({
        slug: ep.slug,
        title: ep.title,
        poster: ep.poster,
        published: ep.published,
        servers: (ep.servers || []).length,
      });
    }
    seriesStore.set(slug, record);
  }
  for (const record of seriesStore.values()) {
    record.episodes.sort((a, b) => String(a.published || '').localeCompare(String(b.published || '')));
    seriesStore.set(record.slug, record);
  }
  if (!DRY) await seriesStore.flush();

  state.samehadaku = {
    anime: anime.length,
    episodes: episodes.length,
    scanned,
    seriesIndexed: seriesStore.size,
    pendingDetails: Math.max(0, epStore.values().filter((ep) => !ep.detailAt).length),
    updatedAt: isoNow(),
  };
  return state.samehadaku;
}

/* ---------------------------------------------------------------- mangadex */

async function scrapeMangadex(state) {
  const client = new MangadexClient(mdxHttp);
  const store = new BucketStore(outPath('mangadex', 'items'));
  await store.load();
  const chapterStore = new BucketStore(outPath('mangadex', 'chapters'));
  await chapterStore.load();

  const lanes = [
    { key: 'manga', lang: 'ja' },
    { key: 'manhwa', lang: 'ko' },
  ];

  // Catalogue: recently-updated first (licensed titles are externalUrl-only and
  // would bake nothing), 100 per page, top few pages per lane.
  for (const lane of lanes) {
    const pages = MODE === 'full' ? 40 : LIMIT > 0 ? Math.ceil(LIMIT / 100) : 8;
    let offset = 0;
    for (let pageIndex = 0; pageIndex < pages; pageIndex += 1) {
      let batch;
      try {
        batch = await client.list({ originalLanguage: lane.lang, offset, limit: 100 });
      } catch (err) {
        log('mangadex list failed', lane.key, offset, err.message);
        break;
      }
      if (!batch.items.length) break;

      let stats = {};
      try {
        stats = await client.statistics(batch.items.map((item) => item.id));
      } catch {
        /* decorative */
      }
      for (const item of batch.items) {
        const existing = store.get(item.id) || {};
        const stat = stats[item.id] || {};
        store.set(item.id, {
          ...existing,
          ...item,
          lane: lane.key,
          rating: stat.rating && stat.rating.average ? Number(stat.rating.average.toFixed(2)) : null,
          follows: stat.follows ?? null,
          listAt: isoNow(),
        });
      }
      log(`mangadex ${lane.key} offset=${offset} got=${batch.items.length}/${batch.total}`);
      offset += 100;
      if (offset >= batch.total) break;
    }
  }
  if (!DRY) await store.flush();

  // Chapter pass: newest titles first; feed refreshes weekly, pages fill by budget.
  const chapterBudget = Number(args.get('pagebudget') || (MODE === 'full' ? 2500 : 200));
  const perTitle = Number(args.get('chapters') || 40);
  const titles = store
    .values()
    .sort((a, b) => (b.follows ?? 0) - (a.follows ?? 0));
  let pagesUsed = 0;
  let feedsRead = 0;
  let unreadable = 0;

  // The feed/metadata pass always runs for every title; only at-home page
  // baking is bounded, so a spent page budget never starves the purge.
  await mapLimit(titles, 4, async (entry) => {
    let record = store.get(entry.id) || entry;
    const stale = !record.chaptersAt
      || (record.chapters || []).length === 0
      || Date.now() - Date.parse(record.chaptersAt) > 7 * 864e5;

    if (stale || !record.chapters) {
      try {
        const feed = await client.feed(record.id, { limit: 500 });
        if (!feed.length) {
          // every chapter is an externalUrl — nothing this reader can serve
          store.delete(entry.id);
          unreadable += 1;
          return;
        }
        const previous = new Map((record.chapters || []).map((ch) => [ch.id, ch]));
        const chapters = feed.slice(0, perTitle).map((ch) => ({
          ...ch,
          baked: previous.get(ch.id)?.baked || chapterStore.has(ch.id),
        }));
        record = { ...record, chapters, chapterCount: feed.length, chaptersAt: isoNow() };
        store.set(entry.id, record);
        feedsRead += 1;
      } catch (err) {
        log('mangadex feed failed', entry.id, err.message);
        return;
      }
    }

    for (const chapter of record.chapters || []) {
      if (pagesUsed >= chapterBudget) break;
      // the store is the source of truth: a baked flag whose chapter file was
      // evicted still needs a fresh at-home lookup
      if (chapterStore.has(chapter.id)) {
        chapter.baked = true;
        continue;
      }
      try {
        const pages = await client.chapterPages(chapter.id);
        if (!pages.length) continue;
        chapterStore.set(chapter.id, {
          id: chapter.id,
          mangaId: record.id,
          mangaTitle: record.title,
          lane: record.lane,
          number: chapter.number,
          volume: chapter.volume,
          title: chapter.title,
          lang: chapter.lang,
          pages,
          createdAt: chapter.createdAt,
          scrapedAt: isoNow(),
        });
        chapter.baked = true;
        pagesUsed += 1;
      } catch (err) {
        log('mangadex pages failed', chapter.id, err.message);
      }
    }
    // persist the baked flags written onto the chapter objects above
    store.set(entry.id, record);
  });

  // Bound the repo: at-home URLs are the only data that grows fast, so the
  // chapter store evicts its oldest entries whenever it crosses the cap.
  const chapterCap = Number(args.get('chaptercap') || (MODE === 'full' ? 4000 : 2400));
  if (chapterStore.size > chapterCap) {
    const doomed = chapterStore
      .values()
      .sort((a, b) => String(a.scrapedAt || '').localeCompare(String(b.scrapedAt || '')))
      .slice(0, chapterStore.size - chapterCap);
    for (const chapter of doomed) chapterStore.delete(chapter.id);
    log(`mangadex chapter store over cap ${chapterCap}: evicted ${doomed.length}`);
  }
  if (!DRY) {
    await store.flush();
    await chapterStore.flush();
  }

  // Lists land after the feed pass: only then is it known which titles are
  // readable (externalUrl-only titles are dropped by the pass above).
  for (const lane of lanes) {
    const records = store
      .values()
      .filter((item) => item.lane === lane.key && (item.chapters || []).length > 0)
      .sort((a, b) => (b.follows ?? 0) - (a.follows ?? 0));
    await writeChunkedList(outPath('mangadex', 'list', lane.key), records.map((item) => ({
      id: item.id,
      title: item.title,
      poster: item.poster,
      year: item.year ?? null,
      status: item.status ?? null,
      rating: item.rating ?? null,
      follows: item.follows ?? null,
      tags: item.tags || [],
      lastChapter: item.lastChapter ?? null,
      chapters: (item.chapters || []).length || null,
      lane: item.lane,
    })));
  }

  await writeJson(outPath('mangadex', 'index.json'), {
    items: store.size,
    readable: store.values().filter((item) => (item.chapters || []).length > 0).length,
    chaptersBaked: chapterStore.size,
    generatedAt: isoNow(),
  });

  state.mangadex = {
    items: store.size,
    readable: store.values().filter((item) => (item.chapters || []).length > 0).length,
    chaptersBaked: chapterStore.size,
    feedsRead,
    pagesUsed,
    droppedExternalOnly: unreadable,
    updatedAt: isoNow(),
  };
  return state.mangadex;
}

/* ---------------------------------------------------------------- nhentai */

async function scrapeNhentai(state) {
  const client = new NhentaiClient(nhHttp);
  const store = new BucketStore(outPath('nhentai', 'items'));
  await store.load();

  const windows = [
    ['language:english', 'popular', 5],
    ['language:english', 'popular-week', 5],
    ['language:english', 'popular-month', 4],
    ['language:english', 'date', 3],
    ['language:japanese', 'popular', 4],
    ['language:chinese', 'popular', 2],
  ];

  let listed = 0;
  for (const [query, sort, pages] of windows) {
    for (let page = 1; page <= pages; page += 1) {
      let batch;
      try {
        batch = await client.search({ query, page, sort, perPage: 25 });
      } catch (err) {
        log('nhentai search failed', query, sort, page, err.message);
        break;
      }
      if (!batch.items.length) break;
      for (const item of batch.items) {
        const existing = store.get(item.id) || {};
        store.set(item.id, { ...existing, ...item, listAt: isoNow() });
      }
      listed += batch.items.length;
      if (page >= batch.numPages) break;
    }
  }
  if (!DRY) await store.flush();
  log(`nhentai listed=${listed} store=${store.size}`);

  const detailBudget = LIMIT || (MODE === 'full' ? 600 : 120);
  const pending = store
    .values()
    .filter((item) => !item.pages)
    .sort((a, b) => (b.favourites ?? 0) - (a.favourites ?? 0))
    .slice(0, detailBudget);
  log(`nhentai details pending=${pending.length}`);

  await mapLimit(pending, 3, async (item) => {
    try {
      const gallery = await client.gallery(item.id);
      store.set(item.id, {
        ...item,
        ...gallery,
        titlePretty: gallery.title.pretty || gallery.title.english || item.titleEnglish || item.id,
        detailAt: isoNow(),
      });
    } catch (err) {
      log('nhentai gallery failed', item.id, err.message);
    }
  });
  if (!DRY) await store.flush();

  const records = store.values().sort((a, b) => (b.favourites ?? 0) - (a.favourites ?? 0));
  await writeChunkedList(outPath('nhentai', 'list'), records.map((item) => ({
    id: item.id,
    title: item.titlePretty || item.titleEnglish || item.titleJapanese || item.id,
    cover: item.thumbnail || item.cover || null,
    pages: item.numPages ?? null,
    favourites: item.favourites ?? null,
    tags: (item.tags || []).filter((tag) => tag.type === 'tag' || tag.type === 'parody').map((tag) => tag.name).slice(0, 6),
    detailed: Boolean(item.detailAt),
  })));

  state.nhentai = {
    items: records.length,
    detailed: records.filter((item) => item.detailAt).length,
    updatedAt: isoNow(),
  };
  return state.nhentai;
}

/* ------------------------------------------------------------------- main */

async function main() {
  const state = (await readJson(STATE_PATH, {})) || {};
  const started = Date.now();

  // leftovers from the retired doujindesu lane; state.json is public
  delete state.doujin;
  delete state.doujinChapters;

  if (SOURCE === 'all' || SOURCE === 'gomunime') {
    log('--- gomunime ---');
    await scrapeGomunime(state);
  }
  if (SOURCE === 'all' || SOURCE === 'samehadaku') {
    log('--- samehadaku ---');
    await scrapeSamehadaku(state);
  }
  if (SOURCE === 'all' || SOURCE === 'mangadex') {
    log('--- mangadex ---');
    await scrapeMangadex(state);
  }
  if (SOURCE === 'all' || SOURCE === 'nhentai') {
    log('--- nhentai ---');
    await scrapeNhentai(state);
  }

  const totals = {
    requests: http.stats.requests + curlHttp.stats.requests + mdxHttp.stats.requests + nhHttp.stats.requests,
    failures: http.stats.failures + curlHttp.stats.failures + mdxHttp.stats.failures + nhHttp.stats.failures,
  };
  state.http = totals;
  state.lastRun = {
    source: SOURCE,
    mode: MODE,
    durationMs: Date.now() - started,
    finishedAt: isoNow(),
  };
  await writeJson(outPath('meta.json'), {
    name: 'nimeku static api',
    sources: ['gomunime', 'samehadaku', 'mangadex', 'nhentai'],
    generatedAt: isoNow(),
    state,
  });
  if (!DRY) await writeJson(STATE_PATH, state);

  log('done', JSON.stringify(totals));
}

main().catch((err) => {
  console.error('fatal', err);
  process.exit(1);
});
