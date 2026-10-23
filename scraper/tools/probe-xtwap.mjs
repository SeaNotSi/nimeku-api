/**
 * Maintenance pass: mark cached gomunime xtwap embeds as live or dead.
 *
 * Episodes are scraped once and then kept in the store, so a player page that
 * starts answering 404 after an upstream purge would keep advertising a dead
 * tab forever. New scrapes already carry the flag; this pass backfills the
 * records written before the probe existed. Safe to re-run: embeds that already
 * carry a boolean `live` are skipped unless --force is passed.
 *
 *   node scraper/tools/probe-xtwap.mjs [--force] [--limit=N]
 */

import { HttpClient } from '../lib/http.mjs';
import { BucketStore } from '../lib/store.mjs';
import { probeXtwap } from '../lib/xtwap.mjs';

const args = new Set(process.argv.slice(2));
const force = args.has('--force');
const limitArg = [...args].find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : Infinity;

const http = new HttpClient({ concurrency: 4, delayMs: 120, retries: 2 });
const store = new BucketStore('data/gomunime/episodes');
await store.load();

const targets = [];
for (const record of store.values()) {
  const players = record.players || [];
  players.forEach((player, index) => {
    if (!/xtwap\.top\/(?:cepat|cepat2|btube3)\.php/i.test(String(player.embed || ''))) return;
    if (!force && typeof player.live === 'boolean') return;
    targets.push({ record, index });
  });
}

console.log(`[probe-xtwap] ${targets.length} embeds queued across ${store.size} cached episodes`);
const queue = targets.slice(0, limit);
const counts = { live: 0, dead: 0, unknown: 0 };

let cursor = 0;
let done = 0;
async function runBatch() {
  const batch = queue.slice(cursor, cursor + 40);
  cursor += batch.length;
  await Promise.all(batch.map(async ({ record, index }) => {
    const player = record.players[index];
    const result = await probeXtwap(player.embed, http);
    player.live = result === null ? null : result;
    if (result === true) counts.live += 1;
    else if (result === false) counts.dead += 1;
    else counts.unknown += 1;
    store.set(record.slug, record);
    done += 1;
    if (done % 100 === 0) {
      console.log(`[probe-xtwap] ${done}/${queue.length} live=${counts.live} dead=${counts.dead} unknown=${counts.unknown}`);
    }
  }));
}

while (cursor < queue.length) await runBatch();

const buckets = await store.flush();
console.log(`[probe-xtwap] done: live=${counts.live} dead=${counts.dead} unknown=${counts.unknown}; ${buckets} buckets written`);
