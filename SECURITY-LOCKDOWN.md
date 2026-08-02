# Securing HK Workshop — the plan, in order

Written for Harvey. Every step says who does it (**YOU** in a dashboard, or **CLAUDE** in code),
how to check it worked, and how to undo it. Do them in order. Do not skip Stage 0.

---

## What is actually wrong (plain English)

The app asks for a 4-digit PIN before it shows you anything. That check happens **in the app on the
screen**, not in the database. The database itself is protected by one key — and that key is written
inside the web page, so anyone who right-clicks → View Source has it.

That means an outsider does not need to guess a PIN. They can skip the app entirely and talk to the
database directly. Today they could read and change every repair, note, stock level, chat message
and staff record you have.

Two things made it worse than that:

1. **Every staff PIN was printed in the page source**, including both managers'. Anyone who looked at
   the source — or the public code repo, or its history — has had them.
2. **A manager's 4-digit PIN is also the master-admin credential.** So one leaked PIN was not one
   account, it was the whole system.

The fix is to move the check from the screen into the database: logging in issues a signed pass that
says *who you are, at which site, on which approved device*, and the database refuses anything that
does not carry a valid one. **Mechanics keep tapping four digits and notice nothing.**

---

## Stage 0 — TODAY. Stop the bleed.

Nothing else matters until this is done. The plan below builds a very good wall, but a wall does not
help while the keys are published.

### 0.1 — Change all eight staff PINs · **YOU** · 5 min

The current PINs are public and cannot be un-published. They are burned permanently.

1. Open the app as a manager → **Master Access → Staff**.
2. Give every person a **new** 4-digit PIN. Avoid `1234`, `0000`, birthdays, and anything sequential.
3. Tell each person their new PIN **in person or by direct message** — never in a group chat.

> Do this **before** 0.4, because 0.4 removes the old list from the app and you may want the staff
> screen to look normal while you work through it.

**Check it worked:** log out, log in with your new PIN. Then try your old one — it must fail.

### 0.2 — Make both repos private · **YOU** · 2 min

For each of `HKInventory/hk-workshop` and `HKInventory/hkwsrunner`:

> GitHub → the repo → **Settings** → scroll to **Danger Zone** → **Change visibility** → **Make private**

⚠️ **Read this before you click on `hk-workshop`:** GitHub Pages will only serve a site from a private
repo on a paid plan (GitHub Pro, about $4/month). If you make it private on the free plan **the app
goes offline for everyone.** So either upgrade to Pro first, or do `hkwsrunner` now and leave
`hk-workshop` public until Stage 2.3 moves the hosting to Cloudflare — which solves it permanently
and for free.

`hkwsrunner` has no such catch. Make it private now.

**Undo:** same screen, change visibility back.

### 0.3 — Rotate the RaceFacer password · **YOU** · 3 min

`RF_PASS=HKWS` is written into the public runner code. Anyone who read that repo has your RaceFacer
login.

1. Change the `HKWS` account's password in RaceFacer.
2. Render → `hkwsrunner` → **Environment** → set `RF_PASS` to the new password → **Save**.
3. The service restarts by itself. Watch the logs for `[rf] logged in` — if you see
   `login rejected — check RF_USER/RF_PASS`, the password did not match.

### 0.4 — Remove the PINs from the app source · **CLAUDE** · done

Already written and pushed to your branch:

- The hardcoded staff list no longer carries PINs — only names, roles and emoji for display.
- The "Staff PINs" panel now shows `••••` instead of everyone's real PIN. It printed the lot to
  anyone holding an unlocked tablet.
- Nothing about logging in changes. The login has always been checked on the server; those PINs in
  the file were never used for it.

**Deploy this after 0.1**, so you rotate first and remove second.

### 0.5 — Close the self-promotion hole · **YOU** · 2 min

Right now anyone with the key from the page source can add themselves to the master-admin list.

> Supabase → **SQL Editor** → **New query** → paste the whole of **`security_stage0.sql`** → **Run**

That file locks writes to `app_access` and `config` while leaving reads open (the app needs to read
them before login to draw the home screen). It ends with checks that print what worked, plus an undo
block if anything misbehaves.

**Check it worked:** the app still opens and shows your normal tabs. The last query in the file lists
every table still wide open — that is Stage 1's to-do list.

### 0.6 — Turn on backups · **YOU** · 2 min

> Supabase → **Database** → **Backups** → enable **Point-in-Time Recovery**

Insurance. Before changing security settings, make sure you can rewind. This also means a hostile
delete is recoverable rather than fatal.

