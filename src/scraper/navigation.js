'use strict';

/**
 * src/scraper/navigation.js
 *
 * Phase 2: navigation only. Given an already-open, already-authenticated
 * GetHook page (see src/browser/launch.js + src/browser/session.js), drives
 * the UI from the Explore screen to a specific brand's detail page:
 *
 *   click "Brands" tab -> wait for it to render -> search by name
 *   -> wait for results -> click the first match -> stop.
 *
 * This module does not launch the browser, does not manage the session,
 * and does not extract any brand/transcript data — that's a later phase.
 *
 * Every locator below is grounded in GetHook's actual markup (inspected
 * live against https://app.gethookd.ai), not guessed. See the comment on
 * each function for why that specific locator was chosen.
 */

const { log, warn } = require('../browser/logger');

const ACTION_TIMEOUT_MS = 15000;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

// How long to give the Brands page a chance to open after a single click,
// and how many times to retry the click if it doesn't. See clickBrandsTab().
const CLICK_VERIFY_TIMEOUT_MS = 5000;
const CLICK_VERIFY_ATTEMPTS = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `fn`, retrying on failure. Playwright locator actions already retry
 * their own actionability checks (visible/enabled/stable) internally up to
 * their timeout, but that doesn't cover transient SPA hiccups where the
 * element itself doesn't exist yet (e.g. a route transition that briefly
 * unmounts and remounts the search box). This adds a coarser, step-level
 * retry on top of that for exactly those cases.
 */
async function withRetries(stepName, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      warn('NAV', `${stepName} failed (attempt ${attempt}/${RETRY_ATTEMPTS}): ${err.message}`);
      if (attempt < RETRY_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  throw new Error(`${stepName} failed after ${RETRY_ATTEMPTS} attempts: ${lastErr.message}`);
}

/**
 * Click the "Brands" tab.
 *
 * Selector: getByRole('tab', { name: 'Brands', exact: true }).
 * GetHook renders the Explore Ads / Brands switcher as
 * <button role="tab">Brands</button>. Role + accessible name is what a
 * real user (or screen reader) uses to identify the control, so it keeps
 * working across Tailwind class or DOM-structure changes that would break
 * a CSS-class or nth-child selector. `exact: true` avoids accidentally
 * matching an unrelated control whose label merely contains "Brands"
 * (e.g. the sidebar's "Brand Spy" item).
 *
 * Synchronization: this waits only on elements — never on the URL or on
 * any notion of "the SPA has finished loading." Two elements matter here:
 * the tab itself (visible + enabled, so it's safe to click) and the
 * "Search brands" combobox that only exists once the Brands page has
 * actually opened (so we can tell the click actually worked).
 *
 * That second check exists because the tab is clickable — and clicking it
 * does start a route change — even while GetHook is still running its own
 * one-time post-login redirect. When that redirect fires after our click,
 * it silently overwrites our navigation and we land back on the default
 * Explore/Ads route instead of Brands, with no error thrown. Since the tab
 * element itself looks identical (visible, enabled) whether or not that
 * race happens, waiting on the tab alone can't detect it. So this makes
 * the click idempotent instead: click, verify the Brands page actually
 * opened by waiting (briefly) for the search combobox, and if it didn't
 * show up, assume the click got overwritten and click again — bounded to
 * a small number of attempts so a genuine failure still surfaces as an
 * error rather than hanging.
 */
async function clickBrandsTab(page) {
  const tab = page.getByRole('tab', { name: 'Brands', exact: true });
  const searchBox = page.getByRole('combobox', { name: 'Search brands', exact: true });

  log('NAV', 'Waiting for the "Brands" tab to be visible and enabled...');
  await tab.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  await waitForEnabled(tab);

  for (let attempt = 1; attempt <= CLICK_VERIFY_ATTEMPTS; attempt++) {
    log('NAV', `Clicking the "Brands" tab (attempt ${attempt}/${CLICK_VERIFY_ATTEMPTS})...`);
    await tab.click({ timeout: ACTION_TIMEOUT_MS });

    const opened = await searchBox
      .waitFor({ state: 'visible', timeout: CLICK_VERIFY_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);

    if (opened) {
      log('NAV', 'Brands tab click confirmed — search box is visible.');
      return;
    }

    warn(
      'NAV',
      `Brands page did not open after the click (attempt ${attempt}/${CLICK_VERIFY_ATTEMPTS}); ` +
        "GetHook's own routing likely overwrote it. Retrying the click."
    );
  }

  throw new Error(
    `Clicking the "Brands" tab did not open the Brands page after ${CLICK_VERIFY_ATTEMPTS} attempts.`
  );
}

/**
 * Polls a locator's isEnabled() until true or timeout. Playwright's own
 * click() already waits for the element to be enabled as part of its
 * actionability checks, but requirement here is to make "wait for the
 * element needed for the next action" an explicit, separate step rather
 * than an implicit side effect of click().
 */
async function waitForEnabled(locator, timeoutMs = ACTION_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await locator.isEnabled()) return;
    await sleep(100);
  }
  throw new Error('Element did not become enabled in time.');
}

