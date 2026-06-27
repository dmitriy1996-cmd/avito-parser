/**
 * Tabular (CSV) export for scraped results.
 *
 * Writes a UTF-8 file with a BOM and ';' as the delimiter so it opens
 * cleanly (with correct Cyrillic) in Excel on a Russian locale, while
 * still being a valid RFC-4180-style CSV for other tools.
 */

const DELIMITER = ';';
const BOM = '\uFEFF';

// Column order for the spreadsheet. `key` maps to the result object field;
// `header` is the human-readable column title.
const COLUMNS = [
  { key: 'success', header: 'Статус' },
  { key: 'title', header: 'Заголовок' },
  { key: 'price', header: 'Цена' },
  { key: 'location', header: 'Местоположение' },
  { key: 'sellerName', header: 'Продавец' },
  { key: 'sellerType', header: 'Тип продавца' },
  { key: 'phone', header: 'Телефон' },
  { key: 'sellerUrl', header: 'Профиль продавца' },
  { key: 'description', header: 'Описание' },
  { key: 'images', header: 'Изображения' },
  { key: 'url', header: 'Ссылка' },
  { key: 'status', header: 'HTTP-код' },
  { key: 'scrapedAt', header: 'Время парсинга' },
  { key: 'error', header: 'Ошибка' },
];

/**
 * Normalize a single value into a flat string suitable for a CSV cell.
 */
function toCell(key, value) {
  if (value === null || value === undefined) return '';

  if (key === 'success') return value ? 'OK' : 'FAILED';

  // Image arrays (and any other array) are joined onto one line.
  if (Array.isArray(value)) return value.join(' | ');

  return String(value);
}

/**
 * Escape a cell per CSV rules: wrap in quotes when it contains the
 * delimiter, a quote, or a newline; double any embedded quotes.
 */
function escapeCell(text) {
  const needsQuoting =
    text.includes(DELIMITER) ||
    text.includes('"') ||
    text.includes('\n') ||
    text.includes('\r');

  if (!needsQuoting) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Convert an array of result objects into a CSV string.
 */
export function resultsToCsv(results) {
  const lines = [];

  lines.push(COLUMNS.map((c) => escapeCell(c.header)).join(DELIMITER));

  for (const row of results) {
    const cells = COLUMNS.map((c) => escapeCell(toCell(c.key, row[c.key])));
    lines.push(cells.join(DELIMITER));
  }

  // Excel-friendly: CRLF line endings + leading BOM.
  return BOM + lines.join('\r\n');
}

export default { resultsToCsv };
