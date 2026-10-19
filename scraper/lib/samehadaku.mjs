/**
 * Samehadaku client — WordPress REST for the catalogue, HTML for the player
 * mirrors. Player options live either inline (data-embed) or behind the
 * theme's `player_ajax` admin-ajax action, which needs the page nonce.
 */

import { decodeEntities, firstMatch, normSpace, stripTags } from './util.mjs';

export const SAMEHADAKU_ORIGIN = 'https://v2.samehadaku.how';

function parsePlayerOptions(html) {
  const options = [];
  const re = /<div[^>]*class="[^"]*player-server-btn[^"]*"[^>]*>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const tag = match[0];
    const attr = (name) => {
      const hit = tag.match(new RegExp(`${name}="([^"]*)"`, 'i'));
      return hit ? decodeEntities(hit[1]) : '';
    };
    const post = attr('data-post');
    const nume = attr('data-nume');
    if (!post || !nume) continue;
    const label = firstMatch(html.slice(match.index, match.index + 400), /<span>([^<]+)<\/span>/i);
    const embed = attr('data-embed');
    const src = embed ? firstMatch(embed, /src="([^"]+)"/i) : null;
    options.push({
      nume,
      post,
      label: label ? normSpace(label) : `Server ${nume}`,
      type: attr('data-type') || 'urliframe',
      url: attr('data-url') || null,
      embedUrl: src ? decodeEntities(src) : null,
    });
  }
  return options;
}

function parseDownloads(html) {
  const blocks = [];
  // Each download format is a <p><b>MKV</b></p> followed by its own <ul> of qualities.
  const re = /<p>\s*<b>([^<]+)<\/b>\s*<\/p>\s*<ul>([\s\S]*?)<\/ul>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const format = normSpace(match[1]);
    const list = match[2];
    if (!/download-eps-links/.test(list)) continue;
    const qualities = [];
    const qre = /<li>\s*<strong>([^<]+)<\/strong>\s*<div class="download-eps-links">([\s\S]*?)<\/div>/gi;
    let qmatch;
    while ((qmatch = qre.exec(list)) !== null) {
      const quality = normSpace(qmatch[1]);
      const links = [];
      const lre = /<a href="([^"]+)"[^>]*>([^<]*)<\/a>/gi;
      let lmatch;
      while ((lmatch = lre.exec(qmatch[2])) !== null) {
        links.push({ host: normSpace(stripTags(lmatch[2])) || 'link', url: lmatch[1] });
      }
      if (links.length) qualities.push({ quality, links });
    }
    if (qualities.length) blocks.push({ format, qualities });
  }
  return blocks;
}

export class SamehadakuClient {
  constructor(http) {
    this.http = http;
    this.nonce = null;
  }

  async rest(resource, params = {}) {
    const qs = new URLSearchParams({ per_page: '100', ...params });
    const url = `${SAMEHADAKU_ORIGIN}/wp-json/wp/v2/${resource}?${qs}`;
    const res = await this.http.request(url, { headers: { accept: 'application/json' } });
    const total = Number(res.headers.get('x-wp-total') || 0);
    const totalPages = Number(res.headers.get('x-wp-totalpages') || 0);
    const data = JSON.parse(res.buffer.toString('utf8'));
    return { data, total, totalPages };
  }

  async restPage(resource, page, params = {}) {
    return this.rest(resource, { page: String(page), ...params });
  }

  async animeList({ page = 1, perPage = 100 } = {}) {
    const { data } = await this.rest('anime', { per_page: String(perPage), page: String(page), _embed: 'wp:featuredmedia' });
    return data.map((item) => this.mapAnime(item));
  }

  /** term ids -> display names for the `include`-capable taxonomies. */
  async taxonomyNames(taxonomy, ids) {
    const unique = [...new Set(ids.map(Number).filter((v) => Number.isFinite(v) && v > 0))];
    const names = {};
    for (let i = 0; i < unique.length; i += 100) {
      const batch = unique.slice(i, i + 100);
      try {
        const { data } = await this.rest(taxonomy, { include: batch.join(','), per_page: '100' });
        for (const term of data) names[term.id] = term.name;
      } catch (err) {
        // a 400 here means the taxonomy rejects `include`; callers fall back to ids.
      }
    }
    return names;
  }

  mapAnime(item) {
    const media = item?._embedded?.['wp:featuredmedia']?.[0];
    return {
      id: item.id,
      slug: item.slug,
      title: stripTags(item.title?.rendered || ''),
      url: item.link,
      poster: media?.source_url || null,
      synopsis: stripTags(item.content?.rendered || '').slice(0, 2000),
      genres: item.genre || [],
      season: item.season || [],
      studio: item.studio || [],
      producers: item.producers || [],
      type: item.type,
      modified: item.modified,
    };
  }

