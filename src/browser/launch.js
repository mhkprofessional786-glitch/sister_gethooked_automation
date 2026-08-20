'use strict';

/**
 * src/browser/launch.js
 *
 * Entry point: launches the real, installed Google Chrome (not Playwright's
 * bundled Chromium) using a persistent context bound to a dedicated
 * automation profile at .playwright-profile/. That profile is fully
 * isolated from the user's personal Chrome profile — this script never
 * reads from or copies the user's real profile — so the user's everyday
 * Chrome can stay open and running throughout.
 *
 * Flow: launch browser -> navigate to brand -> apply filters -> collect
 * ads -> export JSON -> print summary -> close browser (or wait for
 * Enter first, if --inspect was passed).
 *
 * Flags:
 *   --reset-profile   Wipe the saved automation profile before launching,
 *                      forcing a fresh manual login.
 *   --inspect         Keep the browser open (waiting for Enter) after the
 *                      run finishes, instead of closing automatically.
 *                      Normal runs close and exit without any pause.
 *   --url=<brandUrl>  Skip the Brands search and go straight to this brand
 *                      detail URL (.../brands/{id}). Use when GetHook's
 *                      typeahead fails to surface a brand that exists.
 *                      brandName is still required/used for storage & export.
 *
 * Usage:
 *   node src/browser/launch.js [brandName] [--inspect] [--reset-profile]
 *   node src/browser/launch.js "AuraMalibu" --url=https://app.gethookd.ai/brands/4373083
 *
 *   brandName defaults to config.DEFAULT_BRAND_NAME when omitted.
 */

const { chromium } = require('playwright');
const { PROFILE_DIR, TARGET_URL, LOAD_EVENT_TIMEOUT_MS, DEFAULT_BRAND_NAME } = require('./config');
const { log, warn, error } = require('./logger');
const {
  verifyChromeIsInstalled,
  ensureProfileDir,
  warnIfLocked,
  resetProfile,
} = require('./profileManager');
const { ensureLoggedIn } = require('./session');
const { askQuestion } = require('./prompt');
const { navigateToBrand, navigateToBrandByUrl } = require('../scraper/navigation');
const { collectAdsForBrand } = require('../scraper/collect');
const { applyBrandFilters } = require('../scraper/filters');
const { exportAdsToJson } = require('../export/json');
// Imported only for the startup report below — collect.js and filters.js
// each read the values they actually need directly from ../config
// themselves, rather than having them threaded through here.
const { maxAds, filters: filterConfig } = require('../config');

// Separates "--flag"-style switches from the positional brand name
// argument, so they can appear in any order on the command line. Flags may
// be bare ("--inspect") or carry a value ("--url=https://..."); the value is
// kept with the flag string and pulled out later via getFlagValue.
function parseArgs(argv) {
  const flags = new Set();
  const positional = [];
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      flags.add(arg);
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

// Returns the value of a "--name=value" flag, or null if absent.
function getFlagValue(flags, name) {
  for (const flag of flags) {
    if (flag.startsWith(`${name}=`)) return flag.slice(name.length + 1);
  }
  return null;
}

const { flags, positional } = parseArgs(process.argv.slice(2));
const brandName = positional[0] || DEFAULT_BRAND_NAME;
const inspectMode = flags.has('--inspect');
// Optional direct brand URL. When present, skip the Brands search entirely
// and navigate straight to this page — used when GetHook's typeahead fails to
// surface a brand that exists (see navigateToBrandByUrl). brandName is still
// required/used for storage, export, and Supabase; the URL only changes HOW
// we reach the brand page, not what it's filed under.
const brandUrl = getFlagValue(flags, '--url');

// Module-level so the SIGINT handler can reach it for a graceful shutdown.
let context;

async function launchBrowser() {
  verifyChromeIsInstalled();

  if (flags.has('--reset-profile')) {
    resetProfile();
  }

  ensureProfileDir();
  warnIfLocked();

  log('LAUNCH', 'Launching Google Chrome with the automation profile...');
  log('LAUNCH', `Profile dir: ${PROFILE_DIR}`);

  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: 'chrome', // Use the real installed Chrome binary, not Playwright's Chromium.
      headless: false,
      // Playwright appends --no-sandbox to the Chrome command line by
      // default unless chromiumSandbox is explicitly true. --no-sandbox is
      // only needed on root/containerized Linux hosts that can't set up the
      // SUID sandbox; on macOS the OS sandbox works normally. Leaving it on
      // also makes Chrome show an "unsupported command-line flag" warning
      // infobar, which overlays the page and blocks clicks until dismissed
      // — that's the greyed-out/unresponsive page. Opting into the sandbox
      // avoids both the unnecessary flag and the blocking infobar.
      chromiumSandbox: true,
    });
  } catch (err) {
    error('LAUNCH', `Failed to launch Chrome: ${err.message}`);
    process.exit(1);
  }

  log('LAUNCH', 'Chrome launched successfully. Your personal Chrome profile was not touched.');
}

