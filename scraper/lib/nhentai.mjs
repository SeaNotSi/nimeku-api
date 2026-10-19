/**
 * nhentai client (api/v2).
 *
 * The catalogue comes from a handful of popular/recent window queries; the
 * detail pass expands each gallery into browsable page URLs. Images on
 * i.nhentai.net / t.nhentai.net hotlink from any origin, so the reader needs
 * no proxy.
 */

export const NHENTAI_ORIGIN = 'https://nhentai.net';
export const NHENTAI_IMG = 'https://i.nhentai.net';
export const NHENTAI_THUMB = 'https://t.nhentai.net';

export class NhentaiClient {
  constructor(http) {
    this.http = http;
  }

  async search({ query = '', page = 1, perPage = 25, sort = 'popular' } = {}) {
    const params = new URLSearchParams();
    if (query) params.set('query', query);
    params.set('page', String(page));
    params.set('per_page', String(perPage));
    if (sort) params.set('sort', sort);
    const json = await this.http.json(`${NHENTAI_ORIGIN}/api/v2/search?${params.toString()}`);
    return {
      items: (json.result || []).map((item) => this.mapListItem(item)),
      numPages: json.num_pages ?? 0,
      perPage: json.per_page ?? perPage,
      total: json.total ?? 0,
    };
  }

  mapListItem(item) {
    return {
      id: String(item.id),
      mediaId: String(item.media_id),
      titleEnglish: item.english_title || null,
      titleJapanese: item.japanese_title || null,
      thumbnail: item.thumbnail ? `${NHENTAI_THUMB}/${item.thumbnail}` : null,
      numPages: item.num_pages ?? null,
      favourites: item.num_favorites ?? null,
      tagIds: item.tag_ids || [],
      blacklisted: Boolean(item.blacklisted),
    };
  }

  async gallery(id) {
    const json = await this.http.json(`${NHENTAI_ORIGIN}/api/v2/galleries/${id}`);
    const title = json.title || {};
    const pages = (json.pages || [])
      .map((page) => (page.path ? `${NHENTAI_IMG}/${page.path}` : null))
      .filter(Boolean);
    const cover = json.cover && json.cover.path ? `${NHENTAI_IMG}/${json.cover.path}` : null;
    return {
      id: String(json.id),
      mediaId: String(json.media_id),
      title: {
        english: title.english || null,
        japanese: title.japanese || null,
        pretty: title.pretty || null,
      },
      cover,
      thumbnail: json.thumbnail ? `${NHENTAI_THUMB}/${json.thumbnail}` : null,
      scanlator: json.scanlator || null,
      uploadDate: json.upload_date ?? null,
      numPages: json.num_pages ?? pages.length,
      favourites: json.num_favorites ?? null,
      tags: (json.tags || [])
        .filter((tag) => tag && tag.name)
        .map((tag) => ({ name: tag.name, type: tag.type || null })),
      pages,
    };
  }
}
