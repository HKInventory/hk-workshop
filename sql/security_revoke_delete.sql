-- ###########################################################################
--
--   TAKE DELETE AWAY FROM THE BROWSER, EXCEPT WHERE THE APP ACTUALLY USES IT.
--   Applied 7 August 2026 as migration `revoke_authenticated_delete`.
--
-- ###########################################################################
--
-- WHAT WAS TRUE BEFORE THIS RAN
-- Sixty tables granted INSERT, UPDATE and DELETE to `authenticated`, and every
-- one of the sixty granted DELETE. Their policies are almost all `using (true)`,
-- so RLS added nothing. In practice: any signed-in session — or anybody holding
-- a token taken from a signed-in session — could issue
--
--     DELETE FROM rf_repairs
--
-- and remove all 19,578 repair records. Or rimo_bms_history (~1 GB of battery
-- history), or stock, or rf_karts, or stock_backup_20260728, which is the backup.
-- Nothing in the app does any of that. The capability existed only because the
-- grants were handed out wholesale.
--
-- WHAT THE APP ACTUALLY DELETES, COUNTED RATHER THAN ASSUMED
-- index.html contains exactly 13 `.delete()` calls, every one naming its table
-- inline, and there are ZERO raw `method:'DELETE'` fetches. They touch nine
-- tables, which are the nine kept below:
--
--     presence          4976, 6517     kart_checks      10693, 10788
--     kart_check_runs   10694          push_subs        19234
--     ai_convos         20388          ai_queue         20389
--     messages          20996, 21287, 21496
--     chat_groups       21288          tasks            21493
--
-- So 51 of the 60 grants were never exercised by anything. Removing them cannot
-- change what the app does; it only removes what an attacker could do.
--
-- CROSS-CHECKED AGAINST WHAT HAS ACTUALLY RUN. pg_stat_statements shows DELETEs
-- only against parts, staff, account_sites, presence and user_prefs. All except
-- presence are service-role operations (master-staff replacing the roster,
-- admin part edits, and a one-off cleanup done during this security work).
-- That corroborates the code reading; it does not replace it, because
-- pg_stat_statements is normalised, has bounded retention and does not record
-- the role. The CODE is the authority here, and the code was read exhaustively.
--
-- WHO IS UNAFFECTED
-- The runner and every edge function use the service key, which bypasses grants
-- and RLS entirely. hk_close_idle_sessions() runs as postgres via pg_cron. The
-- wall display is a read-only account and deletes nothing. Nothing outside a
-- browser loses anything here.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
-- INSERT and UPDATE are untouched. Narrowing those needs a per-table reading of
-- what the app legitimately writes and is a much larger change with real
-- breakage risk on a live floor; it is worth doing separately and carefully.
-- DELETE is the one that is both the most destructive and the most obviously
-- unused, so it goes first and alone. Staging it this way means that if
-- something does break, there is exactly one candidate cause.

do $$
declare
  -- The nine the app genuinely deletes from. Everything else loses DELETE.
  keep text[] := array[
    'presence', 'kart_checks', 'kart_check_runs', 'push_subs',
    'ai_convos', 'ai_queue', 'messages', 'chat_groups', 'tasks'
  ];
  r record;
  n int := 0;
begin
  for r in
    select distinct table_name
      from information_schema.role_table_grants
     where table_schema = 'public'
       and grantee = 'authenticated'
       and privilege_type = 'DELETE'
       and table_name <> all (keep)
     order by table_name
  loop
    execute format('revoke delete on public.%I from authenticated', r.table_name);
    n := n + 1;
  end loop;
  raise notice 'revoked DELETE from authenticated on % tables', n;
end
$$;


-- ---------------------------------------------------------------------------
-- CHECKS
-- ---------------------------------------------------------------------------
-- 1. Exactly the nine kept tables still grant DELETE. Expect 9 rows.
select table_name
  from information_schema.role_table_grants
 where table_schema='public' and grantee='authenticated' and privilege_type='DELETE'
 order by table_name;

-- 2. The ones that matter most must be gone. Expect false for every row.
select t as table_name, has_table_privilege('authenticated','public.'||t,'DELETE') as can_delete
  from unnest(array['rf_repairs','rimo_bms_history','stock','rf_karts','logs',
                    'rf_passings','stock_backup_20260728','staff_sessions']) t;

-- 3. INSERT/UPDATE deliberately unchanged — this should still be 60.
select count(distinct table_name) as still_writable
  from information_schema.role_table_grants
 where table_schema='public' and grantee='authenticated'
   and privilege_type in ('INSERT','UPDATE');


-- ---------------------------------------------------------------------------
-- ROLLBACK. Only if a delete path was missed. The symptom would be a specific
-- action in the app failing with "permission denied for table X" — note the
-- table name from that message and restore just that one, rather than all 51.
-- ---------------------------------------------------------------------------
-- grant delete on public.<table> to authenticated;
