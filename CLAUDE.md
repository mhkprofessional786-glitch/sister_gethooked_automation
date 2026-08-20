# Sister Gethooked Automation — Collector

A **collector-only** sister project of `gethook-automation`. This repo's single
job is to **scrape and store** ad data from GetHook (gethookd.ai). It does **no
analysis** — all clustering / scoring / reporting / artifacts live in the
original `gethook-automation` project.

## Why this exists (read before changing anything)

The original `gethook-automation` is a mature, heavily-invested scraper +
analysis system. To avoid destabilising it, this project was split off as a
**completely independent repo** with its own git history and its own Supabase
database. The two projects share **no code and no database** — only a family
resemblance, because this repo was seeded as a full copy of the original's
scrape + store infrastructure.

- **Original (`gethook-automation`)** — the brain: scraping + analysis + reports.
- **This repo (`sister_gethooked_automation`)** — a customizable collector:
  open GetHook, move across ads, click a button, store fields. Nothing else.

Keep it that way. If a task here starts drifting toward analysis, stop — that
belongs in the original project.

## Relationship to the original scraper

This repo was copied from `gethook-automation` and **intentionally excludes**
its analysis parts (`src/analysis/`, `src/llm/`, `analysis-prompts/`, the
report `scripts/`, and the `brand_analyses` table/migration). What remains is
the proven skeleton:

- `src/browser/` — Playwright launcher driving real Chrome against a persistent,
  logged-in profile at `.playwright-profile/` (`launch.js`, session, profile mgr).
- `src/scraper/` — the granular ad pipeline (navigation, ad enumeration, detail
  dialogs, `share.js`'s hardened clipboard-poll, transcript, etc.). This is the
  **skeleton to modify per new collection job**, not gospel.
- `src/supabase/` — client + `adsRepository` (storage).
- `src/export/json.js`, `src/config.js`, `supabase/migrations/` (storage schema).

**The clipboard-poll pattern in `src/scraper/share.js` is load-bearing.** Any
"click a copy button → read clipboard" flow MUST reuse it (write a sentinel,
click, poll until the clipboard actually changes) — a plain instant read grabs
the *previous* ad's value. This is the one genuinely fragile part of collection.

## Its own Supabase (separate from the original)

This project uses a **NEW, dedicated Supabase project** — not the original's DB.
Credentials live in `.env` (see `.env.example`): `SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE_KEY`. The storage schema (brands, ads, pages) is applied
from `supabase/migrations/`. `brand_analyses` is deliberately absent.

## Storage routing

Collection jobs file scraped rows under a target that is **sometimes a brand,
sometimes a folder/bucket** — the collector doesn't care what the target is, it
just stores where pointed. (Routing flag e.g. `--into brand:<id>` /
`--into folder:"<name>"` — to be finalised when the first job is built.)

## Status

Repo scaffolded from the original's scrape+store infra. First real collection
job (a GetHook **folder URL** → open each ad → click "copy ad script" → store
the script) not yet built — DOM of the copy button still to be confirmed.
