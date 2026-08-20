'use strict';

/**
 * src/scraper/collect.js
 *
 * Phase 8: process every ad available for the currently-open brand page,
 * not just the first. Reuses the entire single-ad pipeline per ad:
 *
 *   src/scraper/details.js         (openAdDetails / closeAdDetails)
 *   src/scraper/prepareTranscript.js (generate + disable timestamps)
 *   src/scraper/extract.js         (read the transcript)
 *   src/scraper/share.js           (copy the Share URL)
 *
 * Ads are discovered and processed together, one at a time, rather than
 * discovering the full list up front: the ad grid is a virtualized list
 * (react-virtuoso, see src/scraper/ads.js) — scrolling to find later ads
 * un-mounts earlier ones from the DOM, so a card is only guaranteed
 * clickable while it's still on screen. Each newly-seen card is opened,
 * processed, and closed immediately; only then does the loop scroll for
 * more.
 *
 * Milestone 2, Step 2: each successfully processed ad is also upserted
 * into Supabase (src/supabase/adsRepository.js), as a side channel next
 * to the existing JSON export — not a replacement for it. A Supabase
 * failure is caught and counted separately (totalDbErrors) and never
 * affects totalProcessed, totalErrors, or what ends up in the JSON file.
 */

const { log, warn, error } = require('../browser/logger');
const { closeAdDetails } = require('./details');
const { prepareTranscript, BackendTranscriptionFailedError } = require('./prepareTranscript');
const { extractTranscript } = require('./extract');
const { captureShareUrl } = require('./share');
const { upsertBrand, ensureMainPage, upsertAd, getExistingMediaIds } = require('../supabase/adsRepository');
const { maxAds: MAX_ADS, filters: FILTER_CONFIG } = require('../config');

const ACTION_TIMEOUT_MS = 15000;
const MAX_SCROLL_ROUNDS = 500;
const SCROLL_GROWTH_TIMEOUT_MS = 10000;
const MEDIA_ID_PATTERN = /ads_media\/(\d+)\//;

async function extractMediaId(card) {
  const mediaSrc = await card
    .getByTestId('media')
    .locator('img, video')
    .first()
    .getAttribute('src')
    .catch(() => null);
  return mediaSrc ? (mediaSrc.match(MEDIA_ID_PATTERN)?.[1] ?? null) : null;
}

async function extractCardSummary(card) {
  const title = await card
    .getByTestId('title')
    .first()
    .textContent()
    .then((t) => t?.trim() || null)
    .catch(() => null);

  const duration = await card
    .getByTestId('media')
    .first()
    .textContent()
    .then((t) => t?.trim() || null)
    .catch(() => null);

  return { title, duration };
}

/**
 * Runs the full single-ad pipeline (open Details -> open Transcript tab
 * -> prepare (generate + disable timestamps) -> extract -> capture Share
 * URL -> close Details) against one already-visible card. Reuses every
 * existing module unchanged.
 *
 * Builds the one canonical ad object here — this is the only place in
 * the project that constructs it, so there is exactly one data model for
 * a collected ad, not one per consumer (export, summary, etc.).
 */
async function processOneAd(context, page, card, mediaId, cardSummary, brandName) {
  const prep = await prepareTranscript(page, card);
  const extraction = await extractTranscript(page, prep.transcriptPanel);
  const shareUrl = await captureShareUrl(context, page, prep.dialog);
  await closeAdDetails(page, prep.dialog);

  return {
    mediaId,
    brand: brandName,
    title: cardSummary.title,
    duration: cardSummary.duration,
    savedDate: prep.overview.savedDate,
    activePeriod: prep.overview.activePeriod,
    landingPage: prep.overview.landingPage,
    transcript: extraction.text,
    shareUrl,
    filters: {
      country: FILTER_CONFIG.country,
      language: FILTER_CONFIG.language,
      format: FILTER_CONFIG.format,
    },
    collectedAt: new Date().toISOString(),
  };
}

