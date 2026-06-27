import { config } from './config.js';
import { simulateHumanSession, think } from './human.js';
import { log } from './utils.js';
import {
  isCaptchaConfigured,
  isFirewallPage,
  solveAvitoFirewall,
} from './captcha.js';

/**
 * Error subclasses let the retry layer decide whether an attempt is
 * retryable (blocks, bad status) vs. a hard parse failure.
 */
export class BlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BlockedError';
    this.retryable = true;
  }
}

export class HttpStatusError extends Error {
  constructor(status) {
    super(`Unexpected HTTP status ${status}`);
    this.name = 'HttpStatusError';
    this.status = status;
    this.retryable = config.retryStatusCodes.includes(status);
  }
}

/**
 * Detect CAPTCHA / Cloudflare / "access blocked" interstitials. Avito shows
 * a firewall page ("Доступ ограничен", "Подтвердите, что запросы отправляли
 * вы") when it suspects automation.
 */
async function detectBlock(page) {
  const url = page.url();
  if (/\/blocked|\/firewall|geetest|captcha/i.test(url)) {
    return `Block URL detected: ${url}`;
  }

  const signature = await page.evaluate(() => {
    const text = (document.body?.innerText || '').toLowerCase();
    const title = (document.title || '').toLowerCase();
    const markers = [
      'доступ ограничен',
      'подтвердите, что запросы отправляли вы',
      'проверка безопасности',
      'are you a robot',
      'access denied',
      'checking your browser',
      'cloudflare',
      'just a moment',
      'enable javascript and cookies',
      'captcha',
    ];
    const found = markers.find((m) => text.includes(m) || title.includes(m));
    const hasCaptchaEl =
      !!document.querySelector(
        'iframe[src*="captcha"], #geetest, .g-recaptcha, [class*="firewall"]',
      );
    return found || (hasCaptchaEl ? 'captcha element present' : null);
  });

  return signature || null;
}

/**
 * Helper: return trimmed text content of the first matching selector, or null.
 */
async function textOf(page, selectors) {
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) {
      const txt = (await el.textContent())?.trim();
      if (txt) return txt;
    }
  }
  return null;
}

/**
 * Extract the structured listing data from an already-loaded Avito page.
 * Uses layered selector fallbacks (data-marker attributes first, which are
 * the most stable on Avito, then class/semantic fallbacks).
 */
