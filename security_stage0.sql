-- ============================================================================
--  SECURITY — STAGE 0.  Close the two doors that make everything else pointless.
--  Run this in: Supabase Dashboard -> SQL Editor -> New query -> paste -> Run.
--  Safe to run more than once. Reversible (the undo is at the bottom).
--
--  WHY THESE TWO TABLES, AND WHY BEFORE ANYTHING ELSE
--
--  app_access decides who is a MASTER ADMIN. The master-* edge functions read it
--  with the service key and trust it completely. It currently sits under a
--  "for all to anon using (true) with check (true)" policy, which means anyone
--  holding the anon key out of the page source can run:
--
--      update app_access set master_admins = master_admins || '["Them"]';
--
--  ...and has just promoted themselves to master admin of the whole system. Every
--  other control we are about to build reads authority from this table, so if it
--  stays writable the rest of the lockdown is decoration.
--
--  config is the same shape and is where a kill-switch would naturally live. A
--  kill-switch an attacker can flip is not a kill-switch, so it gets locked now,
--  and the real runtime flag lands in its own table in Stage 1.
--
--  READS STAY OPEN. The app reads both tables on boot, before anyone has logged
--  in, to decide which tabs to draw. Closing reads here would blank the home
--  screen for the floor. Only WRITES close, and only for anon. The runner and the
--  edge functions use the service key, which bypasses RLS entirely, so nothing
--  they do changes. Nothing a mechanic does touches these tables either.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. app_access — read by everyone, written by nobody with a browser
-- ---------------------------------------------------------------------------
alter table public.app_access enable row level security;

drop policy if exists app_access_rw   on public.app_access;
drop policy if exists app_access_read on public.app_access;

create policy app_access_read on public.app_access
  for select to anon, authenticated
  using (true);

-- No insert/update/delete policy is created, so under RLS those are denied for
-- anon and authenticated. Service key is unaffected (it bypasses RLS).
revoke insert, update, delete on public.app_access from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. config — same treatment
-- ---------------------------------------------------------------------------
alter table public.config enable row level security;

drop policy if exists config_rw   on public.config;
drop policy if exists config_read on public.config;

create policy config_read on public.config
  for select to anon, authenticated
  using (true);

revoke insert, update, delete on public.config from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. PROVE IT WORKED.  Run these two and read the output.
-- ---------------------------------------------------------------------------

-- (a) Both tables should now show ONLY a SELECT policy. Any row saying
--     cmd = ALL, or with_check = true, means something above did not apply.
select tablename, policyname, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public' and tablename in ('app_access', 'config')
order by tablename, policyname;

-- (b) anon must have no write privilege left on either table.
--     EXPECTED RESULT: zero rows.
select grantee, table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('app_access', 'config')
  and grantee in ('anon', 'authenticated')
  and privilege_type in ('INSERT', 'UPDATE', 'DELETE');

-- ---------------------------------------------------------------------------
-- 4. THE WHOLE PICTURE — worth running once so you can see what is still open.
--     Every row that comes back with roles containing 'anon' and qual 'true'
--     is a table anyone on the internet can currently read or write. This is the
--     list Stage 1 works through, table by table.
-- ---------------------------------------------------------------------------
select tablename, policyname, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public' and 'anon' = any(roles)
order by (cmd = 'ALL') desc, tablename;

-- ---------------------------------------------------------------------------
-- UNDO — only if the app misbehaves after running this.
-- Paste and run just this block to put things back exactly as they were.
-- ---------------------------------------------------------------------------
-- grant insert, update, delete on public.app_access to anon, authenticated;
-- grant insert, update, delete on public.config     to anon, authenticated;
-- drop policy if exists app_access_read on public.app_access;
-- drop policy if exists config_read     on public.config;
-- create policy app_access_rw on public.app_access for all to anon, authenticated using (true) with check (true);
-- create policy config_rw     on public.config     for all to anon, authenticated using (true) with check (true);
