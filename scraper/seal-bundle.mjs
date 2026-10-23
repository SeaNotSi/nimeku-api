#!/usr/bin/env node
/**
 * Builds the single private endpoint and writes it wherever the caller says.
 *
 *   NIMEKU_API_PASSPHRASE=... node seal-bundle.mjs --out=_site/data/api.enc.json
 *
 * It runs inside the Pages deploy job, not the scrape job: the sealed file is
 * ~6 MB of base64 and committing that every six hours would bloat the repo,
 * while the plain data it derives from diffs cleanly.
 */

import { buildAggregate, sealAggregate } from './lib/aggregate.mjs';
import { log, writeJson } from './lib/util.mjs';

const outArg = process.argv.find((arg) => arg.startsWith('--out='));
const out = outArg ? outArg.slice('--out='.length) : '';
const passphrase = (process.env.NIMEKU_API_PASSPHRASE || '').trim();

if (!out) {
  console.error('usage: node seal-bundle.mjs --out=<path>');
  process.exit(2);
}

if (!passphrase) {
  log('api bundle dilewati: NIMEKU_API_PASSPHRASE tidak diset');
  process.exit(0);
}

const started = Date.now();
const bundle = await buildAggregate();
const envelope = sealAggregate(bundle, passphrase);
await writeJson(out, envelope);

log(
  'api bundle',
  JSON.stringify({
    ...bundle.counts,
    rawBytes: envelope.bytes,
    sealedBytes: envelope.data.length,
    ms: Date.now() - started,
  }),
);
