-- ============================================================================
--  FRESH START — run this in Supabase -> SQL Editor -> New query -> Run.
--
--  RUN IT ONLY AFTER hk-auth HAS BEEN REDEPLOYED. The redeploy is what adds the
--  "I'm not on this list" route. Without it, wiping the accounts leaves everyone
--  except Harvey looking at a picker with one name on it and no way to ask for
--  their own — the workshop Macs are already approved, so they never see the
--  screen that asks who you are.
--
--  Safe to run more than once.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PART 1 — the two revokes that were missed.
--
-- The earlier lockdown loop walked pg_tables, which lists tables only. These two
-- are VIEWS, so it skipped them, and both were left with write rights for the
-- key that is printed in the page source. repair_totals_public is the live one:
-- anyone holding that key could DELETE the repair leaderboard, or TRUNCATE it.
-- SELECT stays, because the wall display and the app both read these.
-- ---------------------------------------------------------------------------
revoke all on public.repair_totals_public from anon, authenticated;
revoke all on public.staff_public         from anon, authenticated;
grant  select on public.repair_totals_public to anon, authenticated;
grant  select on public.staff_public         to anon, authenticated;

-- ---------------------------------------------------------------------------
-- PART 2 — everyone starts again.
--
-- Every account except Harvey's goes. Nobody is "already in" — each person asks,
-- gets approved with a role, and chooses their own PIN, which nobody can read
-- back. Harvey stays because someone has to be able to approve the first person.
-- ---------------------------------------------------------------------------
delete from public.hk_accounts where name <> 'Harvey Betts';

-- Any pass still in someone's browser stops working now rather than when it
-- happens to expire.
update public.hk_sessions set revoked = true where revoked = false;

-- ---------------------------------------------------------------------------
-- PART 3 — check it.
--
-- Query 1 must show exactly one row: Harvey.
-- Query 2 must show only SELECT for both views. Any INSERT / UPDATE / DELETE /
-- TRUNCATE still listed means part 1 did not take.
-- ---------------------------------------------------------------------------
select name, app_role, is_master, must_set_pin, status
from public.hk_accounts
order by name;

select table_name, grantee, string_agg(privilege_type, ', ' order by privilege_type) as still_granted
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon', 'authenticated')
  and table_name in ('repair_totals_public', 'staff_public')
group by table_name, grantee
order by table_name, grantee;
