'use strict';

/**
 * Detects and establishes an authenticated GetHook session inside the
 * automation-controlled page. Because the browser context is persistent
 * (bound to .playwright-profile/), any cookies/local storage created by a
 * manual login are saved to disk by Chrome automatically — there is no
 * explicit "save session" step, and no manual login is required again on
 * future runs as long as the session stays valid.
 */

const { log, warn } = require('./logger');
const { askQuestion } = require('./prompt');
const { LOAD_EVENT_TIMEOUT_MS } = require('./config');

/**
 * Heuristic session check: an unauthenticated SPA session typically either
 * redirects to a /login-style URL or renders a login form with a password
 * field. Neither check depends on GetHook-specific internal markup.
 */
async function isLoggedOut(page) {
  const url = page.url();
  if (/\/(login|signin|sign-in)(\/|$|\?)/i.test(url)) {
    return true;
  }

  const passwordField = await page.$('input[type="password"]');
  return passwordField !== null;
}

/**
 * Ensures the page ends up authenticated, prompting for a manual login the
 * first time (or whenever the saved session has expired).
 */
async function ensureLoggedIn(page) {
  const loggedOut = await isLoggedOut(page);

  if (!loggedOut) {
    log('AUTH', 'Existing session found — reusing saved GetHook login.');
    return;
  }

  log('AUTH', 'No active session detected.');
  log('AUTH', 'Please log into GetHook in the browser window that just opened.');
  await askQuestion('\nPress Enter here once you have finished logging in...\n');

  // Same rationale as launch.js: GetHook's long-lived connection means
  // 'networkidle' never resolves. If the login redirected to a new page,
  // 'load' catches that; if login was a client-side SPA transition with no
  // full navigation, the state is already satisfied and this resolves
  // immediately.
  try {
    await page.waitForLoadState('load', { timeout: LOAD_EVENT_TIMEOUT_MS });
  } catch {
    warn(
      'AUTH',
      `Load event did not fire within ${LOAD_EVENT_TIMEOUT_MS}ms; continuing anyway.`
    );
  }

  if (await isLoggedOut(page)) {
    log(
      'AUTH',
      'Still unable to confirm login automatically — continuing anyway. ' +
        'Please verify manually in the browser window.'
    );
  } else {
    log('AUTH', 'Login detected. This session will be reused automatically on future runs.');
  }
}

module.exports = { ensureLoggedIn };