async function extractData(page) {
  const title = await textOf(page, [
    '[data-marker="item-view/title-info"]',
    'h1[itemprop="name"]',
    'h1',
  ]);

  const priceRaw = await page.evaluate(() => {
    const el =
      document.querySelector('[data-marker="item-view/item-price"]') ||
      document.querySelector('[itemprop="price"]') ||
      document.querySelector('[class*="price-value"] span');
    if (!el) return null;
    const content = el.getAttribute('content');
    return content || el.textContent;
  });
  const price = priceRaw ? priceRaw.replace(/\s+/g, ' ').trim() : null;

  const description = await textOf(page, [
    '[data-marker="item-view/item-description"]',
    '[itemprop="description"]',
    '#bx_item-description',
  ]);

  const sellerName = await textOf(page, [
    '[data-marker="seller-info/name"]',
    '[data-marker="seller-link/link"]',
    '.seller-info-name',
    'div[class*="seller-info-name"] a',
  ]);

  const location = await textOf(page, [
    '[data-marker="item-view/item-address"]',
    'div[itemprop="address"]',
    'span.style-item-address__string',
    '[class*="item-address"]',
  ]);

  // Seller profile URL + type (company / private person).
  const seller = await page.evaluate(() => {
    const link =
      document.querySelector('[data-marker="seller-link/link"]') ||
      document.querySelector('[data-marker="seller-info/name"] a') ||
      document.querySelector('a[href*="/user/"], a[href*="/brands/"]');
    const url = link?.href || null;

    const text = (document.body?.innerText || '').toLowerCase();
    let type = null;
    if (document.querySelector('[data-marker="seller-info/label"]')) {
      type = document
        .querySelector('[data-marker="seller-info/label"]')
        .textContent.trim();
    } else if (text.includes('компания') || text.includes('магазин')) {
      type = 'Компания';
    } else if (text.includes('частное лицо')) {
      type = 'Частное лицо';
    }
    return { url, type };
  });

  // High-resolution image URLs. Avito stores galleries in data-marker image
  // frames; we prefer the largest candidate in each srcset and de-dup.
  const images = await page.evaluate(() => {
    const urls = new Set();

    const pushFromSrcset = (srcset) => {
      if (!srcset) return;
      // Take the last (largest) candidate in the srcset string.
      const parts = srcset.split(',').map((s) => s.trim());
      const last = parts[parts.length - 1];
      const url = last?.split(/\s+/)[0];
      if (url) urls.add(url);
    };

    const selectors = [
      '[data-marker="image-frame/image-wrapper"] img',
      'li[data-marker^="image-preview"] img',
      'div[class*="gallery"] img',
      'figure img',
    ];

    document.querySelectorAll(selectors.join(',')).forEach((img) => {
      if (img.srcset) pushFromSrcset(img.srcset);
      const src = img.getAttribute('src') || img.src;
      if (src && !src.startsWith('data:')) urls.add(src);
    });

    // Some galleries keep originals in <link rel="preload" as="image"> or
    // background-image styles.
    document
      .querySelectorAll('[style*="background-image"]')
      .forEach((node) => {
        const m = /url\(["']?(.*?)["']?\)/.exec(node.getAttribute('style') || '');
        if (m && m[1] && !m[1].startsWith('data:')) urls.add(m[1]);
      });

    // Normalize protocol-relative URLs and keep only avito image hosts/CDN.
    return Array.from(urls)
      .map((u) => (u.startsWith('//') ? `https:${u}` : u))
      .filter((u) => /^https?:\/\//.test(u));
  });

  return {
    title: title || null,
    price: price || null,
    description: description || null,
    sellerName: sellerName || null,
    sellerUrl: seller.url || null,
    sellerType: seller.type || null,
    location: location || null,
    images,
  };
}

/**
 * Best-effort seller phone reveal. On Avito the number is hidden behind a
 * "Показать телефон" button and fetched on click (sometimes rendered as an
 * image, sometimes as a tel: link). This works most reliably in HEADFUL mode
 * with a clean session. Returns the phone string or null.
 */
async function revealPhone(page, tag) {
  try {
    const btn = page
      .locator(
        '[data-marker="item-phone-button/card"], [data-marker*="phone-button"], button:has-text("Показать телефон"), button:has-text("Показать")',
      )
      .first();

    if (!(await btn.count())) return null;

    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await think();
    await btn.click({ timeout: 8000 }).catch(() => {});

    // Wait for the number to appear (tel: link or phone marker).
    const phone = await page
      .waitForFunction(
        () => {
          const tel = document.querySelector('a[href^="tel:"]');
          if (tel) return tel.getAttribute('href').replace('tel:', '').trim();
          const marker = document.querySelector(
            '[data-marker="item-phone-number"], [class*="phone"] [class*="number"]',
          );
          const txt = marker?.textContent?.trim();
          if (txt && /[\d\-\+\(\)\s]{7,}/.test(txt)) return txt;
          return null;
        },
        { timeout: 12_000 },
      )
      .then((h) => h.jsonValue())
      .catch(() => null);

    if (phone) log.ok(tag, `Phone revealed: ${phone}`);
    return phone || null;
  } catch {
    return null;
  }
}

/**
 * Scrape a single Avito listing in the given (already created) context.
 * Throws BlockedError / HttpStatusError so the retry layer can react.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {string} url
 * @param {string|number} tag - log tag (worker id)
 */
export async function scrapeListing(context, url, tag) {
  const page = await context.newPage();
  page.setDefaultTimeout(config.navTimeoutMs);
  page.setDefaultNavigationTimeout(config.navTimeoutMs);

  try {
    log.info(tag, `Navigating: ${url}`);
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: config.navTimeoutMs,
    });

    const status = response?.status();

    // Avito serves its firewall CAPTCHA page WITH a 429/403 status. If a
    // solver is configured, try to clear it before treating it as an error.
    if (await isFirewallPage(page)) {
      if (isCaptchaConfigured()) {
        const solved = await solveAvitoFirewall(page, tag);
        if (!solved) throw new BlockedError('Firewall CAPTCHA solve failed');
      } else {
        throw new BlockedError(
          'Firewall/CAPTCHA page (set TWOCAPTCHA_API_KEY to auto-solve)',
        );
      }
    } else if (status && (status >= 400 || config.retryStatusCodes.includes(status))) {
      throw new HttpStatusError(status);
    }

    // Let the page settle, then act human.
    await think();
    await simulateHumanSession(page);

    // Block / CAPTCHA detection after JS has run.
    const block = await detectBlock(page);
    if (block) {
      // A challenge may render only after JS executes — try once more.
      if (isCaptchaConfigured() && (await isFirewallPage(page))) {
        const solved = await solveAvitoFirewall(page, tag);
        if (!solved) throw new BlockedError(block);
      } else {
        throw new BlockedError(block);
      }
    }

    // Ensure the core content actually rendered before parsing.
    await page
      .waitForSelector(
        '[data-marker="item-view/title-info"], h1[itemprop="name"], h1',
        { timeout: 15_000 },
      )
      .catch(() => {
        /* fall through; extractData still tries fallbacks */
      });

    const data = await extractData(page);

    // If we got literally nothing, treat as a soft block to allow a retry.
    if (!data.title && !data.price && !data.description) {
      const recheck = await detectBlock(page);
      throw new BlockedError(
        recheck || 'Empty page — no listing fields found (possible soft block)',
      );
    }

    // Best-effort seller phone reveal (requires a click + extra request).
    const phone = await revealPhone(page, tag);

    return {
      url,
      status: status ?? null,
      scrapedAt: new Date().toISOString(),
      ...data,
      phone: phone || null,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

export default { scrapeListing, BlockedError, HttpStatusError };
