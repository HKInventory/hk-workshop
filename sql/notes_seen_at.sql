-- WHY: Harvey's complaint all day has been "RaceFacer input is slow to show in the app", and there
-- was no way to put a number on it. rf_kart_notes.created_at is RACEFACER's own timestamp; nothing
-- records when the runner actually saw the note. So "is it 5 seconds or 5 minutes?" could only be
-- inferred from request counts, which is how three deploys went out against a cause nobody had
-- measured. seen_at makes the lag a subtraction:
--
--   select round(avg(extract(epoch from (seen_at - created_at)))) avg_s,
--          round(max(extract(epoch from (seen_at - created_at)))) worst_s
--   from rf_kart_notes where seen_at > now() - interval '2 hours';
--
-- Additive and default now(), so it is metadata-only on PG11+ (no table rewrite, no lock worth the
-- name) and nothing that writes this table today has to change. Existing rows stay NULL rather than
-- being back-dated to a lie — a row with no seen_at means "recorded before we measured", which is
-- true, and the queries above skip it on their own.
alter table public.rf_kart_notes
  add column if not exists seen_at timestamptz default now();

comment on column public.rf_kart_notes.seen_at is
  'When the runner first stored this note. created_at is RaceFacer''s clock; seen_at is ours. The gap between them IS the RaceFacer-to-app latency.';
