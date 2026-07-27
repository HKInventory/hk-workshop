# HK Workshop — requested, not yet built

Things Harvey has asked for that are not done. Kept here so they survive between chats and land
in the next handover rather than being remembered by whoever happens to be in the conversation.

---

## Reset finances to zero (Manager Area)

**Asked for:** 27 July 2026. A button in MA to reset the Finance figures — spend to $0 — because
the app is still being stress-tested and the test spend is polluting the real numbers.

Current Finance screen shows: Stock value, Spend · month, Spend · YTD, Daily avg (90d), and a
12-month spend chart. Test data has pushed Apr–Jun 2026 to ~$2,164/month against a flat $0 before
that, which is visibly synthetic and makes the chart useless.

**Before building this, note what it actually is.** A one-tap control that zeroes financial
history is a data-deletion feature living in a production app used by staff on the floor. It
wants building with the same care as anything destructive:

- Confirm what "reset" means: delete the underlying rows, or zero them, or mark them as test
  data and exclude them from the figures? **Excluding is recoverable; deleting is not.** Ask
  before choosing — the answer changes the design entirely.
- Scope it. Reset everything, or only a date range, or only rows created during testing? If test
  rows can be identified (a flag, a date window, a known user), filtering beats wiping.
- Restrict it. Manager Area implies a role gate already; confirm it and require a typed
  confirmation rather than a single tap.
- Say what it did. Report the number of rows affected, and log it, so a reset can never be
  mistaken for data quietly going missing.

**Which screen is "MA"** — Manager Area or Master Admin — should be confirmed rather than
assumed; the app has both a manager screen and a master overlay.

---

## App Health — rebuild, do not extend again

**Asked for:** 27 July 2026, after the page was judged inaccurate and unhelpful. Fair.

It has been extended roughly six times in one session and it shows: a tile and a card disagree
about the same metric, averages print from four minutes of uptime, and until today Render
bandwidth was reported 1024x1024 too small.

Requirements as stated:

- Every graph carries scale, units and time span. No unlabelled shapes.
- **Do not project from instantaneous rates.** Forecast from accumulated history — the ledger for
  realtime, Render's real series for bandwidth — and state the billing-cycle end date and the
  cost expected by then.
- Remove the duplicate realtime panels.
- Fix Render CPU/memory. They read "not measured" from an API already being called. Get
  `select render_raw from app_health order by at desc limit 1;` first — do not guess the shape.
- Suppress averages when uptime is under ~30 minutes instead of printing noise.

**Hard constraint whoever builds this must know:** *"take the data from Supabase"* is not
possible for usage figures. Not a key problem and not a parser problem — the Management API does
not expose them on any plan. Supabase usage exists only on the dashboard page and in our own
ledger. Render's API does work. A rebuild promising "read both and forecast" has to be honest
that Supabase's half is self-measured, which is genuinely better (fresher than the dashboard) but
is a design decision to take deliberately rather than discover halfway through.

---

## Render bandwidth is at 82% of its cap

**Found:** 27 July 2026, while fixing the unit bug that had been hiding it.
**Measured:** 27 July 2026. **The kart-notes theory is wrong — do not act on it.**

81.58 GB of the 100 GB/month allowance. App Health had been reporting 0.0% because Render returns
megabytes and the value was stored as bytes.

The standing theory was the kart-notes index at 2.52 MB every ~18 seconds. It does not survive
measurement, for three independent reasons:

1. **The 2.52 MB is the decompressed body, not the wire.** It comes from `_kniLast.bytes`, which is
   `text.length` — the string after undici has already decompressed it. undici sends
   `accept-encoding: gzip, deflate` on every request whether you ask for it or not, so the explicit
   header on that fetch was redundant and every other RaceFacer fetch is compressed too. Measured
   against a page of ~2,400 kart-notes-shaped rows: **19.9:1**. The real cost is roughly **126 KB**
   per fetch, about 0.6 GB/day.
2. **Render bills outbound bandwidth. The index is a download.** Whether a service-initiated
   download is billed at all is the open question below; either way this is inbound, not outbound.
3. **The arithmetic contradicts itself.** 2.52 MB every 18 s is ~354 GB/month — 4.3× the 81.58 GB
   actually observed and over three times the cap. A proposed cause that over-predicts the bill by
   more than 4× is not the cause.

Raising `NOTES_DUTY` on the strength of this would have cost note latency — fixed only last
session, after being entirely dark — for close to nothing.

**What was built instead:** `net_meter.js` in the runner counts bytes in and out per destination,
including the spawned heavy child (which `stdio: 'inherit'` otherwise hides) and RaceFacer traffic
(which goes through undici's `fetch`, not the global one — wrapping only the global would have
missed the whole subject). It logs a `[net]` line every 5 minutes and stores totals in `app_health`
beside `render_usage`.

**Next step is to read it, not to change anything.** After a deploy plus ~30–60 minutes:

- Whichever of `net_out_bytes` / `net_in_bytes` tracks Render's own delta tells us what Render
  actually meters. That settles from evidence a question the docs would not — `render.com` is
  blocked by the network policy from a Claude session, so the primary source could not be read.
- `net_usage->'by_host'` names the real consumer.

**Check first, before any of that:** whether the 81.58 GB is this worker or the whole Render
workspace. The dashboard shows bandwidth per service. If something else on the account is serving
it, every runner-side change is wasted effort.

### MEASURED 27 Jul — the answer is `karts-info`, not notes, and not RiMO

Six `[net]` readings from 15 to 40 minutes of uptime, all in agreement:

