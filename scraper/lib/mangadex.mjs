/**
 * MangaDex client.
 *
 * Two lanes: manga (ja) and manhwa (ko). Chapter pages are resolved through
 * the at-home server and baked into the JSON, because the browser cannot call
 * api.mangadex.org from a github.io origin (their CORS allows only their own
 * site), and because the at-home URLs are cheap to refresh on the schedule.
 */

export const MANGADEX_ORIGIN = 'https://api.mangadex.org';
export const MANGADEX_UPLOADS = 'https://uploads.mangadex.org';

function pickLang(map, langs) {
  if (!map || typeof map !== 'object') return null;
  for (const lang of langs) {
    if (map[lang]) return map[lang];
  }
  const first = Object.values(map)[0];
  return typeof first === 'string' ? first : null;
}

function coverUrl(id, relationships) {
  const cover = (relationships || []).find((rel) => rel.type === 'cover_art');
  const file = cover && cover.attributes ? cover.attributes.fileName : null;
  return file ? `${MANGADEX_UPLOADS}/covers/${id}/${file}.512.jpg` : null;
}

export class MangadexClient {
  constructor(http) {
    this.http = http;
  }

  /**
   * `order` defaults to latestUploadedChapter: followedCount order surfaces
   * licensed titles whose chapters are all externalUrls, so their feeds bake
   * nothing. Recently-updated titles are the ones scanlators upload to.
   */
  async list({ originalLanguage, offset = 0, limit = 100, order = 'latestUploadedChapter' }) {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    params.set('offset', String(offset));
    params.set('hasAvailableChapters', 'true');
    params.set(`order[${order}]`, 'desc');
    params.append('contentRating[]', 'safe');
    params.append('contentRating[]', 'suggestive');
    params.append('originalLanguage[]', originalLanguage);
    params.append('availableTranslatedLanguage[]', 'id');
    params.append('availableTranslatedLanguage[]', 'en');
    params.append('includes[]', 'cover_art');
    const json = await this.http.json(`${MANGADEX_ORIGIN}/manga?${params.toString()}`);
    return {
      items: (json.data || []).map((item) => this.mapManga(item)),
      total: json.total ?? 0,
      offset: json.offset ?? offset,
      limit: json.limit ?? limit,
    };
  }

  mapManga(item) {
    const attrs = item.attributes || {};
    const tagNames = (attrs.tags || [])
      .filter((tag) => tag.attributes && tag.attributes.group === 'genre')
      .map((tag) => tag.attributes.name.en)
      .filter(Boolean);
    return {
      id: item.id,
      title: pickLang(attrs.title, ['en', 'id', 'ja', 'ko']) || item.id,
      altTitle: pickLang(attrs.altTitles && attrs.altTitles.length ? Object.assign({}, ...attrs.altTitles) : null, ['en', 'id', 'ja', 'ko']),
      description: pickLang(attrs.description, ['id', 'en']),
      year: attrs.year ?? null,
      status: attrs.status || null,
      lastChapter: attrs.lastChapter || null,
      contentRating: attrs.contentRating || null,
      tags: tagNames.slice(0, 8),
      poster: coverUrl(item.id, item.relationships),
      originalLanguage: attrs.originalLanguage || null,
      availableLanguages: attrs.availableTranslatedLanguages || [],
    };
  }

  /**
   * Chapters that can be served as images. `externalUrl` chapters live on
   * someone else's site and `pages === 0` ones lost their files, so both are
   * dropped here rather than leaking dead entries into the reader.
   */
  async feed(mangaId, { limit = 500 } = {}) {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    params.set('order[chapter]', 'desc');
    params.set('includeExternalUrl', '0');
    params.append('translatedLanguage[]', 'id');
    params.append('translatedLanguage[]', 'en');
    const json = await this.http.json(`${MANGADEX_ORIGIN}/manga/${mangaId}/feed?${params.toString()}`);
    const chapters = [];
    for (const item of json.data || []) {
      const attrs = item.attributes || {};
      if (attrs.externalUrl || !attrs.pages) continue;
      chapters.push({
        id: item.id,
        number: attrs.chapter || null,
        volume: attrs.volume || null,
        title: attrs.title || null,
        lang: attrs.translatedLanguage || null,
        pages: attrs.pages,
        createdAt: attrs.publishAt || attrs.createdAt || null,
      });
    }
    return chapters;
  }

  /** Original-quality page URLs for one chapter via the at-home server. */
  /**
   * MangaDex@Home hands back the CDN node plus the file list for one chapter.
   * The same files are also served from uploads.mangadex.org/data/<hash>/<file>
   * with no referer or CORS requirement, so only the hash and file names need
   * storing; the reader rebuilds the URLs itself.
   */
  async chapterManifest(chapterId) {
    const json = await this.http.json(`${MANGADEX_ORIGIN}/at-home/server/${chapterId}`);
    const hash = json.chapter && json.chapter.hash;
    const files = (json.chapter && json.chapter.data) || [];
    if (!hash || files.length === 0) return null;
    return { hash, files };
  }

  async statistics(ids) {
    const out = {};
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const params = new URLSearchParams();
      for (const id of batch) params.append('manga[]', id);
      try {
        const json = await this.http.json(`${MANGADEX_ORIGIN}/statistics/manga?${params.toString()}`);
        Object.assign(out, json.statistics || {});
      } catch {
        /* statistics are decorative; a missing batch never fails the run */
      }
    }
    return out;
  }
}
