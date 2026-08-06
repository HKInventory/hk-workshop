-- ============================================================
--  PRESENCE — powers the Manager Dashboard "Active Staff" panel
--  (green "active now" dot + last-active time). Run once in the
--  Supabase SQL editor.
--
--  One row per person, upserted by the app every 60s while open
--  (and on login / resume / tab-focus). Small table, no growth.
-- ============================================================

create table if not exists public.presence (
  name       text primary key,
  role       text,
  site       text,
  last_seen  timestamptz not null default now()
);

alter table public.presence enable row level security;

-- Internal staff tool: the app uses the anon key, so allow anon + authenticated
-- to read and upsert their presence row.
drop policy if exists presence_rw on public.presence;
create policy presence_rw on public.presence
  for all to anon, authenticated
  using (true) with check (true);

-- Optional: live updates on the dashboard without a manual refresh.
alter publication supabase_realtime add table public.presence;
