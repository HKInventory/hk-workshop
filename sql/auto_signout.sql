-- ###########################################################################
--
--   AUTO SIGN-OUT.  Applied 7 August 2026 as migrations
--   `auto_close_idle_staff_sessions` and `..._v2`, plus a pg_cron schedule.
--
-- ###########################################################################
--
-- WHY THIS EXISTS
-- Master Access -> Settings has always had "Minutes of inactivity", stored in
-- ui_config.auto_logout, and it was set to 30. It could not do its job. The
-- countdown was a browser setTimeout:
--
--     _idleTimer = setTimeout(function(){ ... logout(); }, ms);
--
-- which only fires if the tab is still open when it expires. Close the app and
-- the timer dies with it, sessionClose() never runs, and signed_out_at stays
-- null forever. The Manager Dashboard showed "no sign-out" against Ross, Rob and
-- Andrew, and 26 of 27 open sessions were more than twelve hours old.
--
-- The client timer is still there and is still the fast path for a tab that IS
-- open. This is the backstop that does not depend on a screen being awake.
--
-- THE SECOND BUG, WHICH THE DRY RUN CAUGHT
-- sessionOpen() inserts a new row on every sign-in and never closes the previous
-- one, so people accumulate open sessions — Harvey had ten, Ross six, Alex five.
-- presence is keyed by NAME, not by session, so one active person made every one
-- of their stale rows look live. A naive sweep would have closed nobody who
-- still uses the app. Sessions are therefore ranked per person: only the newest
-- can be live, and anything with a later sign-in after it is superseded.
--
-- THE STAMP IS LAST-ACTIVITY + TIMEOUT, NEVER now()
-- Writing now() would record everyone as signing out the moment a sweep noticed,
-- which is a plausible-looking wrong answer of exactly the kind this system
-- keeps producing. Someone who stopped at 15:36 under a 30 minute timeout signed
-- out at 16:06, whenever we get round to writing it down.
--
-- Superseded rows are an ESTIMATE — the earlier of the next sign-in and their
-- own idle deadline. Said plainly because it matters: for historical rows there
-- is no per-session activity record to work from. A defensible estimate beats
-- "no sign-out" forever, but it is not a measurement.

create or replace function public.hk_close_idle_sessions()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mins int;
  v_n    int := 0;
begin
  -- The owner's setting is the authority. Same clamp the app applies.
  select greatest(1, least(600, coalesce((value ->> 'mins')::int, 30)))
    into v_mins
    from public.ui_config
   where key = 'auto_logout';
  if v_mins is null then v_mins := 30; end if;

  with ranked as (
    select s.id,
           s.name,
           s.signed_in_at,
           lead(s.signed_in_at) over (partition by s.name order by s.signed_in_at) as next_signin,
           greatest(s.signed_in_at, coalesce(p.last_seen, s.signed_in_at))         as person_last_active
      from public.staff_sessions s
      left join public.presence p on p.name = s.name
     where s.signed_out_at is null
  ),
  due as (
    select id, name,
           case
             when next_signin is not null
               then least(next_signin, signed_in_at + make_interval(mins => v_mins))
             else person_last_active + make_interval(mins => v_mins)
           end as stamp
      from ranked
     where next_signin is not null                                        -- superseded
        or person_last_active < now() - make_interval(mins => v_mins)     -- gone quiet
  ),
  upd as (
    update public.staff_sessions s
       set signed_out_at = d.stamp
      from due d
     where s.id = d.id
    returning s.name
  )
  select count(*) into v_n from upd;

  -- Anyone with no open session left is not in the workshop, so take them off
  -- the who-is-here list too. Only when they have actually gone quiet — a person
  -- whose newest session is still live keeps their dot.
  delete from public.presence p
   where p.last_seen < now() - make_interval(mins => v_mins)
     and not exists (
       select 1 from public.staff_sessions s
        where s.name = p.name and s.signed_out_at is null);

  return v_n;
end $$;

-- Nothing in a browser calls this and nothing in a browser should be able to.
-- Same treatment as the other SECURITY DEFINER helpers in this project.
revoke all on function public.hk_close_idle_sessions() from public, anon, authenticated;

-- Every five minutes. The timeout itself comes from the owner's setting, so
-- changing it in Master Access changes behaviour without touching this.
-- select cron.schedule('hk-close-idle-sessions', '*/5 * * * *',
--                      $$select public.hk_close_idle_sessions();$$);


-- ---------------------------------------------------------------------------
-- CHECKS
-- ---------------------------------------------------------------------------
-- Open sessions. Should be roughly the number of people actually using the app.
-- It was 27 before this ran, 26 of them over twelve hours old; 1 after.
select 'open sessions' as check, count(*) as value
  from public.staff_sessions where signed_out_at is null;

-- The job itself.
select jobname, schedule, active from cron.job where jobname = 'hk-close-idle-sessions';

-- Nobody should ever be left with "no sign-out" for longer than the timeout plus
-- five minutes again. If this returns rows older than that, the job has stopped.
select name, signed_in_at
  from public.staff_sessions
 where signed_out_at is null
   and signed_in_at < now() - interval '2 hours';
