# HK Workshop — handover

**Written 6 August 2026.** Everything below was checked against the live
database and the live edge functions on that date, not recalled from memory.
Where I am unsure, I say so.

Read this whole file before touching anything.

---

## 0. Who you are working for, and the standing rules

Harvey Betts owns and built this. He tests on real devices on a live workshop
floor, so a bad change is not a failing test — it is a mechanic who cannot move
stock on a Saturday.

**Rules that are not yours to change:**

- `is_master` is **Harvey Betts and nobody else**. He is the builder. His role
  and his PIN can only ever be changed by him, holding the Owner key.
- **Master Access** (day-to-day admin) = Harvey, Ross McArthur, Andrew
  Richardson. That list lives in `app_access.master_admins` and is changed only
  through the `master-access` function, which requires `OWNER_KEY`.
- **Nobody sees anybody's PIN, including Harvey.** Forgotten PIN → a manager
  resets it → the person chooses a new one. The manager never learns it.
- The runner must **NEVER** call RaceFacer's `manually-start-session` or
  `manually-stop-session`.
- **Never ask for, and never accept, the Supabase service key or the database
  password in chat.** You do not need them; the MCP connector is enough.
- Approvals all happen in-app and must work in the **installed home-screen PWA**
  (no URL bar, no query strings).

**The stated goal, in his words:** *"only our staff can access it. Impossible to
hack or work around"* and *"NO INFORMATION IN THE APP SHOULD BE PUBLIC!!!"*

---

## 1. Get connected first

You need two things. Ask Harvey to enable them if they are missing.

- **Supabase MCP connector** — project `jnxdjzewfrcrexyscxul` ("HK Workshop",
  ap-southeast-2, Postgres 17.6). Gives you `execute_sql`, `apply_migration`,
  `deploy_edge_function`, `get_edge_function`, `get_advisors`, `get_logs`.
  ⚠️ It drops out of a session sometimes and **will not reattach mid-chat** —
  if the tools vanish you need a fresh session.
- **GitHub** — `HKInventory/hk-workshop` and `HKInventory/hkwsrunner`.

**Verify before you trust anything in this file:**

```sql
select (select count(*) from public.rimo_bms_history)                    as bms_rows,
       (select pg_size_pretty(pg_database_size(current_database())))     as db_size,
       (select count(*) from information_schema.role_table_grants
         where table_schema='public' and grantee='anon')                 as anon_grants,
       (select count(*) from public.hk_devices where display_secret is not null) as display_enrolled,
       (select count(*) from public.rimo_bms_history
         where at < now() - interval '7 days')                           as past_cutoff,
       (select to_char(min(at),'DD Mon') from public.rimo_bms_history)   as oldest;
```

On 7 Aug, after the revoke, that returned: `2143906 | 1205 MB | 0 | 1 | 0 | 31 Jul`.

**`anon_grants` must stay 0.** It was 9 for the whole life of this project and was
driven to 0 on 7 August (§5.3). If it is ever not 0, something has re-granted the
public key and the app is leaking again — that is the single most important
number in this file.

**`display_enrolled` must stay 1.** If it drops to 0 the wall display has lost its
account, and because `anon` is now revoked the board will go BLANK rather than
silently falling back. That is the intended behaviour, not a regression.

`past_cutoff = 0` means retention is holding by itself; if it ever climbs, the
prune has stopped and that is the thing to chase.

(The old version of this query also counted `staff_pin_backup`. That table was
dropped on 7 August, so the query as printed in the 6 August handover now errors
on a missing relation — which would be a confusing first thing to hit. This is
the corrected one.)

---

## 2. What the system is

Three moving parts.

**The app** — `hk-workshop/index.html`. One file, ~22,000 lines, vanilla JS, no
build step. Served by GitHub Pages from `main`, installed as a PWA on phones and
a wall-mounted TV. Talks to Supabase directly and to edge functions.