---

## Stage 1 — The wall. Real logins.

This is the part that actually fixes the problem. Staged so the floor never breaks: the old and new
systems run **side by side** until the new one is proven, and every step is reversible on its own.

**None of this changes anything for a mechanic. Still four digits.**

| # | Step | Who | Reversible |
|---|------|-----|-----------|
| 1.1 | Rewrite `verify-pin` so a correct PIN issues a short-lived signed pass carrying who/where/what-role/which-device, plus a quiet renew so a tablet left on all day never re-asks | CLAUDE | n/a — new code, not yet used |
| 1.2 | Paste the new function into Supabase → Edge Functions, and add the signing secret | YOU | delete it, old one stays live |
| 1.3 | App starts using the pass for data, with a **kill-switch** to fall back instantly | CLAUDE | flip the switch |
| 1.4 | Approve the tablets and phones already in use, so nobody is locked out on day one | YOU | one list, editable |
| 1.5 | Add the new database rules **alongside** the old open ones — nothing breaks | CLAUDE + YOU | drop the new rules |
| 1.6 | Watch a full day of racing to confirm all real traffic is on the new path | BOTH | — |
| 1.7 | **Only then** close the old open access, one table at a time | YOU | re-open that table |
| 1.8 | Retire the old public key | YOU | last step, off-race |

Two rules I will hold to: **the old access is not closed until the new path is proven on real
traffic**, and **you get a switch you can flip yourself** if the floor jams — no waiting for me.

After Stage 1: someone with the page source and the public key can do **nothing**. No reads, no
writes. They need a valid PIN **on a device you approved**.

---

## Stage 2 — Going further

Once the wall is up, these are the genuine step-changes, in value order.

### 2.1 Face ID for anything master-level · **biggest single win**

Mechanics keep four digits forever. But **master admin stops being a 4-digit PIN** and becomes a
passkey — Face ID or fingerprint. It cannot be shoulder-surfed, cannot be guessed, cannot be phished,
and never leaves the phone. This closes the "one leaked PIN owns the building" problem for good.
Works in the app as it is — no native app needed.

### 2.2 Writes go through the server

Instead of the app writing to tables directly, it asks the server to do specific jobs — *record this
repair*, *move this stock*. The server checks everything. This shrinks what is reachable from
**~55 tables** to about **a dozen named actions**, and turns the database rules into a second line of
defence instead of the only one.

### 2.3 Make the code unreadable to strangers — properly

This is your "hard to even read the code" ask, and the real answer is **not** to scramble the code
(anyone determined gets past that, and it makes every future fix harder). The real answer is to
**stop serving it to strangers at all**:

> Move hosting from GitHub Pages to **Cloudflare Pages** (free) and put **Cloudflare Access** in front.

Then an unauthenticated stranger asking for the page gets a login screen and **not one line of the
app**. Staff devices are enrolled once and never see it again. This also removes the GitHub Pro
requirement from step 0.2 — so `hk-workshop` can go private at no cost.

### 2.4 Nothing can be permanently destroyed

Remove delete rights from everyone except the runner; deletions become "hidden" rather than gone.
Combined with 0.6, a worst-case compromise is an inconvenience, not a loss.

### 2.5 Lock down what the page is allowed to load

The app pulls three script libraries from a public CDN. If one of those were ever tampered with, it
would run inside your app with full access. A content policy plus fingerprint-pinning means the page
refuses to run anything that is not the exact expected file.

### 2.6 Tie sensitive actions to being at the track

Most work happens with staff physically at the venue. Sensitive actions can require the venue
network, with a deliberate exception for managers off-site. Costs the floor nothing — they are
standing in the building.

---

## Honest verdict

"Impossible to hack" is not a thing anyone can sell you for a web app, and I would rather say so than
promise it. Someone who takes an unlocked, logged-in tablet off your bench has that mechanic's
access, and no architecture prevents that.

What **is** achievable, and what this plan delivers:

- The public key becomes **worthless** — it can read nothing and write nothing.
- Access requires **a valid PIN on a device you approved**, and grants only that person's role at
  that person's site.
- A stolen pass **expires in minutes**, not forever.
- Nothing can be **permanently destroyed**.
- After 2.3, strangers cannot even **see** the app.

That is the difference between one publicly-known key that opens everything, and a per-person,
per-site, per-device, time-limited, delete-proof pass. That is a real ten-fold change.

**The single most important line in this document:** rotate the eight PINs (0.1). Everything else is
built on top of that being done.
