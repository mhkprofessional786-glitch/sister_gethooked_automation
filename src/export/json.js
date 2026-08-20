'use strict';

/**
 * src/export/json.js
 *
 * Persists an already-collected ads array (built by
 * src/scraper/collect.js — the only place that constructs the canonical
 * ad object) to a timestamped JSON file under output/. This module only
 * writes what it's given; it does not shape, filter, or duplicate the
 * ad data model.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'output');

function formatTimestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

/**
 * Writes `ads` to output/<brandName>_<YYYY-MM-DD_HH-mm-ss>.json (UTF-8,
 * pretty-printed with 2-space indentation), creating output/ first if it
 * doesn't exist. Returns the full path written.
 */
function exportAdsToJson(brandName, ads, { now = new Date() } = {}) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const filename = `${brandName}_${formatTimestamp(now)}.json`;
  const filePath = path.join(OUTPUT_DIR, filename);

  fs.writeFileSync(filePath, JSON.stringify(ads, null, 2), 'utf-8');

  return filePath;
}

module.exports = { exportAdsToJson };
