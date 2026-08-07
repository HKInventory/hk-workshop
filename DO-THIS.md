# Do this — 7 August

The four things on the 6 August list are **done**, except where they needed a
dashboard toggle or a physical device. What is left is below, and all of it
needs you rather than me.

---

## Done on 7 August — nothing for you to do here

**The three edge functions are deployed and measured, not assumed.**

| Function | Was | Now | How I know |
|---|---|---|---|
| `hk-auth` | v29, no `change-pin` | **v30** | deployed source is byte-identical to the repo file, same sha256 `90c40aeb…` |
| `hk-ai` | never deployed at all | **v1** | answers on a real request |
| `master-staff` | v26, `self-pin` in front of the auth check | **v27** | `self-pin` now answers "Not authorised for Master Access" |

Please still test the two things these fix, because I cannot press the buttons:

1. **Change PIN** — Account → Change PIN, with a PIN you know. It should work.
   It has never worked before.
2. **Sign in** — sign out and back in on one device. `hk-auth` is the login
   function and it was replaced today; I verified it answers correctly to four
   different requests, but none of those were a real person with a real PIN.

**The SQL is done too.** Ghosts cleared (Jayden, Rafael, "Andrew Richardson
Computer", Charbel), and `staff_pin_backup` — the twelve old PINs — is dropped.
I did not read it before dropping it.

**You said leave the battery thinning.** Done: nothing was thinned. Worth
knowing that the part that *was* urgent had already fixed itself — rows past the
7-day cutoff are **0** and the oldest reading is 31 July, so hard retention is
running on its own. The database stays at 1148 MB and will not grow without
bound. You can thin later; it is a one-way door, so no rush.

---

## 1. Make the runner repo private  ·  2 minutes

github.com/HKInventory/hkwsrunner → Settings → bottom → Change visibility →
Private. Untick Wiki and turn Pages off while you are there. Render keeps
deploying from a private repo; nothing breaks.

*(Leave `hk-workshop` public — GitHub Pages serves the app from it.)*

There is no API for this, which is the only reason it is yours and not mine.

---

## 2. Turn on leaked-password protection  ·  1 minute

Supabase → Authentication → Policies (or Settings) → enable "Leaked password
protection". Checks new passwords against HaveIBeenPwned. Free. Dashboard
toggle, no API.

---

## 3. Rotate the RaceFacer password

`RF_PASS=HKWS` is in the git history of a public repo. It is public forever;
deleting the line does nothing on its own. **Order matters** — doing it the
other way round takes the repairs push offline:

1. Change the password in RaceFacer.
2. Render → hkwsrunner → Environment → set `RF_PASS` to the new value → save.
3. Tell me, and I will strip the hardcoded default from
   `hkwsrunner/rf_push_repairs.js:27`.

---

## 4. When you are standing at the wall display

This is the last step of *"nothing in the app should be public"*, and it is the
one I will not do without you in front of the screen.

The groundwork turned out to be **already done** — the handover said Part D of
the SQL still needed running, and it did not: the three `hk_devices` columns
already existed and `authenticated` already had SELECT on all nine tables the
board reads. So the only thing still holding the public key open is that the TV
has no account of its own.

1. Enrol the TV on the board itself, via `hk-auth`'s `display-signin`.
2. Watch it for **a full day** with no red "not signed in" badge.
3. Then, with the display in front of you, I revoke `anon`.

Until step 3, every repair, kart note, task and stock level is still readable by
anyone with the key in the page source.

---

## One thing I found that nobody was looking for

The repo copy of `master-staff/index.ts` had **two NUL bytes** in it, and had
carried them since the file was first committed on 4 August. Deploying that file
as-is would have broken Master Access → Staff save — Postgres cannot hold a NUL,
so the delete would have failed after the owner-protection block had already
rewritten the list.

It never bit because the live function was pasted in from a clean source, so the
repo and the server disagreed and only the repo was wrong. Fixed and committed.

It is worth knowing what this means more generally: **the repo is not currently a
trustworthy copy of what is running.** Nine of the thirteen deployed functions
are not in git at all (§5.7), and of the four that are, one was silently
un-deployable. That is the same class of problem as the sixteen missing SQL
files.
