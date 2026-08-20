'use strict';

/**
 * src/scraper/extract.js
 *
 * Phase 6: extract (not analyze) the transcript text. Given the already-
 * open Transcript panel (see src/scraper/transcript.js), reads only the
 * spoken transcript content, prints a preview, and reports its
 * character/line counts. Does not summarize, modify, or interpret the
 * text — extraction only.
 */

const { log, error } = require('../browser/logger');

const ACTION_TIMEOUT_MS = 15000;
const PREVIEW_LINE_COUNT = 10;

// The toolbar row (Show timestamps toggle, Copy transcript, any future
// controls) is identified by a structural landmark — a div whose direct
// child is the "Show timestamps" label — not by listing/stripping the
// controls inside it. The transcript body is whatever comes right after
// that row as a sibling.
const HEADER_ROW_SELECTOR = 'div:has(> label:has-text("Show timestamps"))';

/**
 * Resolves the live transcript-body container, positioned structurally
 * beneath the toolbar row rather than found by stripping known controls
 * out of it. The header row (containing the "Show timestamps" label) is
 * located first; the transcript body is its immediate next sibling.
 * Nothing is cloned or removed — both locators point at real, attached
 * DOM nodes, so innerText reflects true rendering (line breaks, spacing)
 * exactly as shown in the UI.
 *
 * Falls back to the panel itself only if that landmark isn't present
 * (e.g. a future UI change removes the toolbar entirely) — still a live,
 * uncloned read, just less specific.
 */
async function resolveTranscriptBody(transcriptPanel) {
  const headerRow = transcriptPanel.locator(HEADER_ROW_SELECTOR).first();
  const headerFound = (await headerRow.count().catch(() => 0)) > 0;

  if (headerFound) {
    const body = headerRow.locator('xpath=following-sibling::*[1]');
    const bodyFound = (await body.count().catch(() => 0)) > 0;
    if (bodyFound) {
      return { container: body, selectorDescription: `${HEADER_ROW_SELECTOR} + next sibling (live)` };
    }
  }

  return { container: transcriptPanel, selectorDescription: 'transcript panel itself (header landmark not found; live, unfiltered fallback)' };
}

/**
 * Extract the spoken transcript text from the already-open Transcript
 * panel, excluding the toolbar row.
 */
async function extractTranscript(page, transcriptPanel) {
  const { container, selectorDescription } = await resolveTranscriptBody(transcriptPanel);
  const text = (await container.innerText().catch(() => '')).trim();

  if (!text) {
    const loadingHint = await transcriptPanel
      .getByText(/loading/i)
      .first()
      .isVisible()
      .catch(() => false);
    const emptyHint = await transcriptPanel
      .getByText(/no transcript|not available|unavailable/i)
      .first()
      .isVisible()
      .catch(() => false);

    let reason = 'selector mismatch (container resolved but held no rendered text)';
    if (loadingHint) reason = 'transcript is still loading';
    else if (emptyHint) reason = 'transcript is unavailable for this ad';

    error('EXTRACT', `Transcript extraction failed: ${reason}.`);
    throw new Error(`Transcript extraction failed: ${reason}.`);
  }

  const lines = text.split('\n');
  const charCount = text.length;
  const lineCount = lines.length;

  // Sanity check: confirm none of the known toolbar labels survived.
  const uiLeakPatterns = [/show timestamps/i, /hide timestamps/i, /copy transcript/i];
  const leaked = uiLeakPatterns.filter((p) => p.test(text));

  log('EXTRACT', `Transcript container resolved via: ${selectorDescription}`);
  console.log('SELECTOR USED:', selectorDescription);

  console.log(`\n----- FIRST ${Math.min(PREVIEW_LINE_COUNT, lines.length)} LINES -----`);
  console.log(lines.slice(0, PREVIEW_LINE_COUNT).join('\n'));

  console.log(`\n----- LAST ${Math.min(PREVIEW_LINE_COUNT, lines.length)} LINES -----`);
  console.log(lines.slice(-PREVIEW_LINE_COUNT).join('\n'));

  console.log(`\nCHARACTER COUNT: ${charCount}`);
  console.log(`LINE COUNT: ${lineCount}`);

  if (leaked.length > 0) {
    error('EXTRACT', `UI text still present in extracted transcript: ${leaked.map(String).join(', ')}`);
  } else {
    log('EXTRACT', 'Confirmed: no known UI text (toolbar labels) present in extracted transcript.');
  }

  log('EXTRACT', `Transcript character count: ${charCount}`);
  log('EXTRACT', `Transcript line count: ${lineCount}`);

  return { text, charCount, lineCount, selectorDescription, uiTextLeaked: leaked.length > 0 };
}

module.exports = { extractTranscript };
