'use strict';

/**
 * src/adlibrary/findPages.js
 *
 * Layer A of the whitelisting/full-footprint project: the Meta Ad Library
 * page finder. Given a brand, it pivots on that brand's landing-page
 * domains — every page running ads to a brand-owned lander IS the brand
 * (main account, secondary account, or whitelisted creator page) — and
 * records the distinct pages it finds under that brand in `pages`.
 *
 * This is a SEPARATE tool from the GetHook scraper (src/browser/launch.js).
 * It does NOT collect ad data — only page identities. GetHook (Layer B)
 * pulls the actual ads per discovered page later.
 *
 * Flow per lander domain:
 *   open Ad Library (All countries · All ads · Active) searching the domain
 *   -> scroll, reading each card's page name -> keep going until new
 *   advertisers stop appearing (discovery plateau) or the results end ->
 *   collect distinct page names. Then classify (main / whitelist /
 *   secondary) and store the new ones. Keeps Ad Library's DEFAULT sort — see
 *   the "NOTE ON SORT" below for why not "Most recent".
 *
 * Usage:
 *   node src/adlibrary/findPages.js "ryze" [--max-scrolls=400] [--inspect]
 *
 * Card structure is grounded in a live recon pass (2026-08-01): Meta's
 * class names are obfuscated, so extraction is anchored on stable card
 * TEXT — "Library ID:" bounds each card, "Started running on <date>" gives
 * the start date, and the page name is always the line directly above
 * "Sponsored".
 */

const { chromium } = require('playwright');
const { PROFILE_DIR } = require('../browser/config');
const { log, warn, error } = require('../browser/logger');
const { verifyChromeIsInstalled, ensureProfileDir, warnIfLocked } = require('../browser/profileManager');
const { askQuestion } = require('../browser/prompt');
const {
  findBrands,
  getBrandLanderDomains,
  getExistingPageNames,
  insertPage,
} = require('./pagesRepository');

const CONSENT_PATTERNS = [/allow all cookies/i, /only allow essential/i, /decline optional/i, /accept all/i];
const SETTLE_MS = 6000;
const SCROLL_STEP_PX = 3000;
const SCROLL_WAIT_MS = 2500;
const STAGNANT_LIMIT = 4;   // consecutive scrolls with no new cards -> end of results
const PAGE_PLATEAU = 8;     // consecutive scrolls with no NEW page -> discovery done
const MIN_SCROLLS = 6;      // always scan at least this far before plateau can stop us

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** Ad Library search URL: All countries, All ads, Active only, domain query. */
function buildSearchUrl(domain) {
  const params = new URLSearchParams({
    active_status: 'active',
    ad_type: 'all',
    country: 'ALL',
    q: domain,
    search_type: 'keyword_unordered',
    media_type: 'all',
  });
  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

async function dismissConsent(page) {
  for (const rx of CONSENT_PATTERNS) {
    const btn = page.getByRole('button', { name: rx }).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {});
      return true;
    }
  }
  return false;
}

// NOTE ON SORT: we deliberately keep Ad Library's DEFAULT sort
// ("Impressions: high to low"), not "Most recent". Confirmed live that
// most-recent clusters the newest slice around the main account (it posts
// daily), burying the whitelist/3rd-party pages hundreds of scrolls back —
// it found 2 pages where the default found 10. The default relevancy order
// diversifies advertisers, which is exactly what a PAGE finder wants. The
// recency lens matters when ranking winning ADS — that's the analysis
// layer's job, on the actual ads, not this discovery step.

/**
 * Segment the results' innerText into per-ad cards and pull, for each, its
 * Library ID, start date, and running page name. Card boundary = a line
 * beginning "Library ID:"; page name = the line directly above "Sponsored".
 */
function parseCards(text) {
  const lines = text.split('\n').map((s) => s.trim());
  const starts = [];
  lines.forEach((l, i) => { if (/^Library ID:/i.test(l)) starts.push(i); });

  const cards = [];
  for (let k = 0; k < starts.length; k++) {
    const seg = lines.slice(starts[k], k + 1 < starts.length ? starts[k + 1] : lines.length);
    const libId = (seg[0].match(/Library ID:\s*(\d+)/i) || [])[1] || null;
    const dateLine = seg.find((l) => /^Started running on /i.test(l));
    const startDate = dateLine ? dateLine.replace(/^Started running on /i, '').trim() : null;
    const spIdx = seg.findIndex((l) => /^Sponsored$/i.test(l));
    const pageName = spIdx > 0 ? seg[spIdx - 1] : null;
    cards.push({ libId, startDate, pageName });
  }
  return cards;
}

/**
 * main / whitelist / secondary from the page name alone (deterministic, no
 * copy-reading — keeps the finder from "analyzing"):
 *   "X with <Brand>"       -> whitelist (branded-content / partnership format)
 *   contains the brand token -> main (the brand's own page)
 *   otherwise               -> secondary (a 3rd-party page running its ads)
 */
