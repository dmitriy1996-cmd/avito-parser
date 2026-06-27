import { writeFile } from 'node:fs/promises';
import { Solver } from '@2captcha/captcha-solver';
import { config } from './config.js';
import { log, sleep } from './utils.js';

/**
 * 2Captcha integration for Avito's firewall challenge
 * ("Доступ ограничен: проблема с IP" → button "Продолжить").
 *
 * Avito's firewall can serve EITHER hCaptcha OR GeeTest v4 — the choice is
 * returned by a POST to `/web/5/firewallCaptcha/get`. This module:
 *   1. Clicks "Продолжить" and captures the `/firewallCaptcha/get` response.
 *   2. Detects the real captcha type + params (sitekey / rqdata / captcha_id).
 *   3. Solves the CORRECT captcha via 2Captcha.
 *   4. Injects the token (Avito's `sethCaptchaResponse` / GeeTest callback).
 *   5. Waits for the firewall to clear.
 *
 * NOTE: This only works in HEADFUL mode. In headless, Avito detects the
 * automation and never renders / fetches the captcha after "Продолжить", so
 * there is nothing to solve — a fresh-IP retry is the only path there.
 */

export function isCaptchaConfigured() {
  return Boolean(config.captcha.apiKey);
}

let solverInstance = null;
function getSolver() {
  if (!solverInstance) solverInstance = new Solver(config.captcha.apiKey);
  return solverInstance;
}

/** Heuristic: is the current page Avito's firewall/captcha interstitial? */
export async function isFirewallPage(page) {
  try {
    return await page.evaluate(() => {
      const t = (document.title || '').toLowerCase();
      const b = (document.body?.innerText || '').toLowerCase();
      return (
        t.includes('доступ ограничен') ||
        b.includes('доступ ограничен') ||
        b.includes('для решения капчи') ||
        typeof window.sethCaptchaResponse === 'function'
      );
    });
  } catch {
    return false;
  }
}

/**
 * Inspect the firewall config + DOM to decide which captcha is active and
 * extract its parameters.
 * @returns {Promise<{type:'hcaptcha'|'geetest', sitekey?:string, rqdata?:string, captchaId?:string, raw?:any}>}
 */
async function detectCaptcha(page, fwConfig) {
  // 1. Try to read params straight from the firewall config JSON (best source).
  if (fwConfig && typeof fwConfig === 'object') {
    const flat = JSON.stringify(fwConfig).toLowerCase();
    // GeeTest markers.
    const captchaId =
      fwConfig.captcha_id ||
      fwConfig.captchaId ||
      fwConfig?.geetest?.captcha_id ||
      fwConfig?.data?.captcha_id;
    if (captchaId || flat.includes('geetest') || flat.includes('captcha_id')) {
      return { type: 'geetest', captchaId, raw: fwConfig };
    }
    // hCaptcha markers.
    const sitekey =
      fwConfig.sitekey ||
      fwConfig.site_key ||
      fwConfig?.hcaptcha?.sitekey ||
      fwConfig?.data?.sitekey;
    const rqdata =
      fwConfig.rqdata || fwConfig?.hcaptcha?.rqdata || fwConfig?.data?.rqdata;
    if (sitekey || flat.includes('hcaptcha')) {
      return { type: 'hcaptcha', sitekey, rqdata, raw: fwConfig };
    }
  }

  // 2. Fall back to DOM inspection.
  const dom = await page
    .evaluate(() => {
      const hHasIframe = !!document.querySelector('iframe[src*="hcaptcha"]');
      const hSitekey =
        document.querySelector('[data-sitekey]')?.getAttribute('data-sitekey') ||
        null;
      const gHas =
        !!document.querySelector(
          '[class*="geetest"], .geetest_box, iframe[src*="geetest"]',
        ) || typeof window.initGeetest4 === 'function';
      return { hHasIframe, hSitekey, gHas };
    })
    .catch(() => ({}));

  if (dom.gHas && !dom.hHasIframe && !dom.hSitekey) {
    return { type: 'geetest' };
  }
  return {
    type: 'hcaptcha',
    sitekey: dom.hSitekey || config.captcha.hcaptchaSitekey,
  };
}

/** Solve via the appropriate 2Captcha method and return a token/result. */
async function solveWith2Captcha(detected, pageurl, userAgent, tag) {
  const solver = getSolver();
  const guard = sleep(config.captcha.timeoutMs).then(() => {
    throw new Error('2Captcha solve timed out');
  });

  if (detected.type === 'geetest') {
    if (!detected.captchaId) {
      log.warn(tag, 'GeeTest detected but no captcha_id found — cannot solve.');
      return null;
    }
    log.info(tag, `Solving GeeTest v4 (captcha_id=${detected.captchaId}) via 2Captcha`);
    const res = await Promise.race([
      solver.geetestV4({ pageurl, captcha_id: detected.captchaId }),
      guard,
    ]);
    return { type: 'geetest', data: res?.data };
  }

  // hCaptcha (pass userAgent + invisible + rqdata — required for Avito).
  const sitekey = detected.sitekey || config.captcha.hcaptchaSitekey;
  log.info(tag, `Solving hCaptcha (sitekey=${sitekey.slice(0, 12)}...) via 2Captcha`);
  const params = { pageurl, sitekey, invisible: true, userAgent };
  if (detected.rqdata) params.data = detected.rqdata;
  const res = await Promise.race([solver.hcaptcha(params), guard]);
  return { type: 'hcaptcha', data: res?.data };
}

