// itch.io, only -100% games, skips "web_flag", fast JSON crawl with parallel expiry enrichment
const fs = require('fs');
const cheerio = require('cheerio');

// Ensure fetch exists for Node 18+ or fall back gracefully
const fetchFn = typeof fetch !== 'undefined' ? fetch : (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// Realistic desktop user-agent rotation
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
];

let _uaIndex = Math.floor(Math.random() * USER_AGENTS.length);
function nextUserAgent() {
  const ua = USER_AGENTS[_uaIndex % USER_AGENTS.length];
  _uaIndex++;
  return ua;
}

const BASE_URL = 'https://itch.io/games/newest/on-sale';
const MAX_PAGES = 300;
const OUT_FILE = 'result.json';
const EXPIRY_CACHE_FILE = 'expiry_cache.json';

const BATCH_SIZE = 3;             // Concurrent page fetches per round
const BATCH_DELAY_MS = 450;       // Pause between page batches
const BATCH_DELAY_JITTER = 150;   // ±jitter on batch delay
const ENRICH_CONCURRENCY = 3;     // Worker pool size for expiry fetches
const ENRICH_DELAY_MS = 400;      // Delay between expiry fetches per worker
const FETCH_TIMEOUT_MS = 25_000;  // Per-request abort timeout
const MAX_ENRICH_RETRIES = 3;     // Max retry attempts per expiry URL

const baseUrl = process.argv[2] || BASE_URL;
const maxPages = parseInt(process.argv[3] || MAX_PAGES, 10);
const outFile = process.argv[4] || OUT_FILE;

let sessionCookie = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function updateCookie(res) {
  let raw = '';
  if (typeof res.headers.getSetCookie === 'function') {
    raw = res.headers.getSetCookie().join('; ');
  } else if (typeof res.headers.get === 'function') {
    raw = res.headers.get('set-cookie') || '';
  }
  const match = raw.match(/itchio_token=[^;]+/);
  if (match) {
    sessionCookie = match[0];
  }
}

function getPageUrl(targetUrl, page) {
  const u = new URL(targetUrl);
  if (page > 1) {
    u.searchParams.set('page', page);
  }
  u.searchParams.set('format', 'json');
  return u.href;
}

/**
 * Fetch itch pagination fragment via native AJAX JSON endpoint.
 */
async function fetchPage(page, targetUrl = baseUrl) {
  const url = getPageUrl(targetUrl, page);
  const MAX_429_RETRIES = 3;
  const BACKOFF_STEPS = [10_000, 20_000, 40_000];

  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    const headers = {
      'User-Agent': nextUserAgent(),
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
    };
    if (sessionCookie) headers['Cookie'] = sessionCookie;

    const res = await fetchFn(url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    updateCookie(res);

    if (res.status === 429) {
      if (attempt >= MAX_429_RETRIES) throw new Error(`HTTP 429 on page ${page} (retries exhausted)`);
      const wait = BACKOFF_STEPS[attempt] + Math.random() * 3000;
      console.warn(`[ITCH] 429 on page ${page} — backing off ${Math.round(wait / 1000)}s (retry ${attempt + 1}/${MAX_429_RETRIES})`);
      await sleep(wait);
      continue;
    }

    if (!res.ok) throw new Error(`HTTP ${res.status} on page ${page}`);
    return res.json();
  }
}

/**
 * Fetch HTML page for sale expiration enrichment.
 */
