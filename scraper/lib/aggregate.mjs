import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { BucketStore } from './store.mjs';
import { readJson, isoNow } from './util.mjs';

const KDF_ITERATIONS = 210000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * One URL that carries the whole catalogue: anime (both sources, with players
 * or servers), manga, manhwa, doujin, every image URL and every rating.
 *
 * Buckets are the storage format, not the API. This flattens them once so a
 * client can boot its entire site from a single fetch instead of walking a
 * directory tree.
 */
export async function buildAggregate(dataDir = join(import.meta.dirname, '../../data')) {
  const load = async (dir) => new BucketStore(join(dataDir, dir)).load();

  const [gmSeries, gmEpisodes, shAnime, shSeries, shEpisodes, mdItems, nhItems, meta] =
    await Promise.all([
      load('gomunime/series'),
      load('gomunime/episodes'),
      load('samehadaku/anime'),
      load('samehadaku/series'),
      load('samehadaku/episodes'),
      load('mangadex/items'),
      load('nhentai/items'),
      readJson(join(dataDir, 'meta.json'), {}),
    ]);

  const episodeNumber = (slug = '', title = '') => {
    const fromSlug = /-episode-(\d+(?:\.\d+)?)(?:$|-)/i.exec(String(slug));
    if (fromSlug) return Number(fromSlug[1]);
    const fromTitle = /episode\s+(\d+(?:\.\d+)?)/i.exec(String(title));
    return fromTitle ? Number(fromTitle[1]) : null;
  };

  /* ------------------------------------------------------------- gomunime */

  const gmEpisodeBySlug = new Map();
  for (const episode of gmEpisodes.values()) {
    gmEpisodeBySlug.set(episode.slug || episode.id, episode);
  }

  const gomunime = [];
  const usedGmEpisodes = new Set();

  for (const series of gmSeries.values()) {
    const slug = series.slug || series.id;
    const episodes = (series.episodes || []).map((stub) => {
      const full = gmEpisodeBySlug.get(stub.slug) || null;
      if (full) usedGmEpisodes.add(full.id);
      return {
        id: full?.id ?? stub.slug,
        slug: stub.slug,
        number: full?.episode ?? stub.number ?? episodeNumber(stub.slug),
        title: full?.title ?? null,
        published: full?.published ?? null,
        poster: full?.poster ?? series.poster ?? null,
        url: full?.sourceUrl ?? stub.url ?? null,
        players: (full?.players || []).map((player) => ({
          label: player.label ?? null,
          kind: player.kind ?? null,
          embed: player.embed ?? null,
          file: player.file ?? null,
          hls: player.hls ?? null,
          live: player.live ?? null,
        })),
      };
    });

    gomunime.push({
      id: `gomunime:${slug}`,
      source: 'gomunime',
      slug,
      title: series.title ?? null,
      type: series.type ?? null,
      status: series.status ?? null,
      poster: series.poster ?? null,
      synopsis: series.synopsis ?? null,
      genres: series.genres || [],
      rating: series.rating ?? null,
      totalEpisodes: series.totalEpisodes ?? episodes.length,
      url: series.sourceUrl ?? null,
      episodes,
    });
  }

  // Episodes whose series record has not been indexed yet: attach by longest
  // slug prefix so nothing silently disappears from the bundle.
  const gmSlugs = gomunime.map((item) => item.slug).sort((a, b) => b.length - a.length);
  for (const episode of gmEpisodes.values()) {
    if (usedGmEpisodes.has(episode.id)) continue;
    const owner = gmSlugs.find((slug) => {
      const needle = `${slug}-episode-`;
      return String(episode.slug || '').startsWith(needle);
    });
    if (!owner) continue;
    const target = gomunime.find((item) => item.slug === owner);
    target.episodes.push({
      id: episode.id,
      slug: episode.slug,
      number: episode.episode ?? episodeNumber(episode.slug),
      title: episode.title ?? null,
      published: episode.published ?? null,
      poster: episode.poster ?? null,
      url: episode.sourceUrl ?? null,
      players: (episode.players || []).map((player) => ({
        label: player.label ?? null,
        kind: player.kind ?? null,
        embed: player.embed ?? null,
        file: player.file ?? null,
        hls: player.hls ?? null,
        live: player.live ?? null,
      })),
    });
  }

  for (const item of gomunime) {
    item.episodes.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  }

  /* ---------------------------------------------------------- samehadaku */

  const shEpisodeBySlug = new Map();
  for (const episode of shEpisodes.values()) {
    shEpisodeBySlug.set(episode.slug, episode);
  }
  const usedShEpisodes = new Set();

  const samehadaku = [];
  for (const anime of shAnime.values()) {
    const slug = anime.slug;
    const series = shSeries.get(slug) || null;
    const stubs = series?.episodes || [];
    const episodes = stubs.map((stub) => {
      const full = shEpisodeBySlug.get(stub.slug) || null;
      if (full) usedShEpisodes.add(full.id);
      return {
        id: full?.id ?? stub.slug,
        slug: stub.slug,
        number: episodeNumber(stub.slug, stub.title || full?.title),
        title: stub.title ?? full?.title ?? null,
        published: stub.published ?? full?.published ?? null,
        poster: stub.poster ?? full?.poster ?? null,
        url: full?.url ?? null,
        servers: (full?.servers || []).map((server) => ({
          server: server.server ?? null,
          type: server.type ?? null,
          embedUrl: server.embedUrl ?? null,
        })),
        downloads: full?.downloads || [],
      };
    });

    samehadaku.push({
      id: `samehadaku:${slug}`,
      source: 'samehadaku',
      slug,
      title: anime.title ?? null,
      type: 'anime',
      status: null,
      poster: anime.poster ?? null,
      synopsis: anime.synopsis ?? null,
      genres: anime.genres || [],
      genreIds: anime.genres || [],
      rating: anime.rating ?? null,
      totalEpisodes: episodes.length || null,
      url: anime.url ?? null,
      episodes,
    });
  }

  const shSlugs = samehadaku.map((item) => item.slug).sort((a, b) => b.length - a.length);
  for (const episode of shEpisodes.values()) {
    if (usedShEpisodes.has(episode.id)) continue;
    const owner = shSlugs.find((slug) => String(episode.slug || '').startsWith(`${slug}-episode-`));
    if (!owner) continue;
    const target = samehadaku.find((item) => item.slug === owner);
    target.episodes.push({
      id: episode.id,
      slug: episode.slug,
      number: episodeNumber(episode.slug, episode.title),
      title: episode.title ?? null,
      published: episode.published ?? null,
      poster: episode.poster ?? null,
      url: episode.url ?? null,
      servers: (episode.servers || []).map((server) => ({
        server: server.server ?? null,
        type: server.type ?? null,
        embedUrl: server.embedUrl ?? null,
      })),
      downloads: episode.downloads || [],
    });
  }

  for (const item of samehadaku) {
    item.episodes.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  }

  /* ------------------------------------------------------------- mangadex */

  const mdRecord = (item) => ({
    id: item.id,
    title: item.title ?? null,
    altTitle: item.altTitle ?? null,
    description: item.description ?? null,
    year: item.year ?? null,
    status: item.status ?? null,
    lastChapter: item.lastChapter ?? null,
    contentRating: item.contentRating ?? null,
    tags: item.tags || [],
    poster: item.poster ?? null,
    originalLanguage: item.originalLanguage ?? null,
    availableLanguages: item.availableLanguages || [],
    lane: item.lane ?? null,
    rating: item.rating ?? null,
    follows: item.follows ?? null,
    chapterCount: item.chapterCount ?? (item.chapters || []).length,
    chapters: (item.chapters || []).map((chapter) => ({
      id: chapter.id,
      number: chapter.number ?? null,
      volume: chapter.volume ?? null,
      title: chapter.title ?? null,
      lang: chapter.lang ?? null,
      pages: chapter.pages ?? null,
      baked: Boolean(chapter.baked),
    })),
  });

  const mangadex = mdItems.values();
  const manga = mangadex.filter((item) => item.lane !== 'manhwa').map(mdRecord);
  const manhwa = mangadex.filter((item) => item.lane === 'manhwa').map(mdRecord);

  /* -------------------------------------------------------------- nhentai */

  const doujin = nhItems.values().map((item) => ({
    id: item.id,
    mediaId: item.mediaId ?? null,
    title: item.title?.pretty || item.titlePretty || item.titleEnglish || null,
    titleEnglish: item.titleEnglish ?? null,
    titleJapanese: item.titleJapanese ?? null,
    cover: item.cover ?? null,
    thumbnail: item.thumbnail ?? null,
    pages: item.pages || [],
    numPages: item.numPages ?? (item.pages || []).length,
    favourites: item.favourites ?? null,
    tags: item.tags || [],
    scanlator: item.scanlator ?? null,
    uploadDate: item.uploadDate ?? null,
    blacklisted: Boolean(item.blacklisted),
  }));

  /* --------------------------------------------------------------- images */

  const posters = {};
  for (const item of gomunime) if (item.poster) posters[item.id] = item.poster;
  for (const item of samehadaku) if (item.poster) posters[item.id] = item.poster;
  for (const item of mangadex) if (item.poster) posters[`mangadex:${item.id}`] = item.poster;
  for (const item of doujin) {
    if (item.cover) posters[`nhentai:${item.id}`] = item.cover;
  }

  const counts = {
    anime: gomunime.length + samehadaku.length,
    animeEpisodes:
      gomunime.reduce((n, item) => n + item.episodes.length, 0) +
      samehadaku.reduce((n, item) => n + item.episodes.length, 0),
    manga: manga.length,
    manhwa: manhwa.length,
    chapters: manga.reduce((n, item) => n + item.chapters.length, 0) +
      manhwa.reduce((n, item) => n + item.chapters.length, 0),
    doujin: doujin.length,
    doujinPages: doujin.reduce((n, item) => n + item.pages.length, 0),
    images: Object.keys(posters).length,
  };

  return {
    v: 1,
    generatedAt: meta.generatedAt || isoNow(),
    sources: ['gomunime', 'samehadaku', 'mangadex', 'nhentai'],
    counts,
    meta: { state: meta.state || {} },
    anime: { gomunime, samehadaku },
    manga,
    manhwa,
    doujin,
    images: { posters },
  };
}

