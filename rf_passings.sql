-- HK Workshop — DEHAARDT BEACON PICKUPS
-- ------------------------------------------------------------------------------------------------
-- One row per kart crossing one timing loop, mirrored from RaceFacer's Passing History
-- (GET /ajax/session-management/passing-records?type=all). See rf_pickups.js in the runner.
--
-- The two columns that make this worth storing are `strength` and `battery`: a transponder does not
-- fail cleanly, it sags for days first. Held over time they say which transponder to swap BEFORE a
-- kart starts dropping laps.
--
-- ⚠️  DO NOT ADD THIS TABLE TO THE REALTIME PUBLICATION.
-- Realtime cost is rows-written x devices-subscribed. Passings are the highest-volume feed we have
-- (a row per kart per loop per lap — thousands an hour during a busy day), so publishing it would
-- repeat the 324M-message incident on its own. The app reads it on demand and on a timer instead.

create table if not exists public.rf_passings (
  id            bigserial primary key,
  site          text        not null,
  fp            text        not null,          -- natural key: RaceFacer's id, else hash(at|transponder|loop|kart)
  at            timestamptz not null,          -- parsed to a real instant, in the venue's zone
  at_raw        text,                          -- exactly what RaceFacer printed — a bad parse stays visible
  loop          text,                          -- S2 / S3 / S/F …
  kart_no       text,
  kart_id       bigint,
  session_label text,
  participant   text,
  lap_time      numeric,
  transponder   text,
  strength      numeric,                       -- signal strength at the beacon
  battery       numeric,                       -- transponder battery
  created_at    timestamptz not null default now()
);

-- Insert-once. The runner upserts on (site, fp) so a re-read of the same passing is a no-op.
create unique index if not exists rf_passings_site_fp on public.rf_passings (site, fp);

-- The three reads the Dehaardt Pickups screen makes.
create index if not exists rf_passings_site_at   on public.rf_passings (site, at desc);
create index if not exists rf_passings_tx_at     on public.rf_passings (site, transponder, at desc);
create index if not exists rf_passings_kart_at   on public.rf_passings (site, kart_no, at desc);

alter table public.rf_passings enable row level security;

-- Read for the app's anon key; writes come from the runner's service key, which bypasses RLS.
drop policy if exists rf_passings_read on public.rf_passings;
create policy rf_passings_read on public.rf_passings for select using (true);

-- Kept to 7 days by the runner. This is the backstop if the runner is ever off for a while.
-- delete from public.rf_passings where at < now() - interval '7 days';
