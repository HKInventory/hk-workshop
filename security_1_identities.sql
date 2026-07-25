-- ============================================================================
--  SECURITY — STAGE 1 of 4: give every staff member a real identity
--  Run once in the Supabase SQL editor. Safe to re-run.
--
--  WHY THIS IS NEEDED
--  The anon key is embedded in index.html, so anyone who views source has it.
--  Every table has RLS enabled but with a policy of "using (true)" for anon —
--  RLS is ON but wide open. The 4-digit PIN gates the user interface, not the
--  data: someone with the page URL can read and write the whole database without
--  ever seeing a PIN. Face ID on top of that would be a strong lock on a door
--  that is propped open.
--
--  THE PLAN, IN ORDER. Each stage is safe on its own and changes nothing until
--  the next one lands:
--    1. THIS FILE  — identities + helper functions. Adds a table. Breaks nothing.
--    2. verify-pin — after the PIN checks out, mint a real Supabase Auth session
--                    (see verify-pin.index.ts). The app starts talking to the
--                    database as a PERSON instead of as "anon".
--    3. Prove it   — confirm every staff member reaches an authenticated session
--                    on their own device, over a full shift.
--    4. Policies   — only then swap "to anon" for "to authenticated" per table.
--
--  Stage 4 is the risky one: a wrong policy locks the whole team out mid-shift,
--  which is worse than the current exposure. So it goes last, behind evidence
--  that stage 3 actually worked.
--
--  DAILY EXPERIENCE DOES NOT CHANGE. Staff keep entering the same 4-digit PIN.
--  Their personal email is used once, to create the identity — after that the
--  session lives on the device and the PIN unlocks it. Nobody checks email to
--  start a shift.
-- ============================================================================

-- One row per staff member, linking their Supabase Auth user to the name the rest
-- of the app already knows them by. `staff.name` stays the join key everywhere
-- else, so nothing downstream has to change.
create table if not exists public.app_users (
  auth_uid    uuid primary key references auth.users(id) on delete cascade,
  staff_name  text        not null unique,          -- must match public.staff.name
  email       text        not null unique,          -- personal email; identity only
  role        text,                                 -- mirrored from staff for fast policy checks
  active      boolean     not null default true,    -- false = revoked, keeps the audit trail
  created_at  timestamptz not null default now(),
  last_seen   timestamptz
);

create index if not exists app_users_name on public.app_users (staff_name) where active;

alter table public.app_users enable row level security;

-- A signed-in person may read their OWN row and nothing else. No anon access at
-- all: this table is what the policies in stage 4 will trust, so it must not be
-- readable or writable with the key that ships inside index.html.
drop policy if exists app_users_self on public.app_users;
create policy app_users_self on public.app_users
  for select to authenticated
  using (auth_uid = auth.uid());

-- Writes happen only through the Edge Functions, which use the service key and
-- bypass RLS. Deliberately no insert/update/delete policy for anon or authenticated.


-- ---------------------------------------------------------------------------
--  HELPER FUNCTIONS
--  Stage 4's policies are written in terms of these rather than repeating a
--  subquery in fifty places. Getting the rule right once, here, is the whole
--  point — and it means a fix later is one function, not fifty policies.
--
--  STABLE so the planner calls them once per statement, not once per row.
--  SECURITY DEFINER so they can read app_users regardless of the caller's own
--  policies, with search_path pinned to stop a shadowed table hijacking them.
-- ---------------------------------------------------------------------------

create or replace function public.hk_staff_name()
returns text
language sql stable security definer set search_path = public, auth
as $$
  select u.staff_name from public.app_users u
  where u.auth_uid = auth.uid() and u.active
$$;

create or replace function public.hk_role()
returns text
language sql stable security definer set search_path = public, auth
as $$
  select u.role from public.app_users u
  where u.auth_uid = auth.uid() and u.active
$$;

-- Managers see everything. Matched loosely on purpose: roles are free text in the
-- staff table ("Manager", "Assistant Manager", "General Manager"), and a policy
-- that silently fails to match a real manager's title is a lockout.
create or replace function public.hk_is_manager()
returns boolean
language sql stable security definer set search_path = public, auth
as $$
  select coalesce(public.hk_role() ilike '%manager%', false)
$$;

-- Signed in AND not revoked. This is the baseline every stage-4 policy will use;
-- revoking someone is then a single flag flip, not fifty policy edits.
create or replace function public.hk_is_staff()
returns boolean
language sql stable security definer set search_path = public, auth
as $$
  select exists (
    select 1 from public.app_users u
    where u.auth_uid = auth.uid() and u.active
  )
$$;

revoke all on function public.hk_staff_name()  from public, anon;
revoke all on function public.hk_role()        from public, anon;
revoke all on function public.hk_is_manager()  from public, anon;
revoke all on function public.hk_is_staff()    from public, anon;
grant execute on function public.hk_staff_name() to authenticated;
grant execute on function public.hk_role()       to authenticated;
grant execute on function public.hk_is_manager() to authenticated;
grant execute on function public.hk_is_staff()   to authenticated;


-- ---------------------------------------------------------------------------
--  AFTER RUNNING THIS
--
--  1. Add each person's personal email to the staff list in Master Access, then
--     deploy the updated verify-pin function (verify-pin.index.ts). It creates
--     the auth user and the app_users row on that person's first PIN sign-in —
--     nobody has to click a link or receive anything.
--
--  2. Watch this fill up over a shift. Everyone who has signed in appears here:
--
--       select staff_name, email, role, active, last_seen
--       from public.app_users order by last_seen desc nulls last;
--
--  3. Anyone still missing after a few days is someone whose sign-in is NOT
--     producing a session — find out why before stage 4, because when the
--     policies tighten they are the person who gets locked out.
--
--  REVOKING SOMEONE (they leave): set active = false. They keep their history,
--  every helper above stops recognising them, and once stage 4 lands their
--  device stops being able to read anything.
--
--       update public.app_users set active = false where staff_name = 'Name Here';
-- ============================================================================
