'use strict';

/**
 * src/adlibrary/scrapePages.js
 *
 * Layer B of the whitelisting/full-footprint project: given a brand whose
 * 3rd-party pages were already discovered by the Ad Library finder
 * (src/adlibrary/findPages.js -> `pages` table), collect each page's ads
 * from GetHook and file them under the REAL brand with that page's
 * `page_id`. A whitelist/secondary page is never turned into its own brand.
 *
 * Independent from the normal scraper (src/browser/launch.js): it reuses
 * the same granular pipeline modules (prepareTranscript, extract, share,
 * details, filters) but runs its own loop and its own storage, exactly the
 * way src/browser/fix.js does.
 *
 * Per discovered page:
 *   search the page name in GetHook -> require a real name match (skip if
 *   none, so we never scrape a stranger's account) -> open it -> apply
 *   filters -> collect ads -> upsert each under (brandId, pageId).
 *
 * Usage:
 *   node src/adlibrary/scrapePages.js "ryze" [--max-ads=25] [--page="Name"] [--inspect]
 */

const { chromium } = require('playwright');
const { PROFILE_DIR, TARGET_URL, LOAD_EVENT_TIMEOUT_MS } = require('../browser/config');
const { log, warn, error } = require('../browser/logger');
const { verifyChromeIsInstalled, ensureProfileDir, warnIfLocked } = require('../browser/profileManager');
const { ensureLoggedIn } = require('../browser/session');
const { askQuestion } = require('../browser/prompt');
const { applyBrandFilters } = require('../scraper/filters');
const { prepareTranscript, BackendTranscriptionFailedError } = require('../scraper/prepareTranscript');
const { extractTranscript } = require('../scraper/extract');
const { captureShareUrl } = require('../scraper/share');
const { openAdDetails, closeAdDetails } = require('../scraper/details');
const { extractOverviewFields } = require('../scraper/overview');
const { upsertAd, getExistingMediaIds } = require('../supabase/adsRepository');
const { findBrands, getDiscoveredPages, getBrandLanderDomains } = require('./pagesRepository');

const T = 15000;
const MAX_SCROLL_ROUNDS = 500;
const SCROLL_GROWTH_TIMEOUT_MS = 10000;
const MEDIA_ID_PATTERN = /ads_media\/(\d+)\//;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
/** GetHook indexes the creator page, not Meta's "Creator with Brand" label. */
const searchTermFor = (pageName) => pageName.replace(/\s+with\s+.*$/i, '').trim();

function parseArgs(argv) {
  const flags = new Set();
  const positional = [];
  const opts = {};
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [k, v] = arg.slice(2).split('=');
      if (v !== undefined) opts[k] = v;
      else flags.add(arg);
    } else positional.push(arg);
  }
  return { flags, positional, opts };
}

async function extractMediaId(card) {
  const src = await card.getByTestId('media').locator('img, video').first().getAttribute('src').catch(() => null);
  return src ? (src.match(MEDIA_ID_PATTERN)?.[1] ?? null) : null;
}

async function extractCardSummary(card) {
  const title = await card.getByTestId('title').first().textContent().then((t) => t?.trim() || null).catch(() => null);
  const duration = await card.getByTestId('media').first().textContent().then((t) => t?.trim() || null).catch(() => null);
  return { title, duration };
}

/**
 * Search a page name in GetHook and open it ONLY if a returned result's
 * name genuinely matches (exact once normalized). Returns false — a skip,
 * not an error — when there are no results or no real match, so we never
 * scrape the wrong account. GetHook returning a dozen loosely-related pages
 * (e.g. many "Jordan"s for "Jordan Staten") is exactly the case to skip.
 */
