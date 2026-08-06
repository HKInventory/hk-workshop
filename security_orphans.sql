-- ===========================================================================
--  WHERE A PERSON ACTUALLY LIVES — find every list still holding someone who
--  no longer has an account, and clear the ones that matter.
--  Supabase -> SQL Editor -> New query -> paste -> Run.
--
--  PART 1 IS READ-ONLY. Run it, look at what comes back, then decide.
-- ===========================================================================
--
--  WHY THIS EXISTS
--  "Rafael still shows in Phones" is not a display bug. A person is written into
--  six different places over their time here, and until now REMOVING them only
--  ever touched one. The one that matters most is push_subs: it is keyed by
--  name, it is what notify-user sends to, and it is not consulted by anything
--  that decides access — so a removed person's phone went on receiving ramp
--  reminders, task assignments and CHAT MESSAGES with nothing on any screen
--  suggesting they still could.
--
--  NOT LISTED HERE ON PURPOSE: messages, rf_repairs, rf_kart_notes, logins.
--  Those are things people WROTE. They are the workshop's record and they stay.
--  Removing someone ends their access; it does not rewrite what happened.
-- ---------------------------------------------------------------------------

-- ---- PART 1 · READ-ONLY. Every name still present somewhere, with no account.
with acct as (select name from public.hk_accounts where status = 'active')
select 'push_subs'     as list, p.name, 'still receives push notifications' as consequence
  from (select distinct name from public.push_subs) p
 where p.name not in (select name from acct)
union all
select 'staff', s.name, 'appears in Master Access, @mentions and the old master PIN check'
  from public.staff s
 where s.name not in (select name from acct)
union all
select 'account_sites', a.staff_name, 'stale per-venue access rows'
  from (select distinct staff_name from public.account_sites) a
 where a.staff_name not in (select name from acct)
union all
select 'hk_devices', d.owner_name, 'an approved device still bound to them'
  from public.hk_devices d
 where d.owner_name is not null and d.status = 'approved'
   and d.owner_name not in (select name from acct)
union all
-- master_admins is JSONB, not a text[] — unnest() rejects it outright, and because
-- the error aborts the whole batch the deletes below never ran the first time.
select 'master_admins', x.nm, 'listed as having Master Access'
  from public.app_access,
       lateral jsonb_array_elements_text(coalesce(master_admins, '[]'::jsonb)) as x(nm)
 where id = 1 and x.nm not in (select name from acct)
order by list, name;

-- ---------------------------------------------------------------------------
-- ---- PART 2 · THE ONE THAT MATTERS. Stop notifying people who are gone.
--      Read part 1 first — this deletes the rows it listed under push_subs.
--      Harmless to the person: if they ever sign up again their phone simply
--      re-registers the first time they open the app.
-- ---------------------------------------------------------------------------
delete from public.push_subs
 where name not in (select name from public.hk_accounts where status = 'active');

-- ---- PART 3 · stale venue access for people who no longer exist.
delete from public.account_sites
 where staff_name not in (select name from public.hk_accounts where status = 'active')
   and staff_name not in (select name from public.staff);

-- ---- PART 4 · check. Part 1 again; push_subs and account_sites should be gone
--      from the results. Anything still listed under `staff` is expected — that
--      table is a directory the master screens still read, and it is emptied by
--      staff_fresh_start.sql, not by this.
with acct as (select name from public.hk_accounts where status = 'active')
select 'push_subs' as list, p.name
  from (select distinct name from public.push_subs) p
 where p.name not in (select name from acct)
union all
select 'account_sites', a.staff_name
  from (select distinct staff_name from public.account_sites) a
 where a.staff_name not in (select name from acct)
order by list, name;
