'use strict';

/**
 * Manages the lifecycle of the dedicated automation Chrome profile
 * (.playwright-profile/). This module never reads from or writes to the
 * user's personal Chrome profile — it only ever touches its own directory.
 */

const fs = require('fs');
const path = require('path');
const { PROFILE_DIR, CHROME_APP_PATH } = require('./config');
const { log, warn, error } = require('./logger');

function verifyChromeIsInstalled() {
  log('CHROME', `Looking for Google Chrome at: ${CHROME_APP_PATH}`);
  if (!fs.existsSync(CHROME_APP_PATH)) {
    error(
      'CHROME',
      `Google Chrome was not found at "${CHROME_APP_PATH}". ` +
        'Install it from https://www.google.com/chrome/ and try again.'
    );
    process.exit(1);
  }
  log('CHROME', 'Google Chrome installation found.');
}

function profileExists() {
  return fs.existsSync(PROFILE_DIR) && fs.readdirSync(PROFILE_DIR).length > 0;
}

/**
 * Creates the automation profile directory if it doesn't exist yet.
 * Logs which case happened, since an existing directory is a hint (not a
 * guarantee) that a session is already saved — session.js confirms that
 * by inspecting the actual page.
 */
function ensureProfileDir() {
  const existedBefore = profileExists();
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  if (existedBefore) {
    log('PROFILE', `Existing automation profile found at: ${PROFILE_DIR}`);
  } else {
    log('PROFILE', `No automation profile found. Creating a new one at: ${PROFILE_DIR}`);
  }
}

function warnIfLocked() {
  // Only relevant if a previous automation run crashed without closing
  // cleanly and left a stale lock behind in OUR profile directory.
  const lockPath = path.join(PROFILE_DIR, 'SingletonLock');
  if (fs.existsSync(lockPath)) {
    warn(
      'PROFILE',
      'The automation profile looks locked, likely from a previous run that ' +
        'did not close cleanly. If launch fails below, make sure no leftover ' +
        'automation Chrome process is still running, then try again.'
    );
  }
}

function resetProfile() {
  log('PROFILE', 'Resetting automation profile (--reset-profile flag detected)...');
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  log('PROFILE', 'Automation profile cleared. You will need to log in again on the next run.');
}

module.exports = {
  verifyChromeIsInstalled,
  ensureProfileDir,
  warnIfLocked,
  resetProfile,
};
