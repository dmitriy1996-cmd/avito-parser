import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pLimit from 'p-limit';

import { config } from './config.js';
import { launchBrowser, createStealthContext } from './browser.js';
import { ProxyManager } from './proxy.js';
import { scrapeListing } from './scraper.js';
import { collectListingUrls } from './search.js';
import { resultsToCsv } from './csv.js';
import { log, sleep, randInt } from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/**
 * Parse simple "--flag value" CLI options.
 * Supported: --search/-q, --category/-c, --region/-r, --max, --pages.
 */
function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = {};
  const aliases = {
    '-q': 'search',
    '--search': 'search',
    '--query': 'search',
    '-c': 'category',
    '--category': 'category',
    '-r': 'region',
    '--region': 'region',
    '--max': 'max',
    '--pages': 'pages',
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (aliases[a]) {
      opts[aliases[a]] = argv[i + 1];
      i += 1;
    } else {
      positionals.push(a);
    }
  }
  opts.urls = positionals.filter((a) => /^https?:\/\//.test(a));
  return opts;
}

/**
 * Load target URLs. Priority:
 *   1. CLI URL args:    node src/index.js <url1> <url2> ...
 *   2. urls.txt file:   one URL per line (# comments allowed)
 */
async function loadUrls(cliUrls) {
  if (cliUrls && cliUrls.length) return cliUrls;

  const urlsFile = path.join(ROOT, 'urls.txt');
  if (existsSync(urlsFile)) {
    const raw = await readFile(urlsFile, 'utf8');
    return raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && /^https?:\/\//.test(l));
  }

  return [];
}

/**
 * Attempt a single URL with retries. Each attempt builds a fresh context with
 * a new proxy session + identity so a blocked IP/UA doesn't poison retries.
 */
async function processUrl(browser, proxyManager, url, workerId) {
  const tag = `w${workerId}`;

  for (let attempt = 1; attempt <= config.maxRetries; attempt += 1) {
    let context;
    let release = async () => {};
    try {
      const session = await proxyManager.acquire(`${workerId}-${attempt}-`);
      release = session.release;
      context = await createStealthContext(browser, session.proxy, `${workerId}.${attempt}`);

      const data = await scrapeListing(context, url, tag);
      log.ok(tag, `✓ Scraped "${(data.title || 'untitled').slice(0, 50)}" (attempt ${attempt})`);
      return { success: true, ...data };
    } catch (err) {
      const retryable = err.retryable === true;
      log.warn(
        tag,
        `Attempt ${attempt}/${config.maxRetries} failed: ${err.name || 'Error'} — ${err.message}`,
      );

      if (attempt < config.maxRetries && (retryable || attempt === 1)) {
        // Exponential-ish backoff with jitter before next attempt.
        const backoff = randInt(1500, 4000) * attempt;
        log.info(tag, `Retrying in ${backoff}ms...`);
        await sleep(backoff);
        continue;
      }

      log.error(tag, `✗ Giving up on ${url} after ${attempt} attempt(s)`);
      return {
        success: false,
        url,
        error: `${err.name || 'Error'}: ${err.message}`,
        scrapedAt: new Date().toISOString(),
      };
    } finally {
      if (context) await context.close().catch(() => {});
      await release();
    }
  }

  // Should be unreachable, but keep a defined return.
  return { success: false, url, error: 'Unknown failure', scrapedAt: new Date().toISOString() };
}

async function main() {
  const args = parseArgs();
  const proxyManager = new ProxyManager();

  // Resolve the search query from CLI (--search) or env (SEARCH_QUERY).
  const query = args.search || config.search.query;
  const region = args.region || config.search.region;
  const categories = args.category
    ? args.category.split(',').map((s) => s.trim()).filter(Boolean)
    : config.search.categories;
  const maxItems = args.max ? parseInt(args.max, 10) : config.search.maxItems;
  const maxPages = args.pages ? parseInt(args.pages, 10) : config.search.maxPages;

  log.info('main', proxyManager.available
    ? `Proxy rotation enabled (${config.proxies.length} gateway/proxies)`
    : 'No proxies configured — running on direct connection (NOT recommended for Avito).');

  const browser = await launchBrowser();

  // Decide the URL set: keyword search mode, or explicit URLs.
  let urls;
  if (query) {
    urls = await collectListingUrls({
      browser,
      proxyManager,
      query,
      region,
      categories,
      maxItems,
      maxPages,
    });
  } else {
    urls = await loadUrls(args.urls);
  }

  if (!urls.length) {
    log.error('main', 'No URLs to scrape.');
    log.info('main', 'Provide listing URLs (args or urls.txt), OR search:');
    log.info('main', '  node src/index.js --search "игровой ноутбук" --category noutbuki --region all --max 30');
    await browser.close().catch(() => {});
    process.exit(1);
  }

  log.info('main', `Scraping ${urls.length} URL(s) | concurrency=${config.concurrency} | retries=${config.maxRetries}`);

  const limit = pLimit(config.concurrency);

  const startedAt = Date.now();
  let counter = 0;

  const tasks = urls.map((url) =>
    limit(() => {
      const workerId = (counter += 1);
      return processUrl(browser, proxyManager, url, workerId);
    }),
  );

  const results = await Promise.all(tasks);

  await browser.close().catch(() => {});

  const succeeded = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  const output = {
    meta: {
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      total: results.length,
      succeeded: succeeded.length,
      failed: failed.length,
      concurrency: config.concurrency,
    },
    results,
  };

  const outPath = path.isAbsolute(config.outputFile)
    ? config.outputFile
    : path.join(ROOT, config.outputFile);

  await writeFile(outPath, JSON.stringify(output, null, 2), 'utf8');

  // Additionally export a spreadsheet-friendly CSV next to the JSON.
  const csvPath = outPath.replace(/\.json$/i, '') + '.csv';
  await writeFile(csvPath, resultsToCsv(results), 'utf8');

  log.ok('main', `Done in ${(output.meta.durationMs / 1000).toFixed(1)}s — ${succeeded.length} ok, ${failed.length} failed.`);
  log.ok('main', `Results written to ${outPath}`);
  log.ok('main', `Table written to ${csvPath}`);
}

// Never let an unhandled rejection crash the whole process silently.
process.on('unhandledRejection', (reason) => {
  log.error('process', 'Unhandled rejection:', reason);
});

main().catch((err) => {
  log.error('main', 'Fatal error:', err);
  process.exit(1);
});
