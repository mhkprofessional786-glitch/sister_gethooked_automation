'use strict';

const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

module.exports = {
  TARGET_URL: 'https://app.gethookd.ai',

  // Standard macOS install path for the Chrome app itself (not a profile).
  CHROME_APP_PATH: '/Applications/Google Chrome.app',

  // Dedicated, project-local automation profile. Fully isolated from the
  // user's personal Chrome profile — nothing is ever read from or copied
  // into it from outside this project.
  PROFILE_DIR: path.join(PROJECT_ROOT, '.playwright-profile'),

  // How long to wait for the window "load" event (all initial sub-resources
  // fetched) before giving up and treating the page as interactive anyway.
  // GetHook keeps a websocket/long-poll connection open indefinitely for
  // live updates, but that traffic does not block "load", so this should
  // normally resolve in a couple of seconds.
  LOAD_EVENT_TIMEOUT_MS: 15000,

  // Brand to search for when none is given on the command line.
  DEFAULT_BRAND_NAME: 'ryze',
};
