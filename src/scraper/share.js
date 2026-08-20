'use strict';

/**
 * src/scraper/share.js
 *
 * Phase 7: capture the Share URL for an ad. Given the already-open
 * Details dialog (see src/scraper/details.js) with a transcript already
 * extracted (see src/scraper/extract.js), clicks the Share button once,
 * reads the resulting clipboard content via the browser's Clipboard API,
 * and verifies it's a real GetHook ad URL — never assuming the click
 * alone succeeded. Does not export anything, does not iterate ads, does
 * not touch the transcript.
 */

const { log, error } = require('../browser/logger');

const ACTION_TIMEOUT_MS = 15000;
const CLIPBOARD_POLL_INTERVAL_MS = 150;
const CLIPBOARD_POLL_TIMEOUT_MS = 5000;
const CLIPBOARD_SENTINEL = '__GETHOOK_SHARE_PENDING__';

// Selector confirmed by live DOM inspection: a native
// <button aria-label="Share ad"> in the Details dialog toolbar. A real
// aria-label on a native <button> is a reliable accessible-name source
// (unlike the timestamps switch, which had none), so role+name is used
// directly rather than any structural workaround.
const SHARE_BUTTON_ROLE = 'button';
const SHARE_BUTTON_NAME = 'Share ad';

function isValidHttpUrl(candidate) {
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function belongsToHost(candidate, hostSuffix) {
  const { hostname } = new URL(candidate);
  return hostname === hostSuffix || hostname.endsWith(`.${hostSuffix}`);
}

/**
 * Clicks the Share button in the given Details dialog exactly once, reads
 * the clipboard via the real browser Clipboard API, verifies the result,
 * prints a report, and returns the copied URL.
 */
async function captureShareUrl(context, page, dialog) {
  const currentUrl = page.url();
  const currentOrigin = new URL(currentUrl).origin;
  // e.g. "app.gethookd.ai" -> "gethookd.ai", so subdomains other than
  // "app" (a share link might use a different one) are still accepted.
  const hostSuffix = new URL(currentUrl).hostname.replace(/^app\./, '');

  // Grant only the two clipboard permissions this operation needs, scoped
  // to the current origin — not a blanket grant of unrelated permissions.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: currentOrigin });

  const shareButton = dialog.getByRole(SHARE_BUTTON_ROLE, { name: SHARE_BUTTON_NAME });
  await shareButton.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });

  await page.evaluate((s) => navigator.clipboard.writeText(s), CLIPBOARD_SENTINEL);

  log('SHARE', 'Clicking "Share ad" once...');
  // Dispatch the click directly on the DOM element rather than at screen
  // coordinates — a third-party Crisp support-chat widget can overlay
  // the button and intercept coordinate-based clicks even with force:true.
  await shareButton.evaluate((el) => el.click());

  const deadline = Date.now() + CLIPBOARD_POLL_TIMEOUT_MS;
  let clipboard = '';
  while (Date.now() < deadline) {
    const raw = await page.evaluate(() => navigator.clipboard.readText());
    clipboard = (raw || '').trim();
    if (clipboard && clipboard !== CLIPBOARD_SENTINEL) break;
    await new Promise((r) => setTimeout(r, CLIPBOARD_POLL_INTERVAL_MS));
  }

  const nonEmpty = clipboard.length > 0;
  const isUrl = nonEmpty && isValidHttpUrl(clipboard);
  const onExpectedHost = isUrl && belongsToHost(clipboard, hostSuffix);
  const validated = nonEmpty && isUrl && onExpectedHost;
  const differsFromCurrent = clipboard !== currentUrl;

  const selectorDescription = `dialog.getByRole('${SHARE_BUTTON_ROLE}', { name: '${SHARE_BUTTON_NAME}' })`;

  log('SHARE', `Selector used: ${selectorDescription}`);
  log('SHARE', `Clipboard contents: "${clipboard}"`);
  log('SHARE', `Current page URL: "${currentUrl}"`);
  log('SHARE', `Clipboard ${differsFromCurrent ? 'differs from' : 'matches'} the current page URL.`);
  log(
    'SHARE',
    `URL validation — non-empty: ${nonEmpty}, valid URL: ${isUrl}, on host "${hostSuffix}": ${onExpectedHost}, overall: ${validated}.`
  );

  if (!nonEmpty) {
    error('SHARE', 'Clipboard is empty after clicking Share — the click may not have copied anything.');
    throw new Error('Clipboard is empty after clicking Share.');
  }
  if (!validated) {
    error('SHARE', `Clipboard content did not pass URL validation: "${clipboard}"`);
    throw new Error(`Clipboard content did not pass URL validation: "${clipboard}"`);
  }

  console.log('SHARE URL:', clipboard);

  return clipboard;
}

module.exports = { captureShareUrl };
