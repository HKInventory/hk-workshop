-- ===========================================================================
--  FROM SUPABASE'S OWN SECURITY LINTER — things the code could not show.
--  Supabase -> SQL Editor -> New query.
--
--  TIER 1 is safe and should be run. TIER 2 needs a decision. TIER 3 is a
--  read-only look before deciding anything.
-- ===========================================================================

-- ###########################################################################
--  TIER 1 · SAFE. Run these.
-- ###########################################################################

-- ---------------------------------------------------------------------------
-- 1.1  staff_pin_backup — A LIVE COPY OF EVERY OLD PIN.
--
--   The whole PIN rotation exists because the old PINs were published. This
--   table is a second copy of them, sitting in the same database, and nothing
--   reads it. RLS is on with no policy, so the API cannot reach it — but a
--   compromised service key or a database dump hands over the lot, and the
--   value of keeping it is zero: those PINs are burned and can never be reused
--   (hk-auth refuses them by name).
--
--   Check what is in it first if you want to see, then drop it.
-- ---------------------------------------------------------------------------
-- select count(*) from public.staff_pin_backup;     -- optional look first
drop table if exists public.staff_pin_backup;

-- ---------------------------------------------------------------------------
-- 1.2  stock_backup_20260728 — a one-off backup from a week ago. Same logic:
--      it is a full copy of stock levels nobody reads. Keep it only if you
--      still need it to compare against.
-- ---------------------------------------------------------------------------
-- drop table if exists public.stock_backup_20260728;

-- ---------------------------------------------------------------------------
-- 1.3  Mutable search_path on two SECURITY DEFINER-adjacent functions.
--
--   A function without a fixed search_path can be tricked into calling
--   somebody else's version of a function it uses, by anyone who can create
--   objects in a schema on the path. Pinning it costs nothing and closes a
--   whole class of privilege escalation.
-- ---------------------------------------------------------------------------
alter function public.touch_updated_at() set search_path = public, pg_temp;
alter function public.rf_debug_trim()    set search_path = public, pg_temp;

-- ###########################################################################
--  TIER 2 · NEEDS A DECISION. Read the note, then uncomment if you agree.
-- ###########################################################################

-- ---------------------------------------------------------------------------
-- 2.1  SIX SECURITY DEFINER FUNCTIONS ANY SIGNED-IN USER CAN CALL.
--
--   hk_db_stats, hk_is_manager, hk_is_staff, hk_realtime_tables, hk_role,
--   hk_staff_name are all reachable at /rest/v1/rpc/<name> by `authenticated`,
--   and they run with the DEFINER's rights rather than the caller's.
--
--   They look like RLS helpers — the kind of function a policy calls to ask
--   "is this person a manager?". A policy calling them does NOT need the
--   caller to have EXECUTE. So unless something in the app calls them directly
--   over REST, revoking EXECUTE is free and removes six functions from the
--   attack surface.
--
--   TIER 3 below shows their definitions so you can see what they do first.
--   Reversible: grant execute back.
-- ---------------------------------------------------------------------------
-- revoke execute on function public.hk_db_stats()        from anon, authenticated;
-- revoke execute on function public.hk_is_manager()      from anon, authenticated;
-- revoke execute on function public.hk_is_staff()        from anon, authenticated;
-- revoke execute on function public.hk_realtime_tables() from anon, authenticated;
-- revoke execute on function public.hk_role()            from anon, authenticated;
-- revoke execute on function public.hk_staff_name()      from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2.2  TWO SECURITY DEFINER VIEWS: staff_public, repair_totals_public.
--
--   Flagged ERROR by the linter, and it explains something from earlier: a
--   SECURITY DEFINER view runs as its CREATOR, so it ignores the querying
--   user's permissions and any RLS on the tables underneath. That is why these
--   two behaved oddly during the lockdown — the grants on the view are the
--   ONLY thing gating them.
--
--   DO NOT flip these blind. The wall display reads repair_totals_public, and
--   switching to security_invoker means the caller then needs rights on the
--   base tables — which is exactly the change that could blank the board.
--   Do it in the same sitting as the display account, with the TV in front of
--   you, not before.
-- ---------------------------------------------------------------------------
-- alter view public.staff_public          set (security_invoker = on);
-- alter view public.repair_totals_public  set (security_invoker = on);

-- ###########################################################################
--  TIER 3 · READ-ONLY. Look before deciding on Tier 2.
-- ###########################################################################

-- What those six functions actually do, and who can run them.
select p.proname,
       pg_get_function_identity_arguments(p.oid) as args,
       p.prosecdef                               as security_definer,
       pg_get_functiondef(p.oid)                 as definition
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('hk_db_stats','hk_is_manager','hk_is_staff',
                     'hk_realtime_tables','hk_role','hk_staff_name')
 order by p.proname;

-- Every table with RLS on but no policy. The hk_* ones are deliberate —
-- server-only, deny everything. Anything else on this list is a table the API
-- cannot read at all, which is either intentional or a surprise.
select c.relname as table_name,
       c.relrowsecurity as rls_on,
       (select count(*) from pg_policies pol
         where pol.schemaname = 'public' and pol.tablename = c.relname) as policies
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
 order by policies, c.relname;
