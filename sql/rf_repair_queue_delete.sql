-- ============================================================
--  rf_repair_queue: DELETE support (run once in Supabase SQL editor)
--
--  The app's red X on a repair row queues a delete for the runner to
--  remove the repair in RaceFacer too. That queue row carries an
--  `action` of 'delete' plus the repair's RaceFacer id.
--
--  Without the `action` column the insert FAILS and the X does
--  nothing at all — same trap the kart-note delete hit, which is why
--  rf_note_queue_action.sql exists alongside this one.
--
--  `repair_id` is very likely already there: an EDIT is the same push
--  carrying repair_id, and that has been in use for a while. It is
--  added here anyway because `if not exists` makes that free, and a
--  half-migrated queue is worse than a redundant line.
--
--  The route this feeds, captured from RaceFacer's own Damages page
--  on 31 July 2026:
--    POST /ajax/garage/damage/delete   ·   repair_id=<id>
--  See rfDeleteDamage in rf_push_repairs.js.
-- ============================================================

alter table public.rf_repair_queue add column if not exists action    text;
alter table public.rf_repair_queue add column if not exists repair_id bigint;

-- Done. The red X now removes the repair from RaceFacer, from Supabase,
-- and from every device — rather than only from the screen you tapped it on.
