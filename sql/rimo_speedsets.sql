-- RiMO's OWN speed settings — id, label, and the colour RiMO paints them.
--
-- WHY A TABLE AND NOT A LIST IN THE APP. Three of these are already hardcoded somewhere and have
-- drifted: the app's button colours were picked by eye, rimo_karts.speedset carries only the label,
-- and the numeric speedId (1226 = "100 %") exists nowhere but control.php. Harvey's ask — "colours
-- of speedsets should follow exact same as RIMO and each kart should be highlighted like RIMO which
-- kart speed setting they're currently on" — cannot be met by guessing hex codes off a screenshot.
-- The runner reads all three off the page it already has to load, writes them here, and the app
-- renders what RiMO actually says. If RiMO recolours a button or renumbers a setting, both follow
-- without a code change.
--
-- The join for kart colouring is rimo_karts.speedset = rimo_speedsets.label — the label is what the
-- fleet feed reports ("Pit (FN49)", "100 %"), so it is the key, and speed_id is the wire value.
create table if not exists public.rimo_speedsets (
  label      text primary key,          -- exactly as control.php prints it, e.g. '100 %', 'Pit'
  speed_id   integer,                   -- what setspeed.php wants; null until it can be read
  colour     text,                      -- RiMO's own bar colour, e.g. '#E24B4A'
  sort_order integer,                   -- the order they appear on RiMO's page, so ours matches
  updated_at timestamptz default now()
);

-- Readable by any signed-in user (the panel needs it to draw); written only by the runner, which
-- uses the service key and bypasses RLS. No policy for anon = anon sees nothing, which is the
-- default this project settled on today.
alter table public.rimo_speedsets enable row level security;
drop policy if exists rimo_speedsets_read on public.rimo_speedsets;
create policy rimo_speedsets_read on public.rimo_speedsets for select to authenticated using (true);
grant select on public.rimo_speedsets to authenticated;
