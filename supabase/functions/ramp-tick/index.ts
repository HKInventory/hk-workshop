// ramp-tick — sends ramp-clearance push notifications at 4h / 1h / 30m / NOW.
//
// Invoked every 5 minutes by pg_cron (job "ramp-tick", see ramp_push.sql). Each run it looks at
// today's and tomorrow's ramp events, works out which reminder thresholds are due (in Sydney time)
// and not yet sent (tracked per-event in the notified jsonb), pushes to every subscribed phone via
// Web Push (VAPID), and marks the threshold sent. Dead subscriptions (410/404) are pruned.
//
// ---------------------------------------------------------------------------------------------
// FIRST COMMITTED TO GIT 7 AUGUST 2026. Deployed-only since May, so it existed nowhere in this
// repository. Four things were wrong; the first is why this could not be committed as it stood.
//
// 1. THE VAPID PRIVATE KEY WAS IN THIS FILE.
//    The header carried a block headed "SECRETS (Edge Functions -> Secrets):" listing the literal
//    VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT. The runtime reads them from Deno.env
//    and always did — the values were sitting in a COMMENT, which is worse than useless: it is a
//    private signing key in plain sight in a place nobody thinks to audit.
//
//    Removed. Names only, values never. The key was NOT rotated, by the owner's decision on 7 Aug:
//    rotating invalidates all 8 rows in push_subs and every person has to re-subscribe before
//    notifications work again. Removing it from the source does not un-publish it to anyone who
//    already read the deployed function, so the residual risk is stated plainly rather than
//    papered over: anyone who has seen this file can still sign a push to a subscription they
//    already hold. What they cannot do is enumerate the subscriptions — push_subs grants to
//    authenticated, postgres and service_role only, anon is not a member of authenticated, so an
//    anon-key read fails 42501 before RLS is consulted (checked, 7 Aug). Rotate when a
//    re-subscribe round is acceptable.
//
// 2. THE 1-HOUR REMINDER DID NOT EXIST. The line above this block has always promised
//    "4h / 1h / 30m / NOW". STEPS contained 240, 30 and 0. There was no 60. So the hour warning —
//    the one with enough time left to actually move karts off a ramp — has never been sent, and
//    nothing reported its absence because the ladder silently takes whichever step matches.
//    Added.
//
// 3. UNPINNED IMPORTS. `jsr:@supabase/supabase-js@2` and `npm:web-push@3` resolve fresh at deploy
//    time. A deploy in this project failed outright on 2026-08-03 because an unpinned registry
//    could not serve a sub-dependency. Both pinned; supabase-js matches every other function here.
//
// 4. WRITE ERRORS WERE NEVER INSPECTED. The `notified` write-back was fire-and-forget, so if it
//    failed the same reminder would be re-sent on the next run — every 5 minutes — to every phone.
//    A silent failure in a notifier is a pager storm waiting for a bad afternoon. Now checked and
//    reported in the response.
//
// STILL OPEN, DELIBERATELY, because it cannot be fixed here alone: this function is verify_jwt=false
// with CORS "*" and gates nothing, and the cron job posts to it with no credential of any kind
// (verified in cron.job: headers are Content-Type only). So anyone can invoke it. The practical
// impact is small — a reminder only fires when a threshold is genuinely due AND notified[key] is
// unset, so repeat calls send nothing — but it is an open trigger on a fan-out to every staff
// phone. Closing it needs a shared secret in BOTH this function and the cron command, which is a
// coordinated change, not a one-file edit.
// ---------------------------------------------------------------------------------------------

import { createClient } from "npm:@supabase/supabase-js@2.111.0";
import webpush from "npm:web-push@3.6.7";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown) => new Response(JSON.stringify(o), { headers: { ...cors, "Content-Type": "application/json" } });

