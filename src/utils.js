/**
 * Small shared utilities: random helpers, sleeping, and a lightweight logger.
 */

/** Sleep for `ms` milliseconds. */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Inclusive random integer between min and max. */
export const randInt = (min, max) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

/** Random float between min and max. */
export const randFloat = (min, max) => Math.random() * (max - min) + min;

/** Pick a random element from an array. */
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** Sleep a randomized, human-like amount within [min, max]. */
export const humanDelay = (min, max) => sleep(randInt(min, max));

/**
 * Timestamped, leveled console logger. Keeps output readable when many
 * contexts run concurrently by tagging each line with a worker id.
 */
const levelColors = {
  info: '\x1b[36m', // cyan
  ok: '\x1b[32m', // green
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
  reset: '\x1b[0m',
};

function emit(level, tag, ...args) {
  const ts = new Date().toISOString().split('T')[1].replace('Z', '');
  const color = levelColors[level] || '';
  const prefix = `${color}[${ts}] [${level.toUpperCase()}]${tag ? ` [${tag}]` : ''}${levelColors.reset}`;
  // eslint-disable-next-line no-console
  console.log(prefix, ...args);
}

export const log = {
  info: (tag, ...a) => emit('info', tag, ...a),
  ok: (tag, ...a) => emit('ok', tag, ...a),
  warn: (tag, ...a) => emit('warn', tag, ...a),
  error: (tag, ...a) => emit('error', tag, ...a),
};

export default { sleep, randInt, randFloat, pick, humanDelay, log };
