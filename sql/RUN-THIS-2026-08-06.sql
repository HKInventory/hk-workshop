-- ###########################################################################
--
--   ONE PASTE. Supabase -> SQL Editor -> New query -> paste all of it -> Run.
--
--   This is items 1, 2, 3 and 4 of the list, in one go, in the order they have
--   to happen. Safe to run twice. Every part ends with a check you can read.
--
--   Item 8 (Andrew's devices) is at the bottom as a READ-ONLY listing — see the
--   note there for why I am not deleting anything on his behalf.
--
--   WHAT THIS DOES NOT DO: it does not revoke the public key. That is the last
--   step of the whole exercise and it has to happen with the wall display in
--   front of you. Part E lays the groundwork for it and takes nothing away.
--
-- ###########################################################################


-- ===========================================================================
--  PART A · RECLAIM 640 MB.        (item 1)
--
--  rimo_bms_history is 1,972,649 rows and 1125 MB — 93% of the whole database.
--  The retention prune never once succeeded; the rewritten function is already
--  installed and the runner is already deploying with the loop that drives it.
--  This just gets the backlog back now rather than over the next few cycles.
--
--    302,426 rows past the 7-day cutoff
--  + 825,038 rows in the 2-7 day band within 10s of another reading from the
--    same pack (80.8% of that band)
--  = 1,127,464 rows, about 640 MB.
--
--  ONE DECISION BEFORE YOU RUN IT. The middle band drops from per-second cell
--  readings to one every 10 seconds. Rows past 7 days go either way — nobody
--  wants those. But if you might want to look back at a race from earlier this
--  week at full resolution, raise RIMO_HIST_FULL_H on Render FIRST (48 hours
--  today; 120 keeps five days at full rate). Thinned cannot be un-thinned.
--
--  Takes a minute or two. The SQL editor has no 8-second limit, which is the
--  whole reason this never ran from the runner.
-- ===========================================================================
do $$
declare r record; rounds int := 0; tot_old bigint := 0; tot_thin bigint := 0;
begin
  loop
    select * into r from public.prune_bms_history(48, 10, 7, 200000, 3);
    tot_old := tot_old + r.deleted_old; tot_thin := tot_thin + r.downsampled;
    rounds := rounds + 1;
    exit when not r.more or rounds >= 40;
  end loop;
  raise notice 'BMS prune caught up in % round(s): % expired, % downsampled',
    rounds, tot_old, tot_thin;
end $$;

-- Check A. Expect oldest ≈ 7 days ago and should_be_zero = 0.
select 'A · bms history' as part,
       pg_size_pretty(pg_total_relation_size('public.rimo_bms_history')) as size,
       count(*) as rows,
       min(at)::date as oldest,
       count(*) filter (where at < now() - interval '7 days') as should_be_zero
  from public.rimo_bms_history;


-- ===========================================================================
--  PART B · THE LAST FIVE LISTS A REMOVED PERSON LIVES IN.     (item 2)
--
--  security_orphans.sql cleared push_subs and account_sites and it worked. It
--  did not check every list. These five still hold people with no account:
--
--    presence              Jayden Aginsky, Rafael Hewitt
--    user_prefs            Rafael Hewitt
--    staff                 Andrew Richardson Computer
--    account_sites         Andrew Richardson Computer (sydney, melbourne)
--    app_access.overrides  Charbel Tawk
--
--  presence is the one you could see — it drives the who-is-here list, which is
--  where "Rafael still shows here" was coming from.
--
--  "Andrew Richardson Computer" is not a person. It is Andrew's Mac, registered
--  as a second staff member back when a new device meant a new name.
--
--  Nothing anyone WROTE is touched. Messages, repairs, notes and login history
--  all stay — removing someone ends their access, it does not rewrite what
--  happened on the floor.
-- ===========================================================================
delete from public.presence
 where name not in (select name from public.hk_accounts where status = 'active');

delete from public.user_prefs
 where name not in (select name from public.hk_accounts where status = 'active');

-- account_sites before staff: it has a foreign key onto staff.name.
delete from public.account_sites
 where staff_name not in (select name from public.hk_accounts where status = 'active');

delete from public.staff
 where name not in (select name from public.hk_accounts where status = 'active');

-- Strip override entries whose person no longer exists, keep everyone else's.
update public.app_access
   set overrides = coalesce((
         select jsonb_object_agg(x.key, x.value)
           from jsonb_each(overrides) x
          where x.key in (select name from public.hk_accounts where status = 'active')
       ), '{}'::jsonb),
       updated_at = now()
 where id = 1;

-- Check B. Expect ZERO rows.
with acct as (select name from public.hk_accounts where status = 'active')
select 'B · ghosts left' as part, 'presence' as list, p.name from public.presence p where p.name not in (select name from acct)
union all select 'B · ghosts left','user_prefs',           u.name       from public.user_prefs u    where u.name       not in (select name from acct)
union all select 'B · ghosts left','staff',                s.name       from public.staff s         where s.name       not in (select name from acct)
union all select 'B · ghosts left','account_sites',        a.staff_name from public.account_sites a where a.staff_name not in (select name from acct)
union all select 'B · ghosts left','app_access.overrides', x.key        from public.app_access, lateral jsonb_each(overrides) x
                                                          where id = 1 and x.key not in (select name from acct);


-- ===========================================================================
--  PART C · DESTROY THE OLD PINS.        (item 4)
--
--  staff_pin_backup is a live second copy of every PIN from before the rotation
--  — the PINs that were published, which is the whole reason the rotation
--  happened. Twelve rows. Nothing reads it. RLS is on with no policy so the API
--  cannot reach it, but a database dump or a leaked service key hands over the
--  lot, and keeping it is worth exactly nothing: those PINs are burned and
--  hk-auth refuses them by name.
--
--  Look first if you want:  select * from public.staff_pin_backup;
-- ===========================================================================
drop table if exists public.staff_pin_backup;

-- stock_backup_20260728 is the same argument with lower stakes: a one-off copy
-- of stock levels from a week ago that nothing reads. Uncomment if you no
-- longer need it to compare against.
-- drop table if exists public.stock_backup_20260728;

-- Check C. Expect ZERO rows.
select 'C · backups left' as part, c.relname
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
   and c.relname in ('staff_pin_backup','stock_backup_20260728');


-- ===========================================================================
--  PART D · GROUNDWORK FOR THE WALL DISPLAY.        (item 3, part one)
--
--  THIS TAKES NOTHING AWAY AND CHANGES NOTHING TODAY. It adds three columns and
--  grants reads to signed-in sessions. The board keeps running on the public
--  key exactly as it does now.
--
--  The board reads NINE tables, not four. That list came from reading every
--  query the TV path makes, not from memory — if one were missing the board
--  would go blank the day the public key is revoked, so it is written out.
--
--  What is left after this: enrol the screen (on the TV, physically), watch it
--  for a day with no red "not signed in" badge, THEN revoke anon — standing in
--  front of the display. That last step is in security_display_account.sql,
--  commented out, and it is the one that makes the published key worthless.
-- ===========================================================================
alter table public.hk_devices add column if not exists display_secret  text;
alter table public.hk_devices add column if not exists display_user_id uuid;
alter table public.hk_devices add column if not exists site            text;

grant select on
  public.sites, public.tv_state, public.rf_karts, public.rf_repairs,
  public.rf_kart_notes, public.repair_totals_public, public.tasks,
  public.ramp_events, public.rimo_karts, public.ui_config
to authenticated;

-- Check D. Expect all TEN tables listed, each with SELECT.
select 'D · board can read' as part, table_name,
       string_agg(privilege_type, ', ' order by privilege_type) as granted
  from information_schema.role_table_grants
 where table_schema = 'public' and grantee = 'authenticated'
   and table_name in ('sites','tv_state','rf_karts','rf_repairs','rf_kart_notes',
                      'repair_totals_public','tasks','ramp_events','rimo_karts','ui_config')
 group by table_name order by table_name;


-- ===========================================================================
--  PART E · READ-ONLY. Devices nobody has used since the day they were
--           approved.        (item 8)
--
--  I said earlier that two of Andrew's three devices were dead. Reading it
--  again: ALL THREE show no use since 4 August — he simply has not opened the
--  app in two days. So there is no "these two are the strays" to act on, and
--  deleting any of them would just mean he has to ask for approval again.
--
--  Left as a listing on purpose. Use Manage Devices in the app to remove the
--  ones you know are gone — that screen exists for exactly this and it is
--  quicker than SQL.
-- ===========================================================================
select 'E · unused devices' as part,
       owner_name, kind, platform,
       created_at::date as approved_on,
       coalesce(to_char(last_seen,'Mon DD HH24:MI'), 'never') as last_used,
       case when last_seen is null or last_seen < created_at + interval '10 minutes'
            then 'never really used' else 'in use' end as verdict
  from public.hk_devices
 where status = 'approved'
 order by owner_name, created_at;
