# HK Workshop — what was broken, and what it means

A running record of problems found and fixed, kept so nothing gets forgotten between sessions
and so there is something concrete to point at when explaining what this system does.

Written for someone who does not work on the code. Each entry says what people actually
experienced, what was really wrong, and what it is worth.

---

## 27 July 2026

### Kart notes were not slow — they were not arriving at all

**What people saw:** a note written on a kart in RaceFacer took a very long time to show up in
the app. Sometimes it seemed never to appear.

**What was actually wrong:** the app reads a fleet-wide notes page from RaceFacer to spot new
notes. The code that read that page was looking for a layout RaceFacer does not use on this
system — so it found nothing, every time, and had been finding nothing all along. Both ways of
detecting a note were dark. Everything was falling back to a slow sweep that checks each kart in
turn, roughly 190 karts deep.

**Now:** 2,408 notes read on every pass. A note added in RaceFacer reaches the app in seconds.

**Worth knowing:** the response was never empty. It was 1.3 MB of data nobody was reading. The
fix came from capturing what RaceFacer genuinely sends and matching it, rather than guessing.

### Kart 20 could not be moved between tracks

**What people saw:** changing kart 20 (and 18) from Intermediate to Main track silently failed.
Other karts moved fine.

**What was actually wrong:** RaceFacer refuses to change a kart's track while that kart is set to
FOR MAINTENANCE. It was reporting exactly that, but the app was throwing the explanation away —
it read RaceFacer's error responses looking for the wrong field name, so every failure came back
as a generic "rejected". That one bug had been hiding the cause of every push failure.

**Now:** the app sets the kart OK, moves it, and puts it straight back into maintenance,
automatically. The kart's status ends exactly where it started.

**Built carefully because it touches kart safety:** the brief status change never leaves
RaceFacer, so it cannot flicker on anyone's screen or fire a kart-check notification for a kart
nobody has fixed. The restore runs whether or not the move worked, is retried, and if it ever
fails it says so loudly rather than leaving a maintenance kart marked OK.

### Kart battery data was showing German time

**What people saw:** "last online" times on the RiMO telemetry were hours out.

**What was actually wrong:** RiMO's servers are in Germany and send times with no timezone on
them. The app was reading those as Sydney times, so the digits were right and the actual moment
was eight to ten hours wrong depending on the season.

**Now:** converted properly, including across daylight saving in both hemispheres.

### The app was writing 208 database rows a minute for no reason

**What was actually wrong:** kart battery percentage was being rounded to the nearest 5%. A kart
sitting at 47.4% would flicker between rounding up and down on every reading, and each flicker
was recorded as a change. Multiplied across 192 karts, around the clock.

**Now:** about 4 rows a minute. A ~40× reduction in pointless database traffic.

**Why this matters more than it sounds:** this account was once refunded for 324 million
realtime messages in six days, caused by exactly this kind of repeated write. See the warning at
the end of this file.

### The kart list was being rewritten every ten minutes whether or not anything changed

**What was actually wrong:** there was a guard meant to prevent this, but it remembered what it
had written in memory only — and that part of the system restarts every cycle by design. So the
guard was empty every time it ran and never actually stopped anything.

**Now:** compares against what is genuinely stored. Roughly 230 needless writes per cycle
removed, each of which was being broadcast to every connected phone and screen.

### The app felt slow, especially the PIN screen

**What people saw:** tapping PIN digits felt heavy and swiping between screens lagged.

**What was actually wrong:** the app was connecting to every live data feed the moment it
loaded — while the user was still standing at the PIN pad — and processing updates for screens
nobody was looking at.

**Now:** live feeds start when you sign in. (Fixing the notes problem above had made this worse,
because the app suddenly had far more updates to process. Both are addressed.)

### Opening a kart started halfway down the previous kart's page

Fixed. Every kart now opens at the top, including when moving straight from one kart to another.

### Five live features were silently not working

**What was actually wrong:** the app was subscribed to live updates for repairs, discrepancies,
parts and stock — but those tables were never switched on for live updates at the database. A
subscription like that reports no error and simply delivers nothing, forever. So a repair logged
by one mechanic never appeared on anyone else's screen, and the manager's discrepancy alert
could not fire at all.

**Now:** switched on, and App Health checks for this automatically so it can never happen
silently again.

