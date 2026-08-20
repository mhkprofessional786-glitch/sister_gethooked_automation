'use strict';

/**
 * src/scraper/details.js
 *
 * Phase 4: open (not scrape) an ad's Details panel. Given an already-open
 * GetHook brand page with ads already detected (see src/scraper/ads.js),
 * clicks a given ad card's "Details" button and verifies the resulting
 * panel actually opened. Does not read anything out of the panel, does
 * not click its Transcript tab, and does not analyze anything — this
 * phase only opens, and (for Phase 8's multi-ad loop) closes, the panel.
 */

const { log } = require('../browser/logger');

const ACTION_TIMEOUT_MS = 15000;

/**
 * Click a given ad card's "Details" button and verify the panel that
 * opens.
 *
 * Button selector: getByTestId('cta-details') scoped to the given ad
 * card. This data-testid was grounded during Phase 3's DOM inspection
 * (src/scraper/ads.js) — every ad card contains exactly one
 * data-testid="cta-details" <button>Details</button>.
 *
 * Verification: getByRole('dialog', { name: 'Ad Details' }). GetHook's UI is built on shadcn/Radix
 * primitives (evident from the data-slot="card"/"button"/"badge"
 * attributes seen on every element inspected so far). Radix's
 * Dialog/Sheet/Drawer components — the whole family used for panels like
 * this — render role="dialog" (plus aria-modal) on their content once
 * open, as their standard accessibility contract. That makes it a robust
 * signal tied to the component family's ARIA behavior rather than to any
 * one CSS class or DOM layout, so it survives markup/styling churn.
 * Waiting on the click alone would only prove the button was clicked, not
 * that a panel actually opened; requiring a role="dialog" element to
 * become visible proves the latter.
 *
 * The accessible name filter ({ name: 'Ad Details' }) is required, not
 * optional, because the page also renders an unrelated role="dialog"
 * element for a support chat widget (accessible name "Chat window") —
 * confirmed live, an unscoped getByRole('dialog') throws a strict-mode
 * violation once that widget is present. The dialog's own visible title
 * ("Ad Details") is what supplies this accessible name via
 * aria-labelledby, so it's tied to the panel's own markup, not a guess.
 */
async function openAdDetails(page, card) {
  await card.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });

  const detailsButton = card.getByTestId('cta-details');
  await detailsButton.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });

  log('DETAILS', 'Clicking "Details" on the ad card...');
  await detailsButton.click({ timeout: ACTION_TIMEOUT_MS });

  const panel = page.getByRole('dialog', { name: 'Ad Details' });
  await panel.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  log('DETAILS', 'Details panel confirmed open (role="dialog", name="Ad Details" is visible).');

  return panel;
}

/**
 * Convenience wrapper preserving the original single-ad behavior: opens
 * Details for the first visible ad card.
 */
async function openFirstAdDetails(page) {
  return openAdDetails(page, page.getByTestId('ad-card').first());
}

/**
 * Closes an open Details dialog via Escape — the standard, built-in way
 * Radix Dialog closes, so this doesn't depend on locating a specific
 * close-button implementation. Verifies the dialog actually disappears
 * rather than assuming the keypress worked.
 */
async function closeAdDetails(page, dialog) {
  log('DETAILS', 'Closing Details panel...');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: ACTION_TIMEOUT_MS });
  log('DETAILS', 'Details panel closed.');
}

module.exports = { openAdDetails, openFirstAdDetails, closeAdDetails };
