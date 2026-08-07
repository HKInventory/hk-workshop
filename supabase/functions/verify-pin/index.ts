// verify-pin — the LEGACY keypad sign-in. Checks the entered PIN against the staff
// table server-side so PINs are never shipped to the browser.
//
// ---------------------------------------------------------------------------------------------
// FIRST COMMITTED TO GIT 7 AUGUST 2026. It had been deployed-only since May and existed nowhere
// in the repository, so this file is the deployed v13 source with the hardening below applied.
//
// WHAT THIS FUNCTION IS NOW. The app's real sign-in is hk-auth. index.html:6355 turns this keypad
// off wherever the new sign-in is on screen (`if(_newAuthUp()) return;`). But the ENDPOINT is
// still deployed with verify_jwt=false and CORS "*", so it answers anyone on the internet with no
// key of any kind, regardless of what the app does. What the app does is not the security boundary.
//
// THREE THINGS WERE WRONG.
//
// 1. AN UNTHROTTLED PLAINTEXT PIN ORACLE.
//    It compared the submitted value against staff.pin in plaintext, with no lockout and no
//    backoff, and on a match returned the person's name, role and emoji. Against a four-digit PIN
//    that is 10,000 tries from anywhere, and it tells you whose account you just opened.
//
//    MEASURED 7 Aug before changing anything: all 6 active staff rows hold a 32-character random
//    hex value, zero hold four digits. So this is NOT exploitable today — hk-auth's mirrorToStaff
//    and owner-set-pin write randHex(16) into staff.pin, which neutralised it as a side effect.
//
//    IT IS STILL A LANDMINE, and that is the point. Master Access -> Staff still accepts and saves
//    four-digit PINs (index.html:16531 validates them and master-staff:240 writes whatever the app
//    sends straight into staff.pin). The moment a manager adds someone with a four-digit PIN, this
//    endpoint becomes a live brute-force oracle for that person's account. Depending on "nobody has
//    done that yet" is not a control, so there is now a rate limit behind it.
//
// 2. A NON-CONSTANT-TIME COMPARE ON A SECRET. `===` stops at the first differing character and how
//    long that takes is measurable. Replaced with the same constant-time compare hk-auth uses.
//
// 3. AN UNPINNED esm.sh IMPORT. "@2" is resolved fresh at deploy time, so this deployed as a
//    different library each time, and on 2026-08-03 a deploy failed outright because esm.sh could
//    not serve a sub-dependency. Pinned, matching hk-auth and the master-* functions.
//
// WHY THE THRESHOLD IS 40 AND NOT 10 LIKE master-pin.
// master-pin is an admin endpoint used a few times a day. This is the SIGN-IN KEYPAD, and every
// tablet on the workshop floor almost certainly shares one NAT address, so per-IP here means
// per-workshop, not per-person. master-pin's limit of 10 in 10 minutes would lock the entire floor
// out over ordinary mistyping — a self-inflicted outage in exchange for defence in depth behind a
// 32-character secret. 40 failures in 10 minutes is far beyond what six people mistyping can
// produce, and still caps a brute force at 240/hour: 10,000 possibilities becomes about 42 hours
// of sustained, logged, obvious attack instead of a few minutes of quiet ones.
//
// The rate-limit read fails OPEN on purpose. A broken count must not take sign-in down; this is
// defence in depth, not the primary control.
//
// GUESSABLE VALUES ARE NOW REFUSED OUTRIGHT. Added on Harvey's instruction, 7 Aug.
// The rate limit slows a brute force; it does not stop one. So this endpoint no longer compares
// short values at all: anything under MIN_SECRET_LEN is rejected before any row is read, and any
// STORED value that short is skipped even if something later writes one. A four-digit PIN can
// therefore never be confirmed here again regardless of what ends up in staff.pin.
//
// Both halves matter and neither is sufficient alone. master-staff now refuses to let a four-digit
// value INTO staff.pin (the server picks the value; the client no longer supplies it); this refuses
// to VALIDATE one that is already there. Belt and braces, because the two paths fail differently.
//
// Nothing legitimate is affected: all six active rows hold 32-character values, and hk-ai passes a
// long bridge token. Measured before shipping, not assumed.
// ---------------------------------------------------------------------------------------------
import { createClient } from "npm:@supabase/supabase-js@2.111.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown) =>
  new Response(JSON.stringify(o), { headers: { ...cors, "Content-Type": "application/json" } });

const MAX_FAILS_PER_IP = 40;   // see the note above on why this is not 10
const WINDOW_MIN       = 10;
/* Shorter than this is guessable by exhaustion, so it is not a secret and is never compared.
   16 sits well above any PIN or short code and well below the 32-character values actually in
   use, so it rejects the dangerous shapes without being tuned to one particular format. */
const MIN_SECRET_LEN   = 16;

const enc = new TextEncoder();
/* Constant-time compare — same reasoning as hk-auth's sameSecret. A plain === stops at the first
   differing character, and how long that takes is measurable one round trip at a time. */
function sameSecret(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const ipOf = (req: Request) =>
  (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const ip = ipOf(req);
  try {
    const { pin } = await req.json();
    const entered = String(pin ?? "").trim();
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    /* Counted per IP, because until the PIN matches there is no account to count against — that is
       the nature of this endpoint. Best-effort and fails open: a logging outage must never become a
       sign-in outage. */
    let recentFails = 0;
    try {
      const since = new Date(Date.now() - WINDOW_MIN * 60000).toISOString();
      const { count } = await sb.from("hk_auth_log")
        .select("*", { count: "exact", head: true })
        .eq("event", "verifypin_fail").eq("ip", ip).gte("at", since);
      recentFails = count || 0;
    } catch { /* best effort */ }
    if (recentFails >= MAX_FAILS_PER_IP) {
      return json({ success: false, message: "Too many tries — wait a few minutes." });
    }

    /* Refused before any row is read, so a short guess costs an attacker a round trip and
       tells them nothing about whether such a value exists. */
    if (entered.length < MIN_SECRET_LEN) {
      try {
        await sb.from("hk_auth_log").insert({
          event: "verifypin_fail", ip,
          detail: { why: entered ? "too short to be a secret" : "empty", len: entered.length },
        });
      } catch { /* best effort */ }
      return json({ success: false });
    }

    const { data, error } = await sb.from("staff").select("name, role, emoji, pin, active").eq("active", true);
    if (error) throw error;

    /* Every row is compared even after a match, so the work done does not depend on WHERE in the
       list the match sits. Constant-time per comparison, constant count of comparisons. */
    let hit: { name?: unknown; role?: unknown; emoji?: unknown } | null = null;
    for (const s of data || []) {
      const stored = String(s.pin ?? "").trim();
      // A stored value too short to be a secret is never matchable, whatever wrote it.
      if (stored.length < MIN_SECRET_LEN) continue;
      if (sameSecret(stored, entered) && !hit) hit = s;
    }

    if (!hit) {
      try { await sb.from("hk_auth_log").insert({ event: "verifypin_fail", ip, detail: { why: "no match" } }); } catch { /* best effort */ }
      return json({ success: false });
    }
    return json({ success: true, name: hit.name, role: hit.role, emoji: hit.emoji });
  } catch (e) {
    /* Generic to the caller. The old version returned String(e), which hands an attacker the
       database error text — table names, column names, and occasionally values. */
    console.error("verify-pin:", String(e));
    return json({ success: false });
  }
});
