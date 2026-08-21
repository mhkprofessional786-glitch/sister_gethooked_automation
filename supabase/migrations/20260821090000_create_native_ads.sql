-- Native ads collector: a standalone table for GetHook "native image + long
-- form copy" board ads. Independent of brands/ads/pages — every native scrape
-- lands here with the same shape. media_id is unique so re-scraping the same
-- ad is an upsert, not a duplicate row.

create table if not exists public.native_ads (
  id bigint generated always as identity primary key,
  media_id text not null unique,          -- the Ad ID (Meta ad id)

  ad_url text,                            -- Facebook Ad Library link for this ad
  source_board_id text,                   -- which GetHook board it came from
  creator_name text,                      -- page/creator name shown on the ad
  creator_url text,                       -- that creator's GetHook brand page

  headline text,                          -- ad headline
  primary_text_copy text,                 -- the full body copy (Copy button)

  saved_date text,                        -- "May 30, 2026"
  active_period text,                     -- "76 days (ended)"
  niche text,                             -- "Health/Wellness"
  cta_type text,                          -- "See Details"
  landing_page text,                      -- destination URL

  image_url text,                         -- original clean (unsigned) creative URL, for reference
  image_stored_url text,                  -- permanent Supabase Storage URL (downloaded copy)

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists native_ads_board_idx on public.native_ads (source_board_id);
