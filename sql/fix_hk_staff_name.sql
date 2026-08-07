-- ###########################################################################
--
--   THE IDENTITY FUNCTION WAS POINTED AT AN EMPTY TABLE.
--   Applied 7 August 2026 as migration `fix_hk_staff_name_use_hk_accounts`.
--
-- ###########################################################################
--
-- WHAT WAS WRONG
-- public.hk_staff_name() is the function that answers "which staff member is
-- this signed-in session?". It is the natural thing to reach for when writing a
-- per-person RLS policy. It read public.app_users:
--
--     select u.staff_name from public.app_users u
--      where u.auth_uid = auth.uid() and u.active
--
-- app_users has ZERO rows. It always did. So the function returned NULL for
-- everybody, always, and a policy written the obvious way —
--
--     using (name = hk_staff_name())
--
-- — denies every row to every person, with no error to explain why.
--
-- WHY THIS IS THE ROOT CAUSE OF SOMETHING BIGGER
-- Roughly sixty tables carry `authenticated` write policies of the form
-- `using (true)`. That looks like nobody bothered. It is at least as likely
-- that somebody DID bother, wrote the correct policy, watched it lock the floor
-- out, could not see why an obviously-correct policy denied everything, and
-- backed out to `using (true)`. An identity function that silently returns NULL
-- produces exactly that outcome and leaves no trace.
--
-- THE MAPPING WAS THERE THE WHOLE TIME, IN A DIFFERENT TABLE
-- Measured 7 Aug before touching anything:
--     active hk_accounts rows ............................. 6
--     ...with auth_user_id set ............................ 6
--     ...whose auth_user_id matches a real auth.users row . 6
--     app_users rows ...................................... 0
-- hk_accounts is what hk-auth actually maintains. app_users is a legacy table
-- that nothing writes to. It is left in place rather than dropped — dropping a
-- table is not needed to fix this, and this project has enough history of
-- things being removed and then wanted.
--
-- SAFE TO REDEFINE, CHECKED RATHER THAN ASSUMED
-- Nothing referenced this function: no RLS policy, no view, no other function,
-- no column default, and no line of index.html, the edge functions or the
-- runner. It has never been called in anger. Changing its body therefore cannot
-- change any current behaviour — it can only stop the NEXT policy being wrong.

create or replace function public.hk_staff_name()
returns text
language sql
stable
security definer
set search_path = public, auth
as $$
  select a.name
    from public.hk_accounts a
   where a.auth_user_id = auth.uid()
     and a.status = 'active'
$$;

-- EXECUTE for signed-in users, and only them. A policy expression is evaluated
-- as the querying role, so without this a policy using hk_staff_name() fails
-- with "permission denied for function" — which is the same dead end by a
-- different route. It leaks nothing: it returns the caller's OWN name and
-- nothing else, and it is STABLE so it cannot be used to probe other rows.
revoke all on function public.hk_staff_name() from public, anon;
grant execute on function public.hk_staff_name() to authenticated;


-- ---------------------------------------------------------------------------
-- CHECKS
-- ---------------------------------------------------------------------------
-- 1. The mapping resolves for every active account. Expect matched = 6, and
--    every row's resolved name equal to its own name. This is the real test:
--    auth.uid() is NULL in the SQL editor, so calling hk_staff_name() here
--    always returns NULL and proves nothing. Simulate it per account instead.
select a.name,
       (select a2.name from public.hk_accounts a2
         where a2.auth_user_id = a.auth_user_id and a2.status = 'active') as resolves_to,
       (select a2.name from public.hk_accounts a2
         where a2.auth_user_id = a.auth_user_id and a2.status = 'active') = a.name as correct
  from public.hk_accounts a
 where a.status = 'active'
 order by a.name;

-- 2. One account must map to exactly one name — a duplicate auth_user_id would
--    make the function non-deterministic. Expect zero rows.
select auth_user_id, count(*) as accounts
  from public.hk_accounts
 where status = 'active' and auth_user_id is not null
 group by auth_user_id having count(*) > 1;

-- 3. Privileges: authenticated EXECUTE, anon none.
select proname,
       has_function_privilege('authenticated', oid, 'EXECUTE') as authenticated_exec,
       has_function_privilege('anon',          oid, 'EXECUTE') as anon_exec
  from pg_proc where proname = 'hk_staff_name';


-- ---------------------------------------------------------------------------
-- ROLLBACK. Restores the old body exactly. Note that "rolling back" here means
-- going back to a function that returns NULL for everyone, so only do this if
-- something genuinely depended on that.
-- ---------------------------------------------------------------------------
-- create or replace function public.hk_staff_name()
-- returns text language sql stable security definer
-- set search_path to 'public', 'auth'
-- as $$ select u.staff_name from public.app_users u
--        where u.auth_uid = auth.uid() and u.active $$;