/**
 * Wait for the Brands page to finish rendering and return the search box.
 *
 * Signal: visibility of getByRole('combobox', { name: 'Search brands' }).
 * Clicking the Brands tab is a client-side route change (URL becomes
 * /explore/brands) with no full page navigation, so there's no "load"
 * event to wait on, and 'networkidle' is unusable here for the same reason
 * it's unusable in src/browser/launch.js (GetHook keeps a long-lived
 * connection open). The search box is the one element guaranteed to exist
 * once the Brands screen has actually mounted, making it a reliable proxy
 * for "rendered" — stronger than a fixed sleep and immune to network
 * timing.
 */
async function waitForBrandsPageReady(page) {
  log('NAV', 'Waiting for the Brands page to finish rendering...');
  const searchBox = page.getByRole('combobox', { name: 'Search brands', exact: true });
  await searchBox.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  log('NAV', 'Brands page rendered — search box is visible.');
  return searchBox;
}

/**
 * Type the brand name into the search box.
 *
 * Selector: the same combobox from waitForBrandsPageReady(). The input is
 * a proper ARIA combobox (role="combobox", aria-label="Search brands",
 * aria-controls -> the results listbox), which is how GetHook itself
 * declares the control's purpose — targeting it by role + accessible name
 * tracks that contract rather than an incidental DOM id.
 */
async function searchForBrand(page, searchBox, brandName) {
  log('NAV', `Searching for brand: "${brandName}"...`);
  await withRetries('Type brand search query', async () => {
    await searchBox.click({ timeout: ACTION_TIMEOUT_MS });
    await searchBox.fill(brandName, { timeout: ACTION_TIMEOUT_MS });
  });
}

/**
 * Wait for search results to settle, and return the options locator.
 *
 * Selectors: getByRole('option') for results, getByText(/No brands found/i)
 * for the empty state. GetHook's search results render inside
 * role="listbox" as role="option" rows — again the ARIA combobox contract,
 * stable across styling changes.
 *
 * The tricky part: the listbox stays mounted and visible even with zero
 * results (it shows a "No brands found for '<query>'" message instead of
 * options), so waiting for the listbox alone can't distinguish "still
 * loading" from "confirmed no matches." We race "at least one option
 * appeared" against "the empty-state message appeared" so a genuine
 * zero-result search fails fast with a clear error instead of silently
 * hanging for the full timeout. If neither shows up in time (e.g. the
 * search request itself stalls), that's also reported as a distinct,
 * readable error.
 */
async function waitForSearchResults(page, brandName) {
  log('NAV', 'Waiting for search results...');

  const firstOption = page.getByRole('option').first();
  const emptyState = page.getByText(/No brands found/i);

  const outcome = await Promise.race([
    firstOption.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS }).then(() => 'results'),
    emptyState.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS }).then(() => 'empty'),
  ]).catch(() => 'timeout');

  if (outcome === 'empty') {
    throw new Error(`No brands found for "${brandName}".`);
  }
  if (outcome === 'timeout') {
    throw new Error(
      `Timed out after ${ACTION_TIMEOUT_MS}ms waiting for search results for "${brandName}".`
    );
  }

  const options = page.getByRole('option');
  const count = await options.count();
  log('NAV', `Search results ready: ${count} match(es) found.`);
  return options;
}

/**
 * Normalize a brand label for comparison: lowercase, collapse internal
 * whitespace, trim. Deliberately does NOT strip accents so "Frøya" only
 * matches "Frøya", never a differently-spelled brand.
 */
