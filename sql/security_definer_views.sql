-- ###########################################################################
--
--   THE TWO security_definer_view ADVISOR ERRORS.  7 August 2026.
--   ONE IS FIXED. THE OTHER IS DECLINED ON PURPOSE, AND THAT IS THE POINT
--   OF THIS FILE.
--
-- ###########################################################################
--
-- Supabase's linter raises ERROR 0010_security_definer_view against both
-- public.staff_public and public.repair_totals_public. The obvious action is to
-- flip both to security_invoker. That was designed three ways, then attacked by
-- three independent reviewers, and the conclusion was that doing it to
-- staff_public would make the system WORSE while making the advisor page green.
--
-- ---------------------------------------------------------------------------
-- WHY staff_public STAYS SECURITY DEFINER
-- ---------------------------------------------------------------------------
-- The lint targets definer views that return rows the caller was meant to be
-- filtered out of, or that evaluate caller-influenced predicates with the
-- owner's privilege. Neither shape exists here:
--
--     staff_public = SELECT name, role, emoji FROM staff
--
-- No WHERE, no join, no function call, no caller input, and no `pin`. The
-- underlying table has ZERO policies, so there is no per-caller RLS to bypass.
-- Every caller is meant to see all six rows and does.
--
-- Flipping it is not free. A security_invoker view reads the base table as the
-- CALLER, and `authenticated` holds nothing on public.staff — so the flip only
-- survives if it is paired with a column GRANT plus a permissive policy. That
-- pairing re-permits, as the querying user, precisely what the owner's
-- rolbypassrls was permitting. Identical reads, different mechanism, zero
-- functional change. What it does change is the failure mode:
--
--   * Today /rest/v1/staff is a uniform 401 for every browser. Nothing queries
--     it (verified: index.html contains no from('staff') and no /rest/v1/staff).
--   * After the flip it is a live PostgREST endpoint over the table holding the
--     bridge credentials, and the only thing standing between a signed-in device
--     and the `pin` column is the parenthesised column list inside one GRANT.
--     RLS cannot help: it filters rows, never columns.
--   * `select=*` would then return 42501 to anyone who tried it — an error
--     nobody sees today, because nothing queries the table. The one-line "fix"
--     for that error is `grant select on public.staff to authenticated`, which
--     hands out every bridge key. The design manufactures its own footgun.
--   * The advisor would go green on public.staff — clearing the INFO lint too —
--     while the table sits behind USING(true) holding live credentials, and it
--     STAYS green after somebody widens that grant. The measurement decouples
--     from the thing it is supposed to measure.
--
-- A linter is a heuristic about a shape. It is not a threat model, and this is
-- the case it gets wrong. Declined, and written onto the object itself via
-- COMMENT so the next person meets the reasoning before the lint.
--
-- ---------------------------------------------------------------------------
-- WHY repair_totals_public IS DIFFERENT AND IS FIXED
-- ---------------------------------------------------------------------------
-- It aggregates public.rf_repairs, and `authenticated` ALREADY holds table-level
-- SELECT on rf_repairs (measured: true) and already passes its single policy
-- (rf_repairs_read, PERMISSIVE, FOR SELECT, TO public, USING (true), zero
-- restrictive policies). The browser reads rf_repairs directly all day.
--
-- So the definer wrapper protects nothing whatsoever — it is surplus privilege
-- on a browser-reachable path that executes as `postgres`, a role with
-- rolbypassrls. Removing it costs nothing and the output cannot change. That is
-- a real reduction in privilege, not a linter score, so it is applied.

-- ---------------------------------------------------------------------------
-- APPLY. One DO block, so it is atomic however the runner handles transactions.
-- A top-level `SET LOCAL ROLE` outside a transaction degrades to a warning and
-- the verification would silently run as postgres, proving nothing.
-- ---------------------------------------------------------------------------
do $$
declare
  before_sig text; after_sig text;
  before_n int;    after_n int;
begin
  set local lock_timeout = '3s';
  set local statement_timeout = '60s';

  select md5(coalesce(string_agg(name||'|'||total||'|'||coalesce(last_at::text,''),
                                 E'\n' order by name),'')), count(*)
    into before_sig, before_n
    from public.repair_totals_public;

  execute 'alter view public.repair_totals_public set (security_invoker = true)';

  -- Re-read as the role PostgREST actually uses. postgres has rolbypassrls, so
  -- reading as postgres after the flip would prove exactly nothing.
  set local role authenticated;
  if current_user <> 'authenticated' then
    raise exception 'ABORT: verification is not running as authenticated (got %)', current_user;
  end if;

  select md5(coalesce(string_agg(name||'|'||total||'|'||coalesce(last_at::text,''),
                                 E'\n' order by name),'')), count(*)
    into after_sig, after_n
    from public.repair_totals_public;

  reset role;

  if before_sig is distinct from after_sig then
    raise exception
      'ABORT: repair_totals_public changed under security_invoker. before=% rows / after=% rows',
      before_n, after_n;
  end if;

  raise notice 'OK: repair_totals_public identical as authenticated (% rows)', after_n;
