import { config } from './config.js';
import { createStealthContext } from './browser.js';
import { isFirewallPage, isCaptchaConfigured, solveAvitoFirewall } from './captcha.js';
import { simulateHumanSession } from './human.js';
import { log, sleep } from './utils.js';

/**
 * Keyword search → listing-URL collector.
 *
 * Avito requires a CATEGORY in the path for keyword search to render results:
 *   https://www.avito.ru/<region>/<category>?q=<query>&p=<page>
 * A bare global "?q=" returns a stripped page for automated browsers, so a
 * category slug is required (e.g. "noutbuki", "telefony", "avtomobili").
 *
 * Common top-level category slugs (for reference / multi-category search):
 */
export const COMMON_CATEGORIES = [
  'avtomobili',
  'noutbuki',
  'telefony',
  'planshety_i_elektronnye_knigi',
  'tovary_dlya_kompyutera',
  'audio_i_video',
  'kvartiry',
  'doma_dachi_kottedzhi',
  'bytovaya_tehnika',
  'mebel_i_interer',
  'odezhda_obuv_aksessuary',
  'tovary_dlya_detey_i_igrushki',
  'velosipedy',
  'instrumenty',
  'predlozheniya_uslug',
];

/** Build a search results URL for a given page. */
function buildSearchUrl({ region, category, query, page }) {
  const base = `https://www.avito.ru/${region}/${category}`;
  const params = new URLSearchParams({ q: query });
  if (page > 1) params.set('p', String(page));
  return `${base}?${params.toString()}`;
}

/** Extract clean listing URLs from a rendered search results page. */
async function extractResultLinks(page) {
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[data-marker="item-title"]'))
      .map((a) => a.href)
      .filter(Boolean),
  );
  // Strip query/context params → canonical item URL.
  return links.map((u) => u.split('?')[0]);
}

/**
 * Load one search results page with firewall-aware retries on fresh proxies.
 * @returns {Promise<{links: string[], hasNext: boolean}|null>}
 */
async function loadSearchPage(browser, proxyManager, target, tag) {
  for (let attempt = 1; attempt <= config.maxRetries; attempt += 1) {
    let context;
    let release = async () => {};
    try {
      const session = await proxyManager.acquire(`search-${tag}-${attempt}-`);
      release = session.release;
      context = await createStealthContext(browser, session.proxy, `search.${tag}.${attempt}`);
      const page = await context.newPage();
      page.setDefaultTimeout(config.navTimeoutMs);

      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs });

      // Firewall handling.
      if (await isFirewallPage(page)) {
        if (isCaptchaConfigured()) {
          const ok = await solveAvitoFirewall(page, tag);
          if (!ok) throw new Error('firewall not cleared');
        } else {
          throw new Error('firewall page (retry on fresh IP)');
        }
      }

      await simulateHumanSession(page);

      // Wait for results to render (SPA).
      let n = 0;
      for (let w = 0; w < 20; w += 1) {
        n = await page.evaluate(
          () => document.querySelectorAll('a[data-marker="item-title"]').length,
        );
        if (n > 0) break;
        await sleep(1000);
      }
      if (n === 0) throw new Error('no results rendered (possible soft block)');

      const links = await extractResultLinks(page);
      const hasNext = await page.evaluate(
        () => !!document.querySelector('[data-marker="pagination-button/nextPage"]'),
      );
      return { links, hasNext };
    } catch (err) {
      log.warn(tag, `search page attempt ${attempt}/${config.maxRetries} failed: ${err.message}`);
      if (attempt < config.maxRetries) await sleep(1500 * attempt);
    } finally {
      if (context) await context.close().catch(() => {});
      await release();
    }
  }
  return null;
}

/**
 * Collect listing URLs for a keyword search across one or more categories.
 *
 * @param {object} opts
 * @param {import('playwright').Browser} opts.browser
 * @param {import('./proxy.js').ProxyManager} opts.proxyManager
 * @param {string} opts.query
 * @param {string} [opts.region='all']
 * @param {string[]} opts.categories - one or more category slugs
 * @param {number} [opts.maxItems=50]
 * @param {number} [opts.maxPages=5]
 * @returns {Promise<string[]>} unique listing URLs
 */
export async function collectListingUrls({
  browser,
  proxyManager,
  query,
  region = 'all',
  categories,
  maxItems = 50,
  maxPages = 5,
}) {
  const cats = (categories && categories.length ? categories : ['noutbuki']).filter(Boolean);
  const collected = new Set();

  log.info('search', `Query="${query}" region=${region} categories=[${cats.join(', ')}] maxItems=${maxItems} maxPages=${maxPages}`);

  for (const category of cats) {
    if (collected.size >= maxItems) break;

    for (let p = 1; p <= maxPages; p += 1) {
      if (collected.size >= maxItems) break;

      const target = buildSearchUrl({ region, category, query, page: p });
      const tag = `${category}:p${p}`;
      log.info('search', `Loading ${target}`);

      const result = await loadSearchPage(browser, proxyManager, target, tag);
      if (!result) {
        log.warn('search', `Skipping ${tag} — could not load.`);
        break;
      }

      const before = collected.size;
      for (const u of result.links) {
        if (collected.size >= maxItems) break;
        collected.add(u);
      }
      const added = collected.size - before;
      log.ok('search', `${tag}: +${added} links (total ${collected.size})`);

      // Stop paginating this category if no new links or no next page.
      if (added === 0 || !result.hasNext) break;
    }
  }

  const urls = [...collected].slice(0, maxItems);
  log.ok('search', `Collected ${urls.length} listing URL(s).`);
  return urls;
}

export default { collectListingUrls, COMMON_CATEGORIES };
