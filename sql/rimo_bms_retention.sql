-- ============================================================================
--  rimo_bms_history — tiered retention
--  Run once in the Supabase SQL editor. Safe to re-run.
--
--  THE SIZING PROBLEM (measured from the live Render log, 25 Jul):
--    5 races run concurrently, ~30 karts on track at peak, and the cell logger
--    writes one row per kart per second while a race is live (cell voltages move
--    under load, so the write-on-change guard rarely skips).
--
--      30 karts x 3600s          = ~108,000 rows/hour
--      x ~12 trading hours       = ~1.3M rows/day
--      x ~400 bytes/row + index  = ~650 MB/day
--
--    A flat 7-day retention is therefore ~4.5 GB. Supabase Pro includes 8 GB of
--    database storage, so BMS history alone would eat over half the disk before
--    repairs (19k rows), notes, sessions and parts history are counted — and
--    disk over the included allowance is billed.
--
--  THE FIX: keep 7 days, but not all at full resolution. Recent data is what
--  gets debugged ("which cell dropped in the 10:20 race?"); older data is only
--  ever read as a trend, where per-second resolution is noise.
--
--      0-48 h   full 1 Hz                      ~1.3 GB
--      2-7 days thinned to 1 row / 10 s / kart  ~0.33 GB
--      > 7 days deleted
--                                       total  ~1.6 GB
--
--    That keeps a full week of history in a fifth of the space, and leaves
--    plenty of headroom inside the plan.
--
--  Called by the runner's existing 6-hourly prune (rf_sessions.js pruneOld).
--  All three windows are arguments, so they can be retuned without a redeploy.
-- ============================================================================

-- Makes the per-kart bucket scan below an index scan rather than a table scan.
create index if not exists rimo_bms_history_kart_at
  on public.rimo_bms_history (serial_no, at);

create or replace function public.prune_bms_history(
  full_hours     int default 48,   -- keep every sample newer than this
  coarse_seconds int default 10,   -- older than that: one sample per kart per N seconds
  retain_days    int default 7     -- older than this: gone
)
returns table(deleted_old bigint, downsampled bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  cut_keep timestamptz := now() - make_interval(days  => retain_days);
  cut_full timestamptz := now() - make_interval(hours => full_hours);
  d_old  bigint := 0;
  d_thin bigint := 0;
begin
  -- 1. Hard retention.
  delete from public.rimo_bms_history where at < cut_keep;
  get diagnostics d_old = row_count;

  -- 2. Downsample the middle band: keep the EARLIEST row per kart per time bucket,
  --    drop the rest. ctid is used as the tiebreak so this works whether or not the
  --    table has a surrogate key.
  delete from public.rimo_bms_history h
  where h.at >= cut_keep
    and h.at <  cut_full
    and exists (
      select 1
      from public.rimo_bms_history k
      where k.serial_no = h.serial_no
        and k.at >= cut_keep
        and k.at <  cut_full
        and floor(extract(epoch from k.at) / coarse_seconds)
          = floor(extract(epoch from h.at) / coarse_seconds)
        and (k.at < h.at or (k.at = h.at and k.ctid < h.ctid))
    );
  get diagnostics d_thin = row_count;

  return query select d_old, d_thin;
end $$;

-- The runner calls this with the service key. No anon access.
revoke all on function public.prune_bms_history(int, int, int) from public, anon, authenticated;

-- Handy one-off check of what the table is actually costing you:
--   select pg_size_pretty(pg_total_relation_size('public.rimo_bms_history')) as total,
--          count(*) as rows,
--          min(at) as oldest
--   from public.rimo_bms_history;
