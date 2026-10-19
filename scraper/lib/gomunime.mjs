/**
 * Gomunime client — server-rendered HTML, so everything comes from the
 * sitemap index plus per-page JSON-LD and the visible markup.
 */

import { absoluteUrl, decodeEntities, firstMatch, normSpace, stripTags } from './util.mjs';
import { isXtwapPlayer, resolveXtwap, xtwapServerName } from './xtwap.mjs';

export const GOMUNIME_ORIGIN = 'https://gomunime.top';

function hostLabel(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (/mp4upload/.test(host)) return 'MP4UPLOAD';
    if (/mega\.nz/.test(host)) return 'MEGA';
    if (/pixeldrain/.test(host)) return 'PIXELDRAIN';
    if (/blogger|blogspot/.test(host)) return 'BLOGSPOT';
    if (/filedon/.test(host)) return 'FILEDON';
    if (/dailymotion|dai\.ly/.test(host)) return 'DAILYMOTION';
    return host.split('.').slice(-2, -1)[0].toUpperCase() || host.toUpperCase();
  } catch {
    return 'SERVER';
  }
}

function ldRating(seriesLd) {
  const aggregate = seriesLd && seriesLd.aggregateRating ? seriesLd.aggregateRating : null;
  if (!aggregate || aggregate.ratingValue == null) return null;
  const value = Number(aggregate.ratingValue);
  return Number.isFinite(value) ? value : null;
}

function jsonLdBlocks(html) {
  const out = [];
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    try {
      out.push(JSON.parse(match[1].trim()));
    } catch {
      /* malformed block, skip */
    }
  }
  return out;
}

function ldOfType(blocks, type) {
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block['@type'] === type) return block;
    if (Array.isArray(block['@graph'])) {
      const hit = block['@graph'].find((node) => node && node['@type'] === type);
      if (hit) return hit;
    }
  }
  return null;
}

function extractIframes(html) {
  const out = [];
  const re = /<iframe\b[^>]*\bsrc="([^"]+)"/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const url = absoluteUrl(match[1], GOMUNIME_ORIGIN);
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

function extractGenres(html) {
  const out = [];
  const re = /href="https?:\/\/gomunime\.top\/genre\/([a-z0-9-]+)"/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const slug = match[1];
    if (!out.includes(slug)) out.push(slug);
  }
  return out;
}

function metaContent(html, property) {
  const re = new RegExp(`<meta[^>]+(?:property|name)="${property}"[^>]+content="([^"]*)"`, 'i');
  const alt = new RegExp(`<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="${property}"`, 'i');
  return decodeEntities(firstMatch(html, re) || firstMatch(html, alt) || '');
}

export class GomunimeClient {
  constructor(http) {
    this.http = http;
  }

  async sitemapUrls(name) {
    const xml = await this.http.text(`${GOMUNIME_ORIGIN}/sitemap-${name}.xml`);
    const out = [];
    const re = /<loc>([^<]+)<\/loc>/g;
    let match;
    while ((match = re.exec(xml)) !== null) out.push(match[1].trim());
    return out;
  }

  async seriesIndex() {
    const urls = await this.sitemapUrls('series');
    return urls
      .map((url) => url.replace(GOMUNIME_ORIGIN + '/', '').replace(/\/$/, ''))
      .filter((slug) => slug && !slug.includes('/'));
  }

  async episodeIndex() {
    const urls = await this.sitemapUrls('episodes');
    return urls.filter((url) => /-episode-\d+$/.test(url));
  }