  async posts({ page = 1, perPage = 100, after, before, order = 'desc' } = {}) {
    const params = {
      per_page: String(perPage),
      page: String(page),
      order,
      orderby: 'date',
      _embed: 'wp:featuredmedia',
    };
    if (after) params.after = after;
    if (before) params.before = before;
    const { data, total, totalPages } = await this.rest('posts', params);
    return { items: data.map((item) => this.mapPost(item)), total, totalPages };
  }

  mapPost(item) {
    const media = item?._embedded?.['wp:featuredmedia']?.[0];
    return {
      id: item.id,
      slug: item.slug,
      title: stripTags(item.title?.rendered || ''),
      url: item.link,
      poster: media?.source_url || null,
      published: item.date,
      modified: item.modified,
      categories: item.categories || [],
    };
  }

  async episode(url) {
    const html = await this.http.text(url);
    const nonce = firstMatch(html, /"nonce":"([a-f0-9]+)"/i);
    if (nonce) this.nonce = nonce;

    const title = stripTags(firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i) || '');
    const poster = firstMatch(html, /<meta property="og:image" content="([^"]+)"/i);

    // Breadcrumb is the reliable series pointer: Home › Anime › <series>.
    const crumbs = [];
    const crumbRe = /<a[^>]*href="([^"]+)"[^>]*><span[^>]*>([^<]+)<\/span><\/a>/gi;
    let crumbMatch;
    while ((crumbMatch = crumbRe.exec(html)) !== null) {
      crumbs.push({ name: normSpace(crumbMatch[2]), url: crumbMatch[1] });
    }
    const seriesCrumb = crumbs.find((c) => /\/anime\//.test(c.url)) || null;
    const seriesUrl = seriesCrumb ? seriesCrumb.url : null;
    const seriesTitle = seriesCrumb ? seriesCrumb.name : null;
    const episodeNumber = Number(firstMatch(html, /itemprop="episodeNumber">(\d+)</i) || 0) || null;
    const options = parsePlayerOptions(html);
    const servers = [];
    for (const option of options) {
      if (option.embedUrl) {
        servers.push({
          server: option.label || `Server ${option.nume}`,
          nume: Number(option.nume) || null,
          embedUrl: option.embedUrl,
          type: option.type,
        });
        continue;
      }
      if (!option.url && this.nonce) {
        const embed = await this.fetchPlayerAjax(option, url);
        if (embed) {
          servers.push({
            server: option.label || `Server ${option.nume}`,
            nume: Number(option.nume) || null,
            embedUrl: embed,
            type: option.type,
          });
        }
      } else if (option.url) {
        servers.push({
          server: option.label || `Server ${option.nume}`,
          nume: Number(option.nume) || null,
          embedUrl: option.url,
          type: option.type,
        });
      }
    }

    return {
      id: Number(firstMatch(url, /-(\d+)\/?$/) || 0) || null,
      slug: url.replace(SAMEHADAKU_ORIGIN, '').replace(/\//g, ''),
      title,
      url,
      poster,
      episode: episodeNumber,
      seriesTitle: seriesTitle || null,
      seriesUrl: seriesUrl || null,
      servers,
      downloads: parseDownloads(html),
      sourceUrl: url,
      scrapedAt: new Date().toISOString(),
    };
  }

  async fetchPlayerAjax(option, refererUrl) {
    const body = new URLSearchParams({
      action: 'player_ajax',
      nonce: this.nonce,
      post: option.post,
      nume: option.nume,
      type: option.type || 'urliframe',
    });
    try {
      const res = await this.http.request(`${SAMEHADAKU_ORIGIN}/wp-admin/admin-ajax.php`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-requested-with': 'XMLHttpRequest',
          // The theme checks the referer against the episode page, not the origin.
          referer: refererUrl || `${SAMEHADAKU_ORIGIN}/`,
        },
        body: body.toString(),
      });
      const html = res.buffer.toString('utf8');
      const src = firstMatch(html, /src="([^"]+)"/i);
      if (src) return decodeEntities(src);
      const bare = html.trim().replace(/^<[^>]*>|<\/[^>]*>$/g, '').trim();
      return /^https?:\/\//.test(bare) ? bare : null;
    } catch {
      return null;
    }
  }

  async schedule() {
    try {
      return await this.http.json(`${SAMEHADAKU_ORIGIN}/wp-json/apk/schedule`);
    } catch {
      return null;
    }
  }

  async latest() {
    try {
      return await this.http.json(`${SAMEHADAKU_ORIGIN}/wp-json/apk/latest`);
    } catch {
      return null;
    }
  }
}
