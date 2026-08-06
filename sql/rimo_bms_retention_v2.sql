-- ============================================================================
--  rimo_bms_history — RETENTION THAT ACTUALLY FINISHES
--
--  THE SCHEMA PART OF THIS FILE IS ALREADY APPLIED. It is kept as the record of
--  what changed and why. The only thing left for you to run is STEP 4, the
--  catch-up, which deletes data and so was left for you to trigger.
--
--  WHAT WAS WRONG (measured on the live database, 6 Aug)
--
--    rimo_bms_history   1,972,649 rows   702 MB heap + 423 MB indexes = 1125 MB
--    whole database                                                     1214 MB
--
--    93% of the database is battery telemetry — and the oldest row was dated
--    25 July, twelve days ago, against a SEVEN day retention. The prune had
--    not succeeded once since the day it was written.
--
--  WHY IT NEVER RAN
--    prune_bms_history's second statement was a correlated self-join: for every
--    row in the 2-7 day band it re-scanned the same band looking for an earlier
--    row in the same 10-second bucket. The planner's own estimate:
--
--      Delete on rimo_bms_history h  (cost=160902.37..3557328.71)
--        ->  Hash Semi Join
--              ->  Seq Scan  rows=1,035,708
--              ->  Hash -> Seq Scan  rows=1,035,708
--
--    Two full scans of a million rows plus a join filter. Minutes, not seconds.
--    PostgREST connects as `authenticator`, which carries statement_timeout=8s,
--    so the call was killed every time. The runner caught that, logged
--    "prune_bms_history unavailable", and fell back to a plain
--    `delete ... where at < cutoff` — which had no index on `at` to work with,
--    seq-scanned 1.97M rows, and was killed by the same 8 seconds. The error
--    went to console.error and the table kept growing ~230 MB a day.
--
--    Nothing in the app or on the wall ever said a word. Same failure shape as
--    everything else we have found: the job reports trouble to a log nobody
--    reads and every screen downstream carries on looking healthy.
--
--  THE FIX (steps 1-3, applied)
--    1. A BRIN index on `at`, so a range delete is a range scan not a table scan.
--    2. Dropped the duplicate index — (serial_no, at) existed twice under two names.
--    3. Rewrote the downsample as a single ranked pass over one time slice at a
--       time, with a row budget, and gave the function its own statement_timeout
--       so the caller's 8-second ceiling can never kill it again.
--
--  WHAT THE CATCH-UP WILL RECLAIM, measured before it runs:
--       302,426 rows past the 7-day cutoff
--     + 825,038 rows in the 2-7 day band sitting within 10s of another sample
--       from the same pack  (80.8% of that band)
--     = 1,127,464 of 1,972,649 rows — about 640 MB.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. INDEX ON `at`.   [APPLIED]
--
--    BRIN, not btree. The table is append-only and physically ordered by time,
--    which is exactly the shape BRIN is for: it stores the min/max `at` per
--    block range instead of one entry per row. A btree here would be ~45 MB on
--    top of the 423 MB of indexes already present; this is a few hundred KB and
--    answers "everything older than X" just as well.
--
--    Measured effect on the retention delete's plan:
--      before   Seq Scan            cost=0.00..139,297
--      after    Bitmap Index Scan   cost=0.00..18.99  ->  36,259 with the limit
-- ---------------------------------------------------------------------------
drop index if exists public.rimo_bms_history_at_brin;
create index rimo_bms_history_at_brin
  on public.rimo_bms_history using brin (at) with (pages_per_range = 8);


-- ---------------------------------------------------------------------------
-- 2. THE SAME INDEX EXISTED TWICE.   [APPLIED]
--
--      rbh_serial_at_idx         (serial_no, at DESC)
--      rimo_bms_history_kart_at  (serial_no, at)
--
--    A btree is readable in both directions, so the second bought nothing and
--    cost a write on every single insert — 385,000 of them on 5 Aug alone —
--    plus its share of the 423 MB. Kept the DESC one: every read in the app is
--    "most recent first".
-- ---------------------------------------------------------------------------
drop index if exists public.rimo_bms_history_kart_at;


-- ---------------------------------------------------------------------------
-- 3. THE PRUNE, REWRITTEN TO FINISH.   [APPLIED]
--
--    Same three windows as before, same meaning. Three things are new:
--
--      batch_rows   a ceiling on how many rows one call may delete. The call
--                   returns `more = true` if it stopped on the ceiling rather
--                   than because it was finished, and the runner calls again.
--                   Nothing is left half-done, it is just done in pieces.
--
--      slice_hours  the downsample walks the 2-7 day band in chunks this wide
--                   instead of ranking the whole million-row band at once. One
--                   sort of ~25k rows per chunk rather than one sort of 1M.
--
--      SET statement_timeout / lock_timeout on the function itself. This is the
--      part that actually mattered. A function-level SET re-arms both for the
--      duration of this call only, so `authenticator`'s 8 seconds — the thing
--      that killed every prune this table has ever had — no longer applies.
--
--    The ranking replaces the self-join. row_number() over (pack, bucket)
--    numbers the samples inside each 10-second bucket in time order; everything
--    after the first is surplus. One pass, no join.
--
--    Measured on a busy 6-hour slice: 6.9s for the old shape's equivalent work,
--    0.8s on a quiet slice. At slice_hours=3 every chunk lands comfortably
--    inside budget even before the raised timeout.
--
--    The old three-argument version had to be dropped rather than replaced —
--    leaving it in place would make a three-argument call ambiguous against the
--    new signature's defaults, and PostgREST would refuse both.
-- ---------------------------------------------------------------------------
drop function if exists public.prune_bms_history(int, int, int);