  async episode(url) {
    const html = await this.http.text(url);
    const blocks = jsonLdBlocks(html);
    const episodeLd = ldOfType(blocks, 'TVEpisode');
    const videoLd = ldOfType(blocks, 'VideoObject');
    const seriesLd = episodeLd && episodeLd.partOfSeries ? episodeLd.partOfSeries : null;

    const slug = url.replace(GOMUNIME_ORIGIN + '/', '');
    const seriesUrl = seriesLd && seriesLd.url ? seriesLd.url : null;
    const seriesSlug = seriesUrl ? seriesUrl.replace(GOMUNIME_ORIGIN + '/', '') : null;

    const embeds = extractIframes(html);
    const players = [];
    for (const embed of embeds) {
      if (isXtwapPlayer(embed)) {
        const resolved = await resolveXtwap(embed, this.http);
        players.push({
          label: xtwapServerName(embed),
          kind: resolved.hls ? 'hls' : resolved.file ? 'file' : 'iframe',
          embed,
          file: resolved.file || null,
          hls: resolved.hls || null,
        });
      } else {
        players.push({ label: hostLabel(embed), kind: 'iframe', embed, file: null, hls: null });
      }
    }

    const synopsis = metaContent(html, 'og:description');
    const ratingMatch = synopsis.match(/rating\s+([0-9.]+)\s*MAL/i);

    return {
      id: slug,
      slug,
      title: normSpace(episodeLd?.name || metaContent(html, 'og:title').replace(/\s*\|.*$/, '')),
      episode: episodeLd?.episodeNumber ?? Number(firstMatch(slug, /-episode-(\d+)$/)),
      series: seriesLd?.name || null,
      seriesSlug,
      seriesUrl,
      poster: absoluteUrl(episodeLd?.image || metaContent(html, 'og:image'), GOMUNIME_ORIGIN),
      published: episodeLd?.datePublished || null,
      genres: Array.isArray(seriesLd?.genre) ? seriesLd.genre.filter((g) => g !== 'Anime') : [],
      rating: ratingMatch ? Number(ratingMatch[1]) : null,
      synopsis,
      embedUrl: videoLd?.embedUrl || null,
      players,
      sourceUrl: url,
      scrapedAt: new Date().toISOString(),
    };
  }

  async series(url) {
    const html = await this.http.text(url);
    const blocks = jsonLdBlocks(html);
    const seriesLd = ldOfType(blocks, 'TVSeries');
    const slug = url.replace(GOMUNIME_ORIGIN + '/', '').replace(/\/$/, '');

    const poster = firstMatch(html, /<div class="aspect-poster[\s\S]{0,400}?<img src="([^"]+)"/i);
    const type = stripTags(firstMatch(html, /<span class="badge-sub">([^<]+)<\/span>/i) || '');
    const status = stripTags(firstMatch(html, /<span class="badge bg-(?:green|yellow|red|blue)[^"]*">([^<]+)<\/span>/i) || '');
    const episodeText = stripTags(firstMatch(html, />Episode<\/dt><dd[^>]*>([^<]+)<\/dd>/i) || '');
    const totalEpisodes = episodeText.includes('/')
      ? Number(episodeText.split('/')[1].trim()) || null
      : Number(episodeText) || null;

    const episodes = [];
    const re = /href="(https:\/\/gomunime\.top\/[a-z0-9-]+-episode-\d+)"/gi;
    let match;
    while ((match = re.exec(html)) !== null) {
      const epUrl = match[1];
      const epSlug = epUrl.replace(GOMUNIME_ORIGIN + '/', '');
      const number = Number(firstMatch(epSlug, /-episode-(\d+)$/));
      if (!episodes.some((ep) => ep.slug === epSlug)) {
        episodes.push({ slug: epSlug, number, url: epUrl });
      }
    }
    episodes.sort((a, b) => a.number - b.number);

    return {
      id: slug,
      slug,
      title: normSpace(seriesLd?.name || firstMatch(html, /<h1[^>]*>([^<]+)<\/h1>/i) || slug),
      type: type || null,
      status: status || null,
      poster: absoluteUrl(poster || seriesLd?.image, GOMUNIME_ORIGIN),
      synopsis: metaContent(html, 'og:description'),
      genres: extractGenres(html),
      rating: ldRating(seriesLd),
      totalEpisodes: totalEpisodes ?? (seriesLd?.numberOfEpisodes ? Number(seriesLd.numberOfEpisodes) : null),
      episodes,
      sourceUrl: url,
      scrapedAt: new Date().toISOString(),
    };
  }
}