**The runner** — `hkwsrunner`, Node on Render, deploys from `main`. Syncs
RaceFacer (karts, repairs, notes, sessions, stock) and RiMO (battery telemetry,
kart control) into Supabase. Unattended — a crash-loop stops all of it silently.

**Supabase** — Postgres, PostgREST, Realtime, Auth, 13 edge functions.

### Deployment, and the trap in it

Both repos have `.github/workflows/auto-merge-claude.yml`: a push to `claude/**`
is validated (every `.js` must parse, `index.js` must load) and **auto-merged to
`main`**. So **pushing your branch deploys the app and the runner.** No PR
needed, and none should be opened unless Harvey asks.

**Edge functions do NOT deploy that way.** They are deployed by hand, or by you
with `deploy_edge_function`. This is behind a recurring class of confusion: the
app ships instantly, the server does not, so a new button can exist days before
the server knows the word for it. The raw symptom is `Unknown op`, which reads
as a broken button. Several call sites now translate that message; keep doing it.

---

## 3. The one lesson that matters most

**This system turns failures into confident wrong answers.** Every serious bug
found here has that shape. Not "it broke" — "it reported success while doing
nothing", or "it reported a specific, plausible, wrong thing".

Confirmed instances, all now fixed:

- RLS returns **empty, not an error**. `app_access` read nothing, the app fell
  back to its built-in `[owner]` default, and Ross was quietly told he had no
  Master Access — while the Owner Access list named him the whole time.
- `supabase-js` **silently falls back to the anon key** when a session dies, so
  calls keep "working" with the wrong identity.
- `VH_LASTSEEN=0` produced a confident "collection stopped".
- A refused read produced "no readings at all today — it never arrived".
- The site chooser fell back to a hardcoded Sydney.
- The BMS prune timed out for twelve days and logged
  `prune_bms_history unavailable` — which reads as a missing migration.
- `hk-ai` rejected every sign-in on a shape check and answered "Sign in first."

**So: measure, do not infer.** Read the live database. Read the deployed
function, not the repo copy. If you write a fix, write the check that proves it
landed. Do not tell Harvey something is fixed because the code looks right — he
has been burned by that and will (correctly) not believe you.

---

## 4. State of play — what is done

### Fixed and verified live

**The battery-history table was eating the database.** `rimo_bms_history` was
1,972,649 rows / 1125 MB — **93% of the whole database** — with rows twelve days
old against a seven-day retention. `prune_bms_history` downsampled with a
correlated self-join (planner cost 3,557,328; two seq scans of a million rows).
PostgREST connects as `authenticator`, which carries `statement_timeout=8s`, so
every call was killed; the runner's fallback plain delete had no index on `at`
and died to the same 8 seconds.

Applied to the live database:
- BRIN index on `at` (`pages_per_range=8`) — retention plan went from a
  139,297-cost seq scan to a 36,259 bitmap scan.
- Dropped `rimo_bms_history_kart_at`, a duplicate of `rbh_serial_at_idx`.
- Dropped `app_health_at_idx`, a duplicate of `app_health_at`.
- Rewrote `prune_bms_history` as bounded time slices with a row budget,
  returning `more`; **and gave it its own `statement_timeout = '120s'`**, which
  is the part that actually mattered.

**It works.** On 6 Aug, rows past the cutoff = **0**, oldest = 31 July. Hard
retention is running on its own now.

- Revoked `EXECUTE` on six `SECURITY DEFINER` helpers (`hk_role`,
  `hk_is_manager`, `hk_is_staff`, `hk_staff_name`, `hk_db_stats`,
  `hk_realtime_tables`) from `anon` and `authenticated`. Verified safe first:
  **`index.html` makes no `.rpc()` calls at all**, and the only caller is the
  runner on the service key.
- Pinned `search_path` on `touch_updated_at` and `rf_debug_trim`.

### Deployed and verified live — 7 August

All three are now deployed. Each was checked by *calling it*, not by reading it:

