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

**Leading candidate once the meter reports:** `rimo.js` polls the RiMO grid every **4 seconds**,
plus a focus-detail loop at 1.5 s and a cell-history loop at 1 s — and it is the **only** loop with
no opening-hours gate. Status, notes, sessions and the heavy sync all stand down overnight; RiMO
polls through the night. By request count it dwarfs the notes index.

**Question for Harvey before touching it:** karts charge overnight, so SOC and BMS genuinely change
while the venue is shut. Is overnight RiMO data wanted? If yes it stays as it is; if it is only
needed while the venue is open, the same `hours.shouldSkip` gate the other four loops use would cut
its requests by roughly half. **Not changed unilaterally** — that is a data-collection decision.

---

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
