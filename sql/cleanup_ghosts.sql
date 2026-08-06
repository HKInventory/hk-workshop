-- ===========================================================================
--  THE LAST FIVE PLACES A REMOVED PERSON IS STILL LIVING.
--  Supabase -> SQL Editor -> New query -> paste -> Run. Safe to re-run.
--
--  security_orphans.sql cleared push_subs and account_sites and it worked —
--  neither holds anybody without an account any more. But it did not check
--  every list, and reading the live database on 6 August turned up five more.
--  This is the rest of the answer to "Rafael still shows here".
-- ===========================================================================

-- ---- PART 1 · READ-ONLY. Exactly what is about to be removed. ------------
with acct as (select name from public.hk_accounts where status = 'active')
select 'presence'             as list, p.name, 'shows in the online/who-is-here list' as consequence
  from public.presence p              where p.name       not in (select name from acct)
union all
select 'user_prefs',           u.name, 'keeps their colour, emoji and avatar'
  from public.user_prefs u            where u.name       not in (select name from acct)
union all
select 'staff',                s.name, 'appears in Master Access, @mentions and the old master PIN check'
  from public.staff s                 where s.name       not in (select name from acct)
union all
select 'account_sites',        a.staff_name, 'still granted a venue'
  from (select distinct staff_name from public.account_sites) a
                                      where a.staff_name not in (select name from acct)
union all
select 'app_access.overrides', x.key, 'carries a personal tab override'
  from public.app_access, lateral jsonb_each(overrides) x
                                      where id = 1 and x.key not in (select name from acct)
order by list, name;

-- Expected on 6 Aug:
--   presence              Jayden Aginsky, Rafael Hewitt
--   user_prefs            Rafael Hewitt
--   staff                 Andrew Richardson Computer
--   account_sites         Andrew Richardson Computer  (sydney, melbourne)
--   app_access.overrides  Charbel Tawk
--
-- "Andrew Richardson Computer" is not a person. It is Andrew's Mac, registered
-- as a second staff member back when signing in on a new device meant creating
-- a new name. He has a real account now; this row is the leftover.

-- ---- PART 2 · REMOVE THEM. -----------------------------------------------
-- Nothing here is anything anyone WROTE. Messages, repairs, notes and the login
-- history all stay — removing someone ends their access, it does not rewrite
-- what happened on the floor.

delete from public.presence
 where name not in (select name from public.hk_accounts where status = 'active');

delete from public.user_prefs
 where name not in (select name from public.hk_accounts where status = 'active');

-- account_sites first: it has a foreign key onto staff.name.
delete from public.account_sites
 where staff_name not in (select name from public.hk_accounts where status = 'active');

delete from public.staff
 where name not in (select name from public.hk_accounts where status = 'active');

-- Strip override entries whose person no longer exists, keeping the rest.
update public.app_access
   set overrides = coalesce((
         select jsonb_object_agg(x.key, x.value)
           from jsonb_each(overrides) x
          where x.key in (select name from public.hk_accounts where status = 'active')
       ), '{}'::jsonb),
       updated_at = now()
 where id = 1;

-- ---- PART 3 · CHECK. Part 1 again. Expect zero rows. ---------------------
with acct as (select name from public.hk_accounts where status = 'active')
select 'presence' as list, p.name from public.presence p where p.name not in (select name from acct)
union all select 'user_prefs',           u.name       from public.user_prefs u    where u.name       not in (select name from acct)
union all select 'staff',                s.name       from public.staff s         where s.name       not in (select name from acct)
union all select 'account_sites',        a.staff_name from public.account_sites a where a.staff_name not in (select name from acct)
union all select 'app_access.overrides', x.key        from public.app_access, lateral jsonb_each(overrides) x
                                                      where id = 1 and x.key not in (select name from acct)
order by list, name;
