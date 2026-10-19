/**
 * play.xtwap.top resolver.
 *
 * Gomunime embeds two flavours of xtwap player:
 *   btube3.php?url=…  -> video.js page, <source src> filled in on a later hit
 *   cepat2.php?url=…  -> jwplayer page, sources[0].file is a direct HLS URL
 *
 * Neither is stable on first fetch, so resolution retries until a URL shows up
 * and the caller stores the player page itself as an iframe fallback when it
 * does not.
 */

import { firstMatch, sleep } from './util.mjs';

const EMPTY_SOURCE = /<source[^>]+src=""\s/i;

export function isXtwapPlayer(url) {
  return /play\.xtwap\.top\/(btube3|cepat2)\.php/i.test(String(url || ''));
}

export function xtwapServerName(url) {
  if (/btube3/i.test(url)) return 'B-TUBE';
  if (/cepat2/i.test(url)) return 'CEPAT';
  return 'XTWAP';
}

function unescapeUrl(value) {
  return String(value).replace(/\\\//g, '/').replace(/&amp;/g, '&').trim();
}

/**
 * Returns { file, hls } — either may be null. Never throws; the player page
 * stays usable as an iframe either way.
 */
export async function resolveXtwap(playerUrl, http, { attempts = 3, delayMs = 700 } = {}) {
  let lastBody = '';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const html = await http.text(playerUrl);
      lastBody = html || '';
      if (html) {
        const hls = firstMatch(html, /"file"\s*:\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/i);
        if (hls) return { file: unescapeUrl(hls), hls: unescapeUrl(hls) };

        const src = firstMatch(html, /<source[^>]+src="([^"]+)"/i);
        if (src && !EMPTY_SOURCE.test(html) && src.trim()) {
          return { file: unescapeUrl(src), hls: /\.m3u8/i.test(src) ? unescapeUrl(src) : null };
        }
      }
    } catch {
      /* transient origin failure — the retry below decides */
    }
    if (attempt < attempts - 1) await sleep(delayMs * (attempt + 1));
  }
  return { file: null, hls: null, lastBodyLength: lastBody.length };
}
