'use strict';

/**
 * src/scraper/filters.js
 *
 * Phase 8.5: restrict the ad set to United States / English / Video
 * before discovery and collection begin, since the previous unfiltered
 * run showed most per-ad pipeline failures clustering on non-video
 * creatives (which have no Transcript tab at all).
 *
 * Implementation choice: GetHook's own Explore page already round-trips
 * filter state through the URL (observed earlier: navigating to
 * /explore lands on /explore?performance_scores=...&ads_per_brand_limit=4
 * once its filters resolve) — this app treats query params as the source
 * of truth for filter state, not just internal component state. That
 * makes navigating directly to a filtered URL a legitimate mechanism, not
 * a workaround, and it avoids depending on undiscovered dropdown/option
 * markup for three separate filter controls that would each need their
 * own selector guesswork without a prior DOM inspection pass.
 *
 * Candidate param names (location, languages, display_formats) are a
 * best-effort guess pending confirmation — this module logs the exact
 * before/after URL and whether an ad card became visible afterward, so
 * the one verification run itself is the evidence for whether this
 * actually took effect, not an assumption.
 */

const { log, warn } = require('../browser/logger');
const { filters } = require('../config');

const ACTION_TIMEOUT_MS = 15000;

async function applyBrandFilters(page) {
  const beforeUrl = page.url();
  const url = new URL(beforeUrl);

  // Each filter is optional: an empty/unset config value means "don't
  // constrain on this dimension." Actively delete the param in that case so
  // a value already present on the brand URL (e.g. location=US carried over
  // from navigation) doesn't silently keep filtering.
  const paramForFilter = [
    ['location', filters.country, 'Country'],
    ['languages', filters.language, 'Language'],
    ['display_formats', filters.format, 'Ad format'],
    // Sort order. Empty leaves GetHook's default sort ("Most impressions"), so
    // no param is set and the list already comes back impressions-first. The
    // exact param name/value for forcing a non-default sort is still to be
    // confirmed from a live URL; until then only the default (empty) path is
    // exercised. The guard below deletes any stale 'sort' param when empty.
    ['sort', filters.sort, 'Sort'],
  ];
  const applied = [];
  for (const [param, value, label] of paramForFilter) {
    if (value) {
      url.searchParams.set(param, value);
      applied.push(`${label}=${value}`);
    } else {
      url.searchParams.delete(param);
    }
  }
  const requestedUrl = url.toString();

  log('FILTERS', `Applying filters: ${applied.length ? applied.join(', ') : '(none)'}`);
  log('FILTERS', `Navigating to filtered URL: ${requestedUrl}`);
  await page.goto(requestedUrl, { waitUntil: 'domcontentloaded' });

  const refreshed = await page
    .getByTestId('ad-card')
    .first()
    .waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false);

  if (!refreshed) {
    warn('FILTERS', 'No ad card became visible after applying filters within the timeout.');
  }

  const afterUrl = page.url();
  log('FILTERS', `URL after filter navigation: ${afterUrl}`);
  log('FILTERS', `Query params retained: ${afterUrl === requestedUrl}`);

  return { beforeUrl, requestedUrl, afterUrl, refreshed };
}

module.exports = { applyBrandFilters };
