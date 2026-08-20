'use strict';

/**
 * src/scraper/ads.js
 *
 * Phase 3: ad detection only. Given an already-open GetHook brand detail
 * page (see src/scraper/navigation.js), detects every currently-rendered
 * ad card and logs a short summary for each. Does not click into an ad,
 * open anything, or read a transcript — detection only.
 *
 * Selectors were grounded by live DOM inspection of a real brand page
 * (https://app.gethookd.ai/brands/{id}), not guessed:
 *
 *   - Ad list container: data-testid="virtuoso-item-list". The list is
 *     rendered by react-virtuoso, a virtualized list — only ads currently
 *     scrolled into view exist in the DOM at all. That means querying
 *     ad-card elements directly already gives "every visible ad card"
 *     with no extra visibility filtering needed.
 *   - Each ad: data-testid="ad-card".
 *   - Title/headline: data-testid="title" inside the card.
 *   - Duration: the burned-in time overlay text inside
 *     data-testid="media" (e.g. "1:30") — there is no separate
 *     structured duration field, this overlay text is the only source.
 *   - Stable identifier: the numeric id embedded in the thumbnail/video
 *     src URL (".../ads_media/<id>/..."), the only per-ad stable
 *     identifier found on the card. There is no per-ad platform badge in
 *     the markup (this tool appears to track Meta/Facebook Ads Library
 *     data exclusively), so platform isn't reported.
 */

const { log } = require('../browser/logger');

const FIRST_CARD_TIMEOUT_MS = 15000;
const MEDIA_ID_PATTERN = /ads_media\/(\d+)\//;

/**
 * Synchronization: wait on the ad card itself, not its container.
 *
 * The container (data-testid="virtuoso-item-list") mounts as soon as the
 * brand page's react-virtuoso list component mounts, independent of
 * whether the underlying ad data has actually arrived from the API yet —
 * so waiting for the container to be visible proved insufficient; it can
 * be visible and still empty. The thing this function actually depends on
 * is at least one ad card existing, so that's the only thing it waits for.
 */
async function detectAds(page) {
  const cards = page.getByTestId('ad-card');
  await cards.first().waitFor({ state: 'visible', timeout: FIRST_CARD_TIMEOUT_MS });

  const count = await cards.count();
  log('ADS', `Detected ${count} visible ad card(s).`);

  const summaries = [];
  for (let i = 0; i < count; i++) {
    const card = cards.nth(i);

    const title = await card
      .getByTestId('title')
      .first()
      .textContent()
      .then((t) => t?.trim() || null)
      .catch(() => null);

    const duration = await card
      .getByTestId('media')
      .first()
      .textContent()
      .then((t) => t?.trim() || null)
      .catch(() => null);

    const mediaSrc = await card
      .getByTestId('media')
      .locator('img, video')
      .first()
      .getAttribute('src')
      .catch(() => null);
    const mediaId = mediaSrc ? (mediaSrc.match(MEDIA_ID_PATTERN)?.[1] ?? null) : null;

    summaries.push({ index: i, mediaId, title, duration });
    log(
      'ADS',
      `[${i}] mediaId=${mediaId ?? 'unknown'} title="${title ?? 'unknown'}" duration=${duration ?? 'unknown'}`
    );
  }

  return summaries;
}

module.exports = { detectAds };
