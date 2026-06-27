import * as ProxyChain from 'proxy-chain';
import { config } from './config.js';
import { log } from './utils.js';

/** Generate a short, clean alphanumeric session id (no hyphens). */
function randomSession(len = 10) {
  let s = '';
  while (s.length < len) s += Math.random().toString(36).slice(2);
  return s.slice(0, len);
}

/** Escape a string for safe use inside a RegExp. */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SOCKS_PROTOCOLS = new Set(['socks', 'socks4', 'socks5', 'socks5h']);

/**
 * ProxyManager rotates through configured proxies and builds a unique
 * sticky-session identity for each browser context.
 *
 * Session id placement (handled by `buildUsername`):
 *   - Token already inside the username (NodeMaven "-sid-<id>-filter-..")
 *     → its value is replaced in place.
 *   - Token absent → it is appended as "<user><TOKEN><id>".
 *
 * Transport handling (handled by `acquire`):
 *   - HTTP/HTTPS proxies are passed to Playwright natively (it supports
 *     proxy auth for these).
 *   - SOCKS proxies that require auth CANNOT be used directly by Chromium
 *     (it has no SOCKS authentication support). For those we spin up a tiny
 *     local HTTP→SOCKS bridge (proxy-chain) and hand Playwright the local
 *     anonymous endpoint instead. The bridge is torn down on release().
 */
export class ProxyManager {
  constructor(proxies = config.proxies, sessionToken = config.sessionToken) {
    this.proxies = proxies;
    this.sessionToken = sessionToken;
    this.index = 0;
  }

  get available() {
    return this.proxies.length > 0;
  }

  /** Apply a fresh per-context session id to the username. */
  buildUsername(username, sessionId) {
    const token = this.sessionToken;
    if (!username || !token) return username;

    const unique = randomSession();

    if (username.includes(token)) {
      // Token sits inside the username (e.g. NodeMaven "-sid-<id>-filter-..").
      const re = new RegExp(`(${escapeRegExp(token)})([^-]+)`);
      if (re.test(username)) return username.replace(re, `$1${unique}`);
      return `${username}${unique}`;
    }
    // Token not present: append it as "<user><TOKEN><id>".
    return `${username}${token}${unique}`;
  }

  /**
   * Acquire a ready-to-use proxy for one browser context.
   *
   * @param {string|number} sessionId - unique seed (worker/attempt index)
   * @returns {Promise<{proxy: object|undefined, release: () => Promise<void>}>}
   *   `proxy` is a Playwright proxy option (or undefined for direct).
   *   `release` MUST be called when the context closes (tears down bridges).
   */
  async acquire(sessionId) {
    if (!this.available) {
      return { proxy: undefined, release: async () => {} };
    }

    // Round-robin across configured proxies.
    const base = this.proxies[this.index % this.proxies.length];
    this.index += 1;

    const username = this.buildUsername(base.username, sessionId);
    const password = base.password || '';
    const isSocks = SOCKS_PROTOCOLS.has(base.protocol);

    if (!isSocks) {
      // HTTP/HTTPS: Playwright handles auth natively, no bridge needed.
      const proxy = { server: `${base.protocol}://${base.host}:${base.port}` };
      if (username) {
        proxy.username = username;
        proxy.password = password;
      }
      return { proxy, release: async () => {} };
    }

    // SOCKS with auth: build a local HTTP bridge that forwards upstream.
    const auth =
      username !== undefined
        ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
        : '';
    const upstreamUrl = `${base.protocol}://${auth}${base.host}:${base.port}`;

    const server = new ProxyChain.Server({
      port: 0, // OS-assigned free port
      prepareRequestFunction: () => ({ upstreamProxyUrl: upstreamUrl }),
    });

    await server.listen();
    const localUrl = `http://127.0.0.1:${server.port}`;

    return {
      proxy: { server: localUrl },
      release: async () => {
        try {
          await server.close(true);
        } catch {
          /* best-effort cleanup */
        }
      },
    };
  }
}

export default ProxyManager;
