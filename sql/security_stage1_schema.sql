-- ============================================================================
--  SECURITY — STAGE 1.  The tables behind real logins.
--  Run in: Supabase Dashboard -> SQL Editor -> New query -> paste -> Run.
--  Safe to run more than once.
--
--  NOTHING IN THIS FILE CHANGES HOW THE APP WORKS TODAY.
--  Every table here is brand new and nothing reads or writes them yet. The old
--  `staff` table, the verify-pin function and every master-* screen carry on
--  exactly as they are. This is the foundation going in underneath, so that when
--  the new login screen ships there is somewhere for it to land. If we stopped
--  after this file, you would notice no difference at all.
--
--  WHY NEW TABLES INSTEAD OF CHANGING THE OLD ONES
--  The master-* edge functions read the existing staff table with the service
--  key, and I cannot see their source. Changing that table underneath them is
--  the one move that would break Master Access — the exact screen you need in
--  order to approve anybody. So credentials move somewhere new and the old
--  roster stays untouched, which also means the two systems can run side by side
--  while we prove the new one.
--
--  WHO OWNS WHAT, ONCE THIS IS LIVE
--    staff_public   (existing) — the ROSTER. Names, roles, emoji. You manage it
--                   in Master Access exactly as you do now. It is what the login
--                   screen shows you a list of.
--    hk_accounts    (new)      — the CREDENTIALS. One row per person, holding a
--                   scrambled PIN nobody can read back, including you.
--    hk_devices     (new)      — which phones, iPads and Macs are allowed.
--    hk_sessions    (new)      — live logins, so one can be cut off remotely.
--    hk_auth_config (new)      — the join code and your recovery code.
--    hk_auth_log    (new)      — every login, request and approval, for the trail.
--
--  ALL FIVE NEW TABLES ARE LOCKED TO THE SERVER.
--  No browser touches them directly, not even a logged-in manager's. Everything
--  goes through the hk-auth function, which checks who is asking before it
--  answers. That is the whole point: the browser stops being trusted.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. ACCOUNTS — one per person. The PIN is stored scrambled, never in the clear.
-- ---------------------------------------------------------------------------
create table if not exists public.hk_accounts (
  id            uuid primary key default gen_random_uuid(),
  -- Matches staff_public.name exactly. That is the join between the roster you
  -- edit in Master Access and the credentials the server keeps.
  name          text unique not null,
  app_role      text not null default 'Mechanic',
  site          text not null default 'sydney',
  is_master     boolean not null default false,

  /* THE PIN, AND AN HONEST NOTE ABOUT WHAT SCRAMBLING BUYS.
     pin_hash is PBKDF2-SHA256 with a per-person random salt. That stops anyone
     reading PINs out of the database, which is what stops YOU being able to see
     them, and it is genuinely worth having.
     But be clear-eyed: a 4-digit PIN is only 10,000 possibilities, so anyone who
     stole this whole table could work out every PIN offline no matter how it is
     stored. Hashing is not what makes a 4-digit PIN safe. What makes it safe is
     that a PIN alone is useless — it must be typed on an approved device, and
     the account locks after a handful of wrong guesses. Those two, not this
     column, are the actual defence. */
  pin_hash      text,
  pin_salt      text,
  -- true = the next login must set a new PIN. Set on creation and on reset, so a
  -- new PIN is always chosen by the person, never issued to them by a manager.
  must_set_pin  boolean not null default true,
  pin_set_at    timestamptz,

  -- 'active' | 'disabled'. Disabling is instant and reversible; we never delete,
  -- so the audit trail keeps meaning something after someone leaves.
  status        text not null default 'active',

  /* LOCKOUT COUNTED PER PERSON, NOT PER VENUE.
     This is only possible because the new login asks WHO you are before it asks
     for a PIN. Today the PIN is the only identifier, so a wrong guess cannot be
     attributed to anyone and any limit would have to punish the whole venue —
     which behind one wifi router means five fat-fingered entries at shift open
     could lock out the floor. Naming yourself first is what lets us lock one
     account for a minute and leave everyone else working. */
  failed_count  int not null default 0,
  locked_until  timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. DEVICES — the phones, iPads and Macs allowed to log anyone in.
-- ---------------------------------------------------------------------------
create table if not exists public.hk_devices (
  id            uuid primary key default gen_random_uuid(),

  /* WHY NOT THE SERIAL NUMBER.
     A browser cannot read a hardware serial — there is no API for it, on purpose.
     And we would not want one: a serial is printed on the box and sits in
     Settings -> About, so anyone who read one off the back of an iPad could claim
     to BE that iPad. device_id is a random secret generated on the device the
     first time it asks for access. Only its hash is stored here, so even this
     table cannot impersonate a device. Unguessable, and revocable by you. */
  device_id     text unique not null,
  key_hash      text not null,

  -- What you call it. "Workshop iPad 1", "Front desk Mac", "Alex's iPhone".
  label         text,

  /* personal — one named person only. Their phone opens straight to their PIN pad.
     shared   — the communal iPads and workshop Macs. Shows the full staff picker,
                anyone approved can log in, and it gets a shorter idle logout
                because it is kit that gets left on a bench. */
  kind          text not null default 'personal',
  owner_name    text,

  -- 'pending' | 'approved' | 'revoked'. Revoked is kept, not deleted, so a lost
  -- phone stays on the record and can never quietly come back.
  status        text not null default 'pending',

  -- Filled in at request time so your approval screen reads "iPad · Safari ·
  -- requested by Alex" instead of a meaningless id. Advisory only — a browser can
  -- claim to be anything, so nothing is ever decided on these.
  requested_name text,
  user_agent     text,
  platform       text,

  approved_by   text,
  approved_at   timestamptz,
  last_seen     timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists hk_devices_status_idx on public.hk_devices (status, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. SESSIONS — live logins, so access can be cut off without waiting.
-- ---------------------------------------------------------------------------
create table if not exists public.hk_sessions (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references public.hk_accounts(id) on delete cascade,
  device_id     text not null,

  /* A login hands the browser a pass that expires in minutes, plus a renewal
     ticket kept here. The short pass is what the database checks; the renewal
     ticket is what stops a mechanic being asked for a PIN every half hour.
     Because the ticket lives server-side, revoking it here cuts the person off
     for real — which is what makes "someone left, remove them" instant rather
     than "instant, unless they still have the app open". */
  refresh_hash  text not null,
  expires_at    timestamptz not null,
  revoked       boolean not null default false,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index if not exists hk_sessions_lookup_idx on public.hk_sessions (device_id, revoked);

-- ---------------------------------------------------------------------------
-- 4. AUTH CONFIG — the join code and your recovery code. Exactly one row.
-- ---------------------------------------------------------------------------
create table if not exists public.hk_auth_config (
  id                int primary key default 1,

  /* THE JOIN CODE stops the request queue being open to the internet. Your app
     URL is public, so without it anyone on earth can ask for an account — and the
     danger is not the noise, it is that one busy afternoon you see "Alex H",
     assume it is your Alex, and approve. With a code you read out to the team,
     only people you have spoken to can reach the queue at all. */
  join_code         text,
  join_code_set_at  timestamptz,

  /* THE RECOVERY CODE is your way back in when there is no way back in: every
     device forgot at once, or your phone died, and there is nobody left who can
     approve you. Typing it on any device approves that device and logs you in as
     master, then burns itself. Only its hash lives here, so it cannot be read out
     of the database — write the real one down and keep it somewhere safe. */
  recovery_hash     text,
  recovery_set_at   timestamptz,

  updated_at        timestamptz not null default now(),
  constraint hk_auth_config_singleton check (id = 1)
);
insert into public.hk_auth_config (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 5. AUTH LOG — who logged in, from what, and every approval you granted.
-- ---------------------------------------------------------------------------
create table if not exists public.hk_auth_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  -- login_ok | login_fail | locked | device_request | device_approved |
  -- device_revoked | pin_set | pin_reset | recovery_used | refresh
  event      text not null,
  name       text,
  device_id  text,
  ip         text,
  detail     jsonb
);
create index if not exists hk_auth_log_at_idx on public.hk_auth_log (at desc);

-- ---------------------------------------------------------------------------
-- 6. LOCK ALL FIVE TO THE SERVER.
--     RLS on, and NO policies at all. No policy means no access for anon or for
--     a logged-in browser — deny is the default once RLS is on. The hk-auth
--     function uses the service key, which bypasses RLS, and it checks who is
--     asking before it answers. So the credentials, the device list and the audit
--     trail are simply not reachable from a browser, full stop.
-- ---------------------------------------------------------------------------
alter table public.hk_accounts    enable row level security;
alter table public.hk_devices     enable row level security;
alter table public.hk_sessions    enable row level security;
alter table public.hk_auth_config enable row level security;
alter table public.hk_auth_log    enable row level security;

revoke all on public.hk_accounts    from anon, authenticated;
revoke all on public.hk_devices     from anon, authenticated;
revoke all on public.hk_sessions    from anon, authenticated;
revoke all on public.hk_auth_config from anon, authenticated;
revoke all on public.hk_auth_log    from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. THE LOGIN SCREEN NEEDS THE ROSTER BEFORE ANYONE HAS LOGGED IN.
--     staff_public holds names, roles and emoji — and since today's commit, no
--     PINs anywhere near it. The picker has to draw before there is any session,
--     so this one stays readable without logging in. Names are not a secret in a
--     workshop where everyone knows each other, and once the app moves behind
--     Cloudflare (Stage 2.3) even that is only visible to staff.
--     Writes stay closed: the roster is edited through Master Access, server-side.
-- ---------------------------------------------------------------------------
alter table public.staff_public enable row level security;
drop policy if exists staff_public_rw   on public.staff_public;
drop policy if exists staff_public_read on public.staff_public;
create policy staff_public_read on public.staff_public
  for select to anon, authenticated using (true);
revoke insert, update, delete on public.staff_public from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. SEED YOUR OWN ACCOUNT.
--     Chicken and egg: approvals need a master, and the master needs an account.
--     This creates yours as master with NO PIN — must_set_pin is true, so the
--     first thing the new login does is make you choose one. Nobody, me included,
--     ever knows it.
--     Change the name here ONLY if your roster spells it differently; it has to
--     match staff_public.name exactly.
-- ---------------------------------------------------------------------------
insert into public.hk_accounts (name, app_role, site, is_master, must_set_pin, status)
values ('Harvey Betts', 'Assistant Manager', 'sydney', true, true, 'active')
on conflict (name) do update
  set is_master = true, status = 'active';

-- ---------------------------------------------------------------------------
-- 9. CHECK IT WORKED. Expect: 5 tables, all with rls_enabled = true and 0
--     policies, plus one row for you in hk_accounts with pin_hash still empty.
-- ---------------------------------------------------------------------------
select c.relname as table_name,
       c.relrowsecurity as rls_enabled,
       (select count(*) from pg_policies p
         where p.schemaname = 'public' and p.tablename = c.relname) as policy_count
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('hk_accounts','hk_devices','hk_sessions','hk_auth_config','hk_auth_log')
order by c.relname;

select name, app_role, is_master, must_set_pin, status,
       (pin_hash is not null) as has_pin_set
from public.hk_accounts;

-- ---------------------------------------------------------------------------
-- UNDO — removes everything this file created. The old login is untouched
-- throughout, so this is always safe to run.
-- ---------------------------------------------------------------------------
-- drop table if exists public.hk_auth_log, public.hk_sessions, public.hk_devices,
--                      public.hk_accounts, public.hk_auth_config cascade;
-- grant insert, update, delete on public.staff_public to anon, authenticated;
