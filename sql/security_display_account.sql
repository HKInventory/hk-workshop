-- ===========================================================================
--  THE WALL DISPLAY GETS ITS OWN ACCOUNT
--  Supabase -> SQL Editor -> New query -> paste -> Run.  Safe to run twice.
--
--  RUN THIS *BEFORE* ENROLLING THE SCREEN, AND AFTER DEPLOYING hk-auth.
--
--  NOTHING HERE CHANGES ANYTHING FOR ANYONE TODAY.
--  It only adds three columns and grants reads to signed-in sessions. No access
--  is taken away, no key is retired, the board keeps working exactly as it does
--  now until you enrol it. The step that actually closes the door — revoking the
--  public key — is at the bottom, commented out, and must not be run until the
--  board is confirmed working on its own account.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Somewhere to keep the display's own login.
--    display_secret / display_user_id are written by hk-auth and never read by
--    a browser. `site` is which venue this screen shows.
-- ---------------------------------------------------------------------------
alter table public.hk_devices add column if not exists display_secret  text;
alter table public.hk_devices add column if not exists display_user_id uuid;
alter table public.hk_devices add column if not exists site            text;

-- ---------------------------------------------------------------------------
-- 2. What a signed-in session may READ.
--
--    THE BOARD READS NINE TABLES, NOT FOUR. I said four twice and was wrong both
--    times; this list came from reading every query the TV path makes rather than
--    from memory. If a table is missing here the board goes blank on the day the
--    public key is revoked, so it is written out in full:
--      sites, tv_state, rf_karts, rf_repairs, rf_kart_notes,
--      repair_totals_public, tasks, ramp_events, rimo_karts
--    ui_config is included because the board reads it at boot.
--
--    Granted to `authenticated`, which covers both staff sessions and the
--    display's. Tightening the display down to only its own list is a later
--    step and needs RLS policies, not grants — this is the part that must be in
--    place before anything is taken away.
-- ---------------------------------------------------------------------------
grant select on
  public.sites, public.tv_state, public.rf_karts, public.rf_repairs,
  public.rf_kart_notes, public.repair_totals_public, public.tasks,
  public.ramp_events, public.rimo_karts, public.ui_config
to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Check. Every table above should list SELECT for `authenticated`.
--    Anything missing is a table the board will lose when the key is revoked.
-- ---------------------------------------------------------------------------
select table_name, string_agg(privilege_type, ', ' order by privilege_type) as granted
  from information_schema.role_table_grants
 where table_schema = 'public' and grantee = 'authenticated'
   and table_name in ('sites','tv_state','rf_karts','rf_repairs','rf_kart_notes',
                      'repair_totals_public','tasks','ramp_events','rimo_karts','ui_config')
 group by table_name
 order by table_name;

-- ===========================================================================
--  4. DO NOT RUN THIS YET.
--
--  This is the step that makes the published key worthless — the whole point of
--  the exercise. Run it only when ALL of these are true:
--    * the board has been enrolled and approved, and has run for a full day
--      with no red "not signed in" badge in its bottom-left corner;
--    * every screen in the app has been opened by a signed-in person and works;
--    * you are standing in front of the wall display when you run it.
--
--  Reversible: re-grant select to anon on whatever went dark.
-- ===========================================================================
-- revoke all on all tables in schema public from anon;
-- revoke all on all sequences in schema public from anon;
-- revoke all on all functions in schema public from anon;