const TZ = "Australia/Sydney";
// Reminder ladder: minutes-before-start -> key + wording.
// Descending, and the loop below takes the LAST match on purpose, so a run that arrives late
// sends the most urgent step that applies rather than a stale one.
const STEPS: [number, string, (m: number) => string][] = [
  [240, "h4", () => "in 4 hours"],
  [60, "h1", () => "in 1 hour"],      // was missing entirely — see note 2 above
  [30, "m30", () => "in 30 minutes"],
  [0, "now", () => "NOW"],
];

function sydneyNowParts(): { date: string; minutes: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const p: Record<string, string> = {};
  fmt.formatToParts(new Date()).forEach((x) => { p[x.type] = x.value; });
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86400000);
}
function hm(t: string): number { const m = t.match(/^(\d{2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : 0; }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const pub = Deno.env.get("VAPID_PUBLIC_KEY") || "";
    const priv = Deno.env.get("VAPID_PRIVATE_KEY") || "";
    const subj = Deno.env.get("VAPID_SUBJECT") || "mailto:workshop@hyperkarting.example";
    if (!pub || !priv) return json({ success: false, message: "VAPID keys not set in function secrets" });
    webpush.setVapidDetails(subj, pub, priv);

    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const now = sydneyNowParts();

    // events today or tomorrow that haven't finished
    const { data: events } = await sb.from("ramp_events").select("*").gte("date", now.date).lte("date", new Date(Date.parse(now.date) + 86400000).toISOString().slice(0, 10));
    let sent = 0, pruned = 0, writeFailures = 0;

    for (const ev of events || []) {
      const dd = dayDiff(ev.date, now.date);                    // 0 today, 1 tomorrow
      const minsUntilStart = dd * 1440 + hm(ev.start_t) - now.minutes;
      const minsUntilEnd = dd * 1440 + hm(ev.end_t) - now.minutes;
      if (minsUntilEnd < -5) continue;                          // over
      const notified = (ev.notified && typeof ev.notified === "object") ? ev.notified : {};
      let due: [string, string] | null = null;
      for (const [thresh, key, word] of STEPS) {
        if (minsUntilStart <= thresh && !notified[key]) { due = [key, word(minsUntilStart)]; }
      }
      if (!due) continue;
      const [key, word] = due;
      const title = key === "now" ? "🚧 Ramp must be clear NOW" : `🚧 Ramp clearance ${word}`;
      const body = `${ev.name} — clear the ramp by ${ev.start_t} on ${ev.date.split("-").reverse().join("/")} (needed ${ev.start_t}–${ev.end_t}).`;

      // ev.site === "" (or null) means "all sites" — push to every subscribed phone.
      // Otherwise scope the push to phones subscribed at that site.
      const subsSel = sb.from("push_subs").select("endpoint, sub");
      const { data: subs } = ev.site ? await subsSel.eq("site", ev.site) : await subsSel;
      for (const s of subs || []) {
        try {
          await webpush.sendNotification(s.sub, JSON.stringify({ title, body, tag: "ramp-" + ev.id, url: "./" }), { TTL: 3600 });
          sent++;
        } catch (e: any) {
          const code = e && (e.statusCode || e.status);
          if (code === 404 || code === 410) { await sb.from("push_subs").delete().eq("endpoint", s.endpoint); pruned++; }
        }
      }
      notified[key] = new Date().toISOString();
      /* CHECKED, because a silent failure here re-sends this reminder on the next run — and the
         next, every 5 minutes, to every phone. Surfaced in the response rather than thrown: the
         notification has already gone out, so the run is not a failure, but nobody should have to
         infer a stuck write from staff complaining their phones will not stop. */
      const { error: upErr } = await sb.from("ramp_events").update({ notified }).eq("id", ev.id);
      if (upErr) {
        writeFailures++;
        console.error(`ramp-tick: could not mark event ${ev.id} step ${key} as sent — it WILL repeat:`, upErr.message);
      }
    }
    return json({ success: true, sent, pruned, writeFailures });
  } catch (e) {
    return json({ success: false, message: String((e as Error)?.message || e) });
  }
});
