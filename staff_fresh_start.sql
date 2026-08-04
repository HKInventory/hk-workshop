-- ===========================================================================
--  Clear the OLD staff list, so everyone signs up again on their own device
--  (or on an approved workshop device) and you set their role on approval.
--  Supabase -> SQL Editor -> New query -> paste -> Run.
--
--  RUN hk-auth's REDEPLOY FIRST. The redeploy is what re-creates a person's
--  entry in this old table when you approve them — without it, people who sign
--  up on the new system stay invisible to the @mention roster and to
--  master-access, which refuses to grant Master Access to a name it cannot find
--  in `staff`.
-- ===========================================================================
--
--  WHAT THIS TABLE IS NOW
--  `staff` is not a sign-in list any more. The sign-in reads hk_accounts, which
--  you already emptied — so nobody but you can get into the app regardless of
--  what is in here. What `staff` still feeds is:
--    * the master-* functions, which authorise on staff.pin
--    * @mentions in chat, and the per-site access screen (via staff_public)
--    * master-access, which will only grant Master Access to a name found here
--
--  WHAT DELETING IT ACTUALLY BUYS YOU
--  The old PINs. Every row here carries one of the eight PINs that sat in the
--  page source, and those PINs still open the master tools today. Deleting the
--  row deletes the PIN with it. That, not the tidiness, is the reason to run it.
--
--  ONE THING IT DOES NOT DO — READ THIS
--  Ross and Andrew will NOT get their master tools back by signing up. Being in
--  the Owner Access list gets them the Master Access tab; every action inside it
--  still asks `staff` for their PIN, and after this they have no usable one. The
--  redeploy re-creates their row on approval with a long random value that can
--  never be typed on a keypad — deliberately, because nobody's PIN goes back
--  into this table, yours included.
--  So until master-* is migrated onto the new session: you can do everything
--  (the owner key is a skeleton key), and they cannot. That is the honest cost
--  of closing the old PINs tonight.
-- ---------------------------------------------------------------------------

-- Everyone except you. Yours stays so master tools keep working without having
-- to reach for the owner key every time.
delete from public.staff where name <> 'Harvey Betts';

-- Check: one row.
select name, role, active from public.staff order by name;

-- And confirm the new system is still just you, waiting for people to ask.
select name, app_role, is_master, status, must_set_pin
  from public.hk_accounts order by name;
