'use strict';

/**
 * src/browser/fix.js
 *
 * Standalone repair tool for already-scraped ad data. Completely
 * independent from the normal scraper (src/browser/launch.js) — reuses
 * the same browser, navigation, and module infrastructure but runs its
 * own lightweight pipeline that only touches the specific columns that
 * need fixing.
 *
 * Usage:
 *   node src/browser/fix.js "Brand Name" --fix share-urls [--inspect]
 *
 * Each fix mode defines:
 *   identify(brandId)          — which ads need fixing (Supabase query)
 *   process(context, page, …)  — minimal per-ad work (e.g. capture share URL)
 *   update(mediaId, newValues)  — write fixed column(s) to Supabase
 */

const { chromium } = require('playwright');
const { PROFILE_DIR, TARGET_URL, LOAD_EVENT_TIMEOUT_MS, DEFAULT_BRAND_NAME } = require('./config');
const { log, warn, error } = require('./logger');
const { verifyChromeIsInstalled, ensureProfileDir, warnIfLocked } = require('./profileManager');
const { ensureLoggedIn } = require('./session');
const { askQuestion } = require('./prompt');
const { navigateToBrand } = require('../scraper/navigation');
const { applyBrandFilters } = require('../scraper/filters');
const { openAdDetails, closeAdDetails } = require('../scraper/details');
const { captureShareUrl } = require('../scraper/share');
const { prepareTranscript, BackendTranscriptionFailedError } = require('../scraper/prepareTranscript');
const { extractTranscript } = require('../scraper/extract');
const { supabase } = require('../supabase/client');

const ACTION_TIMEOUT_MS = 15000;
const MAX_SCROLL_ROUNDS = 500;
const MEDIA_ID_PATTERN = /ads_media\/(\d+)\//;

// ── Helpers (reused from collect.js without modifying it) ──────────

async function extractMediaId(card) {
  const mediaSrc = await card
    .getByTestId('media')
    .locator('img, video')
    .first()
    .getAttribute('src')
    .catch(() => null);
  return mediaSrc ? (mediaSrc.match(MEDIA_ID_PATTERN)?.[1] ?? null) : null;
}

async function scrollForMore(page) {
  const findAndScroll = () => {
    const card = document.querySelector('[data-testid="ad-card"]');
    if (!card) return { scrolled: false, scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
    let scroller = null;
    let el = card.parentElement;
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
        scroller = el;
        break;
      }
      el = el.parentElement;
    }
    if (!scroller) scroller = document.documentElement;
    const before = scroller.scrollTop;
    scroller.scrollTop += scroller.clientHeight;
    return { scrolled: scroller.scrollTop > before + 1, scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight };
  };

  const getScrollHeight = () => {
    const card = document.querySelector('[data-testid="ad-card"]');
    if (!card) return 0;
    let el = card.parentElement;
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) return el.scrollHeight;
      el = el.parentElement;
    }
    return document.documentElement.scrollHeight;
  };

  const scrollInfo = await page.evaluate(findAndScroll);
  log('SCROLL', `scrollTop=${scrollInfo.scrollTop}, scrollHeight=${scrollInfo.scrollHeight}, moved=${scrollInfo.scrolled}`);

  if (!scrollInfo.scrolled) {
    const prevHeight = scrollInfo.scrollHeight;
    const SCROLL_GROWTH_TIMEOUT_MS = 10000;
    const deadline = Date.now() + SCROLL_GROWTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await page.waitForTimeout(500);
      const curHeight = await page.evaluate(getScrollHeight);
      if (curHeight > prevHeight) {
        await page.evaluate(findAndScroll);
        await page.waitForTimeout(300);
        return true;
      }
    }
    return false;
  }

  await page.waitForTimeout(300);
  return true;
}

// ── Fix mode: share-urls ───────────────────────────────────────────

async function identifyBadShareUrls(brandId) {
  const { data, error: err } = await supabase
    .from('ads')
    .select('media_id, share_url')
    .eq('brand_id', brandId);

  if (err) throw new Error(`Failed to query ads: ${err.message}`);

  const urlCounts = {};
  for (const ad of data) {
    if (!ad.share_url) continue;
    if (!urlCounts[ad.share_url]) urlCounts[ad.share_url] = [];
    urlCounts[ad.share_url].push(ad.media_id);
  }

  const badMediaIds = new Set();
  for (const [url, mediaIds] of Object.entries(urlCounts)) {
    if (mediaIds.length > 1) {
      for (const id of mediaIds) badMediaIds.add(id);
    }
  }

  return badMediaIds;
}

async function updateShareUrl(mediaId, newShareUrl) {
  const { error: err } = await supabase
    .from('ads')
    .update({ share_url: newShareUrl, updated_at: new Date().toISOString() })
    .eq('media_id', mediaId);

  if (err) throw new Error(`Failed to update share_url for mediaId=${mediaId}: ${err.message}`);
}

