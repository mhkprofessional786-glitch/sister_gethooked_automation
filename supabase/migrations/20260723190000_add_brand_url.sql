-- Add url column to brands for storing the GetHook brand page URL.

alter table public.brands add column if not exists url text;
