'use strict';

/**
 * src/config.js
 *
 * Single home for collection-tunable values, so changing them later
 * doesn't mean editing scraper logic. Modules that need one of these
 * import this file directly rather than having the value threaded down
 * through function parameters from launch.js.
 */

module.exports = {
  maxAds: 100,

  filters: {
    // Empty = no constraint on that dimension (see src/scraper/filters.js).
    country: 'US',
    language: 'en',
    format: 'video',
    // Sort order for the ad list. Empty = leave GetHook's default sort, which
    // is "Most impressions" — so an empty value already gives impressions-first
    // ordering. Set this only to force a non-default sort; the URL param it maps
    // to is applied in src/scraper/filters.js.
    sort: '',
  },

  collection: {
    continueOnError: true,
    deduplicateByMediaId: true,
  },
};
