-- ============================================================
--  SESSION DATA — hard reset (run once in Supabase SQL editor)
--  Wipes all stored race sessions, per-kart runs and BMS cell
--  history so the app starts a CLEAN, rolling 7-day window from
--  today. The runner immediately begins re-capturing every
--  session as its chequered flag drops, and prunes anything
--  older than 7 days automatically.
-- ============================================================

-- 1. Per-kart BMS cell traces (voltage / temp per session)
truncate table public.rimo_bms_history;

-- 2. Per-kart run rows (who ran in which session, laps, best)
truncate table public.rf_session_runs;

-- 3. The sessions themselves
truncate table public.rf_sessions;

-- Done. From this moment the app shows only sessions captured
-- from today onward, growing to a full rolling 7 days.
