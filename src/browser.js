import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import {
  config,
  USER_AGENTS,
  VIEWPORTS,
  LOCALE,
  TIMEZONES,
} from './config.js';
import { pick, log } from './utils.js';

/**
 * Register the stealth plugin once at module load. playwright-extra accepts
 * puppeteer-extra stealth plugins and applies the relevant evasions
 * (navigator.webdriver, chrome.runtime, WebGL vendor, permissions, etc.).
 */
let stealthRegistered = false;
function ensureStealth() {
  if (stealthRegistered) return;
  const stealth = StealthPlugin();
  // Some evasions are puppeteer-specific and noisy under Playwright; drop them.
  stealth.enabledEvasions.delete('user-agent-override');
  chromium.use(stealth);
  stealthRegistered = true;
  log.info('browser', 'Stealth plugin registered');
}

/**
 * Launch a single shared Chromium instance. Each URL gets its own isolated
 * browser *context* (cookies/cache/proxy/UA) instead of a whole new browser,
 * which is far lighter on CPU/RAM while still isolating fingerprints.
 */
export async function launchBrowser() {
  ensureStealth();

  const browser = await chromium.launch({
    headless: config.headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-infobars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=IsolateOrigins,site-per-process',
      '--lang=ru-RU,ru',
    ],
  });

  log.info('browser', `Chromium launched (headless=${config.headless})`);
  return browser;
}

/**
 * Create an isolated context with a distinct identity: unique UA, viewport,
 * timezone, locale, and a per-session rotating proxy.
 *
 * @param {import('playwright').Browser} browser
 * @param {object|undefined} proxy - Playwright proxy option from ProxyManager
 * @param {string|number} sessionId
 */
export async function createStealthContext(browser, proxy, sessionId) {
  const userAgent = pick(USER_AGENTS);
  const viewport = pick(VIEWPORTS);
  const timezoneId = pick(TIMEZONES);

  const context = await browser.newContext({
    userAgent,
    viewport,
    locale: LOCALE,
    timezoneId,
    proxy, // undefined => direct connection
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    javaScriptEnabled: true,
    bypassCSP: true,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
    },
  });

  // Extra hardening on top of the stealth plugin.
  await context.addInitScript(() => {
    // navigator.webdriver -> undefined
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // Realistic language set
    Object.defineProperty(navigator, 'languages', {
      get: () => ['ru-RU', 'ru', 'en-US', 'en'],
    });
    // Plausible plugin/mimeType length
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });
    // Fake a chrome runtime object
    window.chrome = window.chrome || { runtime: {} };
    // Permissions query consistency
    const originalQuery = window.navigator.permissions?.query;
    if (originalQuery) {
      window.navigator.permissions.query = (params) =>
        params && params.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(params);
    }
  });

  // Block heavy resources we don't need (fonts, media, analytics) to save
  // bandwidth/proxy cost. Images are allowed because we extract image URLs
  // from the DOM, but we abort actually downloading the bytes.
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['media', 'font'].includes(type)) {
      return route.abort();
    }
    return route.continue();
  });

  log.info(
    `ctx#${sessionId}`,
    `UA="${userAgent.slice(0, 40)}..." viewport=${viewport.width}x${viewport.height} tz=${timezoneId} proxy=${proxy ? 'yes' : 'direct'}`,
  );

  return context;
}

export default { launchBrowser, createStealthContext };
