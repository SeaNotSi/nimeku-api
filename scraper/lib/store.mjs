import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { bucketOf, readJson, writeJson } from './util.mjs';

/**
 * Records are split into 256 hash buckets so a 12k-item catalogue stays a few
 * hundred small files instead of one multi-megabyte blob. Flush only rewrites
 * buckets whose contents actually changed, which keeps Action commits tiny.
 */
export class BucketStore {
  constructor(dir) {
    this.dir = dir;
    this.buckets = new Map();
    this.dirty = new Set();
  }

  static bucketFor(id) {
    return bucketOf(id);
  }

  async load() {
    let names = [];
    try {
      names = await readdir(this.dir);
    } catch {
      return this;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const bucket = name.slice(0, -5);
      const data = await readJson(join(this.dir, name), {});
      this.buckets.set(bucket, data && typeof data === 'object' ? data : {});
    }
    return this;
  }

  has(id) {
    return Boolean(this.get(id));
  }

  get(id) {
    const bucket = BucketStore.bucketFor(id);
    const data = this.buckets.get(bucket);
    return data ? data[id] : undefined;
  }

  set(id, record) {
    const bucket = BucketStore.bucketFor(id);
    if (!this.buckets.has(bucket)) this.buckets.set(bucket, {});
    const data = this.buckets.get(bucket);
    const next = JSON.stringify(record);
    if (JSON.stringify(data[id]) === next) return false;
    data[id] = record;
    this.dirty.add(bucket);
    return true;
  }

  delete(id) {
    const bucket = BucketStore.bucketFor(id);
    const data = this.buckets.get(bucket);
    if (!data || !(id in data)) return false;
    delete data[id];
    this.dirty.add(bucket);
    return true;
  }

  values() {
    const out = [];
    for (const data of this.buckets.values()) out.push(...Object.values(data));
    return out;
  }

  get size() {
    let total = 0;
    for (const data of this.buckets.values()) total += Object.keys(data).length;
    return total;
  }

  async flush() {
    const buckets = this.dirty.size > 0 ? [...this.dirty] : [...this.buckets.keys()];
    for (const bucket of buckets) {
      await writeJson(join(this.dir, `${bucket}.json`), this.buckets.get(bucket) || {});
    }
    this.dirty.clear();
    return buckets.length;
  }
}

/**
 * Writes a chunked list plus its manifest. Chunks are ordered, so the frontend
 * can page without downloading the whole catalogue.
 */
export async function writeChunkedList(dir, records, perChunk = 500) {
  const chunks = [];
  for (let i = 0; i < records.length; i += perChunk) {
    chunks.push(records.slice(i, i + perChunk));
  }
  for (let i = 0; i < chunks.length; i += 1) {
    await writeJson(join(dir, `${String(i).padStart(3, '0')}.json`), chunks[i]);
  }
  const expected = new Set(chunks.map((_, i) => `${String(i).padStart(3, '0')}.json`));
  let existing = [];
  try {
    existing = await readdir(dir);
  } catch {
    existing = [];
  }
  for (const name of existing) {
    if (name === 'index.json' || !name.endsWith('.json')) continue;
    if (!expected.has(name)) await unlink(join(dir, name)).catch(() => {});
  }
  await writeJson(join(dir, 'index.json'), {
    count: records.length,
    perChunk,
    chunks: chunks.length,
    generatedAt: new Date().toISOString(),
  });
  return { count: records.length, chunks: chunks.length };
}