async function searchAndOpenPage(page, pageName) {
  const term = searchTermFor(pageName);
  const tab = page.getByRole('tab', { name: 'Brands', exact: true });
  const searchBox = page.getByRole('combobox', { name: 'Search brands', exact: true });

  // Return to the Explore screen first: after scraping a page we're on its
  // /brands/{id} detail view, which has no "Brands" tab to click.
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForLoadState('load', { timeout: LOAD_EVENT_TIMEOUT_MS }).catch(() => {});

  await tab.waitFor({ state: 'visible', timeout: T });
  for (let a = 0; a < 3; a++) {
    await tab.click({ timeout: T }).catch(() => {});
    if (await searchBox.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) break;
  }

  await searchBox.click({ timeout: T }).catch(() => {});
  await searchBox.fill('', { timeout: T }).catch(() => {});
  await sleep(1000);
  await searchBox.fill(term, { timeout: T }).catch(() => {});

  const firstOpt = page.getByRole('option').first();
  const empty = page.getByText(/No brands found/i);
  const outcome = await Promise.race([
    firstOpt.waitFor({ state: 'visible', timeout: 9000 }).then(() => 'results'),
    empty.waitFor({ state: 'visible', timeout: 9000 }).then(() => 'empty'),
  ]).catch(() => 'timeout');
  await sleep(1500); // let the debounced list settle before reading

  if (outcome !== 'results') return { opened: false, reason: outcome === 'empty' ? 'no results in GetHook' : 'search timed out' };

  const options = page.getByRole('option');
  const count = await options.count();
  let matchIdx = -1;
  for (let i = 0; i < count; i++) {
    const label = (await options.nth(i).innerText().catch(() => '')).split('\n')[0].trim();
    if (norm(label) === norm(term)) { matchIdx = i; break; }
  }
  if (matchIdx === -1) return { opened: false, reason: `no exact match among ${count} result(s)` };

  await options.nth(matchIdx).click({ timeout: T });
  await page.waitForURL(/\/brands\//, { timeout: T }).catch(() => {});
  return { opened: true };
}

/** Copy of the normal scraper's virtualized-list scroll (kept local, like fix.js). */
async function scrollForMore(page) {
  const findAndScroll = () => {
    const card = document.querySelector('[data-testid="ad-card"]');
    if (!card) return { scrolled: false, scrollHeight: 0 };
    let scroller = null, el = card.parentElement;
    while (el && el !== document.body) {
      const s = getComputedStyle(el);
      if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) { scroller = el; break; }
      el = el.parentElement;
    }
    if (!scroller) scroller = document.documentElement;
    const before = scroller.scrollTop;
    scroller.scrollTop += scroller.clientHeight;
    return { scrolled: scroller.scrollTop > before + 1, scrollHeight: scroller.scrollHeight };
  };
  const getScrollHeight = () => {
    const card = document.querySelector('[data-testid="ad-card"]');
    if (!card) return 0;
    let el = card.parentElement;
    while (el && el !== document.body) {
      const s = getComputedStyle(el);
      if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) return el.scrollHeight;
      el = el.parentElement;
    }
    return document.documentElement.scrollHeight;
  };
  const info = await page.evaluate(findAndScroll);
  if (!info.scrolled) {
    const prev = info.scrollHeight;
    const deadline = Date.now() + SCROLL_GROWTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await page.waitForTimeout(500);
      if ((await page.evaluate(getScrollHeight)) > prev) { await page.evaluate(findAndScroll); await page.waitForTimeout(300); return true; }
    }
    return false;
  }
  await page.waitForTimeout(300);
  return true;
}

async function processOneAd(context, page, card, mediaId, summary) {
  const prep = await prepareTranscript(page, card);
  const extraction = await extractTranscript(page, prep.transcriptPanel);
  const shareUrl = await captureShareUrl(context, page, prep.dialog);
  await closeAdDetails(page, prep.dialog);
  return {
    mediaId,
    title: summary.title,
    duration: summary.duration,
    savedDate: prep.overview.savedDate,
    activePeriod: prep.overview.activePeriod,
    landingPage: prep.overview.landingPage,
    transcript: extraction.text,
    shareUrl,
  };
}

/** Bare hostname of a landing page, or null. */
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./i, '').toLowerCase(); } catch { return null; }
}