// ── Fix mode: transcripts ─────────────────────────────────────────

const BAD_TRANSCRIPT_PATTERNS = ['Generating...', 'Generate Transcription'];

async function identifyBadTranscripts(brandId) {
  const { data, error: err } = await supabase
    .from('ads')
    .select('media_id, transcript')
    .eq('brand_id', brandId);

  if (err) throw new Error(`Failed to query ads: ${err.message}`);

  const badMediaIds = new Set();
  for (const ad of data) {
    if (!ad.transcript || BAD_TRANSCRIPT_PATTERNS.includes(ad.transcript.trim())) {
      badMediaIds.add(ad.media_id);
    }
  }

  return badMediaIds;
}

async function updateTranscript(mediaId, newTranscript) {
  const { error: err } = await supabase
    .from('ads')
    .update({ transcript: newTranscript, updated_at: new Date().toISOString() })
    .eq('media_id', mediaId);

  if (err) throw new Error(`Failed to update transcript for mediaId=${mediaId}: ${err.message}`);
}

// ── Per-ad processors ─────────────────────────────────────────────

async function processShareUrlFix(context, page, card) {
  const dialog = await openAdDetails(page, card);
  const shareUrl = await captureShareUrl(context, page, dialog);
  await closeAdDetails(page, dialog);
  await updateShareUrl(card._fixMediaId, shareUrl);
  return `New share_url: ${shareUrl}`;
}

const TRANSCRIPT_WAIT_TIMEOUT_MS = 60000;
const TRANSCRIPT_POLL_MS = 500;

async function waitForRealTranscript(transcriptPanel) {
  const deadline = Date.now() + TRANSCRIPT_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const text = (await transcriptPanel.innerText().catch(() => '')).trim();
    if (text.length > 0 && !BAD_TRANSCRIPT_PATTERNS.includes(text)) {
      return text;
    }
    await new Promise(r => setTimeout(r, TRANSCRIPT_POLL_MS));
  }
  return null;
}

async function processTranscriptFix(context, page, card) {
  const mediaId = card._fixMediaId;
  const { dialog, transcriptPanel } = await prepareTranscript(page, card);

  let realText = await waitForRealTranscript(transcriptPanel);
  if (!realText) {
    await closeAdDetails(page, dialog);
    throw new Error('Transcript still "Generating..." after 60s — GetHook backend likely cannot transcribe this ad');
  }

  const { text } = await extractTranscript(page, transcriptPanel);
  await closeAdDetails(page, dialog);

  if (BAD_TRANSCRIPT_PATTERNS.includes(text.trim())) {
    throw new Error(`Transcript is still "${text.trim()}" — GetHook backend likely cannot transcribe this ad`);
  }

  await updateTranscript(mediaId, text);
  return `Transcript length: ${text.length} chars`;
}

// ── Main fix loop ──────────────────────────────────────────────────

async function runFixLoop(context, page, brandId, adsToFix, processOne) {
  const cards = page.getByTestId('ad-card');
  await cards.first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });

  const visited = new Set();
  let fixed = 0;
  let errors = 0;
  let skipped = 0;
  let backendFailures = 0;

  log('FIX', `${adsToFix.size} ad(s) need repair. Scrolling through ad list...`);

  for (let round = 0; round < MAX_SCROLL_ROUNDS; round++) {
    let count;
    try {
      count = await cards.count();
    } catch {
      warn('FIX', 'Page became unresponsive — ending with results gathered so far.');
      break;
    }

    let newThisRound = 0;

    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);
      const mediaId = await extractMediaId(card);

      if (!mediaId || visited.has(mediaId)) continue;
      visited.add(mediaId);

      if (!adsToFix.has(mediaId)) {
        skipped += 1;
        continue;
      }

      newThisRound += 1;
      log('FIX', `Fixing mediaId=${mediaId} (${fixed + 1}/${adsToFix.size})...`);

      try {
        card._fixMediaId = mediaId;
        const result = await processOne(context, page, card);
        fixed += 1;
        log('FIX', `  -> fixed. ${result}`);
      } catch (err) {
        if (err instanceof BackendTranscriptionFailedError) {
          backendFailures += 1;
          warn('FIX', `  -> skipped mediaId=${mediaId}: backend transcription failed`);
        } else {
          errors += 1;
          error('FIX', `  -> failed for mediaId=${mediaId}: ${err.message}`);
        }
        await page.keyboard.press('Escape').catch(() => {});
      }
    }

    if (fixed + errors + backendFailures >= adsToFix.size) {
      log('FIX', 'All target ads have been processed.');
      break;
    }

    const grew = await scrollForMore(page);
    log('FIX', `Round ${round} done: newThisRound=${newThisRound}, grew=${grew}`);
    if (!grew && newThisRound === 0) {
      log('FIX', 'No new ads after scrolling — reached the end of the list.');
      break;
    }
  }

  return { fixed, errors, backendFailures, skipped, totalTargeted: adsToFix.size, notFound: adsToFix.size - fixed - errors - backendFailures };
}