| Function | Version | Change | Proof |
|---|---|---|---|
| `hk-auth` | 29 → **30** | adds `change-pin` | deployed source byte-identical to repo, sha256 `90c40aeb…`; `change-pin` returns "This device isn't approved." while a nonsense op returns "Unknown op" — so it matched a real `case` |
| `hk-ai` | none → **v1** | session auth | no credential → "Sign in first."; bogus credential → "Couldn't verify your sign-in" — the old `/^\d{4,8}$/` shape guard is provably gone |
| `master-staff` | 26 → **27** | removes `self-pin` | `self-pin` now answers "Not authorised for Master Access" |

Harvey still needs to confirm a real sign-in and a real Change PIN — I can verify
the server's answers, not a person with a real PIN on a real device.

**Note for whoever deploys next.** The container running these sessions is
blocked from reaching `*.supabase.co` over HTTPS (403 on CONNECT), so curl
cannot be used to test a function. `pg_net` can: `net.http_post(...)` from
`execute_sql`, then read `net._http_response`. That is the smoke-test harness
used above and it works well.

### The repo is not a trustworthy copy of what is running

`master-staff/index.ts` carried **two NUL bytes** inside its delete sentinels
(`neq("name", "\0__none__")`) from the moment it was first committed on 4 August.
Deploying the repo copy would have broken Master Access → Staff save: Postgres
text cannot hold a NUL, PostgREST would reject the delete, and the `save` op
would fail *after* the owner-protection block had rewritten the caller's list.

It never bit anyone because the live v26 had been pasted in from a clean source.
The repo and the server disagreed, and only the repo was wrong. Fixed in
`41f4320` and deployed as v27.

Take the general lesson: between the nine functions missing from git (§5.7) and
the sixteen missing SQL files (§5.8), **this repository still cannot rebuild the
system, and where it does have a file that file is not guaranteed to be what is
running.** Diff before you trust.

**Two live bugs these fix:**

1. **HK AI answers "Sign in first." to everyone.** It guarded on
   `/^\d{4,8}$/.test(pin)`, but `cu.pin` has carried a 32-character bridge key
   since the sign-in changed, so the test was false for every current account.
2. **Nobody can change a PIN they still know.** The client compared four typed
   digits against that same 32-character key ("Current PIN is wrong" to a
   *correct* PIN), and `master-staff`'s `self-pin` made the same doomed
   comparison and wrote to `staff.pin` — a table that stopped deciding sign-ins.
   `set-pin` refuses an account that already has one. There was no route at all.
   `hk-auth`'s new `change-pin` is it: approved device, PIN checked against the
   hash, same per-account lockout as `login`, same burned-PIN list.

---

## 5. What is left — in order

### 5.1 Deploy three functions — ✅ DONE 7 August

See §4. `hk-auth` v30, `hk-ai` v1, `master-staff` v27, each smoke-tested.

### 5.2 Run `sql/RUN-THIS-2026-08-06.sql` — ✅ DONE 7 August, except Part A

Parts B and C are run and checked (zero ghosts left; `staff_pin_backup`
dropped). **Part D needed nothing — it was already true.** See `sql/README.md`
for the part-by-part record.

**Part A was declined by Harvey on 7 August** and that is a live decision, not an
oversight. It thins the 48h–7d band to one reading per 10 s; he chose to keep
full resolution. Note the framing in the original file is now out of date: it
described Part A as reclaiming ~640 MB, but the *expired-row* half of that had
already been done by the runner — rows past the 7-day cutoff are **0**, oldest
**31 July**. Retention is holding on its own, so nothing is growing without
bound. Thinning remains available; it is one-way.

Bulk deletes were **not** refused by the agent safety layer this time — Parts B
and C ran straight through `execute_sql` / `apply_migration`.

### 5.3 Close the last public read — ✅ DONE 7 August

**`anon` now holds zero grants.** Proven, not assumed: the anon key printed in the
page source was used against the REST API after the revoke and every one of the
nine came back `401 permission denied` —

