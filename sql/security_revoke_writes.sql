-- ###########################################################################
--
--   TAKE INSERT AND UPDATE AWAY FROM THE BROWSER ON THE 31 TABLES IT NEVER
--   WRITES TO.  Applied 7 August 2026 as `revoke_authenticated_insert_update`.
--
--   The companion to security_revoke_delete.sql, which did the same for DELETE.
--
-- ###########################################################################
--
-- WHERE THIS STARTED
-- Sixty tables granted INSERT, UPDATE and DELETE to `authenticated`, behind
-- policies that are almost all `using (true)`. DELETE went first, alone, on the
-- 51 tables nothing deleted from. This is the other half.
--
-- WHAT THE APP ACTUALLY WRITES, RESOLVED CALL BY CALL
-- index.html contains 65 `.insert(` / `.update(` / `.upsert(` calls. Each was
-- matched back to its nearest preceding `.from('...')`, and all 65 resolved:
-- 63 to a literal table name, and 2 to `reg.update()` — the service-worker
-- registration, not a database write at all. There are NO dynamic table names,
-- no raw REST POST/PATCH/PUT against /rest/v1, no `.rpc()` calls, and no write
-- helper wrapping `.from`. That matters: it means the literal list IS the
-- complete set, rather than the set I happened to grep for.
--
-- Twenty-nine tables. The other 31 lose INSERT and UPDATE.
--
-- WHY THE SPLIT LANDS SO CLEANLY, WHICH IS THE REASSURING PART
-- The 29 are queues and the app's own state: rf_note_queue, rf_repair_queue,
-- rf_status_queue, rf_kart_edit_queue, rimo_control_queue, plus presence,
-- staff_sessions, tasks, messages, ui_config, user_prefs and so on. The 31 are
-- the authoritative tables — rf_repairs, rf_karts, parts, rf_passings,
-- rimo_bms_history, logs, app_health.
--
-- That is the architecture working as designed: the browser asks by writing to
-- a queue, and the runner or an edge function performs the change with the
-- service key. The grants simply never caught up with it. So this is not a new
-- restriction on the app; it is the grants finally matching what the app does.
--
-- CROSS-CHECKED against pg_stat_statements. Every table with observed INSERT or
-- UPDATE traffic is either in the 29, or is service-role-only and never was
-- browser-writable at all (hk_accounts, hk_devices, hk_sessions, hk_auth_config,
-- app_access, staff). Nothing shows writes that this revoke would break.
--
-- WHO IS UNAFFECTED
-- The runner and all 14 edge functions use the service key, which bypasses
-- grants and RLS. The wall display is read-only. SELECT is untouched everywhere,
-- so nothing that merely reads or subscribes to realtime changes behaviour.

do $$
declare
  -- Every table index.html writes to. Resolved from all 65 write call sites.
  keep text[] := array[
    'ai_convos','ai_queue','chat_groups','chat_reads','kart_check_runs','kart_checks',
    'logins','messages','notif_state','presence','push_subs','rf_kart_edit_queue',
    'rf_kart_notes','rf_kart_types','rf_note_queue','rf_repair_queue','rf_status_queue',
    'rimo_control_queue','rimo_focus','sites','staff_sessions','stock','stock_snapshots',
    'tasks','track_layouts','tv_state','ui_config','user_prefs','venue_map'
  ];
  r record;
  n int := 0;
begin
  for r in
    select distinct table_name
      from information_schema.role_table_grants
     where table_schema = 'public'
       and grantee = 'authenticated'
       and privilege_type in ('INSERT','UPDATE')
       and table_name <> all (keep)
     order by table_name
  loop
    execute format('revoke insert, update on public.%I from authenticated', r.table_name);
    n := n + 1;
  end loop;
  raise notice 'revoked INSERT+UPDATE from authenticated on % tables', n;
end
$$;


-- ---------------------------------------------------------------------------
-- CHECKS
-- ---------------------------------------------------------------------------
-- 1. Exactly the 29 the app writes to remain writable.
select count(distinct table_name) as writable_tables
  from information_schema.role_table_grants
 where table_schema='public' and grantee='authenticated'
   and privilege_type in ('INSERT','UPDATE');        -- expect 29

-- 2. The authoritative tables must be read-only to a browser now.
select t as table_name,
       has_table_privilege('authenticated','public.'||t,'SELECT') as can_read,
       has_table_privilege('authenticated','public.'||t,'INSERT') as can_insert,
       has_table_privilege('authenticated','public.'||t,'UPDATE') as can_update
  from unnest(array['rf_repairs','rf_karts','parts','rimo_bms_history','logs',
                    'rf_passings','app_health','stock_backup_20260728']) t;

-- 3. The queues the app depends on must still be writable, or the floor breaks.
select t as table_name,
       has_table_privilege('authenticated','public.'||t,'INSERT') as can_insert,
       has_table_privilege('authenticated','public.'||t,'UPDATE') as can_update
  from unnest(array['rf_note_queue','rf_repair_queue','rf_status_queue',
                    'rf_kart_edit_queue','rimo_control_queue','presence',
                    'staff_sessions','tasks','messages','stock','ui_config']) t;


-- ---------------------------------------------------------------------------
-- ROLLBACK. Only if a write path was missed. The symptom is a specific action
-- failing with "permission denied for table X" — take the table name from that
-- message and restore just that one.
-- ---------------------------------------------------------------------------
-- grant insert, update on public.<table> to authenticated;
