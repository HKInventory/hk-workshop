-- ============================================================================================
--  rf_type_parts — the parts RaceFacer will actually accept, per kart type
--  Run once in the Supabase SQL editor. Safe to re-run.
--
--  WHY THIS EXISTS. The app's parts picker was built from rf_warehouse: every part in the
--  building, 155 of them. RaceFacer only accepts the ~127 in the KART TYPE's own list, so a
--  mechanic could pick something RaceFacer would refuse for that kart — and before the id fix,
--  it did not refuse, it attached whatever part happened to share that number. Selecting a
--  DGM Front recorded a 250amp Fuse.
--
--  RaceFacer keys its own picker data (available_parts) by kart type for exactly this reason.
--  This table mirrors that shape so the app can ask the same question RaceFacer's picker asks:
--  what can go on THIS kart?
--
--  TWO IDS, AND THEY ARE NOT INTERCHANGEABLE — this is the whole point of the table:
--    part_id   the warehouse part. What the app sends and what a repair is matched on.
--    stock_id  the stock BATCH. What RaceFacer's form actually submits.
--  One part has many batches, so the two are different numbers from different sequences.
--
--  Deliberately NOT published to realtime: it changes when stock moves, nobody needs it to the
--  second, and the app reads it when a repair card opens.
-- ============================================================================================

create table if not exists public.rf_type_parts (
  kart_type_id int         not null,          -- RaceFacer's kart_type_id (1 = Adult Track, …)
  part_id      int         not null,          -- warehouse part id — what the app sends
  stock_id     int         not null,          -- stock batch id — what RaceFacer's form submits
  name         text        not null,
  price        numeric     not null default 0,
  max_qty      int         not null default 0,   -- RaceFacer's count for the chosen batch
  updated_at   timestamptz not null default now(),
  primary key (kart_type_id, part_id)
);

-- The app's only read: one kart type, alphabetical.
create index if not exists rf_type_parts_type on public.rf_type_parts (kart_type_id, name);

alter table public.rf_type_parts enable row level security;

-- Read-only to the app with the anon key; the runner's service key bypasses RLS to write it.
drop policy if exists rf_type_parts_read on public.rf_type_parts;
create policy rf_type_parts_read on public.rf_type_parts
  for select to anon, authenticated using (true);

-- Until the runner next reads a damage page this is empty, and the app falls back to the full
-- warehouse list — the behaviour you have today. It populates on the next repair push or boot.
