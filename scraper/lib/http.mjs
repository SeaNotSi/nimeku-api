import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runCurl(args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error('curl timeout'));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`curl exited ${code}: ${Buffer.concat(err).toString().slice(0, 300)}`));
        return;
      }
      resolve(Buffer.concat(out));
    });
  });
}

/**
 * Bounded-concurrency HTTP client.
 *
 * Two transports: native fetch, and curl. Some origins (samehadaku behind
 * Cloudflare) reject undici's TLS fingerprint outright while curl passes, so
 * callers can pick the transport per client instead of fighting the handshake.
 */
export class HttpClient {
  constructor({
    concurrency = 6,
    delayMs = 80,
    timeoutMs = 30000,
    retries = 3,
    rateLimitMs = 5000,
    ua = DEFAULT_UA,
    transport = 'fetch',
  } = {}) {
    this.concurrency = Math.max(1, concurrency);
    this.delayMs = delayMs;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    // 429 needs a longer, doubling cooldown than a transient network error:
    // origins that rate-limit (nhentai) stay hot for minutes, not milliseconds.
    this.rateLimitMs = rateLimitMs;
    this.ua = ua;
    this.transport = transport;
    this.active = 0;
    this.queue = [];
    this.stats = { requests: 0, failures: 0 };
  }

  _acquire() {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this._pump();
    });
  }

  _pump() {
    while (this.active < this.concurrency && this.queue.length > 0) {
      this.active += 1;
      const next = this.queue.shift();
      next();
    }
  }

  _release() {
    this.active -= 1;
    this._pump();
  }

  async _curlOnce(url, opts) {
    const dir = await mkdtemp(join(tmpdir(), 'nimeku-'));
    const bodyPath = join(dir, 'body');
    const headersPath = join(dir, 'headers');
    try {
      const args = [
        '-sS',
        '-L',
        '--compressed',
        '--max-time',
        String(Math.ceil(this.timeoutMs / 1000)),
        '-A',
        this.ua,
        '-H',
        'accept-language: id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
        '-o',
        bodyPath,
        '-D',
        headersPath,
        '-w',
        '%{http_code}',
      ];
      for (const [key, value] of Object.entries(opts.headers || {})) {
        args.push('-H', `${key}: ${value}`);
      }
      if (opts.method && opts.method.toUpperCase() !== 'GET') {
        args.push('-X', opts.method.toUpperCase());
      }
      if (opts.body) args.push('--data-raw', String(opts.body));
      args.push(url);

      const statusRaw = (await runCurl(args, { timeoutMs: this.timeoutMs + 5000 })).toString().trim();
      const status = Number(statusRaw.slice(-3));
      if (!Number.isFinite(status) || status === 0) {
        throw new Error(`curl produced no status for ${url}`);
      }
      if (status === 429 || status === 408 || status >= 500) {
        throw Object.assign(new Error(`HTTP ${status} for ${url}`), { status });
      }
      if (status >= 400) throw Object.assign(new Error(`HTTP ${status} for ${url}`), { status });

      const headerText = await readFile(headersPath, 'utf8').catch(() => '');
      const headers = new Map();
      for (const block of headerText.split(/\r?\n\r?\n/)) {
        for (const line of block.split(/\r?\n/)) {
          const idx = line.indexOf(':');
          if (idx <= 0) continue;
          headers.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
        }
      }
      return { buffer: await readFile(bodyPath), headers };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async request(url, opts = {}) {
    await this._acquire();
    try {
      let lastError = null;
      for (let attempt = 0; attempt <= this.retries; attempt += 1) {
        try {
          if (this.transport === 'curl') {
            const { buffer, headers } = await this._curlOnce(url, opts);
            this.stats.requests += 1;
            return { buffer, status: 200, headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null } };
          }
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), this.timeoutMs);
          try {
            const res = await fetch(url, {
              redirect: 'follow',
              ...opts,
              signal: controller.signal,
              headers: {
                'user-agent': this.ua,
                'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
                ...(opts.headers || {}),
              },
            });
            if (res.status === 429 || res.status === 408 || res.status >= 500) {
              const retryAfter = Number(res.headers.get('retry-after'));
              throw Object.assign(new Error(`HTTP ${res.status} for ${url}`), {
                status: res.status,
                retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null,
              });
            }
            if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} for ${url}`), { status: res.status });
            const buffer = Buffer.from(await res.arrayBuffer());
            this.stats.requests += 1;
            return { buffer, status: res.status, headers: res.headers };
          } finally {
            clearTimeout(timer);
          }
        } catch (err) {
          lastError = err;
          const status = err && err.status;
          if (status === 404 || status === 410) break;
          if (attempt < this.retries) {
            const scale = status === 429 ? this.rateLimitMs : this.delayMs;
            const backoff = Math.max(err?.retryAfter || 0, scale * 2 ** attempt)
              + Math.floor(Math.random() * 250);
            await sleep(backoff);
          }
        }
      }
      this.stats.failures += 1;
      throw lastError || new Error(`request failed: ${url}`);
    } finally {
      if (this.delayMs > 0) await sleep(this.delayMs);
      this._release();
    }
  }

  async text(url, opts = {}) {
    const res = await this.request(url, opts);
    return res.buffer.toString('utf8');
  }

  async json(url, opts = {}) {
    const res = await this.request(url, opts);
    return JSON.parse(res.buffer.toString('utf8'));
  }

  async buffer(url, opts = {}) {
    const res = await this.request(url, opts);
    return res.buffer;
  }
}
