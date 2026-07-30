-- ============================================================================================
--  rf_passings — DEHAARDT BEACON PICKUPS
--  Run once in the Supabase SQL editor. Safe to re-run, and safe to run over an earlier copy
--  of this file (the alters below add the columns that copy was missing).
--
--  ⚠️  NOTHING HAS EVER BEEN STORED IN THIS TABLE.
--  Until this script is run, the runner logs "cannot write N passing(s)" on every cycle and the
--  Dehaardt Pickups screen has nothing to show. That is the whole reason that screen is empty —
--  not a quiet day, not a broken parser. There is a verification query at the bottom of the file.
--
--  One row per kart crossing one timing loop, mirrored from RaceFacer's Passing History
--  (GET /ajax/session-management/passing-records?type=all). See rf_pickups.js in the runner.
--
--  THE WIRE SHAPE, CONFIRMED FROM A LIVE CAPTURE ON 30 JULY 2026. Every column below maps to a
--  named field; the runner does no guessing. Keep this table in step with that list:
--
--    RaceFacer field        column          note
--    ---------------------  --------------  ----------------------------------------------------
--    id                     rf_id           sequential; the natural key, and how gaps are spotted
--    loop_number            loop            'S2' / 'S3' / 'S/F'
--    kart                   kart_no         a DISPLAY number — it repeats across kart types
--    kart_id                kart_id         -> rf_karts.rf_id, the only unambiguous kart key
--    transponder            transponder
--    device_timestamp       at              epoch ms; authoritative, carries milliseconds
--    datetime               at_raw          venue wall clock, kept verbatim as printed
--    client                 participant     RaceFacer calls the driver the client; '-' when none
--    session                session_label   '-' outside a booked race
--    session_id             session_id      -> rf_sessions.rf_session_id, and how `track` is resolved
--    run_id                 run_id          -> rf_session_runs.run_id (driver + kart for the run)
--    transponder_lap_time   lap_time        seconds; what RaceFacer's own LAP TIME column shows
--    loop_lap_time          loop_lap_time   seconds; same loop to same loop, i.e. a true lap
--    strength               strength        see the warning below
--    battery_low            battery_low     a FLAG, not a level
--    (none)                 track           NOT in the payload. RaceFacer knows it and the runner
--                                           reads it off RaceFacer: session_id -> rf_sessions.track,
--                                           then loop -> track learned from those. See rf_pickups.js.
--
--  ⚠️  DO NOT BUILD ON strength OR battery_low AT THIS VENUE.
--  Both are empty here: RaceFacer reports strength as '-' and battery as N/A on every record, in
--  the JSON and in its own Passing History table. The columns are kept because they cost nothing
--  and a venue on different decoder hardware may populate them — but any screen that DEPENDS on
--  them will show an em-dash forever. What this table can actually answer is presence: which
--  loops a kart was seen at, which it was not, and when it was last seen.
--
--  ⚠️  DO NOT ADD THIS TABLE TO THE REALTIME PUBLICATION.
--  Realtime cost is rows-written x devices-subscribed. Passings are the highest-volume feed we
--  have — a row per kart per loop per lap, thousands an hour on a busy day — so publishing it
--  would repeat the 324M-message incident on its own. The app reads it on demand and on a timer.
-- ============================================================================================

