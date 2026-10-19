import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const DATA_DIR = join(ROOT, 'data');

export function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Stable 2-hex-digit bucket so detail files stay small and cacheable. */
export function bucketOf(id, buckets = 256) {
  return (fnv1a(String(id)) % buckets).toString(16).padStart(2, '0');
}

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  times: '×',
  middot: '·',
};

export function decodeEntities(input = '') {
  return String(input)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name] ?? match);
}

export function stripTags(input = '') {
  return normSpace(decodeEntities(String(input).replace(/<[^>]*>/g, ' ')));
}

export function normSpace(input = '') {
  return String(input).replace(/\s+/g, ' ').trim();
}

export function absoluteUrl(url, base) {
  if (!url) return null;
  try {
    return new URL(decodeEntities(url), base).toString();
  } catch {
    return null;
  }
}

export function firstMatch(input, regex, group = 1) {
  const match = input.match(regex);
  return match ? match[group] : null;
}

export async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value)}\n`, 'utf8');
  await rename(tmp, path);
}

export function isoNow() {
  return new Date().toISOString();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);
}

/** Run tasks with a hard ceiling so a bad page can never hang the job. */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