// ── CLI & entry point ──────────────────────────────────────────────

function parseArgs(argv) {
  const flags = new Set();
  const positional = [];
  let fixMode = null;
  const args = argv.slice(0);

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--fix' && i + 1 < args.length) {
      fixMode = args[i + 1];
      i++;
    } else if (args[i].startsWith('--')) {
      flags.add(args[i]);
    } else {
      positional.push(args[i]);
    }
  }

  return { flags, positional, fixMode };
}

const FIX_MODES = {
  'share-urls': {
    identify: identifyBadShareUrls,
    process: processShareUrlFix,
    needsBrowser: true,
  },
  'transcripts': {
    identify: identifyBadTranscripts,
    process: processTranscriptFix,
    needsBrowser: true,
  },
};

let context;

async function main() {
  const { flags, positional, fixMode } = parseArgs(process.argv.slice(2));
  const brandName = positional[0] || DEFAULT_BRAND_NAME;
  const inspectMode = flags.has('--inspect');

  if (!fixMode) {
    console.error('Usage: node src/browser/fix.js "Brand Name" --fix <mode>');
    console.error('Available modes:', Object.keys(FIX_MODES).join(', '));
    process.exit(1);
  }

  const mode = FIX_MODES[fixMode];
  if (!mode) {
    console.error(`Unknown fix mode: "${fixMode}". Available: ${Object.keys(FIX_MODES).join(', ')}`);
    process.exit(1);
  }

  log('FIX', `Fix mode: ${fixMode} | Brand: "${brandName}"`);

  // Find existing brand by fuzzy match — never create a new one
  const { data: brands, error: brandErr } = await supabase
    .from('brands')
    .select('id, name')
    .ilike('name', `%${brandName}%`);

  if (brandErr) {
    error('FIX', `Failed to query brands: ${brandErr.message}`);
    process.exit(1);
  }
  if (!brands || brands.length === 0) {
    error('FIX', `No brand found matching "${brandName}". Available brands:`);
    const { data: all } = await supabase.from('brands').select('name');
    (all || []).forEach((b) => console.error(`  - ${b.name}`));
    process.exit(1);
  }

  const brand = brands[0];
  const brandId = brand.id;
  log('FIX', `Matched brand: "${brand.name}" (id=${brandId})`);

  // Identify which ads need fixing
  const adsToFix = await mode.identify(brandId);
  if (adsToFix.size === 0) {
    log('FIX', 'No ads need fixing — all data looks clean. Nothing to do.');
    return;
  }
  log('FIX', `Found ${adsToFix.size} ad(s) that need repair.`);

  if (!mode.needsBrowser) {
    log('FIX', 'This fix mode is DB-only — no browser needed.');
    // Future DB-only modes would run their logic here
    return;
  }

  // Launch browser
  verifyChromeIsInstalled();
  ensureProfileDir();
  warnIfLocked();

  log('FIX', 'Launching Chrome...');
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    chromiumSandbox: true,
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });

  try {
    await page.waitForLoadState('load', { timeout: LOAD_EVENT_TIMEOUT_MS });
  } catch {
    warn('FIX', 'Load event did not fire in time; continuing anyway.');
  }

  await ensureLoggedIn(page);
  await navigateToBrand(page, brand.name);
  await applyBrandFilters(page);

  const startTime = Date.now();
  const summary = await runFixLoop(context, page, brandId, adsToFix, mode.process);
  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n----- FIX SUMMARY -----');
  console.log(`Brand: ${brandName}`);
  console.log(`Mode: ${fixMode}`);
  console.log(`Targeted: ${summary.totalTargeted}`);
  console.log(`Fixed: ${summary.fixed}`);
  console.log(`Backend failures (skipped): ${summary.backendFailures}`);
  console.log(`Errors: ${summary.errors}`);
  console.log(`Not found on page: ${summary.notFound}`);
  console.log(`Good ads skipped: ${summary.skipped}`);
  console.log(`Duration: ${durationSec}s`);

  if (inspectMode) {
    await askQuestion('\n--inspect: browser is open. Press Enter to close...\n');
  }

  log('FIX', 'Closing browser...');
  await context.close();
  log('FIX', 'Done.');
}

process.on('SIGINT', async () => {
  console.log('\n[FIX] Interrupt received, closing browser...');
  if (context) await context.close();
  process.exit(0);
});

main().catch((err) => {
  error('FIX', err.stack || err.message);
  process.exit(1);
});