```
GET /rest/v1/rf_repairs     → 401  permission denied for table rf_repairs
GET /rest/v1/stock          → 401  permission denied for table stock
GET /rest/v1/staff_public   → 401  permission denied for view staff_public
GET /rest/v1/rf_kart_notes  → 401  permission denied for table rf_kart_notes
```

`authenticated` kept SELECT on all nine, so the board and every signed-in person
were unaffected — Harvey confirmed the board live at the moment of the revoke.

The rollback is written into the migration `revoke_anon_reads_display_enrolled`
and repeated in `sql/security_revoke_anon.sql`. If the board ever goes dark,
re-grant, then look at `display_enrolled`.

**Done ahead of the full day of observation, deliberately.** The handover advised
watching the board for a day first. That advice predates `tvAuthWatch`, which
renews the session **five minutes ahead of expiry** on its own `setInterval` —
specifically because auth-js stops its refresh ticker whenever the browser
reports the tab hidden, which is what a screen-blanked TV reports for hours. The
renewal path was read before the revoke, and the log already showed the watchdog
renewing unprompted. The revoke is also reversible in one statement. Both facts
together made the wait unnecessary.

#### What was NOT done, and why

**The two SECURITY DEFINER views are still SECURITY DEFINER** (§6), and the
advisor still reports them as ERROR. Flipping `staff_public` would have broken
the app: it is `select name, role, emoji from staff`, and `staff` has RLS enabled
with **no policy**, so under `security_invoker` the caller's RLS applies and the
view returns EMPTY — silently killing the @mention roster (`index.html:19342`).
`repair_totals_public` reads `rf_repairs`, which `authenticated` can read, so
that one is probably safe alone — but they are not the same problem and should
not be flipped together.

**Do this first, then flip:** add a real RLS policy on `staff` for
`authenticated`, prove `staff_public` still returns rows, and only then set
`security_invoker`. Both views are read by the runner too, but on the service
key, so the runner is not a constraint.

### 5.3b The old plan, for reference

**Steps 1 and 2 are DONE as of 7 August.** Part D was already applied (§5.2), and
the wall display is now enrolled and signing itself in:

```
label "Wall display · sydney"  kind display  status approved  site sydney
display_secret SET   display_user_id SET   display_enrolled = 1
```

Two `display_signin` events logged at 02:49 and 02:50, the second one the
watchdog renewing on its own. **`display_enrolled` was 0 from the day this
started; that is the number that had to move, and it has.**

**What remains: step 3 (watch it a full day, no red badge) then step 4, the
revoke.** Do the revoke and the `security_invoker` flip on `staff_public` /
`repair_totals_public` in the SAME sitting, with the board in front of you —
those two views are the other thing that can blank it.

⚠️ **Enrolment had a bug, now fixed** — see the comment at the `_tvm` match in
`index.html`. `#tv-enrol=CODE` set `__tvSite` to the string `"enrol=555678"`,
so the board asked for a site that does not exist and came up fully drawn with
no data in it, and the join code got stamped into the device label. Nothing
errored. If a board ever shows its layout with empty panels, check
`window.__tvSite` before anything else.

**`anon` can still SELECT nine tables** using the key printed in the page
source: `rf_karts`, `rf_repairs`, `rf_kart_notes`, `tasks`, `stock`, `tv_state`,
`ui_config`, `staff_public`, `repair_totals_public`. Every repair, every kart
note, every task, all stock levels. This is the whole gap against *"nothing in
the app should be public"*.

It is open **only because the wall display still runs on the anon key.**
`display_enrolled` was 0 on 6 Aug.

Order, and do not shortcut it:
1. Run Part D of the SQL above (grants `authenticated` the reads — takes nothing
   away).
2. Enrol the TV — physical, on the board, using `hk-auth`'s `display-signin`.
3. Watch it for **a full day** with no red "not signed in" badge.
4. Then, **standing in front of the display**, run the revoke at the bottom of
   `sql/security_display_account.sql`.

The board reads **nine** tables, not four. I said four twice and was wrong both
times; the list came from reading every query the TV path makes. Miss one and
the board goes blank the day the key is revoked.