```
WIRE out 12.3MB in 525.0MB over 40min -> ~13.01GB/mo out, ~553.40GB/mo in
103.166.146.163 6.0/510.3MB · supabase 6.1/11.9MB · rimo 0.2/2.8MB
busiest: supabase 9183req · rf:garage/karts-info 2872req · rf:garage/notifications 2002req
```

- **RaceFacer is 97% of inbound** (510 MB of 525 MB).
- **`karts-info` is the biggest single line.** `statusFast` issues one call per distinct kart type
  — 6 of them — every status cycle, ~**72 requests a minute**, each returning that type's full
  kart records, to read one field per kart.
- **The notes index is exonerated.** It does not reach the top three; at ~126 KB on the wire every
  10–20 s it is under 4% of inbound.
- **RiMO is 0.2 MB out / 2.8 MB in** — the previous "leading candidate" was wrong too. The
  overnight-gate question below is now moot for bandwidth; leave RiMO alone.

This is also the RaceFacer **contention** the codebase documents everywhere (`status cycle SLOW`,
karts-info going 478 ms → 4.8 s in races). 72 req/min into a per-IP throughput-bound box. Bandwidth
and status latency have the same root cause.

**Still open: does Render bill inbound?** Out projects to ~13 GB/mo (fine); in projects to ~553
GB/mo (5× the cap). Render's 81.58 GB is *historical* and the code has changed since it accrued, so
it will not match a current rate — do not try to force it to. `app_health` now stores
`net_out_bytes`, `net_in_bytes` and `render_usage` in the same row every 30 min, so the honest
comparison is delta-vs-delta:

```sql
select at,
       net_out_bytes - lag(net_out_bytes) over (order by at) as out_delta,
       net_in_bytes  - lag(net_in_bytes)  over (order by at) as in_delta,
       (render_usage->>'bandwidth_bytes')::bigint
         - lag((render_usage->>'bandwidth_bytes')::bigint) over (order by at) as render_delta
from app_health
where at > now() - interval '1 day'
order by at;
```

Ignore rows where a delta is negative (the worker restarted; `net_*` are cumulative since boot).
Whichever of `out_delta` / `in_delta` tracks `render_delta` is what Render meters.

**Next step depends on one measured fact, now being collected.** A one-shot log line prints the
`karts-info` response headers. If RaceFacer sends an `ETag`/`Last-Modified`, an `If-None-Match`
turns a ~100 KB body into a ~200-byte 304 — the problem disappears at no cost to status latency.
If it does not, the levers are polling slower (`STATUS_POLL_SEC`, already an env var — tunable from
the Render dashboard with no deploy) or asking for less, and both trade latency. **Do not pick
until the header line has been read.**

---

## Layout Designer — v2 (27 Jul). Letters + direction tabs, plan as backdrop

**Model, as Harvey specified it:**

- A **track is a LETTER** (A–AX, 50). Selecting one shows two tabs: **Clockwise / Anti-clockwise**.
- **Barriers belong to the letter** — physical, shared by both directions. Connecting two pillars
  closes a gap, disjoining opens it, and the set of connections *is* the track layout.
- **Beacon S/N + F/N belong to the direction** — same track driven the other way needs different
  functions. One DB row per letter holding `barriers`, `beacons_c`, `beacons_a`.
- Disjoining a barrier clears its beacon on **both** directions: a beacon cannot sit on a barrier
  that is not there, and leaving one behind would export a function for hardware that is not on
  the track.

**The plan is an uploaded image, not a redrawing.** The first attempt traced Harvey's annotations
into vector shapes — a yellow outline polygon and pink blobs for the static track sections — and
he was right that it looked terrible. The annotations were him *pointing at* which sections stay
the same, not instructions to draw circles. Re-drawing a surveyed architectural plan by eye from a
screenshot can only ever be a worse copy of a thing he already has. So: **🗺️ Upload venue plan**
puts the real drawing underneath (stored inline in `venue_map.doc`; PNG, JPEG fallback over
~2.2 MB), with a fade slider, and pillars/barriers/beacons overlay it. Uploading rescales all
existing geometry proportionally so nothing drifts.

**Seeded with real data** off the annotated plan — eight named static beacons with their actual
values: Pit On 1st (S00/F12), Pit On 2nd (S00/F11), Pit Entry (S00/F28), Track B (S01/F26),
Normal (S00/F53), Normal (S01/F09), Holding (S00/F48), Release (S00/F51). **Their positions are
approximate** — read off a differently-cropped drawing than the pillars were — so they want
dragging onto their real spots once. The values are exact.

Open items:

- **Pillar positions are traced by eye.** Upload the plan, drag the pillars onto the real columns
  once, Save. From then on the DB copy is authoritative.
- **Zones / concurrent tracks** (adult + junior + intermediate open at once): each is its own
  letter, but there is no "venue preset" grouping several active letters into one tap. Natural
  next step, and what the Arduino stage would switch.
- **Link letters to RaceFacer's 46 configs** so the live layout auto-detects — needs an
  `rf_track_id` column on `track_layouts`.
- **MAC addresses are unvalidated free text** until a real Dehaardt identifier has been seen.
- Arduino export format is stable: `{track, direction, code, beacons:[{id,kind,label,mac,sn,fn}]}`.

## Parts still do not attach to repairs pushed from the app

Root cause known. RaceFacer renders "Parts used" as a Vue component, so `used_parts[index].id`
binds to `stock.id` — a stock-batch id, not the part id we send from `rf_warehouse`. One part has
many stocks.

The missing piece is where `part.stocks` is loaded from. The full page is already captured:

```sql
select substring(payload from position('stocks' in payload) for 4000)
from rf_debug where kind='damage_form' order by id desc limit 1;
```

**Do not guess the field mapping.** That class of guess caused several regressions.