async function fetchHtml(url) {
  const MAX_429_RETRIES = 3;
  const BACKOFF_STEPS = [10_000, 20_000, 40_000];

  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    const headers = {
      'User-Agent': nextUserAgent(),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    };
    if (sessionCookie) headers['Cookie'] = sessionCookie;

    const res = await fetchFn(url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    updateCookie(res);

    if (res.status === 429) {
      if (attempt >= MAX_429_RETRIES) throw new Error(`HTTP 429 on ${url} (retries exhausted)`);
      const wait = BACKOFF_STEPS[attempt] + Math.random() * 3000;
      console.warn(`[ITCH] 429 on ${url} — backing off ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }

    if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
    return res.text();
  }
}

function extractFreeGames(html) {
  const $ = cheerio.load(html);
  const results = [];

  $('.game_cell').each((_, el) => {
    const cell = $(el);
    const saleTag = cell.find('.sale_tag').first().text().trim();
    if (saleTag !== '-100%') return;
    if (cell.find('.web_flag').length > 0) return;

    const saleAnchor = cell.find('a.price_tag.sale').first();
    const saleUrlRaw = saleAnchor.attr('href') || '';
    const saleUrl = saleUrlRaw ? new URL(saleUrlRaw, 'https://itch.io').href : null;

    const titleEl = cell.find('.game_title a.title').first();
    const titleHrefRaw = titleEl.attr('href') || '';
    const titleHref = titleHrefRaw ? new URL(titleHrefRaw, 'https://itch.io').href : '';

    const authorEl = cell.find('.game_author a').first();
    const authorUrlRaw = authorEl.attr('href') || '';
    const authorUrl = authorUrlRaw ? new URL(authorUrlRaw, 'https://itch.io').href : null;

    const thumbEl = cell.find('.game_thumb');
    let image = thumbEl.find('img').attr('data-lazy_src')
      || thumbEl.find('img').attr('src')
      || thumbEl.attr('data-background_image')
      || null;

    const genre = cell.find('.game_genre').first().text().trim() || null;
    const blurb = cell.find('.game_text').first().text().trim() || null;

    results.push({
      id: cell.attr('data-game_id') || null,
      title: titleEl.text().trim(),
      url: titleHref,
      author: authorEl.text().trim(),
      author_url: authorUrl,
      image,
      genre,
      blurb,
      sale_url: saleUrl,
      expires: null,
      expires_raw: null,
    });
  });

  return results;
}

function parseExpiry(html) {
  const $ = cheerio.load(html);
  const dateSpan = $('.promotion_dates .date_format').first();
  if (!dateSpan.length) return { raw: null, iso: null };

  const raw = dateSpan.text().trim() || null;
  let iso = null;
  if (raw && !isNaN(Date.parse(raw))) {
    iso = new Date(raw).toISOString();
  } else {
    const title = (dateSpan.attr('title') || '').replace(/\s*UTC\s*$/i, '');
    if (title && !isNaN(Date.parse(title + ' UTC'))) {
      iso = new Date(title + ' UTC').toISOString();
    } else if (title && !isNaN(Date.parse(title))) {
      iso = new Date(title).toISOString();
    }
  }

  return { raw, iso };
}

function loadCache(cacheFile = EXPIRY_CACHE_FILE) {
  try {
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(cache, cacheFile = EXPIRY_CACHE_FILE) {
  try {
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.error(`[ITCH] Failed to save expiry cache: ${err.message}`);
  }
}

/**
 * Worker pool to enrich expiry dates in parallel.
 */
async function enrichExpiry(games, cache) {
  const failedEnrichAttempts = new Map();
  const uniqueUrls = [...new Set(games.map((g) => g.sale_url).filter(Boolean))];
  const toFetch = uniqueUrls.filter((url) => !cache[url]);

  console.error(`[ITCH] ${uniqueUrls.length} unique sale page(s), ${toFetch.length} new (rest cached).`);
  if (!toFetch.length) {
    attachExpiry(games, cache);
    return;
  }

  console.error(`[ITCH] Enriching expiry for ${toFetch.length} new sale(s) (concurrency: ${ENRICH_CONCURRENCY})…`);

  const queue = [...toFetch];
  async function worker() {
    while (queue.length > 0) {
      const url = queue.shift();
      if (cache[url]) continue;

      try {
        const html = await fetchHtml(url);
        cache[url] = parseExpiry(html);
        failedEnrichAttempts.delete(url);
      } catch (err) {
        console.warn(`[ITCH] Expiry fetch failed for ${url}: ${err.message}`);
        const attempts = (failedEnrichAttempts.get(url) || 0) + 1;
        failedEnrichAttempts.set(url, attempts);

        if (attempts < MAX_ENRICH_RETRIES) {
          queue.push(url);
        } else {
          cache[url] = { raw: null, iso: null };
        }
      }

      await sleep(ENRICH_DELAY_MS);
    }
  }

  const poolSize = Math.min(ENRICH_CONCURRENCY, toFetch.length);
  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  attachExpiry(games, cache);
}

function attachExpiry(games, cache) {
  for (const g of games) {
    if (g.sale_url && cache[g.sale_url]) {
      g.expires = cache[g.sale_url].iso || null;
      g.expires_raw = cache[g.sale_url].raw || null;
    }
  }
}

function dedupe(games) {
  const seen = new Set();
  return games.filter((g) => {
    const key = g.id || g.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Scrape all pages in concurrent batches, then batch-enrich new games.
 */
async function scrapeAll({
  targetUrl = baseUrl,
  maxP = maxPages,
  cacheFile = EXPIRY_CACHE_FILE,
} = {}) {
  const t0 = Date.now();
  const all = [];
  const seen = new Set();
  let page = 1;
  let pagesScraped = 0;
  let stoppedReason = null;

  while (page <= maxP) {
    const batchPages = [];
    for (let i = 0; i < BATCH_SIZE && (page + i) <= maxP; i++) {
      batchPages.push(page + i);
    }

    let batchResults;
    try {
      batchResults = await Promise.allSettled(batchPages.map((p) => fetchPage(p, targetUrl)));
    } catch (err) {
      stoppedReason = err.message;
      console.error(`[ITCH] Stopping: ${err.message}`);
      break;
    }

    let reachedEnd = false;

    for (let i = 0; i < batchResults.length; i++) {
      const p = batchPages[i];
      const result = batchResults[i];

      if (result.status === 'rejected') {
        console.warn(`[ITCH] Page ${p} failed: ${result.reason?.message || result.reason}`);
        continue;
      }

      const data = result.value;
      pagesScraped++;

      if (!data || !data.content || data.num_items === 0) {
        reachedEnd = true;
        stoppedReason = 'end_of_results';
        break;
      }

      const found = extractFreeGames(data.content).filter((g) => {
        const key = g.id || g.url;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      if (found.length) {
        console.error(`[ITCH] Page ${p}: ${found.length} free game(s) found.`);
        all.push(...found);
      } else {
        console.error(`[ITCH] Page ${p}: 0 free games (out of ${data.num_items || 0} items).`);
      }

      if (data.num_items < 36) {
        reachedEnd = true;
        stoppedReason = 'last_page_reached';
        break;
      }
    }

    if (reachedEnd) break;

    if (page + batchPages.length > maxP) {
      stoppedReason = 'max_pages_reached';
      break;
    }

    page += batchPages.length;
    await sleep(BATCH_DELAY_MS + Math.random() * BATCH_DELAY_JITTER);
  }

  const games = dedupe(all);

  const cache = loadCache(cacheFile);
  await enrichExpiry(games, cache);
  saveCache(cache, cacheFile);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.error(`[ITCH] Crawl complete: ${games.length} free game(s) across ${pagesScraped} page(s) in ${elapsed}s`);

  return {
    source: targetUrl,
    scraped_at: new Date().toISOString(),
    pages_scraped: pagesScraped,
    total_found: games.length,
    stopped_reason: stoppedReason,
    games,
  };
}

if (require.main === module) {
  (async () => {
    try {
      const output = await scrapeAll({ targetUrl: baseUrl, maxP: maxPages, cacheFile: EXPIRY_CACHE_FILE });
      fs.writeFileSync(outFile, JSON.stringify(output, null, 2), 'utf8');
      console.error(`Wrote ${output.games.length} free games to ${outFile}`);
    } catch (err) {
      console.error(`[ITCH] Fatal scrape error: ${err.message}`);
      process.exit(1);
    }
  })();
}

module.exports = {
  scrapeAll,
  extractFreeGames,
  parseExpiry,
  fetchPage,
  fetchHtml,
  meta: { id: 'itch', name: 'itch.io — Free Games', url: baseUrl, color: 0xfa5c5c },
};
