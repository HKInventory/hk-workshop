-- ============================================================
--  rf_note_queue: DELETE support (run once in Supabase SQL editor)
--
--  The app's red X on a kart note queues a delete for the runner to
--  clear the note in RaceFacer too. That queue row carries an
--  `action` + the note's RaceFacer ids. Without these columns the
--  app's insert fails silently and the X only hides the note locally
--  (never deletes it in RaceFacer). This adds them, idempotently.
-- ============================================================

-- Queue: mark a row as a delete + carry the RaceFacer ids to clear.
alter table public.rf_note_queue add column if not exists action              text;
alter table public.rf_note_queue add column if not exists rf_notification_id  bigint;
alter table public.rf_note_queue add column if not exists rf_kart_note_id     bigint;

-- Stored notes: the runner reads these back to resolve a note's RaceFacer
-- ids when the app only sent the notification id (or none).
alter table public.rf_kart_notes  add column if not exists rf_notification_id bigint;
alter table public.rf_kart_notes  add column if not exists rf_kart_note_id    bigint;

-- Done. The red X now clears the note in RaceFacer as well as in the app.
