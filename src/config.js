import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Centralized configuration for the Avito scraper.
 *
 * All tunables come from environment variables (see .env.example) with
 * sensible production defaults. Proxy handling supports both a single
 * rotating gateway and an explicit list of proxies.
 */

const toInt = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

const toBool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
};

const DEFAULT_PROTOCOL = (process.env.PROXY_PROTOCOL || 'http')
  .toLowerCase()
  .replace(':', '');

/**
 * Parse a single proxy entry into a descriptor:
 *   { protocol, host, port, username, password }
 *
 * Two accepted formats:
 *   1. Full URL:   socks5://user:pass@host:port  (or http://, https://)
 *   2. Colon form: host:port:username:password   (protocol = PROXY_PROTOCOL)
 */
function parseProxyEntry(entry) {
  const e = entry.trim();
  if (!e) return null;

  if (e.includes('://')) {
    try {
      const u = new URL(e);
      const port = Number(u.port);
      if (!u.hostname || !port) return null;
      return {
        protocol: u.protocol.replace(':', '').toLowerCase(),
        host: u.hostname,
        port,
        username: u.username ? decodeURIComponent(u.username) : undefined,
        password: u.password ? decodeURIComponent(u.password) : undefined,
      };
    } catch {
      return null;
    }
  }

  // Colon form: host:port:username:password (username/password optional).
  const parts = e.split(':');
  const host = parts[0];
  const port = Number(parts[1]);
  if (!host || !port) return null;
  return {
    protocol: DEFAULT_PROTOCOL,
    host,
    port,
    username: parts[2] || undefined,
    // Password may itself contain ':' — re-join the remainder just in case.
    password: parts.length > 3 ? parts.slice(3).join(':') : undefined,
  };
}

/**
 * Read proxy entries from a plain-text file (one proxy per line).
 * Blank lines and lines starting with '#' are ignored. Returns the raw
 * (unparsed) entry strings.
 */
function readProxyFile() {
  const file = process.env.PROXY_FILE || 'proxies.txt';
  const filePath = path.isAbsolute(file) ? file : path.join(ROOT, file);
  if (!existsSync(filePath)) return [];

  try {
    return readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

/**
 * Build the proxy pool. Sources are merged in this order:
 *   1. proxies.txt file (one proxy per line) — primary, easy to edit.
 *   2. PROXY_LIST env var (comma/newline-separated).
 *   3. Single PROXY_* gateway (only if nothing above matched).
 */
function parseProxies() {
  const proxies = [];
  const seen = new Set();

  const addEntry = (entry) => {
    const parsed = parseProxyEntry(entry);
    if (!parsed) return;
    const key = `${parsed.protocol}://${parsed.host}:${parsed.port}:${parsed.username || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    proxies.push(parsed);
  };

  // 1. Separate file (recommended for multi-proxy / multi-thread setups).
  readProxyFile().forEach(addEntry);

  // 2. PROXY_LIST env var.
  (process.env.PROXY_LIST || '')
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach(addEntry);

  // 3. Fall back to a single gateway if nothing else was provided.
  if (proxies.length === 0 && process.env.PROXY_HOST && process.env.PROXY_PORT) {
    proxies.push({
      protocol: DEFAULT_PROTOCOL,
      host: process.env.PROXY_HOST,
      port: Number(process.env.PROXY_PORT),
      username: process.env.PROXY_USERNAME || undefined,
      password: process.env.PROXY_PASSWORD || undefined,
    });
  }

  return proxies;
}

export const config = {
  concurrency: toInt(process.env.CONCURRENCY, 5),
  maxRetries: toInt(process.env.MAX_RETRIES, 3),
  headless: toBool(process.env.HEADLESS, true),
  navTimeoutMs: toInt(process.env.NAV_TIMEOUT_MS, 60_000),

  delay: {
    min: toInt(process.env.MIN_DELAY_MS, 2000),
    max: toInt(process.env.MAX_DELAY_MS, 6000),
  },

  outputFile: process.env.OUTPUT_FILE || 'results.json',

  // Keyword-search mode (Avito requires a category in the path).
  search: {
    query: process.env.SEARCH_QUERY || '',
    region: process.env.SEARCH_REGION || 'all',
    // Comma-separated category slugs, e.g. "noutbuki,telefony".
    categories: (process.env.SEARCH_CATEGORY || 'noutbuki')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    maxItems: toInt(process.env.MAX_ITEMS, 50),
    maxPages: toInt(process.env.MAX_PAGES, 5),
  },

  proxies: parseProxies(),
  sessionToken: process.env.SESSION_TOKEN || '-session-',

  // Whether to retry on the listed HTTP status codes / conditions.
  retryStatusCodes: [403, 429, 500, 502, 503, 520, 521, 522, 524],

  // CAPTCHA solving (2Captcha). When a key is present, the scraper will try
  // to solve Avito's firewall hCaptcha instead of immediately failing.
  captcha: {
    apiKey: process.env.TWOCAPTCHA_API_KEY || '',
    // Avito's firewall hCaptcha sitekey (stable). Overridable via env.
    hcaptchaSitekey:
      process.env.AVITO_HCAPTCHA_SITEKEY ||
      '070db171-ddb9-4c93-b7f6-d25d3c9d7e28',
    // Max seconds to wait for 2Captcha to return a token.
    timeoutMs: toInt(process.env.CAPTCHA_TIMEOUT_MS, 180_000),
  },
};

/**
 * A curated pool of realistic, recent desktop User-Agents.
 * Each browser context picks a distinct one so fingerprints differ.
 */
export const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
];

/**
 * Common desktop viewport sizes for randomization.
 */
export const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1600, height: 900 },
];

/**
 * Locales / timezones to make each context look like a distinct Russian user.
 */
export const LOCALE = 'ru-RU';
export const TIMEZONES = [
  'Europe/Moscow',
  'Europe/Samara',
  'Asia/Yekaterinburg',
];

export default config;