end
$$;


-- ---------------------------------------------------------------------------
-- THE DURABLE RECORD. These COMMENTs live on the objects, so anyone who opens
-- the table in the dashboard meets the reasoning before they meet the lint.
-- ---------------------------------------------------------------------------
comment on table public.staff is
$c$HOLDS LIVE CREDENTIALS. staff.pin is the 32-character bridge credential that
authorises stock-move, notify-user, verify-pin, master-write, master-staff,
master-pin and rimo-image-sync. Measured 7 Aug 2026: all 6 rows are 32 chars and
none matches ^[0-9]{4}$ — no human PIN is stored here. Real PINs are PBKDF2
hashes in hk_accounts and nobody, the owner included, can read one.

NEVER grant SELECT on this table to anon or authenticated — with OR without a
column list. Browsers read the roster through public.staff_public and nothing
else (verified 7 Aug 2026: index.html has no from('staff') and no /rest/v1/staff).

NEVER add this table to the supabase_realtime publication. It is not a member
today. Realtime replicates whole ROWS, not view projections, so publishing it
alongside any permissive SELECT policy would stream pin to every signed-in
client, and a column grant would not stop it.

The zero-policy state is DELIBERATE. RLS is ENABLED with no policies, so every
role without BYPASSRLS is denied outright rather than filtered. Do not "fix" the
rls_enabled_no_policy lint on this table.$c$;

comment on view public.staff_public is
$c$SECURITY DEFINER BY DESIGN. Do not "fix" Supabase lint 0010_security_definer_view
on this view. Reviewed and declined 7 Aug 2026 — see sql/security_definer_views.sql.

Definer semantics are the mechanism that lets a browser read the roster while
public.staff stays completely unreachable (401, not filtered). The lint targets
definer views that bypass RLS the caller was meant to be subject to; that does
not apply here. This is SELECT name, role, emoji FROM staff — no WHERE, no
caller input — over a table with no policies to bypass. All callers see the
same 6 rows.

Flipping to security_invoker REQUIRES first granting authenticated direct SELECT
on public.staff plus a permissive SELECT policy. Net effect: zero functional
change, /rest/v1/staff becomes a live endpoint for every signed-in device, the
sole barrier to the pin column becomes one GRANT column list, and public.staff
drops to zero advisor findings while carrying USING(true) over live credentials.

IF SOMEONE FLIPS IT ANYWAY: the grant and policy MUST commit FIRST, in the same
transaction, and the predicate must be literally USING(true) — USING(active)
returns the same 6 rows today and silently shrinks the roster the first time
somebody is deactivated. Flipping first makes loadRoster() return permission
denied; its error arm is silent, ROSTER stays null, and the app falls back to a
hardcoded name list. The floor would look correct for hours.$c$;

comment on view public.repair_totals_public is
$c$security_invoker = true, set 7 Aug 2026 to clear Supabase lint 0010. Safe and
free here, unlike staff_public: authenticated already holds table SELECT on
rf_repairs and already passes its only policy (rf_repairs_read, PERMISSIVE, FOR
SELECT, TO public, USING (true)), and the browser reads rf_repairs directly. The
definer wrapper was surplus privilege on a browser-reachable path running as
postgres. Output verified byte-identical before and after, read as the
authenticated role.$c$;


-- ---------------------------------------------------------------------------
-- CHECKS
-- ---------------------------------------------------------------------------
-- repair_totals_public invoker, staff_public still definer, and the row count
-- unchanged at 52.
select c.relname,
       coalesce((select option_value from pg_options_to_table(c.reloptions)
                  where option_name='security_invoker'), 'not set') as security_invoker
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relname in ('staff_public','repair_totals_public');

select count(*) as repair_totals_groups from public.repair_totals_public;   -- expect 52

-- staff must remain unreachable. Expect false / 0 / 0.
select has_table_privilege('authenticated','public.staff','SELECT') as authed_can_read_staff,
       (select count(*) from pg_attribute
         where attrelid='public.staff'::regclass and attnum>0 and attacl is not null) as column_acls,
       (select count(*) from pg_policies
         where schemaname='public' and tablename='staff') as policies;


-- ---------------------------------------------------------------------------
-- ROLLBACK (repair_totals_public only — nothing else was changed)
-- ---------------------------------------------------------------------------
-- alter view public.repair_totals_public set (security_invoker = false);