/** gzip first, then AES-256-GCM: JSON compresses ~10x, ciphertext does not. */
export function sealAggregate(bundle, passphrase) {
  const plaintext = gzipSync(Buffer.from(JSON.stringify(bundle), 'utf8'));
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = pbkdf2Sync(passphrase, salt, KDF_ITERATIONS, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const sealed = Buffer.concat([body, cipher.getAuthTag()]);

  return {
    v: 1,
    alg: 'AES-256-GCM',
    enc: 'gzip',
    kdf: {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations: KDF_ITERATIONS,
      salt: salt.toString('base64'),
    },
    iv: iv.toString('base64'),
    generatedAt: bundle.generatedAt,
    bytes: plaintext.length,
    data: sealed.toString('base64'),
  };
}

/** Inverse of sealAggregate; used by tests and by any Node-side consumer. */
export function openAggregate(envelope, passphrase) {
  if (!envelope || envelope.alg !== 'AES-256-GCM' || !envelope.data) {
    throw new Error('envelope tidak dikenal');
  }
  const sealed = Buffer.from(envelope.data, 'base64');
  if (sealed.length <= TAG_BYTES) throw new Error('envelope terpotong');
  const body = sealed.subarray(0, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const key = pbkdf2Sync(
    passphrase,
    Buffer.from(envelope.kdf.salt, 'base64'),
    envelope.kdf.iterations,
    32,
    'sha256',
  );
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
  return JSON.parse(gunzipSync(plaintext).toString('utf8'));
}
