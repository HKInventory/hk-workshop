-- ============================================================================
--  rf_kart_types — venue assignment for RaceFacer kart types
--  Run once in the Supabase SQL editor. Safe to re-run.
--
--  WHY: which venue a kart type belongs to used to be a hardcoded map inside
--  racefacer-sync.js, so pointing "Adult Track" at Sydney meant a code change
--  and a redeploy. This table moves that decision into the app: Master Access
--  lists every kart type and you pick its venue from a dropdown.
--
--  HOW IT FILLS ITSELF: the runner discovers kart types straight from
--  RaceFacer's garage page and inserts any it hasn't seen with site = NULL
--  (meaning "not assigned yet"), so you never have to find a UUID by hand.
--  Discovery is purely additive — it never overwrites the venue or the name
--  on a row you've already edited.
--
--  SAFETY: a type with site = NULL is inert. The runner only syncs types that
--  have a venue, and if this table is empty or unreadable it falls back to the
--  built-in map rather than going blind. On first run against an empty table
--  the runner seeds it with the current built-in assignments, so nothing
--  changes until you change it.
--
--  NOT added to the realtime publication on purpose. The runner re-reads it
--  every ~2 minutes and the app refreshes on save; a live subscription here
--  would be pure cost for a table that changes a few times a year.
-- ============================================================================

create table if not exists public.rf_kart_types (
  uuid        text primary key,                       -- RaceFacer kart_type_uuid
  type        text,                                   -- display name, e.g. 'Adult Track'
  site        text,                                   -- venue: 'sydney' | 'melbourne' | NULL = unassigned
  active      boolean     not null default true,      -- false hides it without deleting history
  sort_order  int,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

create index if not exists rf_kart_types_site on public.rf_kart_types (site, sort_order, type);

alter table public.rf_kart_types enable row level security;

-- Internal staff tool: the app talks to Supabase with the anon key, so this matches the
-- convention used by the other tables here. See the note at the bottom of this file.
drop policy if exists rf_kart_types_rw on public.rf_kart_types;
create policy rf_kart_types_rw on public.rf_kart_types
  for all to anon, authenticated
  using (true) with check (true);


-- ============================================================================
--  push_subs — close an open door
--
--  push_subs was the ONLY table in the schema with row level security switched
--  off, and it holds each staff phone's push endpoint and its auth keys. The
--  anon key is embedded in index.html, so anyone who viewed source could read
--  every subscription — enough to push notifications to staff phones — or
--  delete them all.
--
--  The app never READS this table; it only upserts its own row (index.html,
--  "SBC.from('push_subs').upsert(...)"). So reads can be closed off entirely
--  without changing app behaviour. The runner sends pushes using the SERVICE
--  key, which bypasses RLS, so notifications keep working.
-- ============================================================================

alter table public.push_subs enable row level security;

drop policy if exists push_subs_rw   on public.push_subs;
drop policy if exists push_subs_write on public.push_subs;

-- Register / refresh this device's own subscription. No SELECT policy is created,
-- so anon cannot list anyone's subscriptions.
create policy push_subs_write on public.push_subs
  for insert to anon, authenticated
  with check (true);

create policy push_subs_update on public.push_subs
  for update to anon, authenticated
  using (true) with check (true);


-- ============================================================================
--  NOTE FOR THE NEXT STEP (app security work)
--
--  Every table in this schema currently has RLS enabled with a policy of
--  "using (true) with check (true)" for the anon role. That means RLS is ON
--  but wide open: the anon key in index.html can read and write everything.
--  The 4-digit PIN gates the user interface, not the data.
--
--  Do NOT tighten these policies piecemeal — the app has no real login yet, so
--  narrowing them now would simply break it. Proper per-user auth comes first;
--  the policies follow. push_subs above is the exception only because the app
--  genuinely never reads it.
--
--  Run this to see the current policy surface:
--
--    select tablename, policyname, roles, cmd, qual, with_check
--    from pg_policies where schemaname = 'public'
--    order by tablename, policyname;
-- ============================================================================

-- ----------------------------------------------------------------------------
--  FOLLOW-UP: link rows to RaceFacer's own numeric kart-type id.
--
--  The first cut keyed this table on the garage page's kart_type_uuid. That is
--  not RaceFacer's identity for a kart type — Settings -> Karts lists them by a
--  numeric id (Adult Track 1, Mini Track 6, Junior Track 7, Red Remotes 14,
--  Twin 17, Lane 18, BattleKart 21, Intermediate Track 22, Melbourne Fleet 23).
--
--  It also showed the built-in seed labels were wrong: type 23 is "Melbourne
--  Fleet", not a second "Adult Track", which is why two identical Adult Track
--  rows appeared in Master Access.
--
--  The runner now discovers types from that authoritative list (via the copy the
--  pusher already syncs into rf_kart_admin), stamps the numeric id onto matching
--  rows and corrects their names. Types with no garage uuid yet are inert: the
--  runner skips them, so they can never misdirect a sync.
-- ----------------------------------------------------------------------------

alter table public.rf_kart_types
  add column if not exists rf_type_id int;

create unique index if not exists rf_kart_types_type_id
  on public.rf_kart_types (rf_type_id) where rf_type_id is not null;
