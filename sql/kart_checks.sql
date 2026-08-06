-- Kart Check (v2) — named, shared, live pre-session fleet checks.
-- Run once in the Supabase SQL editor. Safe to re-run. (This replaces the first single-table version;
-- there's no important data in it yet, so we drop and recreate.)

drop table if exists public.kart_checks cascade;

-- A run = one named check of a kart type (mechanic + date). Several staff can share an active run.
create table if not exists public.kart_check_runs (
  id            uuid primary key default gen_random_uuid(),
  site          text        not null default 'sydney',
  kart_type     text        not null,
  mechanic      text,
  check_date    date        not null,
  status        text        not null default 'active',   -- 'active' | 'done'
  started_by    text,
  started_at    timestamptz not null default now(),
  completed_at  timestamptz,
  ok_count      int,
  fm_count      int,
  damaged_count int
);
create index if not exists kart_check_runs_lookup on public.kart_check_runs (site, kart_type, started_at desc);

-- One row per kart per run: the tick result + note.
create table if not exists public.kart_checks (
  id          bigint generated always as identity primary key,
  run_id      uuid        not null references public.kart_check_runs(id) on delete cascade,
  site        text        not null default 'sydney',
  kart_type   text,
  rf_kart_id  bigint      not null,
  kart_no     text,
  result      text,                              -- 'ok' | 'damaged' | 'maint'
  note        text,
  by_name     text,
  updated_at  timestamptz not null default now(),
  unique (run_id, rf_kart_id)
);
create index if not exists kart_checks_run on public.kart_checks (run_id);

-- Same access posture as the app's other client-written tables (anon key; PIN-gated in the UI).
alter table public.kart_check_runs enable row level security;
alter table public.kart_checks     enable row level security;
drop policy if exists kart_check_runs_rw on public.kart_check_runs;
create policy kart_check_runs_rw on public.kart_check_runs for all to anon, authenticated using (true) with check (true);
drop policy if exists kart_checks_rw on public.kart_checks;
create policy kart_checks_rw on public.kart_checks for all to anon, authenticated using (true) with check (true);

-- Realtime so a check split across several phones updates everyone live. Safe to re-run.
do $$ begin
  begin alter publication supabase_realtime add table public.kart_check_runs; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.kart_checks;     exception when duplicate_object then null; end;
end $$;
