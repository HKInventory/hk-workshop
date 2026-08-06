-- ===========================================================================
--  ANY SIGNED-IN BROWSER CAN CURRENTLY TRUNCATE YOUR TABLES.
--  Supabase -> SQL Editor -> New query -> paste -> Run. Safe to run twice.
--
--  PART 1 IS ZERO-RISK AND SHOULD BE RUN NOW.
--  PART 2 IS A READ-ONLY SURVEY. Nothing in this file breaks the app.
-- ===========================================================================
--
--  WHAT THE DISPLAY-ACCOUNT CHECK ACCIDENTALLY REVEALED
--  It printed what `authenticated` holds on the board's tables, and the answer
--  was not "SELECT". It was:
--
--    rf_karts       DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
--    rf_repairs     DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
--    rf_kart_notes  DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
--    tasks, sites, ramp_events, rimo_karts — the same
--
--  Every lockdown so far aimed at `anon`, the key printed in the page source.
--  Nothing ever touched `authenticated` — and since the new sign-in shipped,
--  EVERY SIGNED-IN BROWSER IS `authenticated`. So the work that stopped a
--  stranger reading the data also quietly handed every person who signs in the
--  ability to empty a table.
--
--  That is not a theoretical risk. It is one compromised phone, or one person
--  with the developer console open, away from the fleet list being gone.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- PART 1 · TRUNCATE, TRIGGER and REFERENCES. Revoke all three, everywhere.
--
--   ZERO RISK. None of the three is reachable through PostgREST, which is the
--   only way the app talks to the database — there is no TRUNCATE verb in the
--   REST API at all. The app cannot notice this, and it removes the ability to
--   empty a table in one statement.
--
--   TRUNCATE is the one that matters: DELETE leaves a trail and can be caught
--   by a row limit, TRUNCATE takes the whole table instantly.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select c.relname
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r','p','v','m','f')
  loop
    execute format('revoke truncate, trigger, references on public.%I from authenticated, anon', r.relname);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- PART 2 · READ-ONLY. What can a signed-in browser still WRITE?
--
--   Do not act on this yet. Some of it is legitimate — the app writes repairs,
--   notes, stock moves and chat straight from the browser, and revoking those
--   would break the floor. The point is to see the size of the surface, so the
--   next step can be deliberate rather than a guess.
--
--   Read the `writes` column as: what someone signed in could do to this table
--   from a browser console, today, whatever the app's own screens allow.
-- ---------------------------------------------------------------------------
select table_name,
       string_agg(privilege_type, ', ' order by privilege_type) as writes
  from information_schema.role_table_grants
 where table_schema = 'public'
   and grantee = 'authenticated'
   and privilege_type in ('INSERT','UPDATE','DELETE')
 group by table_name
 having string_agg(privilege_type, ',' order by privilege_type) like '%DELETE%'
 order by table_name;

-- ---------------------------------------------------------------------------
-- PART 3 · confirm TRUNCATE is gone. Expect zero rows.
-- ---------------------------------------------------------------------------
select table_name, grantee, privilege_type
  from information_schema.role_table_grants
 where table_schema = 'public'
   and grantee in ('anon','authenticated')
   and privilege_type in ('TRUNCATE','TRIGGER','REFERENCES')
 order by table_name, grantee;
