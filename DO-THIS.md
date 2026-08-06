# Do this — 6 August

Four things. Nothing here is optional; the first two are why HK AI and
Change PIN are broken right now.

---

## 1. Deploy three edge functions

Supabase → Edge Functions → click the function → paste the file → Deploy.

| Function | Paste this file | Why |
|---|---|---|
| `hk-auth` | `supabase/functions/hk-auth/index.ts` | adds `change-pin`. Nobody can currently change a PIN they still know. |
| `hk-ai` | `supabase/functions/hk-ai/index.ts` | HK AI answers "Sign in first." to everyone today. |
| `master-staff` | `supabase/functions/master-staff/index.ts` | removes an unauthenticated write endpoint that ran before the auth check. |

Deploy `hk-auth` **first**. If you only get through one, make it that one.

---

## 2. Run one SQL file

Supabase → SQL Editor → New query → paste **all** of
`sql/RUN-THIS-2026-08-06.sql` → Run.

It does four things in order, each with a check you can read at the end:

- reclaims **~640 MB** (the battery-history backlog that was never being cleared)
- clears the last five lists still holding people with no account
- destroys the old-PIN backup table
- lays the groundwork for the wall display's own account — **takes nothing away**

**One decision before you run it.** Part A thins battery readings older than
48 hours down to one every 10 seconds. If you might want to look back at a race
from *earlier this week* at full resolution, set `RIMO_HIST_FULL_H = 120` on
Render first. Thinned data cannot be un-thinned. If you have no idea, leave it —
48 hours is the setting you have been running.

---

## 3. Two settings, two minutes

**a. Make the runner repo private.**
github.com/HKInventory/hkwsrunner → Settings → scroll to the bottom →
Change visibility → Private. Also untick Wiki and turn off Pages while you are
there. Render keeps deploying from a private repo; nothing breaks.

*(Leave `hk-workshop` public — GitHub Pages serves the app from it.)*

**b. Turn on leaked-password protection.**
Supabase → Authentication → Policies (or Settings) → enable "Leaked password
protection". Checks new passwords against HaveIBeenPwned. Free.

---

## 4. Rotate the RaceFacer password

`RF_PASS=HKWS` is in the git history of a public repo. It is public forever;
deleting the line does nothing on its own.

1. Change the password in RaceFacer.
2. Render → hkwsrunner → Environment → set `RF_PASS` to the new value → save.
3. Tell me it is done and I will strip the hardcoded default from the source.

---

## Then send me

The source of **`stock-move`**, **`notify-user`** and **`master-pin`** — copy
them out of Supabase → Edge Functions and paste them to me like you did with
the master-* ones.

They are not in this repository, so I cannot read them. They authenticate the
same way `hk-ai` did, and `hk-ai` turned out to be broken. I need to see whether
those three carry the same fault before telling you they are fine.