/** Inject the solved token into the page using Avito's own hooks. */
async function injectToken(page, result, tag) {
  await page
    .evaluate(
      ({ type, data }) => {
        if (type === 'hcaptcha') {
          document
            .querySelectorAll(
              'textarea[name="h-captcha-response"], textarea#h-captcha-response, textarea[name="g-recaptcha-response"]',
            )
            .forEach((ta) => {
              ta.value = data;
              ta.dispatchEvent(new Event('input', { bubbles: true }));
              ta.dispatchEvent(new Event('change', { bubbles: true }));
            });
          try {
            if (typeof window.sethCaptchaResponse === 'function') {
              window.sethCaptchaResponse(data);
            }
          } catch {}
        } else if (type === 'geetest') {
          // GeeTest v4 returns an object; hand it to Avito's callback if any.
          try {
            if (typeof window.setGeetestCaptchaResponse === 'function') {
              window.setGeetestCaptchaResponse(data);
            } else if (typeof window.sethCaptchaResponse === 'function') {
              window.sethCaptchaResponse(data);
            }
          } catch {}
        }
        try {
          if (typeof window.verifyCaptcha === 'function') window.verifyCaptcha();
        } catch {}
      },
      { type: result.type, data: result.data },
    )
    .catch((e) => log.warn(tag, `Token injection issue: ${e.message}`));
}

/**
 * Attempt to solve the Avito firewall captcha on `page`.
 * @returns {Promise<boolean>} true if the page is unblocked afterwards.
 */
export async function solveAvitoFirewall(page, tag) {
  if (!isCaptchaConfigured()) {
    log.warn(tag, 'CAPTCHA detected but TWOCAPTCHA_API_KEY is not set — skipping solve.');
    return false;
  }

  log.info(tag, 'Firewall/CAPTCHA detected — attempting 2Captcha solve...');

  // Capture the firewall config response that "Продолжить" triggers.
  const configPromise = page
    .waitForResponse((r) => /firewallCaptcha\/get/i.test(r.url()), { timeout: 20_000 })
    .then(async (r) => {
      try {
        return JSON.parse((await r.body()).toString('utf8'));
      } catch {
        return null;
      }
    })
    .catch(() => null);

  // Click "Продолжить" to make the firewall render / fetch the captcha.
  try {
    const btn = page
      .locator('button:has-text("Продолжить"), a:has-text("Продолжить")')
      .first();
    if (await btn.count()) {
      await btn.click({ timeout: 5000 }).catch(() => {});
    }
  } catch {
    /* widget may already be present */
  }

  const fwConfig = await configPromise;
  if (fwConfig) {
    // Persist raw config for inspection / tuning (firewall shape varies).
    await writeFile(
      'captcha_config_debug.json',
      JSON.stringify(fwConfig, null, 2),
      'utf8',
    ).catch(() => {});
    log.info(tag, `Firewall config captured: ${JSON.stringify(fwConfig).slice(0, 200)}`);
  } else {
    log.warn(
      tag,
      'No firewall captcha config captured (headless block?). Falling back to DOM detection.',
    );
  }

  // Give the widget a moment to render, then detect type + params.
  await sleep(2500);
  const detected = await detectCaptcha(page, fwConfig);
  log.info(tag, `Detected captcha type: ${detected.type}`);

  const pageurl = page.url();
  const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => undefined);

  let result;
  try {
    result = await solveWith2Captcha(detected, pageurl, userAgent, tag);
  } catch (err) {
    log.error(tag, `2Captcha solve failed: ${err.message}`);
    return false;
  }

  if (!result || !result.data) {
    log.error(tag, '2Captcha returned an empty result.');
    return false;
  }
  log.ok(tag, `2Captcha solved (${result.type}). Injecting token...`);

  await injectToken(page, result, tag);

  // Wait for the firewall to clear.
  for (let i = 0; i < 6; i += 1) {
    await sleep(2500);
    if (!(await isFirewallPage(page))) {
      log.ok(tag, 'CAPTCHA solved — firewall cleared.');
      return true;
    }
    if (i === 2) {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    }
  }

  log.warn(tag, 'CAPTCHA submitted but firewall page is still showing.');
  return false;
}

export default { isCaptchaConfigured, isFirewallPage, solveAvitoFirewall };
