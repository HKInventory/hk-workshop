-- Kart Check — shared, live pre-session fleet checklist.
-- Run once in the Supabase SQL editor. One row per kart per day; the app upserts on each tick,
-- and several phones stay in sync via realtime (that's the "shared live" part).

create table if not exists public.kart_checks (
  id          bigint generated always as identity primary key,
  site        text        not null default 'sydney',
  kart_type   text        not null,
  check_date  date        not null,
  rf_kart_id  bigint      not null,
  kart_no     text,
  result      text,                              -- 'ok' | 'damaged' | 'maint'
  note        text,
  by_name     text,
  updated_at  timestamptz not null default now(),
  unique (site, kart_type, check_date, rf_kart_id)
);

-- Fast lookups for "today's check of this site".
create index if not exists kart_checks_lookup on public.kart_checks (site, check_date);

-- Same access posture as the app's other client-written tables (anon key; the app is PIN-gated in the UI).
alter table public.kart_checks enable row level security;
drop policy if exists kart_checks_rw on public.kart_checks;
create policy kart_checks_rw on public.kart_checks
  for all to anon, authenticated
  using (true) with check (true);

-- Realtime so a check split across several phones updates everyone live. Safe to re-run.
do $$ begin
  begin
    alter publication supabase_realtime add table public.kart_checks;
  exception when duplicate_object then null;
  end;
end $$;
