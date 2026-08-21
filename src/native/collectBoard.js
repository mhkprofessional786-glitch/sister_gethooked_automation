'use strict';

/**
 * src/native/collectBoard.js
 *
 * Native-ads board collector. Independent of the normal scraper (own loop +
 * own storage), like fix.js. Given a GetHook shared-board URL:
 *
 *   open board -> scroll to load all cards -> read the heavy fields (copy,
 *   headline, creator, landing, image, dates) straight from each card's DOM
 *   (they're all present via data-testid, so no clipboard needed) -> open the
 *   ad's modal only to grab the modal-only fields (Meta Ad ID, Facebook Ad
 *   Library URL, niche, exact saved date) -> upsert into native_ads by
 *   media_id -> next.
 *
 * Images: by default we store just the clean (unsigned) image URL, which
 * opens fine on demand. Pass --with-images to also download each creative
 * and archive it in Supabase Storage (slower; use when you want permanence).
 *
 * Reuses only shared infra: the persistent-Chrome launch profile and the
 * Supabase service client. Touches no normal-scraper code.
 *
 * Usage:
 *   node src/native/collectBoard.js "<board-url>" [--max-ads=N] [--with-images] [--inspect]
 */

const { chromium } = require('playwright');
const { PROFILE_DIR } = require('../browser/config');
const { log, warn, error } = require('../browser/logger');
const { ensureImageBucket, uploadAdImage, upsertNativeAd } = require('./nativeAdsRepository');

const DIALOG = '[role="dialog"]';
const CARD = '[data-testid="ad-card"]';
const DETAILS_BTN = '[data-testid="cta-details"]';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function flagValue(argv, name) {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
}

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const BOARD_URL = positional[0];
const MAX_ADS = Number(flagValue(argv, '--max-ads')) || Infinity;
const WITH_IMAGES = argv.includes('--with-images');
const INSPECT = argv.includes('--inspect');

if (!BOARD_URL) {
  console.error('Usage: node src/native/collectBoard.js "<board-url>" [--max-ads=N] [--with-images] [--inspect]');
  process.exit(1);
}
const boardIdMatch = BOARD_URL.match(/board\/(\d+)/);
const SOURCE_BOARD_ID = boardIdMatch ? boardIdMatch[1] : null;

let context;

/** Scroll until the number of ad-cards stops growing. */
async function loadAllCards(page) {
  const count = () => page.locator(CARD).count();
  let last = -1;
  let stable = 0;
  for (let i = 0; i < 60 && stable < 4; i++) {
    await page.mouse.wheel(0, 4000);
    await sleep(600);
    const n = await count();
    if (n === last) stable += 1;
    else stable = 0;
    last = n;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(500);
  return count();
}

/** Read every card's DOM fields in one pass (no modal, no clipboard). */
async function readAllCardFields(page) {
  return page.evaluate(
    ({ CARD }) => {
      const txt = (el, sel) => {
        const n = el.querySelector(sel);
        return n ? (n.innerText || '').trim() : null;
      };
      const href = (el, sel) => {
        const n = el.querySelector(sel);
        return n ? n.href : null;
      };
      return [...document.querySelectorAll(CARD)].map((card) => {
        const img = [...card.querySelectorAll('img')]
          .map((im) => im.currentSrc || im.src)
          .find((s) => s && s.includes('/ads_media/'));
        return {
          gethook_id: card.getAttribute('data-ad-id'),
          creator_name: txt(card, '[data-testid="brand-name"]'),
          creator_url: href(card, '[data-testid="brand-name"], [data-testid="brand-logo-link"]'),
          headline: txt(card, '[data-testid="title"]'),
          primary_text_copy: txt(card, '[data-testid="description"]'),
          landing_page: href(card, '[data-testid="landing-url"]'),
          cta_type: txt(card, '[data-testid="learn-more"]'),
          date_range: txt(card, '[data-testid="ad-date-range"]'),
          image_url: img ? img.split('?')[0] : null,
        };
      });
    },
    { CARD }
  );
}

/** Read the modal-only fields from the currently open dialog. */
async function readModalFields(page) {
  return page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return null;
    const lines = (dlg.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const after = (label) => {
      const i = lines.findIndex((l) => l.toLowerCase() === label.toLowerCase());
      return i >= 0 && i + 1 < lines.length ? lines[i + 1] : null;
    };
    let media_id = null;
    let ad_url = null;
    const fb = dlg.querySelector('a[href*="facebook.com/ads/library"]');
    if (fb) {
      ad_url = fb.href;
      const m = fb.href.match(/[?&]q=(\d+)/);
      media_id = m ? m[1] : (fb.textContent.match(/\d{6,}/) || [])[0] || null;
    }
    if (!media_id) media_id = (dlg.innerText.match(/#(\d{6,})/) || [])[1] || null;
    const niche = (after('Niche') || '').replace(/^[^A-Za-z]+/, '').trim() || null;
    return {
      media_id,
      ad_url,
      niche,
      saved_date: after('Saved'),
      active_period: after('Active Period'),
      cta_type: after('CTA Type'),
    };
  });
}

async function closeDialog(page) {
  const dlg = page.locator(DIALOG);
  try {
    const close = dlg.getByRole('button', { name: 'Close' }).first();
    if (await close.count()) await close.evaluate((el) => el.click());
    else await page.keyboard.press('Escape');
  } catch {
    await page.keyboard.press('Escape');
  }
  try {
    await dlg.first().waitFor({ state: 'hidden', timeout: 4000 });
  } catch {
    /* content sometimes swaps without a hide; the next open reuses it */
  }
}

async function downloadImage(url) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    const resp = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) return null;
    return Buffer.from(await resp.arrayBuffer());
  } catch (e) {
    warn('IMAGE', `download failed: ${e.message}`);
    return null;
  }
}

