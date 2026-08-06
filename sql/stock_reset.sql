-- Reset stock data feature — adds a per-part baseline the usage/prediction maths ignores everything before.
-- Run once in the Supabase SQL editor. Non-destructive: no history is deleted; "Reset" just moves this
-- timestamp forward, so a part's usage, reorder predictions and 0/6 yield gate start fresh from that point.

alter table public.parts add column if not exists stats_reset_at timestamptz;
