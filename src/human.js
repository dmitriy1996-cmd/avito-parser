import { randInt, randFloat, sleep, humanDelay } from './utils.js';
import { config } from './config.js';

/**
 * Human-like behavior helpers. These make the automated session look less
 * robotic: easing mouse movements along curved paths, variable scrolling,
 * and randomized think-time pauses.
 */

/** Randomized pause within the configured human delay window. */
export const think = () => humanDelay(config.delay.min, config.delay.max);

/** A shorter micro-pause (e.g. between scroll steps). */
export const microPause = () => sleep(randInt(120, 600));

/**
 * Move the mouse from its current spot to (targetX, targetY) along a
 * jittered, multi-step path with easing — not a straight teleport.
 */
export async function humanMouseMove(page, targetX, targetY, steps) {
  const n = steps || randInt(15, 30);
  // Start from a random-ish origin (Playwright tracks last position internally,
  // but we simulate a believable origin).
  const startX = randInt(0, page.viewportSize()?.width || 1280);
  const startY = randInt(0, page.viewportSize()?.height || 800);

  for (let i = 1; i <= n; i += 1) {
    const t = i / n;
    // easeInOutQuad for natural acceleration/deceleration
    const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    const jitterX = randFloat(-3, 3);
    const jitterY = randFloat(-3, 3);
    const x = startX + (targetX - startX) * ease + jitterX;
    const y = startY + (targetY - startY) * ease + jitterY;
    await page.mouse.move(x, y);
    await sleep(randInt(8, 25));
  }
}

/**
 * Wander the cursor around the viewport a few times to emulate a user
 * reading / orienting on the page.
 */
export async function wanderCursor(page, moves) {
  const vp = page.viewportSize() || { width: 1280, height: 800 };
  const count = moves || randInt(2, 4);
  for (let i = 0; i < count; i += 1) {
    await humanMouseMove(
      page,
      randInt(50, vp.width - 50),
      randInt(50, vp.height - 50),
    );
    await microPause();
  }
}

/**
 * Variable scrolling: scroll down in irregular increments with pauses,
 * occasionally scrolling back up a little, mimicking reading behavior.
 */
export async function humanScroll(page, options = {}) {
  const { maxSteps = randInt(6, 12) } = options;

  for (let i = 0; i < maxSteps; i += 1) {
    const delta = randInt(200, 700);
    await page.mouse.wheel(0, delta);
    await sleep(randInt(300, 1200));

    // Occasionally scroll back up a touch.
    if (Math.random() < 0.2) {
      await page.mouse.wheel(0, -randInt(80, 250));
      await sleep(randInt(200, 600));
    }
  }

  // Drift back toward the top sometimes.
  if (Math.random() < 0.4) {
    await page.mouse.wheel(0, -randInt(500, 1500));
    await microPause();
  }
}

/**
 * Run a believable interaction sequence on a freshly loaded page:
 * think -> wander cursor -> scroll -> think. Safe to call best-effort.
 */
export async function simulateHumanSession(page) {
  try {
    await think();
    await wanderCursor(page);
    await humanScroll(page);
    await microPause();
    await wanderCursor(page, 1);
  } catch {
    // Behavior simulation is best-effort; never let it break the scrape.
  }
}

export default {
  think,
  microPause,
  humanMouseMove,
  wanderCursor,
  humanScroll,
  simulateHumanSession,
};