async function main() {
  const t0 = Date.now();
  log('NATIVE', `Board: ${BOARD_URL}`);
  log('NATIVE', `source_board_id: ${SOURCE_BOARD_ID} | images: ${WITH_IMAGES ? 'download+archive' : 'url only'}`);
  if (WITH_IMAGES) await ensureImageBucket();

  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    chromiumSandbox: true,
  });
  const page = context.pages()[0] || (await context.newPage());

  await page.goto(BOARD_URL, { waitUntil: 'domcontentloaded' });
  await page.locator(CARD).first().waitFor({ state: 'visible', timeout: 20000 });

  const total = await loadAllCards(page);
  const cards = await readAllCardFields(page);
  const target = Math.min(cards.length, MAX_ADS);
  log('NATIVE', `Cards on board: ${total} (read ${cards.length}) — collecting ${target}`);

  const stats = { processed: 0, saved: 0, skipped: 0, errors: 0, images: 0 };
  const seen = new Set();

  for (let i = 0; i < target; i++) {
    const card = cards[i];
    try {
      const btn = page.locator(DETAILS_BTN).nth(i);
      await btn.scrollIntoViewIfNeeded();
      await btn.evaluate((el) => el.click());
      await page.locator(DIALOG).first().waitFor({ state: 'visible', timeout: 10000 });
      // content-ready signal instead of a fixed sleep: wait for the FB Ad
      // Library link (proves the overview panel populated), fall back fast.
      await page
        .locator(`${DIALOG} a[href*="facebook.com/ads/library"]`)
        .first()
        .waitFor({ state: 'attached', timeout: 4000 })
        .catch(() => {});

      const modal = (await readModalFields(page)) || {};
      stats.processed += 1;

      const media_id = modal.media_id || card.gethook_id;
      if (!media_id) {
        warn('NATIVE', `[${i + 1}/${target}] no media_id — skipping`);
        stats.skipped += 1;
        await closeDialog(page);
        continue;
      }
      if (seen.has(media_id)) {
        await closeDialog(page);
        continue;
      }
      seen.add(media_id);

      let image_stored_url = null;
      if (WITH_IMAGES && card.image_url) {
        const buf = await downloadImage(card.image_url);
        if (buf) {
          image_stored_url = await uploadAdImage(media_id, buf);
          stats.images += 1;
        }
      }

      await upsertNativeAd({
        media_id,
        ad_url: modal.ad_url,
        source_board_id: SOURCE_BOARD_ID,
        creator_name: card.creator_name,
        creator_url: card.creator_url,
        headline: card.headline,
        primary_text_copy: card.primary_text_copy,
        saved_date: modal.saved_date,
        active_period: modal.active_period || card.date_range,
        niche: modal.niche,
        cta_type: modal.cta_type || card.cta_type,
        landing_page: card.landing_page,
        image_url: card.image_url,
        image_stored_url,
      });
      stats.saved += 1;
      log(
        'NATIVE',
        `[${i + 1}/${target}] ${media_id} "${(card.headline || '').slice(0, 38)}" copy:${(card.primary_text_copy || '').length}ch`
      );
      await closeDialog(page);
    } catch (e) {
      stats.errors += 1;
      error('NATIVE', `[${i + 1}/${target}] error: ${e.message}`);
      await closeDialog(page).catch(() => {});
    }
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const perAd = stats.processed ? (secs / stats.processed).toFixed(2) : '—';
  console.log('\n----- NATIVE SUMMARY -----');
  console.log(JSON.stringify({ ...stats, seconds: Number(secs), perAd: Number(perAd), projected100: Math.round(perAd * 100) + 's' }, null, 2));

  if (INSPECT) {
    log('NATIVE', 'inspect: browser open 20s');
    await sleep(20000);
  }
  await context.close();
}

process.on('SIGINT', async () => {
  console.log('\n[CLOSE] Interrupt — closing browser...');
  if (context) await context.close();
  process.exit(0);
});

main().catch((err) => {
  error('FATAL', err.stack || err.message);
  process.exit(1);
});