create table if not exists public.rf_passings (
  id            bigserial primary key,
  site          text        not null,
  fp            text        not null,          -- natural key: 'id:' || RaceFacer's id
  rf_id         bigint,                        -- RaceFacer's own passing id. Sequential, which is how
                                               -- the runner spots passings that scrolled off the page
                                               -- between polls. The runner has always written this
                                               -- column and the first draft of this file never had it,
                                               -- so every upsert would have failed PGRST204 even after
                                               -- the SQL was run. Do not remove it.
  at            timestamptz not null,          -- the passing instant, from device_timestamp
  at_raw        text,                          -- exactly what RaceFacer printed — a bad parse stays visible
  loop          text,                          -- S2 / S3 / S/F …
  kart_no       text,                          -- display number; ambiguous across kart types
  kart_id       bigint,                        -- -> rf_karts.rf_id
  track         text,                          -- RaceFacer's track_configuration, resolved by the runner
  session_label text,
  participant   text,
  session_id    bigint,                        -- -> rf_sessions.rf_session_id
  run_id        bigint,                        -- -> rf_session_runs.run_id
  lap_time      numeric,                       -- seconds
  loop_lap_time numeric,                       -- seconds
  transponder   text,
  strength      numeric,                       -- empty at this venue — see the warning above
  battery_low   boolean,                       -- a flag, not a level; null = not reported
  created_at    timestamptz not null default now()
);

-- Columns added after the first draft of this file. Written as separate alters so that pasting
-- this script over an older copy of the table brings it up to date instead of failing.
alter table public.rf_passings add column if not exists session_id    bigint;
alter table public.rf_passings add column if not exists run_id        bigint;
alter table public.rf_passings add column if not exists loop_lap_time numeric;
alter table public.rf_passings add column if not exists battery_low   boolean;
alter table public.rf_passings add column if not exists track         text;
alter table public.rf_passings add column if not exists rf_id         bigint;

-- The first draft had `battery numeric`, meaning a battery LEVEL. RaceFacer sends no level — only
-- the battery_low flag above — so an earlier copy of this table has a column that can never be
-- anything but null. Dropped rather than left to look like a reading nobody is taking.
alter table public.rf_passings drop column if exists battery;

-- Insert-once. The runner upserts on (site, fp) so a re-read of the same passing is a no-op.
-- This exact index is what makes `on_conflict=site,fp` legal — do not drop it.
create unique index if not exists rf_passings_site_fp on public.rf_passings (site, fp);

/* THE ONE READ THE APP ACTUALLY MAKES.
   The Dehaardt Pickups screen issues a single query — site + a time window, newest first — and does
   all its grouping by kart and by loop in the browser. So one index earns its keep here.
   The earlier draft also indexed (site, transponder, at) and (site, kart_no, at) for "the three
   reads the screen makes". The screen makes one, and on the highest-volume write table in the
   system every extra index is paid for on every insert, forever. They are one line each if a
   per-kart or per-transponder drill-down ever gets built; until then they are cost without a
   reader. */
create index if not exists rf_passings_site_at on public.rf_passings (site, at desc);

-- Dropped for the reason above. Harmless no-ops if this is a first run.
drop index if exists public.rf_passings_tx_at;
drop index if exists public.rf_passings_kart_at;

alter table public.rf_passings enable row level security;

-- Read-only for the app. Writes come from the runner's service key, which bypasses RLS — and the
-- runner's 7-day prune is a delete on that same service key, so it needs no policy of its own.
-- Deliberately narrower than the other tables here: nothing in the app should ever write a passing.
drop policy if exists rf_passings_read on public.rf_passings;
create policy rf_passings_read on public.rf_passings
  for select to anon, authenticated
  using (true);


-- ============================================================================================
--  DID IT WORK? Run this straight after the script above.
--  Expect a row to appear within ~30 seconds of a kart crossing a loop. If `passings` stays 0
--  while karts are on track, check the Render log for lines starting "[pickups]".
-- ============================================================================================
-- select count(*)                as passings,
--        count(distinct kart_no) as karts,
--        count(distinct loop)    as loops,
--        min(at)                 as oldest,
--        max(at)                 as newest,
--        count(strength)         as have_strength,     -- expected 0 at this venue
--        count(session_id)       as tied_to_a_session
--   from public.rf_passings
--  where site = 'sydney' and at > now() - interval '12 hours';

-- Kept to 7 days by the runner (RF_PICK_KEEP_DAYS). This is the backstop if it is ever off a while.
-- delete from public.rf_passings where at < now() - interval '7 days';
