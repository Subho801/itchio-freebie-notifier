// itch.io, only -100% games, skips "web_flag", check for expiring date after the pull
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const fs = require('fs');

const BASE_URL    = 'https://itch.io/games/newest/on-sale';
const MAX_PAGES   = 25;			// Currently 21, so 25 as safe guard?!
const OUT_FILE    = 'result.json';
const EXPIRY_CACHE_FILE = 'expiry_cache.json';
const DELAY_MS    = 3000;		// HTTP 429 Rate Limit
const MAX_RETRIES = 3;

const baseUrl  = process.argv[2] || BASE_URL;
const maxPages = parseInt(process.argv[3] || MAX_PAGES, 10);
const outFile  = process.argv[4] || OUT_FILE;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(page, overrideUrl) {
  const url = overrideUrl || (page === 1 ? baseUrl : `${baseUrl}?page=${page}`);
  const label = overrideUrl ? url : `page ${page}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; itch-scraper/1.0)' }
    });

    if (res.status === 429) {
      const wait = DELAY_MS * attempt * 2;
      console.error(`${label}: 429, retrying in ${wait}ms (attempt ${attempt}/${MAX_RETRIES})`);
      await sleep(wait);
      continue;
    }

    if (!res.ok) throw new Error(`HTTP ${res.status} on ${label}`);
    return res.text();
  }

  throw new Error(`HTTP 429 on ${label} (gave up after ${MAX_RETRIES} retries)`);
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
    results.push({
  id: cell.attr('data-game_id') || null,
  title: titleEl.text().trim(),
  url: titleEl.attr('href') || '',
  image: (() => {
    const img = cell.find('.game_thumb img').first();
    return (
      img.attr('data-lazy_src') ||
      img.attr('data-src') ||
      img.attr('src') ||
      null
    );
  })(),
  author: cell.find('.game_author a').first().text().trim(),
      genre: cell.find('.game_genre').first().text().trim() || null,
      blurb: cell.find('.game_text').first().text().trim() || null,
      sale_url: saleUrl,
      expires: null,
      expires_raw: null
    });
  });

  return results;
}

function hasNextPage(html) {
  return cheerio.load(html)('.next_page a').length > 0;
}

function parseExpiry(html) {
  const $ = cheerio.load(html);
  const dateSpan = $('.promotion_dates .date_format').first();
  if (!dateSpan.length) return { raw: null, iso: null };

  const title = (dateSpan.attr('title') || '').replace(/\s*UTC\s*$/i, '');
  const iso = Date.parse(title) ? new Date(title).toISOString() : null;
  return { raw: dateSpan.text().trim(), iso };
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(EXPIRY_CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  fs.writeFileSync(EXPIRY_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

async function enrichExpiry(games) {
  const cache = loadCache();
  const uniqueUrls = [...new Set(games.map((g) => g.sale_url).filter(Boolean))];
  const toFetch = uniqueUrls.filter((url) => !cache[url]);

  console.error(`${uniqueUrls.length} unique sale page(s), ${toFetch.length} new (rest cached).`);

  for (let i = 0; i < toFetch.length; i++) {
    const url = toFetch[i];
    console.error(`  [${i + 1}/${toFetch.length}] ${url}`);
    try {
      const html = await fetchPage(0, url);
      cache[url] = parseExpiry(html);
    } catch (err) {
      console.error(`  failed (will retry next run): ${err.message}`);
    }
    await sleep(DELAY_MS);
  }

  saveCache(cache);

  for (const g of games) {
    if (g.sale_url && cache[g.sale_url]) {
      g.expires_raw = cache[g.sale_url].raw;
      g.expires = cache[g.sale_url].iso;
    }
  }
}

function dedupe(games) {
  const seen = new Set();
  return games.filter((g) => {
    if (seen.has(g.url)) return false;
    seen.add(g.url);
    return true;
  });
}

(async () => {
  const all = [];
  let page = 1;
  let pagesScraped = 0;
  let stoppedReason = null;

  while (page <= maxPages) {
    let html;
    try {
      html = await fetchPage(page);
    } catch (err) {
      stoppedReason = err.message;
      console.error(`Stopping: ${err.message}`);
      break;
    }

    const found = extractFreeGames(html);
    all.push(...found);
    pagesScraped++;
    console.error(`Page ${page}: ${found.length} free game(s) found.`);

    if (!hasNextPage(html)) break;

    if (page === maxPages) {
      stoppedReason = 'max_pages_reached';
      break;
    }

    page++;
    await sleep(DELAY_MS);
  }

  const games = dedupe(all);
  await enrichExpiry(games);

  const output = {
    source: baseUrl,
    scraped_at: new Date().toISOString(),
    pages_scraped: pagesScraped,
    total_found: games.length,
    stopped_reason: stoppedReason,
    games
  };

  fs.writeFileSync(outFile, JSON.stringify(output, null, 2), 'utf8');
  console.error(`Wrote ${games.length} free games to ${outFile}`);
})();