create or replace function public.prune_bms_history(
  full_hours     int default 48,     -- keep every sample newer than this
  coarse_seconds int default 10,     -- older than that: one sample per pack per N seconds
  retain_days    int default 7,      -- older than this: gone
  batch_rows     int default 200000, -- most rows one call may delete
  slice_hours    int default 3       -- width of one downsample chunk
)
returns table(deleted_old bigint, downsampled bigint, more boolean)
language plpgsql
security definer
set search_path = public
set statement_timeout = '120s'
set lock_timeout = '15s'
as $$
declare
  cut_keep  timestamptz := now() - make_interval(days  => retain_days);
  cut_full  timestamptz := now() - make_interval(hours => full_hours);
  s_from    timestamptz;
  s_to      timestamptz;
  d_old     bigint := 0;
  d_thin    bigint := 0;
  n         bigint := 0;
  budget    int;
begin
  -- Guard rails, so a bad argument can never turn this back into the unbounded
  -- statement it used to be.
  batch_rows     := greatest(1000, least(batch_rows, 1000000));
  slice_hours    := greatest(1, least(slice_hours, 24));
  coarse_seconds := greatest(1, coarse_seconds);

  -- 1. HARD RETENTION. Bounded by ctid so the delete only ever touches
  --    batch_rows rows, however far behind the table has fallen. The BRIN index
  --    turns `at < cut_keep` into a scan of the oldest blocks.
  delete from public.rimo_bms_history
   where ctid in (
     select ctid from public.rimo_bms_history
      where at < cut_keep
      limit batch_rows
   );
  get diagnostics d_old = row_count;

  -- 2. DOWNSAMPLE the 2-7 day band, oldest chunk first, until the budget is
  --    spent or the band is walked. Chunks thinned on an earlier call find
  --    nothing and cost one small scan.
  s_from := cut_keep;
  while s_from < cut_full loop
    budget := batch_rows - d_thin - d_old;
    exit when budget <= 0;

    s_to := least(cut_full, s_from + make_interval(hours => slice_hours));

    delete from public.rimo_bms_history h
     using (
       select id from (
         select id,
                row_number() over (
                  partition by serial_no,
                               div(floor(extract(epoch from at))::bigint, coarse_seconds)
                  order by at, id
                ) as rn
           from public.rimo_bms_history
          where at >= s_from and at < s_to
       ) ranked
      where ranked.rn > 1
      limit budget
     ) surplus
     where h.id = surplus.id;

    get diagnostics n = row_count;
    d_thin := d_thin + n;

    -- Budget spent part-way through a chunk: stop HERE, not at the next chunk,
    -- so the next call re-enters this same chunk and finishes it.
    exit when n >= budget;
    s_from := s_to;
  end loop;

  return query select d_old, d_thin, (d_old + d_thin) >= batch_rows;
end $$;

-- The runner calls this with the service key. Nobody else may call it.
revoke all on function public.prune_bms_history(int, int, int, int, int)
  from public, anon, authenticated;


-- ###########################################################################
--  STEP 4 · THE CATCH-UP. THIS IS THE ONLY PART LEFT TO RUN.
--
--  It deletes about 1.13M rows, so it was left for you rather than done for
--  you. Everything above is already in place, which means the runner's next
--  6-hourly pass will start doing this anyway — this just gets the 640 MB back
--  now instead of over the next few cycles.
--
--  BEFORE YOU RUN IT, one decision: the middle band. Rows older than 7 days go
--  either way, nobody wants those. But the 2-7 day thinning drops per-second
--  cell readings down to one every 10 seconds. If you ever want to look back at
--  a specific race from earlier in the week at full resolution, raise
--  RIMO_HIST_FULL_H on Render first (48 hours today — 120 would keep five days
--  at full rate) and re-run. Anything already thinned cannot be un-thinned.
-- ###########################################################################
do $$
declare r record; rounds int := 0; tot_old bigint := 0; tot_thin bigint := 0;
begin
  loop
    select * into r from public.prune_bms_history(48, 10, 7, 200000, 3);
    tot_old := tot_old + r.deleted_old; tot_thin := tot_thin + r.downsampled;
    rounds := rounds + 1;
    exit when not r.more or rounds >= 40;
  end loop;
  raise notice 'prune caught up in % round(s): % expired, % downsampled',
    rounds, tot_old, tot_thin;
end $$;

-- Deleted rows leave dead space behind. This hands it back to the filesystem.
-- Takes a few minutes on a table this size and LOCKS THE TABLE while it runs,
-- so do it outside trading hours. Skipping it is not harmful — the space is
-- reused by tomorrow's inserts instead of being returned to the disk.
--   vacuum full public.rimo_bms_history;
-- Non-blocking alternative, tidies the statistics without the lock:
--   vacuum (analyze) public.rimo_bms_history;


-- ---------------------------------------------------------------------------
-- 5. CHECK. Expect oldest ≈ 7 days ago, should_be_zero = 0, and a much
--    smaller total.
-- ---------------------------------------------------------------------------
select pg_size_pretty(pg_total_relation_size('public.rimo_bms_history')) as total_size,
       count(*)                                                          as rows,
       min(at)                                                           as oldest,
       count(*) filter (where at < now() - interval '7 days')            as should_be_zero
  from public.rimo_bms_history;
