'use strict';

/**
 * src/scraper/transcript.js
 *
 * Phase 5: open (not read) an ad's Transcript tab. Given an already-open
 * Details panel (see src/scraper/details.js), clicks the Transcript
 * tab/button/menu item and verifies its content actually became visible.
 * Does not copy, extract, or analyze any transcript text — this phase
 * only opens and confirms the tab.
 *
 * "Show timestamps" handling now lives in src/scraper/prepareTranscript.js,
 * which searches the whole Details dialog rather than just this tab's
 * panel — the control isn't scoped inside the panel.
 */

const { log } = require('../browser/logger');

const ACTION_TIMEOUT_MS = 15000;

/**
 * Click the Transcript control inside the open Details panel and verify
 * its content opened.
 *
 * Control selector: getByRole('tab'|'button'|'menuitem', { name: /transcript/i }),
 * combined with .or(). The Details panel is built on the same shadcn/Radix
 * primitives as the rest of the app (see details.js), and Radix Tabs —
 * the standard way that family implements in-panel sections — exposes
 * each section switcher as role="tab". Since it isn't certain from the
 * outside whether this control is a tab, a plain button, or a menu item,
 * matching all three ARIA roles by accessible name "Transcript" (instead
 * of guessing one) maximizes the chance of hitting the real control
 * without depending on one specific implementation.
 *
 * Verification: resolve the exact panel the control declares it opens via
 * its `aria-controls` attribute (the standard ARIA tabs contract — a tab
 * points at the id of the panel it reveals) and wait for that specific
 * element to become visible, falling back to any role="tabpanel" inside
 * the dialog if `aria-controls` isn't present. Radix Tabs only mounts the
 * active panel's content by default, so the Transcript panel does not
 * exist in the DOM at all until its control is selected — its appearance
 * is a real, positive signal the transcript view opened, not an
 * assumption based on the click having been dispatched.
 */
async function openTranscriptTab(page) {
  // Scoped by name to avoid a strict-mode match against the page's
  // unrelated support-chat dialog (accessible name "Chat window") — see
  // src/scraper/details.js.
  const dialog = page.getByRole('dialog', { name: 'Ad Details' });
  await dialog.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });

  const transcriptControl = dialog
    .getByRole('tab', { name: /transcript/i })
    .or(dialog.getByRole('button', { name: /transcript/i }))
    .or(dialog.getByRole('menuitem', { name: /transcript/i }))
    .first();

  await transcriptControl.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });

  const controlledId = await transcriptControl.getAttribute('aria-controls').catch(() => null);

  log('TRANSCRIPT', 'Clicking the "Transcript" control...');
  await transcriptControl.click({ timeout: ACTION_TIMEOUT_MS });

  const panel = controlledId
    ? page.locator(`[id="${controlledId}"]`)
    : dialog.getByRole('tabpanel');

  await panel.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });

  const selected = await transcriptControl.getAttribute('aria-selected').catch(() => null);
  log(
    'TRANSCRIPT',
    `Transcript panel confirmed open (${controlledId ? `#${controlledId}` : 'role="tabpanel"'} is visible` +
      `${selected ? `, aria-selected="${selected}"` : ''}).`
  );

  return panel;
}

module.exports = { openTranscriptTab };
