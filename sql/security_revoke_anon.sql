-- ###########################################################################
--
--   THE LAST PUBLIC READ.  Run 7 August 2026 as migration
--   `revoke_anon_reads_display_enrolled`.  Kept here because this repository
--   should be able to rebuild the system, and this is the statement that makes
--   "nothing in the app is public" true.
--
-- ###########################################################################
--
-- WHAT THIS CLOSED
-- These nine were readable by anyone holding the anon key printed in the page
-- source: every repair, every kart note, every task, all stock levels, staff
-- names and roles. No sign-in, no device, nothing. They were open for exactly
-- one reason — the wall display ran on that key and would have gone blank
-- without it.
--
-- THE PRECONDITION, AND IT IS NOT OPTIONAL
-- Do not run this while `display_enrolled` is 0. Check first:
--
--   select count(*) from public.hk_devices where display_secret is not null;
--
-- On 7 Aug that was 1: the board holds its own read-only display account,
-- scoped to one site, revocable in one tap, and renews its own session five
-- minutes ahead of expiry via tvAuthWatch. Two display_signin events were in
-- hk_auth_log before this ran, the second one the watchdog renewing unprompted.
--
-- `authenticated` keeps SELECT on all nine, so the board and every signed-in
-- person are unaffected. The runner uses the service key and never sees this.

revoke select on
  public.rf_karts, public.rf_repairs, public.rf_kart_notes,
  public.tasks, public.stock, public.tv_state, public.ui_config,
  public.staff_public, public.repair_totals_public
from anon;


-- ---------------------------------------------------------------------------
-- CHECK. Expect 0. This is the most important number in the project.
-- ---------------------------------------------------------------------------
select 'anon grants remaining' as check, count(*) as value
  from information_schema.role_table_grants
 where table_schema = 'public' and grantee = 'anon';

-- And prove it from outside, which is the only proof that counts. With the anon
-- key from index.html:
--   GET /rest/v1/rf_repairs?select=id&limit=1
-- must answer 401 `permission denied for table rf_repairs`. On 7 Aug all four
-- tables tested answered exactly that.


-- ---------------------------------------------------------------------------
-- ROLLBACK. If the wall display goes dark, put it back first and diagnose
-- second — a blank board on a workshop floor is not the place to be curious.
-- Then check `display_enrolled`, because a board that lost its account is the
-- only thing this revoke can break.
-- ---------------------------------------------------------------------------
-- grant select on
--   public.rf_karts, public.rf_repairs, public.rf_kart_notes,
--   public.tasks, public.stock, public.tv_state, public.ui_config,
--   public.staff_public, public.repair_totals_public
-- to anon;