function classifyPage(pageName, brandName) {
  const p = pageName.toLowerCase();
  if (/\bwith\b/.test(p)) return 'whitelist';
  const token = (brandName.split(/\s+/)[0] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (token && p.replace(/[^a-z0-9]/g, '').includes(token)) return 'main';
  return 'secondary';
}

/** Scroll a domain's results, collecting distinct advertiser pages until
 *  discovery plateaus or the results end. */
async function harvestPagesForDomain(page, domain, maxScrolls) {
  await page.goto(buildSearchUrl(domain), { waitUntil: 'domcontentloaded' });
  await dismissConsent(page);
  await sleep(SETTLE_MS);

  const seenIds = new Set();
  const found = new Map(); // pageName -> earliest start Date seen (kept for reporting)
  let cardStagnant = 0;
  let pageStagnant = 0;

  for (let i = 0; i < maxScrolls; i++) {
    const text = await page.evaluate(() => document.body.innerText).catch(() => '');
    const cards = parseCards(text);

    let newCards = 0;
    let newPages = 0;
    for (const c of cards) {
      if (!c.libId || seenIds.has(c.libId)) continue;
      seenIds.add(c.libId);
      newCards++;
      const d = c.startDate ? new Date(c.startDate) : null;
      const validDate = d && !Number.isNaN(d.getTime());
      if (c.pageName) {
        if (!found.has(c.pageName)) { found.set(c.pageName, validDate ? d : null); newPages++; }
        else if (validDate) { const prev = found.get(c.pageName); if (!prev || d < prev) found.set(c.pageName, d); }
      }
    }

    log('ADLIB', `  scroll ${i}: cards=${seenIds.size} (+${newCards}), pages=${found.size} (+${newPages})`);

    // Stop on end-of-results, or once page discovery has plateaued (the finder
    // wants page coverage, not a time window — so we run until new advertisers
    // stop showing up, not until a date).
    if (newCards === 0) {
      if (++cardStagnant >= STAGNANT_LIMIT) { log('ADLIB', '  no new cards — end of results.'); break; }
    } else cardStagnant = 0;

    pageStagnant = newPages === 0 ? pageStagnant + 1 : 0;
    if (i >= MIN_SCROLLS && pageStagnant >= PAGE_PLATEAU) {
      log('ADLIB', `  page discovery plateaued (${PAGE_PLATEAU} scrolls, no new page) — stopping this domain.`);
      break;
    }

    await page.mouse.wheel(0, SCROLL_STEP_PX).catch(() => {});
    await sleep(SCROLL_WAIT_MS);
  }

  return found; // Map<pageName, Date|null>
}

let context;

async function main() {
  const { flags, positional, opts } = parseArgs(process.argv.slice(2));
  const brandQuery = positional[0];
  const maxScrolls = Number(opts['max-scrolls'] || 400);
  const inspect = flags.has('--inspect');

  if (!brandQuery) {
    console.error('Usage: node src/adlibrary/findPages.js "Brand Name" [--max-scrolls=400] [--inspect]');
    process.exit(1);
  }

  // Resolve the brand (must already exist — the finder never creates brands).
  const brands = await findBrands(brandQuery);
  if (brands.length === 0) {
    error('ADLIB', `No brand matching "${brandQuery}". The finder never creates brands — scrape it first.`);
    process.exit(1);
  }
  const brand = brands[0];
  log('ADLIB', `Brand: "${brand.name}" (id=${brand.id})`);

  const domains = await getBrandLanderDomains(brand.id);
  if (domains.length === 0) {
    error('ADLIB', `Brand "${brand.name}" has no landing-page domains on its ads yet — nothing to pivot on.`);
    process.exit(1);
  }
  log('ADLIB', `Pivoting on ${domains.length} lander domain(s): ${domains.join(', ')}`);
  log('ADLIB', 'Active ads only · default (impressions) sort · scanning until page discovery plateaus.');

  verifyChromeIsInstalled();
  ensureProfileDir();
  warnIfLocked();
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome', headless: false, chromiumSandbox: true,
  });
  const page = context.pages()[0] || (await context.newPage());

  // Union of pages found across every lander domain.
  const allFound = new Map(); // pageName -> { earliest Date|null, via domain }
  for (const domain of domains) {
    log('ADLIB', `── Searching lander: ${domain} ──`);
    const found = await harvestPagesForDomain(page, domain, maxScrolls);
    for (const [name, date] of found) {
      if (!allFound.has(name)) allFound.set(name, { date, via: domain });
    }
    log('ADLIB', `  ${domain}: ${found.size} distinct page(s).`);
  }

  // Store: skip the brand's own main page (already have a main row) and any
  // page name we already stored; insert the rest with a classified type.
  const existing = await getExistingPageNames(brand.id);
  let inserted = 0, skippedMain = 0, skippedDup = 0;
  const report = [];
  for (const [name, meta] of allFound) {
    const type = classifyPage(name, brand.name);
    if (type === 'main') { skippedMain++; report.push(`  [main]      ${name}  (skipped — main already tracked)`); continue; }
    if (existing.has(name.toLowerCase())) { skippedDup++; report.push(`  [dup]       ${name}`); continue; }
    await insertPage(brand.id, name, type, meta.via);
    existing.add(name.toLowerCase());
    inserted++;
    report.push(`  [${type.padEnd(9)}] ${name}  (via ${meta.via})`);
  }

  console.log('\n----- PAGE FINDER SUMMARY -----');
  console.log(`Brand: ${brand.name} (id=${brand.id})`);
  console.log(`Landers pivoted: ${domains.length}`);
  console.log(`Distinct pages seen: ${allFound.size}`);
  console.log(`Inserted (new 3rd-party/whitelist): ${inserted}`);
  console.log(`Skipped (main page): ${skippedMain}`);
  console.log(`Skipped (already stored): ${skippedDup}`);
  console.log('Pages:');
  report.forEach((r) => console.log(r));

  if (inspect) await askQuestion('\n--inspect: browser open. Press Enter to close...\n');
  await context.close();
  log('ADLIB', 'Done.');
}

process.on('SIGINT', async () => { console.log('\n[ADLIB] Interrupt — closing browser...'); if (context) await context.close(); process.exit(0); });
main().catch((err) => { error('ADLIB', err.stack || err.message); process.exit(1); });
