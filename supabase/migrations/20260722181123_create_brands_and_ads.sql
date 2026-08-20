-- Milestone 2, Step 2: brands + ads schema for the GetHook scraper.
--
-- brands.name is unique so a brand is created at most once and every ad
-- links to it via brand_id. ads.media_id is unique so re-scraping the
-- same ad is an upsert, not a duplicate row.

create table if not exists public.brands (
  id bigint generated always as identity primary key,
  name text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.ads (
  id bigint generated always as identity primary key,
  media_id text not null unique,
  brand_id bigint not null references public.brands (id) on delete cascade,

  saved_date text,
  active_period text,
  landing_page text,

  title text,
  duration text,
  transcript text,
  share_url text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ads_brand_id_idx on public.ads (brand_id);
