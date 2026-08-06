-- ============================================================
--  rf_repairs: original-note column (run once in Supabase SQL editor)
--
--  RaceFacer's Repairs tab expands each repair (the +) to show the
--  ORIGINAL note it was logged against, separate from the annotation
--  (what was done). This column stores that note so the app shows the
--  same. Safe/idempotent; the runner fills it going forward.
-- ============================================================

alter table public.rf_repairs add column if not exists damage_note text;
