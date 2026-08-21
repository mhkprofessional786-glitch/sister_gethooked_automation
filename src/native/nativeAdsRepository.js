'use strict';

/**
 * src/native/nativeAdsRepository.js
 *
 * Storage for the native-ads board collector. Independent of the normal
 * ads repository. Two responsibilities:
 *   1. Persist rows to public.native_ads (upsert by unique media_id).
 *   2. Archive each ad's creative image into a public Supabase Storage
 *      bucket, so we keep a permanent copy (GetHook's own image links are
 *      signed and expire ~daily).
 *
 * Uses the service_role client from src/supabase/client.js.
 */

const { supabase } = require('../supabase/client');

const BUCKET = 'native-ad-images';

/**
 * Creates the public image bucket if it doesn't exist yet. Idempotent —
 * safe to call at the start of every run.
 */
async function ensureImageBucket() {
  const { data } = await supabase.storage.getBucket(BUCKET);
  if (data) return;
  const { error } = await supabase.storage.createBucket(BUCKET, { public: true });
  if (error && !/already exists/i.test(error.message)) {
    throw new Error(`Failed to create Storage bucket "${BUCKET}": ${error.message}`);
  }
}

/**
 * Uploads image bytes for one ad and returns the permanent public URL.
 * upsert:true so re-scraping overwrites rather than erroring on conflict.
 */
async function uploadAdImage(mediaId, buffer, contentType = 'image/jpeg') {
  const path = `${mediaId}.jpg`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, buffer, { contentType, upsert: true });
  if (error) {
    throw new Error(`Failed to upload image for ${mediaId}: ${error.message}`);
  }
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

/**
 * Upserts one native-ad row keyed on the unique media_id, so re-scraping
 * updates the existing row instead of duplicating it.
 */
async function upsertNativeAd(row) {
  const record = { ...row, updated_at: new Date().toISOString() };
  const { error } = await supabase
    .from('native_ads')
    .upsert(record, { onConflict: 'media_id' });
  if (error) {
    throw new Error(`Failed to upsert native ad ${row.media_id}: ${error.message}`);
  }
}

/** media_ids already stored, so a re-run can skip them if desired. */
async function getExistingMediaIds() {
  const { data, error } = await supabase.from('native_ads').select('media_id');
  if (error) {
    throw new Error(`Failed to fetch existing native media ids: ${error.message}`);
  }
  return data.map((r) => r.media_id);
}

module.exports = { ensureImageBucket, uploadAdImage, upsertNativeAd, getExistingMediaIds, BUCKET };
