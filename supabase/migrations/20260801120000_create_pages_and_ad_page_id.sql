-- Whitelisting / full-footprint intelligence: introduce a pages layer
-- between brands and ads.
--
-- A brand runs ads across multiple pages/accounts (main + whitelisted
-- creator pages + secondary accounts). Every ad KEEPS its real brand_id so
-- "analyse RYZE" returns the whole footprint; the new ads.page_id records
-- which specific page ran it. A whitelist page is never its own brand.

create table if not exists public.pages (
  id bigint generated always as identity primary key,
  brand_id bigint not null references public.brands (id) on delete cascade,
  name text not null,
  meta_page_id text,
  page_url text,
  type text not null default 'main',   -- main | whitelist | secondary
  created_at timestamptz not null default now(),
  unique (brand_id, name)
);
create index if not exists pages_brand_id_idx on public.pages (brand_id);

alter table public.ads add column if not exists page_id bigint references public.pages (id);
create index if not exists ads_page_id_idx on public.ads (page_id);

-- Backfill: one 'main' page per brand that actually has ads (skips the
-- BRIGHT IDEAS container brand, which has none), then label existing ads as
-- coming from that main page. Idempotent — safe to re-run.
insert into public.pages (brand_id, name, type)
select distinct b.id, b.name, 'main'
from public.brands b
join public.ads a on a.brand_id = b.id
where not exists (
  select 1 from public.pages p where p.brand_id = b.id and p.type = 'main'
);

update public.ads a
set page_id = p.id
from public.pages p
where p.brand_id = a.brand_id and p.type = 'main' and a.page_id is null;