async function main() {
  console.log('Loaded configuration:');
  console.log(`  maxAds:   ${maxAds}`);
  console.log(`  country:  ${filterConfig.country || '(none)'}`);
  console.log(`  language: ${filterConfig.language || '(none)'}`);
  console.log(`  format:   ${filterConfig.format}`);
  console.log(`  sort:     ${filterConfig.sort || '(default: most impressions)'}`);

  await launchBrowser();

  const page = context.pages()[0] || (await context.newPage());

  page.on('domcontentloaded', () =>
    log('NAVIGATE', 'DOMContentLoaded fired — initial HTML parsed.')
  );
  page.on('load', () => log('NAVIGATE', 'Load event fired — initial sub-resources loaded.'));

  log('NAVIGATE', `Navigation starting: ${TARGET_URL}`);
  // GetHook keeps a long-lived connection open (websocket/polling for live
  // updates), so the network never goes idle and waitUntil: 'networkidle'
  // hangs until Playwright's navigation timeout. 'domcontentloaded' only
  // waits for the initial HTML to parse, which is enough for a modern SPA
  // shell to start mounting.
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });

  try {
    await page.waitForLoadState('load', { timeout: LOAD_EVENT_TIMEOUT_MS });
  } catch {
    warn(
      'NAVIGATE',
      `Load event did not fire within ${LOAD_EVENT_TIMEOUT_MS}ms; continuing anyway.`
    );
  }
  log('NAVIGATE', 'Page is interactive.');

  await ensureLoggedIn(page);

  log('BRAND', `Using brand: "${brandName}"`);
  if (brandUrl) {
    log('BRAND', `Direct URL provided — skipping Brands search: ${brandUrl}`);
    await navigateToBrandByUrl(page, brandUrl);
  } else {
    await navigateToBrand(page, brandName);
  }

  const filterResult = await applyBrandFilters(page);
  log('BRAND', `Filters applied — ad card visible after refresh: ${filterResult.refreshed}`);

  const collectionStart = Date.now();
  const summary = await collectAdsForBrand(context, page, brandName);
  const collectionDurationMs = Date.now() - collectionStart;

  const exportedPath = exportAdsToJson(brandName, summary.ads);

  const successRate =
    summary.totalDiscovered > 0 ? (summary.totalProcessed / summary.totalDiscovered) * 100 : 0;

  console.log(`\nExported ${summary.ads.length} ad(s) to: ${exportedPath}`);
  console.log('First exported object:');
  console.log(JSON.stringify(summary.ads[0] ?? null, null, 2));

  console.log('\n----- SUMMARY -----');
  console.log(`Brand: ${brandName}`);
  console.log(`Ads discovered: ${summary.totalDiscovered}`);
  console.log(`Ads processed: ${summary.totalProcessed}`);
  console.log(`Errors: ${summary.totalErrors}`);
  console.log(`Skipped (backend transcription failed): ${summary.totalBackendFailures}`);
  console.log(`Saved to Supabase: ${summary.totalDbSaved}`);
  console.log(`Supabase errors: ${summary.totalDbErrors}`);
  console.log(`Success rate: ${successRate.toFixed(1)}%`);
  console.log(`JSON file path: ${exportedPath}`);
  console.log(`Collection duration: ${(collectionDurationMs / 1000).toFixed(1)}s`);

  if (inspectMode) {
    await askQuestion(
      '\n--inspect: browser is open and ready. Press Enter in this terminal to close it...\n'
    );
  } else {
    log('CLOSE', 'Run complete — closing browser automatically (pass --inspect to keep it open).');
  }

  log('CLOSE', 'Closing browser...');
  await context.close();
  log('CLOSE', 'Browser closed. Goodbye!');
}

// Ensure Ctrl+C also closes Chrome cleanly instead of leaving an orphaned process.
process.on('SIGINT', async () => {
  console.log('\n[CLOSE] Interrupt received, closing browser...');
  if (context) {
    await context.close();
  }
  process.exit(0);
});

main().catch((err) => {
  error('FATAL', err.stack || err.message);
  process.exit(1);
});