/**
 * Finds the scrollable ancestor of the ad cards and scrolls it down by
 * one viewport. The ad list's scroll container is detected at runtime
 * (the first ancestor with overflow-y: auto/scroll that has overflowing
 * content) rather than by a hardcoded data-testid, since the host app
 * can change which element owns the scroll.
 *
 * Mid-list: scrollTop moved → brief render pause, return true.
 * At bottom: scrollTop didn't move → poll for scrollHeight growth
 * (server-side pagination), returning false if nothing loads.
 */
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
  log('SCROLL', `scrollTop=${scrollInfo.scrollTop}, scrollHeight=${scrollInfo.scrollHeight}, clientHeight=${scrollInfo.clientHeight}, moved=${scrollInfo.scrolled}`);

  if (!scrollInfo.scrolled) {
    const prevHeight = scrollInfo.scrollHeight;
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

/**
 * Discovers and processes every ad for the currently-open brand page, up
 * to maxAds. Never aborts the whole run because one ad failed — each
 * ad's pipeline is individually caught, logged, and skipped on error.
 * Avoids reprocessing a mediaId already seen (whether successfully
 * processed or not), including ones that reappear across scroll rounds
 * due to the virtualized list's overscan buffer.
 */
async function collectAdsForBrand(context, page, brandName, maxAds = MAX_ADS) {
  const cards = page.getByTestId('ad-card');
  await cards.first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });

  const brandUrl = page.url();
  let brandId = null;
  let mainPageId = null;
  try {
    brandId = await upsertBrand(brandName, brandUrl);
    // Every brand gets a `main` page and every ad is linked to it, so new
    // brands don't need the one-time migration backfill.
    mainPageId = await ensureMainPage(brandId, brandName);
    log('COLLECT', `Supabase brand ready: "${brandName}" (id=${brandId}, mainPage=${mainPageId}).`);
  } catch (err) {
    warn('COLLECT', `Could not upsert brand "${brandName}" to Supabase; skipping DB writes for this run: ${err.message}`);
  }

  const seenIds = new Set();
  const results = [];
  const skippedAds = [];
  let duplicatesIgnored = 0;
  let skipped = 0;
  let errors = 0;
  let dbSaved = 0;
  let dbErrors = 0;

  if (brandId !== null) {
    try {
      const existing = await getExistingMediaIds(brandId);
      for (const id of existing) seenIds.add(id);
      if (seenIds.size > 0) {
        log('COLLECT', `Skipping ${seenIds.size} already-scraped ad(s) found in Supabase.`);
      }
    } catch (err) {
      warn('COLLECT', `Could not load existing media IDs from Supabase: ${err.message}`);
    }
  }

  for (let round = 0; round < MAX_SCROLL_ROUNDS && seenIds.size < maxAds; round++) {
    let count;
    try {
      count = await cards.count();
    } catch {
      warn('COLLECT', 'Page became unresponsive — ending collection with results gathered so far.');
      break;
    }
    let newThisRound = 0;

    log('COLLECT', `Round ${round}: ${count} card(s) in DOM, seenIds=${seenIds.size}`);

    for (let i = 0; i < count && seenIds.size < maxAds; i++) {
      const card = cards.nth(i);
      const mediaId = await extractMediaId(card);

      if (!mediaId) {
        skipped += 1;
        warn('COLLECT', `Card at position ${i} has no extractable mediaId; skipping.`);
        continue;
      }

      if (seenIds.has(mediaId)) {
        duplicatesIgnored += 1;
        continue;
      }

      seenIds.add(mediaId);
      newThisRound += 1;

      const cardSummary = await extractCardSummary(card);
      log('COLLECT', `Processing ad ${seenIds.size}/${maxAds}: mediaId=${mediaId} title="${cardSummary.title}"`);

      try {
        const result = await processOneAd(context, page, card, mediaId, cardSummary, brandName);
        results.push(result);
        log(
          'COLLECT',
          `  -> success. transcriptLength=${result.transcript.length}, shareUrl=${result.shareUrl}`
        );

        if (brandId !== null) {
          try {
            await upsertAd(result, brandId, mainPageId);
            dbSaved += 1;
            log('COLLECT', `  -> saved to Supabase (mediaId=${mediaId}).`);
          } catch (dbErr) {
            dbErrors += 1;
            error('COLLECT', `Failed to save mediaId=${mediaId} to Supabase: ${dbErr.message}`);
          }
        }
      } catch (err) {
        if (err instanceof BackendTranscriptionFailedError) {
          skippedAds.push({
            mediaId,
            reason: 'backend_transcription_failed',
            transcriptionStatus: err.transcriptionStatus,
          });
          log(
            'COLLECT',
            `  -> skipped. GetHook's backend failed to transcribe mediaId=${mediaId} ` +
              `(transcription_status="${err.transcriptionStatus}"); not a scraper error.`
          );
        } else {
          errors += 1;
          error('COLLECT', `Failed to process ad mediaId=${mediaId}: ${err.message}`);
        }
        // Best-effort: make sure a half-open dialog doesn't break the next
        // ad's attempt, even though this ad's own close step may not
        // have run.
        await page.keyboard.press('Escape').catch(() => {});
      }
    }

    if (seenIds.size >= maxAds) break;

    const grew = await scrollForMore(page);
    log('COLLECT', `Round ${round} done: newThisRound=${newThisRound}, grew=${grew}`);
    if (!grew && newThisRound === 0) {
      log('COLLECT', 'No new ads after scrolling — reached the end of the list.');
      break;
    }
  }

  const summary = {
    totalDiscovered: seenIds.size,
    totalProcessed: results.length,
    totalSkipped: skipped,
    totalDuplicatesIgnored: duplicatesIgnored,
    totalErrors: errors,
    totalBackendFailures: skippedAds.length,
    totalDbSaved: dbSaved,
    totalDbErrors: dbErrors,
    ads: results,
    skippedAds,
  };

  log(
    'COLLECT',
    `Summary: discovered=${summary.totalDiscovered}, processed=${summary.totalProcessed}, ` +
      `skipped=${summary.totalSkipped}, duplicatesIgnored=${summary.totalDuplicatesIgnored}, ` +
      `errors=${summary.totalErrors}, backendFailures=${summary.totalBackendFailures}, ` +
      `dbSaved=${summary.totalDbSaved}, dbErrors=${summary.totalDbErrors}`
  );

  return summary;
}

module.exports = { collectAdsForBrand, MAX_ADS };
