'use strict';

/**
 * src/scraper/overview.js
 *
 * Milestone 2, Step 1: read three fields off an ad's Overview tab —
 * savedDate ("Saved"), activePeriod ("Active Period"), and landingPage
 * ("Landing page") — before the existing flow switches to the
 * Transcription tab. Does not click anything or change tabs: the Details
 * dialog opens with Overview already selected (confirmed live —
 * aria-selected="true" on the Overview tab as soon as the dialog mounts),
 * so this only reads.
 *
 * Panel resolution mirrors src/scraper/transcript.js's openTranscriptTab:
 * resolve the Overview tab control's `aria-controls` to find its exact
 * panel id, per the standard ARIA tabs contract, rather than assuming
 * "whichever tabpanel is visible" (the dialog also renders a "Saved"
 * label elsewhere, in its header/credits area, so an unscoped search for
 * that text would be ambiguous).
 *
 * Field layout confirmed live: each Overview field is a label div (exact
 * text, e.g. "Saved") followed by a sibling div holding the value (plain
 * text, or an <a href> for link-shaped values like the landing page URL).
 *
 * Correction from an earlier assumption: the Overview tab is only the
 * dialog's default for the very first ad opened. Confirmed live across a
 * multi-ad run — the underlying Radix Tabs state persists across ads
 * (ad 2's dialog reopened with Transcription still selected, since that's
 * what ad 1 last left active), so this clicks the Overview tab whenever
 * it isn't already selected, the same way openTranscriptTab always clicks
 * Transcript rather than assuming its starting state.
 */

const { log, warn } = require('../browser/logger');

const ACTION_TIMEOUT_MS = 15000;
const OVERVIEW_TAB_NAME_PATTERN = /^overview$/i;

/**
 * Resolves the Overview tabpanel via the Overview tab control's
 * aria-controls attribute, same technique as openTranscriptTab. Clicks
 * the Overview tab first if it isn't already selected (see module doc
 * comment) — selecting an already-active tab again would be a harmless
 * no-op, but checking first avoids an unnecessary click on the common
 * case (the first ad in a run).
 */
async function resolveOverviewPanel(page, dialog) {
  const overviewControl = dialog.getByRole('tab', { name: OVERVIEW_TAB_NAME_PATTERN }).first();
  await overviewControl.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });

  const controlledId = await overviewControl.getAttribute('aria-controls').catch(() => null);
  const panel = controlledId ? page.locator(`[id="${controlledId}"]`) : dialog.getByRole('tabpanel');

  const alreadySelected = (await overviewControl.getAttribute('aria-selected').catch(() => null)) === 'true';
  if (!alreadySelected) {
    log('OVERVIEW', 'Overview tab not selected — clicking it...');
    await overviewControl.click({ timeout: ACTION_TIMEOUT_MS });
  }

  await panel.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  return panel;
}

/**
 * Given a field's exact label text, resolves its value container: the
 * label div's parent's next sibling div — the same "landmark, then
 * structural next sibling" approach extract.js uses for the transcript
 * body, rather than a CSS-class selector tied to Tailwind's generated
 * classes.
 */
function fieldValueLocator(panel, labelText) {
  const labelDiv = panel.locator(`div:text-is("${labelText}")`).first();
  return labelDiv.locator('xpath=../following-sibling::*[1]');
}

async function readFieldText(panel, labelText) {
  const value = fieldValueLocator(panel, labelText);
  const present = (await value.count().catch(() => 0)) > 0;
  if (!present) {
    warn('OVERVIEW', `Field "${labelText}" not found on the Overview tab.`);
    return null;
  }
  const text = (await value.innerText().catch(() => '')).trim();
  return text || null;
}

/**
 * Same as readFieldText, but prefers the value container's <a href> when
 * present (the landing page value is a link, not plain text).
 */
async function readFieldLink(panel, labelText) {
  const value = fieldValueLocator(panel, labelText);
  const link = value.locator('a').first();
  const hasLink = (await link.count().catch(() => 0)) > 0;
  if (hasLink) {
    const href = await link.getAttribute('href').catch(() => null);
    if (href) return href;
  }
  return readFieldText(panel, labelText);
}

/**
 * Reads savedDate, activePeriod, and landingPage off the currently-open
 * Details dialog's Overview tab. Expects to be called before the caller
 * switches to the Transcript tab.
 */
async function extractOverviewFields(page, dialog) {
  const panel = await resolveOverviewPanel(page, dialog);

  const savedDate = await readFieldText(panel, 'Saved');
  const activePeriod = await readFieldText(panel, 'Active Period');
  const landingPage = await readFieldLink(panel, 'Landing page');

  log(
    'OVERVIEW',
    `savedDate=${JSON.stringify(savedDate)}, activePeriod=${JSON.stringify(activePeriod)}, ` +
      `landingPage=${JSON.stringify(landingPage)}`
  );

  return { savedDate, activePeriod, landingPage };
}

module.exports = { extractOverviewFields };
