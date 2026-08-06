-- ============================================================================================
--  rimo_control_queue — speed and mode commands from the app to RiMO's control page
--  Run once in the Supabase SQL editor. Safe to re-run.
--
--  One row per button press. The runner (rimo_control.js) picks up the NEWEST pending row, sends
--  it to control.rimo-germany.com, and marks the older ones 'superseded' rather than replaying
--  them — putting an older speed on the track after a newer one is the one outcome worse than
--  dropping a command.
--
--  ⚠️  THIS TABLE CHANGES HOW FAST KARTS GO, WITH PEOPLE IN THEM.
--  Every other queue in this system moves records around. This one moves karts. So every row
--  records WHO asked for it, and rows are kept for a fortnight rather than pruned aggressively —
--  "who put the track to 25% during the 2pm race" needs to have an answer tomorrow, not just now.
--
--  Open to every role by design: mechanics and marshals work off iPads and all of them need this
--  during a session. The audit trail is the control, not a permission gate.
-- ============================================================================================

create table if not exists public.rimo_control_queue (
  id         bigserial primary key,
  site       text        not null,
  action     text        not null,          -- 'speed' | 'mode'
  value      text        not null,          -- '25'..'100' for speed; 'pit' / 'stop' / 'standard' … for mode
  label      text,                          -- what the button said, for the log and the audit trail
  karts      text,                          -- comma-separated kart numbers; NULL = every kart
  user_name  text,                          -- who pressed it
  status     text        not null default 'pending',   -- pending | sending | sent | failed | superseded
  error      text,
  reply      text,                          -- what RiMO answered, kept for diagnosing a refusal
  created_at timestamptz not null default now(),
  sent_at    timestamptz
);

-- The runner's one read: this site's pending rows, newest first.
create index if not exists rimo_control_queue_pending
  on public.rimo_control_queue (site, status, id desc);

-- The app's read: the recent history, newest first.
create index if not exists rimo_control_queue_recent
  on public.rimo_control_queue (site, created_at desc);

alter table public.rimo_control_queue enable row level security;

-- The app both writes commands and reads their outcome, with the anon key — the same convention the
-- other queues here use. The runner's service key bypasses RLS.
drop policy if exists rimo_control_queue_rw on public.rimo_control_queue;
create policy rimo_control_queue_rw on public.rimo_control_queue
  for all to anon, authenticated
  using (true) with check (true);

-- Realtime: the app shows the command's outcome (sent / failed) as it happens, and a second device
-- watching the same track should see what was pressed. Low volume — a few rows a session — so
-- unlike rf_passings this one is worth publishing.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'rimo_control_queue'
  ) then
    alter publication supabase_realtime add table public.rimo_control_queue;
  end if;
end $$;

-- Kept a fortnight. This is an audit trail of who changed kart speeds, so it outlives the other
-- queues on purpose.
-- delete from public.rimo_control_queue where created_at < now() - interval '14 days';