/**
 * Cheaply read ONLY an ad's landing-page host by opening Details and reading
 * the Overview — WITHOUT opening the transcript tab (the slow part). Lets a
 * multi-brand creator page skip off-brand ads before paying for a transcript.
 * Returns null if it can't read one, so the caller falls back to full processing.
 */
async function peekLanderHost(page, card) {
  try {
    const dialog = await openAdDetails(page, card);
    const overview = await extractOverviewFields(page, dialog);
    await closeAdDetails(page, dialog);
    return hostOf(overview.landingPage);
  } catch {
    return null;
  }
}

/**
 * Collect the currently-open page's ads and file them under (brandId, pageId).
 * `allowedDomains` (the brand's own lander domains) is the safety net for
 * multi-brand creator/whitelist pages: a creator like "Maggie Jones" runs ads
 * for several brands off one GetHook page, so we only SAVE the ads whose
 * landing page points at this brand's domain and skip the rest. `maxAds` caps
 * how many of the page's ads we EXAMINE (not how many we save).
 */
async function collectPageAds(context, page, brandId, pageId, seenIds, maxAds, allowedDomains) {
  const cards = page.getByTestId('ad-card');
  const appeared = await cards.first().waitFor({ state: 'visible', timeout: T }).then(() => true).catch(() => false);
  if (!appeared) { warn('LAYERB', '  no ad cards for this page — nothing to collect.'); return { saved: 0, filtered: 0, errors: 0, backendFailures: 0 }; }

  const filterOn = allowedDomains && allowedDomains.size > 0;
  let saved = 0, filtered = 0, errors = 0, backendFailures = 0, examined = 0;

  for (let round = 0; round < MAX_SCROLL_ROUNDS && examined < maxAds; round++) {
    const count = await cards.count().catch(() => 0);
    let newThisRound = 0;

    for (let i = 0; i < count && examined < maxAds; i++) {
      const card = cards.nth(i);
      const mediaId = await extractMediaId(card);
      if (!mediaId || seenIds.has(mediaId)) continue;
      seenIds.add(mediaId);
      newThisRound++; examined++;

      const summary = await extractCardSummary(card);
      log('LAYERB', `  ad ${examined}/${maxAds}: mediaId=${mediaId} "${summary.title}"`);

      // Cheap pre-check: peek at the landing page BEFORE the transcript wait, so
      // an off-brand ad on a multi-brand creator page is skipped fast. If the
      // peek can't read a host, fall through — the post-process check still guards.
      if (filterOn) {
        const peekHost = await peekLanderHost(page, card);
        if (peekHost && !allowedDomains.has(peekHost)) {
          filtered++;
          log('LAYERB', `    -> filtered out (off-brand: ${peekHost}) — skipped before transcript.`);
          continue;
        }
      }

      try {
        const ad = await processOneAd(context, page, card, mediaId, summary);
        const host = hostOf(ad.landingPage);
        if (filterOn && !allowedDomains.has(host)) {
          filtered++;
          log('LAYERB', `    -> filtered out (off-brand lander: ${host || 'none'}).`);
          continue;
        }
        await upsertAd(ad, brandId, pageId);
        saved++;
        log('LAYERB', `    -> saved (transcript ${ad.transcript.length} chars, lander ${host}).`);
      } catch (err) {
        if (err instanceof BackendTranscriptionFailedError) { backendFailures++; warn('LAYERB', `    -> skipped (backend transcription failed).`); }
        else { errors++; error('LAYERB', `    -> failed: ${err.message}`); }
        await page.keyboard.press('Escape').catch(() => {});
      }
    }

    if (examined >= maxAds) break;
    const grew = await scrollForMore(page);
    if (!grew && newThisRound === 0) { log('LAYERB', '  reached end of this page\'s ads.'); break; }
  }
  return { saved, filtered, errors, backendFailures };
}

let context;

