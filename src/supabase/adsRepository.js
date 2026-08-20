'use strict';

/**
 * src/supabase/adsRepository.js
 *
 * Persists collected ads to Supabase (schema: supabase/migrations/), as a
 * side channel alongside the existing JSON export — it does not replace
 * or affect it. Uses the service_role client from src/supabase/client.js.
 *
 * Two upserts, matching the schema's unique constraints:
 *   - brands.name is unique, so upsertBrand is idempotent and safe to
 *     call once per brand per run rather than once per ad.
 *   - ads.media_id is unique, so upsertAd is how re-scraping the same ad
 *     later updates its row instead of creating a duplicate.
 */

const { supabase } = require('./client');

/**
 * Resolves a brand's id, inserting the brand row if it doesn't exist yet.
 * Intended to be called once per collection run (brand name is constant
 * across all ads in that run), not once per ad.
 */
async function upsertBrand(brandName, brandUrl = null) {
  const row = { name: brandName };
  if (brandUrl) row.url = brandUrl;
  const { data, error } = await supabase
    .from('brands')
    .upsert(row, { onConflict: 'name' })
    .select('id')
    .single();

  if (error) {
    throw new Error(`Failed to upsert brand "${brandName}": ${error.message}`);
  }

  return data.id;
}

/**
 * Ensures a brand has a `main` page row and returns its id, so every ad the
 * normal scraper collects can be linked to it via page_id. Idempotent: reuses
 * the existing main page if there is one, inserts it otherwise. This replaces
 * the one-time migration backfill for any brand created after that migration.
 */
async function ensureMainPage(brandId, brandName) {
  const { data: existing, error: selErr } = await supabase
    .from('pages')
    .select('id')
    .eq('brand_id', brandId)
    .eq('type', 'main')
    .maybeSingle();
  if (selErr) throw new Error(`Failed to look up main page: ${selErr.message}`);
  if (existing) return existing.id;

  const { data, error } = await supabase
    .from('pages')
    .insert({ brand_id: brandId, name: brandName, type: 'main' })
    .select('id')
    .single();
  if (error) throw new Error(`Failed to create main page for brand ${brandId}: ${error.message}`);
  return data.id;
}

async function getExistingMediaIds(brandId) {
  const { data, error } = await supabase
    .from('ads')
    .select('media_id')
    .eq('brand_id', brandId);

  if (error) {
    throw new Error(`Failed to fetch existing media IDs: ${error.message}`);
  }

  return data.map((row) => row.media_id);
}

async function upsertAd(ad, brandId, pageId = null) {
  const row = {
    media_id: ad.mediaId,
    brand_id: brandId,
    saved_date: ad.savedDate,
    active_period: ad.activePeriod,
    landing_page: ad.landingPage,
    title: ad.title,
    duration: ad.duration,
    transcript: ad.transcript,
    share_url: ad.shareUrl,
    updated_at: new Date().toISOString(),
  };
  // Only touch page_id when a caller supplies it (Layer B files whitelist
  // ads under the real brand + the 3rd-party page). Omitting it leaves any
  // existing page_id untouched on re-scrape, so the normal scraper's
  // two-arg call is unaffected.
  if (pageId != null) row.page_id = pageId;

  const { error } = await supabase.from('ads').upsert(row, { onConflict: 'media_id' });

  if (error) {
    throw new Error(`Failed to upsert ad mediaId=${ad.mediaId}: ${error.message}`);
  }
}

module.exports = { upsertBrand, ensureMainPage, upsertAd, getExistingMediaIds };