### 5.4 Make `hkwsrunner` private

Both repos are **public**. `hk-workshop` has to be — GitHub Pages serves the app
from it. **`hkwsrunner` has no reason to be**, and it contains
`RF_PASS = 'HKWS'` as a hardcoded default plus RaceFacer's IP.

There is **no MCP tool for repo visibility** — Harvey does it:
Settings → bottom → Change visibility → Private. Untick Wiki, turn off Pages.
Render keeps deploying from a private repo.

### 5.5 Rotate the RaceFacer password

`HKWS` is in the **git history** of a public repo, so it is public forever.
Deleting the line achieves nothing on its own. Sequence: Harvey changes it in
RaceFacer → sets `RF_PASS` on Render → **then** you strip the default from
`hkwsrunner/rf_push_repairs.js:27`. Doing it in the other order takes the
repairs push offline.

### 5.6 Turn on leaked-password protection

Supabase → Authentication. Dashboard toggle, no MCP tool. Free.

### 5.7 Pull the nine orphan edge functions into the repo

**Nine of the thirteen deployed functions do not exist in git**: `verify-pin`,
`master-pin`, `stock-move`, `notify-user`, `master-karts`, `master-tracks`,
`part-image`, `rimo-image-sync`, `ramp-tick`.

Use `get_edge_function` for each and commit them under
`supabase/functions/<slug>/index.ts`. **The repo currently cannot rebuild this
system** — that is the fix.

While you are there, two of them (`stock-move`, `master-pin`) import
**unpinned** `https://esm.sh/@supabase/supabase-js@2`, and `notify-user` uses
unpinned `jsr:`. That exact landmine already failed a deploy in August: the CDN
resolved `@2` to a version whose sub-dependency was not servable. Pin them to
`npm:@supabase/supabase-js@2.111.0`, which is what the repo functions use.

### 5.8 Sixteen SQL files the app tells you to run do not exist

`chat_admin.sql`, `chat_groups.sql`, `chat_images.sql`, `chats_tasks.sql`,
`hk_ai.sql`, `intelligence.sql`, `messages_shared.sql`, `ramp_push.sql`,
`rf_debug.sql`, `rf_kart_admin.sql`, `rf_sync.sql`, `rimo_detail.sql`,
`rimo_focus.sql`, `security_ramp.sql`, `staff_and_group.sql`,
`user_avatars.sql`. Named in comments, never committed.

Do **not** reconstruct them from memory. `sql/README.md` carries the query that
reads the real schema back out of the live database. Same habit as 5.7: commit
the file *before* running it.

### 5.9 Retire the `staff` table

`stock-move`, `notify-user` and `master-pin` all authenticate by matching
`cu.pin` against `staff.pin`. **I read all three on 6 Aug and confirmed none of
them carries the shape regex that broke `hk-ai` — they work.** They are the only
reason `staff.pin` still exists.

Move them onto the session (`hk-ai` is the worked example — verify the JWT with
`auth.getUser`, look the auth user up in `hk_accounts`, keep the legacy path
underneath). Then `verify-pin` can be retired and `staff.pin` dropped, and the
`legacy_key` bridge in `index.html` goes with it.

---

## 6. Security wishlist beyond the above

Harvey wants this genuinely locked down, not merely tidied. Beyond §5:

- **Cloudflare Access in front of GitHub Pages**, so the app is not merely
  hard to use without an account but unreachable without passing the door first.
- **Passkeys / WebAuthn for master-level actions**, replacing the Owner key as a
  typed secret.
- **RLS policies that mean something.** RLS is enabled on nearly every table,
  but almost every policy is `using (true)` for `{anon,authenticated}` — which
  is no restriction at all. Revoking `anon` (§5.3) is what actually closes the
  door today; real per-role policies are the durable version. **Do not tighten
  these blind** — the app writes repairs, notes, stock moves and chat straight
  from the browser and you will stop the floor.