### App Health rebuilt

The page that shows what this system costs to run. It now measures realtime message usage
directly — by counting what the system actually sends — rather than relying on a figure the
supplier's API does not expose. It also shows connected devices, peak usage over the week, and
an estimated monthly bill.

**The dial:** a control that decides which features update instantly, priced. Turning it up costs
money and makes more things live; turning it down is free and instant. Every setting states its
gains and its costs, and shows how many devices it supports.

### We were about to fix the wrong thing, and measured it first

**The situation:** the worker that talks to RaceFacer runs on a hosting service with a hard limit
of 100 GB of traffic a month. It was at 81.58 GB — 82% — with the month still running. Going over
means either a bill or the service being cut off.

**The suspected cause** was a large page the worker downloads from RaceFacer to spot new kart
notes: 2.5 MB, roughly every 18 seconds. It looked obvious, and the fix looked easy — fetch it
less often.

**Measuring it first showed the theory was wrong three times over:**

- That 2.5 MB is the size **after unpacking**. Everything is sent compressed, and a page of 2,400
  near-identical rows compresses about **20 to 1**. What actually crosses the wire is roughly
  126 KB, not 2.5 MB.
- The hosting service charges for data **sent out**. This page is data coming **in**.
- The numbers never added up. 2.5 MB every 18 seconds would be about **354 GB a month** — more
  than four times what the bill actually shows, and over three times the cap. If that were the
  cause, the service would have been cut off weeks ago.

**Why it matters that we checked:** the "easy fix" was to fetch the notes page less often. Notes
detection had *just* been repaired — before that it had been finding nothing at all — so the
proposed fix would have slowed down the feature we had only-just got working, to save a few
percent of a bill it was not causing.

**What was built instead:** the worker now counts every byte it sends and receives, and which
system it went to. Nothing was counting before — the same blind spot behind the 324 million
message incident below, where a runaway process ran for six days because nothing was watching.

**Still to do:** read the meter after it has been running an hour, and confirm whether the 81.58 GB
is even this worker rather than something else on the same account. The current leading suspect is
the battery-telemetry poller, which checks every 4 seconds around the clock and is the only part of
the system that does not stand down overnight — a question for Harvey, since karts charge overnight
and that data may well be wanted.

### Track layouts got a system instead of a naming nightmare

**What it was like:** every track configuration had its own ad-hoc name, RaceFacer holds 46 of
them with names like "Australian GP 1, Clockwise", and nobody could say from a name which
beacons should be doing what.

**What was built:** a Layout Designer in the app. The venue (a car park — the pillars are real)
is drawn once as a digital map: every Dehaardt beacon segment in its place, red for the
programmable ones, blue for the fixed ones. Every possible layout gets a short code — A to AX,
plus c for clockwise, a for anti-clockwise — exactly matching the master spreadsheet. A marketing
name like "The Clock" is just a label on a code, so a track can be renamed for a season without
touching a single beacon setting.

Pick a layout, tap a beacon, set its sector and function numbers — the function list is the real
one from the Dehaardt manual, with plain-English descriptions. The map itself is editable by
dragging, so when the venue changes, fixing the map takes seconds and no programmer.

**Built ready for the next stage:** the programmable beacons each store their MAC address, and
every layout can be exported as the exact configuration file a small computer (Arduino) would
push to the beacons — the eventual goal being turning a whole track layout on from the app in
one tap.

---

## The 324 million message incident — read before changing anything

Supabase refunded this account for **324 million realtime messages in six days**, against a
**5 million per month** allowance. That is 65× the monthly limit, burned in under a week, with
nothing anywhere reporting a problem.

The cause was a loop rewriting rows that had not changed, on a table set up for live updates,
multiplied by every connected device.

```
cost  =  rows written to live tables  ×  devices connected
```

Speed is not in that equation. Checking for changes more often does not cost more — a kart that
breaks is recorded once whether it is noticed in 3 seconds or 30. What costs money is writing
rows that did not change.

**Current position:** 45,205 of 5,000,000 used — under 1%, roughly 33× headroom. That is a
healthy position, and the monitoring now exists to keep it that way.

**The rule:** never write a row that has not changed. Anything running on a loop needs to check
first — and that check has to survive a restart, because one of the bugs above was a check that
did not.