async function main() {
  const { flags, positional, opts } = parseArgs(process.argv.slice(2));
  const brandQuery = positional[0];
  const maxAds = Number(opts['max-ads'] || 25);
  const onlyPage = opts.page || null;
  const inspect = flags.has('--inspect');

  if (!brandQuery) {
    console.error('Usage: node src/adlibrary/scrapePages.js "Brand Name" [--max-ads=25] [--page="Name"] [--inspect]');
    process.exit(1);
  }

  const brands = await findBrands(brandQuery);
  if (brands.length === 0) { error('LAYERB', `No brand matching "${brandQuery}".`); process.exit(1); }
  const brand = brands[0];

  // Only save ads whose landing page points at one of the brand's own domains —
  // the guard for multi-brand creator/whitelist pages (see collectPageAds).
  const allowedDomains = new Set(await getBrandLanderDomains(brand.id));
  log('LAYERB', `Domain filter: keeping only ads landing on [${[...allowedDomains].join(', ') || '(any — no known landers)'}].`);

  let pages = await getDiscoveredPages(brand.id);
  if (onlyPage) pages = pages.filter((p) => norm(p.name).includes(norm(onlyPage)));
  if (pages.length === 0) { log('LAYERB', 'No discovered pages to scrape (run findPages.js first).'); return; }
  log('LAYERB', `Brand "${brand.name}" (id=${brand.id}) — ${pages.length} discovered page(s) to scrape, up to ${maxAds} ads each.`);

  verifyChromeIsInstalled(); ensureProfileDir(); warnIfLocked();
  context = await chromium.launchPersistentContext(PROFILE_DIR, { channel: 'chrome', headless: false, chromiumSandbox: true });
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('load', { timeout: LOAD_EVENT_TIMEOUT_MS }).catch(() => {});
  await ensureLoggedIn(page);

  // Pre-seed with the brand's existing ads so we never re-scrape a media_id.
  const seenIds = new Set(await getExistingMediaIds(brand.id).catch(() => []));

  const results = [];
  for (const p of pages) {
    log('LAYERB', `── Page: "${p.name}" (${p.type}, page_id=${p.id}) ──`);
    // Guard against reversed branded-content labels like "<Brand> with Creator":
    // stripping " with …" leaves the brand name, which would open (and
    // re-scrape) the MAIN brand and misfile its ads under this page_id.
    if (norm(searchTermFor(p.name)) === norm(brand.name)) {
      log('LAYERB', '  skipped — name resolves to the main brand itself, not a distinct page.');
      results.push({ page: p.name, skipped: 'resolves to main brand' });
      continue;
    }
    const open = await searchAndOpenPage(page, p.name);
    if (!open.opened) { log('LAYERB', `  skipped — ${open.reason}.`); results.push({ page: p.name, skipped: open.reason }); continue; }
    await applyBrandFilters(page);
    const r = await collectPageAds(context, page, brand.id, p.id, seenIds, maxAds, allowedDomains);
    results.push({ page: p.name, ...r });
    log('LAYERB', `  "${p.name}": saved=${r.saved}, filtered(off-brand)=${r.filtered}, errors=${r.errors}, backendFailures=${r.backendFailures}`);
  }

  console.log('\n----- LAYER B SUMMARY -----');
  console.log(`Brand: ${brand.name} (id=${brand.id})`);
  for (const r of results) {
    if (r.skipped) console.log(`  [skip] ${r.page} — ${r.skipped}`);
    else console.log(`  [ok]   ${r.page} — saved ${r.saved}, filtered ${r.filtered || 0} off-brand (errors ${r.errors}, backend-fail ${r.backendFailures})`);
  }
  const totalSaved = results.reduce((s, r) => s + (r.saved || 0), 0);
  console.log(`Total ads saved: ${totalSaved}`);

  if (inspect) await askQuestion('\n--inspect: browser open. Press Enter to close...\n');
  await context.close();
  log('LAYERB', 'Done.');
}

process.on('SIGINT', async () => { console.log('\n[LAYERB] Interrupt — closing browser...'); if (context) await context.close(); process.exit(0); });
main().catch((err) => { error('LAYERB', err.stack || err.message); process.exit(1); });
