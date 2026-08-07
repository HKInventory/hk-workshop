-- Applied 7 August 2026 as migration `backup_track_blueprints`.
--
-- tracks.blueprint_url holds an inline data: URI — 195,091 characters for
-- "The Cyclone 1, Clockwise". It exists in that one column and nowhere else. It
-- cannot be re-derived, re-fetched or reconstructed, only re-drawn by hand. It
-- had never been backed up.
--
-- Taken immediately before testing master-tracks' absent-vs-null fix, so that a
-- test against unrecoverable data was recoverable. Kept afterwards, because the
-- reason for taking it does not expire.

create table if not exists public.tracks_blueprint_backup_20260807 as
  select id, name, blueprint_url, has_map, now() as backed_up_at
    from public.tracks
   where blueprint_url is not null;

-- Locked like everything else holding data a browser has no business reading.
alter table public.tracks_blueprint_backup_20260807 enable row level security;
revoke all on public.tracks_blueprint_backup_20260807 from anon, authenticated;

-- CHECK. Expect 1 row, 195091 chars, and false.
select count(*) as rows, max(length(blueprint_url)) as chars
  from public.tracks_blueprint_backup_20260807;
select has_table_privilege('authenticated','public.tracks_blueprint_backup_20260807','SELECT') as browser_can_read;