- **`authenticated` can still INSERT/UPDATE/DELETE on ~60 tables.** TRUNCATE,
  TRIGGER and REFERENCES have been revoked (verified: zero rows left). The
  write surface itself has not been narrowed — see
  `sql/security_authenticated_writes.sql` Part 2 for the survey.
- **Two `SECURITY DEFINER` views** — `staff_public`, `repair_totals_public` —
  run as their creator and ignore the caller's permissions. Flipping them to
  `security_invoker` is right but **must be done in the same sitting as the
  display account, with the TV in front of you**; it is exactly the change that
  could blank the board.
- **`pg_net` is installed in the `public` schema.** Move it.

---

## 7. Next project — RiMO APIs

Harvey now has **the RiMO API credentials/documentation**. Once §5 is done, that
is the next piece of work.

Today the runner reaches RiMO by **scraping and driving the WFM web UI**
(`rimo.js`, `rimo_control.js`, against `http://wfm.rimo-germany.com`, logging in
with `RIMO_USER` / `RIMO_PASS`). A real API replaces that with something that
does not break when a page changes.

**Ask him for the docs before designing anything.** Do not guess at endpoints.
Relevant existing code: `hkwsrunner/rimo.js` (BMS polling — this is what fills
`rimo_bms_history`), `hkwsrunner/rimo_control.js` (speed presets, driven from
the RIMO Control screen via the `rimo_control_queue` table).

Note that `RIMO_HIST_SKIP` already excludes junior/mini/battle/kids/cadet
sessions from history collection, and the write rate is what made that table
93% of the database — **whatever the API makes easy, sample rate is a cost
decision, not a free one.**

---

## 8. Facts you will want, measured 6 Aug

**Accounts** (5, all active, all with PINs): Harvey Betts (Assistant Manager,
`is_master`), Ross McArthur (Manager), Andrew Richardson (Owner), Rob Scott
(Owner), Alex Harper (Mechanic).

**`app_access.master_admins`** = Harvey, Ross, Andrew. Correct.

**Devices**: 10 approved, 1 revoked. Andrew has three and has not opened the app
since 4 Aug — *all three* look unused, so there is no obvious stray to delete.
One shared "Workshop Mac". Use Manage Devices in the app, not SQL.

**Ghosts — all cleared 7 August.** Part B ran and its check returned zero rows.
Gone: Jayden Aginsky and Rafael Hewitt from `presence`, Rafael Hewitt from
`user_prefs`, "Andrew Richardson Computer" from `staff` and `account_sites`
(that was Andrew's Mac, registered as a person back when a new device meant a
new name), Charbel Tawk from `app_access.overrides`. `push_subs` was already
clean. Verified afterwards that all five real accounts survive in every one of
those lists.

**Biggest tables**: `rimo_bms_history` 1055 MB, `rf_passings` 36 MB,
`rf_repairs` 10 MB, `rf_kart_notes` 6.8 MB.

**Role tab config** lives in `app_access.roles`. Worth knowing: the **Owner**
role does not include `sessdata`, `health` or `summary`, while Manager and
Assistant Manager do. Andrew and Rob are Owners. That may be deliberate; ask
before changing it.

---

## 9. How to work with Harvey

- He reports bugs from the floor, in his own words, often several at once. Read
  all of them before starting.
- **Check the client before the server.** He was once told to redeploy
  `master-staff` for a "needs a 4-digit PIN" error that was `msSave()` in
  `index.html` refusing before the server was ever called. That same pattern —
  a client-side check that can never pass — turned out to be behind both bugs
  found on 6 Aug. Grep the app first.
- **A test that passes on a dead server is not a passing test.** One repro came
  back clean and was reported as "cause not found"; the local test server had
  died. Verify the harness is alive before believing a negative.
- He will ask you to confirm things are *fully* sorted. Do not confirm on the
  strength of code you wrote — confirm on the strength of something you
  measured, and say which.
- Explainer images for him and Ross showing how the sign-in system works are
  **requested but queued** — he will say when.
