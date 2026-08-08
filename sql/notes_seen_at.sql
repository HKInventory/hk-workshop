-- WHY: Harvey's complaint all day has been "RaceFacer input is slow to show in the app", and there
-- was no way to put a number on it. rf_kart_notes.created_at is RACEFACER's own timestamp; nothing
-- recorded when the runner actually saw the note. So "is it 5 seconds or 5 minutes?" could only be
-- inferred from per-host request counts, which is how three deploys went out against a cause nobody
-- had measured. seen_at makes the lag a subtraction:
--
--   select round(avg(extract(epoch from (seen_at - created_at)))) avg_s,
--          round(max(extract(epoch from (seen_at - created_at)))) worst_s
--   from rf_kart_notes where seen_at is not null;
--
-- Additive with a default, so it is metadata-only on PG11+ and no writer has to change: the runner
-- does not know this column exists, and the DEFAULT stamps every new row for it.
alter table public.rf_kart_notes
  add column if not exists seen_at timestamptz default now();

-- AND THEN CLEAR IT, WHICH IS THE POINT OF THIS SECOND STATEMENT.
-- I wrote first that existing rows would "stay NULL rather than being back-dated to a lie". They do
-- not: ADD COLUMN ... DEFAULT applies the default to every existing row, so all 9,734 notes on file
-- came out stamped with the moment of the ALTER. Left alone, a note RaceFacer recorded three weeks
-- ago would read as three weeks of lag and the very first query off this column would have been
-- garbage — a measurement that manufactures its own answer, which is worse than no column at all.
-- Every row present at this instant predates the measurement, so NULL is the honest value for all
-- of them: "recorded before we were counting". Only rows written from here carry a real seen_at.
update public.rf_kart_notes set seen_at = null where seen_at is not null;

comment on column public.rf_kart_notes.seen_at is
  'When the runner first stored this note. created_at is RaceFacer''s clock; seen_at is ours. The gap between them IS the RaceFacer-to-app latency. NULL means the note predates this column.';
