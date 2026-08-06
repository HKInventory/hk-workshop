-- ===========================================================================
--  EMERGENCY: get Harvey back in.
--  Supabase -> SQL Editor -> New query -> paste all of this -> Run.
--  Safe to run more than once. Safe whichever button was actually pressed.
-- ===========================================================================
--
--  WHAT HAPPENED
--  The row said "asked for a reset" and had two buttons on it. Either one, used
--  on your own account, locks you out:
--
--    Reset PIN  -> clears your PIN and revokes your sessions. Recoverable on its
--                  own (reopen the app and it offers "create your PIN"), which is
--                  why the screen went "Managers only" first — your session had
--                  just been revoked underneath you.
--    Remove     -> sets the account to disabled AND bans the Supabase login
--                  behind it, replacing its password with a random one that is
--                  never written down. That one is NOT self-recoverable: login
--                  answers "That PIN doesn't match" no matter what you type,
--                  because it fails on status before it ever looks at the PIN.
--
--  This handles both, and does not care which.
-- ---------------------------------------------------------------------------

-- 1. Lift the ban Supabase put on the underlying login.
--    Done first, while hk_accounts still has the email to match on.
update auth.users u
   set banned_until = null
  from public.hk_accounts a
 where a.name = 'Harvey Betts'
   and u.email = a.auth_email;

-- 2. Put the account back, and force a clean re-link of the login.
--    auth_user_id and auth_secret are cleared deliberately: the ban randomised
--    the real password without recording it, so the stored secret is now wrong.
--    Clearing these makes the next sign-in re-find the user by email and set a
--    fresh password it actually knows. auth_email is KEPT — step 1 needs it.
update public.hk_accounts
   set status             = 'active',
       pin_hash           = null,      -- you will choose a new PIN on the way in
       pin_salt           = null,
       must_set_pin       = true,
       failed_count       = 0,
       locked_until       = null,
       reset_requested_at = null,      -- clears the request that started all this
       auth_user_id       = null,
       auth_secret        = null,
       updated_at         = now()
 where name = 'Harvey Betts';

-- 3. Check. Expect exactly one row: active, must_set_pin true, no lock.
select name, app_role, is_master, status, must_set_pin,
       (pin_hash is null) as pin_cleared,
       locked_until, reset_requested_at
  from public.hk_accounts
 where name = 'Harvey Betts';

-- 4. And confirm your devices are still approved — removing an account never
--    touched them, so this should list your Mac and your phone.
select label, kind, owner_name, status, last_seen
  from public.hk_devices
 where status = 'approved'
 order by last_seen desc nulls last;
