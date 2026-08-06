-- ============================================================================
--  rf_sessions.started_at — record a race from the GREEN FLAG, not the clock
--  Run once in the Supabase SQL editor. Safe to re-run.
--
--  THE PROBLEM: races here routinely start late. BMS cell logging was timed off
--  scheduled_at, so it began recording while the karts were still in the pits
--  and stopped partway through the actual race — which is why kart data kept
--  coming up missing for sessions that clearly ran.
--
--  THE FIX: RaceFacer's session-detail status flips to *_progress the moment an
--  operator hits the green flag (POST /ajax/sessions/manually-start-session).
--  The runner stamps started_at the FIRST cycle it observes that, and the cell
--  logger anchors its recording window to that instant instead of the schedule.
--
--  started_at is written ONCE per session and never moved: later writes omit the
--  column entirely rather than sending null, so an upsert cannot clear it.
--  Sessions predating this column simply have NULL and fall back to the old
--  scheduled-time window, so nothing breaks while the table backfills naturally.
-- ============================================================================

alter table public.rf_sessions
  add column if not exists started_at timestamptz;

comment on column public.rf_sessions.started_at is
  'Observed green flag: when the runner first saw RaceFacer report this session as running. Anchors BMS cell logging. Written once, never updated.';

-- Finding a race by when it actually started is now the common lookup.
create index if not exists rf_sessions_started_at on public.rf_sessions (started_at desc nulls last);