function normalizeName(s) {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Click the search result whose NAME matches the brand we searched for,
 * then wait for the resulting brand detail page to load.
 *
 * Why not simply options.first(): GetHook's results are grouped, and a
 * "YOUR BRANDS" (already-spied) entry can be listed above the brand you
 * actually searched for. Observed live: searching "Frøya Organics" returns
 * "Norse Organics" (YOUR BRANDS) as the first option and "Frøya Organics"
 * (DISCOVER BRANDS) second — clicking the first row would scrape the wrong
 * brand entirely. So we read each option's name (the first line of its
 * text) and pick the closest match to `brandName`:
 *   1. exact normalized name equality,
 *   2. else an option whose name contains the query (or vice-versa),
 *   3. else fall back to the first option (with a warning) so an
 *      approximate-but-unambiguous search like "ryze" still works.
 *
 * Clicking triggers a client-side route to /brands/{id}, confirmed via
 * waitForURL rather than a load-state wait, since (as above) this app
 * doesn't reliably fire full navigation/network-idle events on client-side
 * routing.
 */
async function clickFirstResult(page, options, brandName) {
  const count = await options.count();
  const target = normalizeName(brandName);

  const labels = [];
  for (let i = 0; i < count; i++) {
    const text = await options.nth(i).innerText().catch(() => '');
    labels.push(normalizeName(text.split('\n')[0]));
  }

  let chosenIndex = labels.findIndex((name) => name === target);
  if (chosenIndex === -1) {
    chosenIndex = labels.findIndex(
      (name) => name && (name.includes(target) || target.includes(name))
    );
  }
  if (chosenIndex === -1) {
    warn(
      'NAV',
      `No result name matched "${brandName}" among [${labels.join(' | ')}]; ` +
        'falling back to the first result.'
    );
    chosenIndex = 0;
  } else if (chosenIndex !== 0) {
    log(
      'NAV',
      `Skipping earlier result(s) [${labels.slice(0, chosenIndex).join(' | ')}] ` +
        `to click the name-matched brand at position ${chosenIndex + 1}.`
    );
  }

  const chosen = options.nth(chosenIndex);
  const label = labels[chosenIndex] || brandName;
  log('NAV', `Clicking matching brand: "${label}"...`);

  await withRetries('Click brand result', async () => {
    await chosen.click({ timeout: ACTION_TIMEOUT_MS });
  });

  await page.waitForURL(/\/brands\/\d+/, { timeout: ACTION_TIMEOUT_MS });
  log('NAV', `Navigated to brand page: ${page.url()}`);
}

/**
 * Direct-URL alternative to navigateToBrand: skip the Brands search entirely
 * and go straight to a brand's detail page by its URL.
 *
 * Why this exists: GetHook's search typeahead intermittently fails to surface
 * a brand that unquestionably exists (observed with "AuraMalibu" — the
 * dropdown returned "No brands found" while the brand list table below it
 * showed the brand with 3,370 saved ads). When that happens there is no
 * dropdown option to click, so navigateToBrand can't reach the brand at all.
 * Pasting the brand's own /brands/{id} URL sidesteps the broken typeahead:
 * the destination is identical to what clicking the result would have loaded.
 *
 * This does NOT bypass any real work — applyBrandFilters (the next step) is
 * already fully URL-driven and layers its filter params onto whatever brand
 * URL we land on, so a direct navigation here feeds it exactly what a search
 * click would have. Assumes the session is already authenticated (launch.js
 * runs ensureLoggedIn before navigation), so the goto lands on the brand page
 * rather than being bounced to login.
 */
async function navigateToBrandByUrl(page, brandUrl) {
  if (!brandUrl || !brandUrl.trim()) {
    throw new Error('navigateToBrandByUrl requires a non-empty URL.');
  }
  if (!/\/brands\/\d+/.test(brandUrl)) {
    throw new Error(
      `"${brandUrl}" does not look like a GetHook brand URL (expected .../brands/{id}).`
    );
  }

  log('NAV', `Direct navigation to brand URL: ${brandUrl}`);
  await page.goto(brandUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(/\/brands\/\d+/, { timeout: ACTION_TIMEOUT_MS });
  log('NAV', `On brand page: ${page.url()}`);
  return page;
}

/**
 * Full Phase 2 flow: from an already-open, already-authenticated GetHook
 * page, go to Brands, search for `brandName`, and click the first matching
 * result. Leaves the caller on the resulting brand detail page. Does not
 * extract any data from it.
 */
async function navigateToBrand(page, brandName) {
  if (!brandName || !brandName.trim()) {
    throw new Error('navigateToBrand requires a non-empty brand name.');
  }

  await clickBrandsTab(page);
  const searchBox = await waitForBrandsPageReady(page);
  await searchForBrand(page, searchBox, brandName);
  const options = await waitForSearchResults(page, brandName);
  await clickFirstResult(page, options, brandName);

  log('NAV', 'Navigation complete.');
  return page;
}

module.exports = { navigateToBrand, navigateToBrandByUrl };
