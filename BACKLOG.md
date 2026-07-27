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

81.58 GB of the 100 GB/month allowance. App Health had been reporting 0.0% because Render returns
megabytes and the value was stored as bytes.

The likely driver is the kart-notes index: 2.52 MB fetched roughly every 18 seconds. That is the
first thing to measure. Options if confirmed: request a narrower column set from the DataTables
endpoint, page it, or lengthen the duty cycle (`NOTES_DUTY`). **This is a real operational limit
and more urgent than the page's appearance.**

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
