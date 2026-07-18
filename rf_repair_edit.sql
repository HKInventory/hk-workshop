-- ============================================================
--  rf_repair_queue: EDIT support (run once in Supabase SQL editor)
--
--  Lets the app edit an existing repair. The queue row carries the
--  repair's RaceFacer id + action='edit'; the runner updates that
--  repair in RaceFacer instead of creating a new one. Idempotent.
-- ============================================================

alter table public.rf_repair_queue add column if not exists action        text;
alter table public.rf_repair_queue add column if not exists rf_repair_id  bigint;
