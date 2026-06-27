# Avito.ru Resilient Scraper

A production-ready, concurrent web scraper for [Avito.ru](https://www.avito.ru) built with
**Playwright + stealth**, rotating **residential proxies**, and **human-like behavior**
to bypass anti-bot / fingerprinting protections.

## Features

- **Stealth**: `playwright-extra` + `puppeteer-extra-plugin-stealth` plus extra init-script hardening (`navigator.webdriver`, languages, plugins, WebGL, permissions).
- **Concurrency**: `p-limit` runs N isolated browser **contexts** in parallel (configurable, default 5) — lightweight on CPU/RAM vs. spawning whole browsers.
- **Unique identity per context**: distinct User-Agent, viewport, timezone, and a **sticky rotating-proxy session** so each context gets its own exit IP.
- **SOCKS5 + HTTP proxies**: HTTP/HTTPS proxies are used natively; **authenticated SOCKS5** proxies are supported via an auto-spun local HTTP→SOCKS bridge (`proxy-chain`), since Chromium can't authenticate SOCKS itself.
- **Human behavior**: eased/curved cursor movement, variable scrolling with read-backs, randomized 2000–6000 ms think-time.
- **Resilience**: up to 3 retries with jittered backoff for timeouts / 403 / 429 / proxy failures; each retry uses a fresh proxy session + identity.
- **CAPTCHA solving**: detects Avito's firewall hCaptcha ("Доступ ограничен: проблема с IP") and solves it automatically via **2Captcha** when `TWOCAPTCHA_API_KEY` is set; otherwise logs gracefully and moves on without crashing.
- **Structured output**: writes `results.json` with per-item data and a run summary,
  plus `results.csv` — a spreadsheet table (UTF-8 + BOM, `;` delimiter) that opens
  cleanly in Excel / Google Sheets.

## Extracted fields

`title`, `price`, `description`, `sellerName`, `sellerType` (company/private),
`sellerUrl` (profile link), `location`, `images[]` (high-resolution URLs), and
`phone` (best-effort).

> **Phone numbers:** Avito hides the phone behind "Показать телефон", which
> opens a **login wall** for guests. So `phone` is `null` unless the scraper
> runs with an authenticated Avito session (account cookies). See below.

## Project structure

```
avito-scraper/
├── package.json
├── .env.example          # copy to .env and fill in
├── urls.txt              # one Avito listing URL per line
└── src/
    ├── config.js         # proxy, threads, captcha & runtime settings + UA/viewport pools
    ├── proxy.js          # rotating proxy manager (sticky sessions + SOCKS bridge)
    ├── browser.js        # Playwright + stealth launch / context creation
    ├── human.js          # human-like cursor, scroll & delay helpers
    ├── captcha.js        # 2Captcha hCaptcha solver for Avito's firewall
    ├── scraper.js        # DOM parsing + firewall/CAPTCHA detection & solving
    ├── utils.js          # logging, random & sleep helpers
    └── index.js          # entry point: concurrency manager + retries + output
```

## ⚠️ Important: run in HEADFUL mode for Avito

Avito's firewall **blocks headless Chromium** (serves a "Доступ ограничен:
проблема с IP" hCaptcha challenge), but lets a **headful** (visible-window)
browser through when combined with a Russian residential proxy + stealth.

Verified working setup:

- `HEADLESS=false` (required)
- A **Russian** residential proxy (e.g. NodeMaven `-country-ru`)
- Retries enabled — the occasional flagged IP is retried on a fresh session

With this, real listings are scraped at HTTP 200 with all fields populated. The
2Captcha hook remains as a best-effort fallback, but Avito's challenge is
hCaptcha Enterprise (needs `rqdata`); in practice a fresh-IP retry in headful
mode is what reliably clears it. You can leave `TWOCAPTCHA_API_KEY` empty to
rely purely on headful + RU proxy + retries (faster).

> Headless servers: run under a virtual display (e.g. `xvfb-run`) since headful
> requires a display.

## Setup

```bash
cd avito-scraper
npm install            # also runs "playwright install chromium" via postinstall
cp .env.example .env   # then edit .env with your proxy credentials
```

> On Windows PowerShell use `Copy-Item .env.example .env`.

## Configure proxies

This scraper is built around [NodeMaven](https://nodemaven.com) residential
proxies. Avito requires a **Russian** exit IP — NodeMaven's `-country-ru`
option provides one with sticky sessions, which is exactly what's needed.

### Proxy file (recommended for multi-threading)

Put your proxies in a **separate `proxies.txt`** file — one proxy per line.
This is the easiest way to feed many proxies for parallel workers: each worker
picks one round-robin and a unique session id is injected automatically, so
every browser context gets its own sticky Russian IP.

```bash
cp proxies.example.txt proxies.txt   # then edit proxies.txt
```

```text
# proxies.txt — one per line, '#' comments allowed
socks5://USER-country-ru-sid-AAAA-filter-high:PASS@gate.nodemaven.com:1080
socks5://USER-country-ru-sid-BBBB-filter-high:PASS@gate.nodemaven.com:1080
socks5://USER-country-ru-sid-CCCC-filter-high:PASS@gate.nodemaven.com:1080
```

NodeMaven exposes SOCKS5 on port `1080` and encodes the session id inside the
username (`-sid-<id>-`). Set `SESSION_TOKEN=-sid-` in `.env` so the scraper
rotates the session per context. The number of parallel workers is controlled
by `CONCURRENCY` in `.env`.

The scraper detects the SOCKS scheme and automatically runs a local HTTP→SOCKS
bridge per context (Chromium can't authenticate SOCKS directly). `proxies.txt`
is git-ignored so your credentials never get committed.

The file path is configurable via `PROXY_FILE`. Alternatively you can set
`PROXY_LIST` inline in `.env` (comma/newline-separated) instead of the file.

> Don't have an account yet? Grab residential proxies at
> [nodemaven.com](https://nodemaven.com).

### Solving Avito's CAPTCHA (2Captcha)

Avito's firewall challenges browsers with an hCaptcha ("Доступ ограничен:
проблема с IP"). Set your 2Captcha key to solve it automatically:

```env
TWOCAPTCHA_API_KEY=your_2captcha_key
```

The scraper then clicks "Продолжить", solves the hCaptcha via 2Captcha, injects
the token (Avito's `sethCaptchaResponse`), and continues. Without a key it logs
the block and moves on.

## Usage

Add URLs to `urls.txt` (one per line), then:

```bash
npm start
```

Or pass URLs directly as arguments:

```bash
node src/index.js "https://www.avito.ru/.../item_123" "https://www.avito.ru/.../item_456"
```

### Search by keyword (no URLs needed)

You can scrape by a **keyword query** instead of URLs. Avito requires a
**category** in the path for search to render, so pass a category slug:

```bash
node src/index.js --search "игровой ноутбук" --category noutbuki --region all --max 30 --pages 3
```

| Flag | Env | Default | Meaning |
| --- | --- | --- | --- |
| `--search` / `-q` | `SEARCH_QUERY` | — | keyword query |
| `--category` / `-c` | `SEARCH_CATEGORY` | `noutbuki` | category slug(s), comma-separated |
| `--region` / `-r` | `SEARCH_REGION` | `all` | region slug (`all`, `moskva`, `sankt-peterburg`, …) |
| `--max` | `MAX_ITEMS` | 50 | max listings to collect |
| `--pages` | `MAX_PAGES` | 5 | max result pages per category |

The scraper builds `https://www.avito.ru/<region>/<category>?q=<query>&p=<n>`,
collects listing URLs across pages (and categories), then scrapes each one.
Pass several with `--category "noutbuki,telefony"` to search across them.

Common category slugs (also in `src/search.js` → `COMMON_CATEGORIES`):

```
avtomobili            telefony              noutbuki
planshety_i_elektronnye_knigi               tovary_dlya_kompyutera
audio_i_video         kvartiry              doma_dachi_kottedzhi
bytovaya_tehnika      mebel_i_interer       odezhda_obuv_aksessuary
tovary_dlya_detey_i_igrushki                velosipedy
instrumenty           predlozheniya_uslug
```

Results are written to `results.json` (and to `results.csv` — the same data in
tabular form for Excel/Google Sheets):

```json
{
  "meta": { "total": 2, "succeeded": 2, "failed": 0, "durationMs": 18342 },
  "results": [
    {
      "success": true,
      "url": "https://www.avito.ru/...",
      "title": "iPhone 15 Pro Max 256GB",
      "price": "120 000 ₽",
      "description": "...",
      "sellerName": "Иван",
      "location": "Москва, м. Арбатская",
      "images": ["https://...jpg", "..."],
      "scrapedAt": "2026-06-27T13:00:00.000Z"
    }
  ]
}
```

## Tuning (`.env`)

| Variable        | Default | Description                                   |
| --------------- | ------- | --------------------------------------------- |
| `CONCURRENCY`   | 5       | Parallel browser contexts                     |
| `MAX_RETRIES`   | 3       | Retry attempts per URL                        |
| `HEADLESS`      | true    | Run headless (set `false` to watch/debug)     |
| `NAV_TIMEOUT_MS`| 60000   | Navigation timeout                            |
| `MIN_DELAY_MS`  | 2000    | Min human think-time                          |
| `MAX_DELAY_MS`  | 6000    | Max human think-time                          |
| `OUTPUT_FILE`   | results.json | Output path                              |

## Notes & responsible use

- Avito's markup changes frequently; selectors in `src/scraper.js` use stable
  `data-marker` attributes first with class/semantic fallbacks. Update them if
  extraction returns `null`.
- Quality **residential** proxies are essential — datacenter IPs are blocked
  almost immediately.
- Respect Avito's Terms of Service, `robots.txt`, and applicable laws. Use a
  low concurrency and generous delays. This code is provided for educational
  and authorized use only.
```
