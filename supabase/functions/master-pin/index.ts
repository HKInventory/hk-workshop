// master-pin — returns the CURRENT 10-minute master code to anyone who has Master Access.
//
// "Has Master Access" = the owner (OWNER_NAME, always), OR anyone listed in the owner-controlled
// app_access.master_admins, OR anyone in the legacy config.pin_managers list. Because master_admins
// is changed ONLY by the master-access function (which requires OWNER_KEY), granting someone like Ross
// the ability to use the master tools is a single owner action and can't be done by any app user.
//
// The seed lives as MASTER_PIN_SEED and never leaves the server, so the rotating code can only ever
// be handed to an authorised caller here. (The owner can also bypass this entirely with OWNER_KEY,
// which every master- function accepts directly as a skeleton key.)
//
// ---------------------------------------------------------------------------------------------
// HARDENED 7 AUGUST 2026. THREE THINGS WERE WRONG, AND ONE OF THEM WAS LIVE.
//
// 1. NO RATE LIMIT, AND A FOUR-DIGIT SECRET BEHIND IT.
//    This function has verify_jwt=false and CORS "*", so it answers anyone on the internet with no
//    key of any kind — that is deliberate and fine on its own. What was not fine: it took a PIN,
//    compared it to staff.pin, and on a match handed back a live master code, with no lockout and
//    no backoff. Every account had a 32-character random placeholder in staff.pin EXCEPT the
//    owner's, whose row predated the migration and still held their real four digits. Ten thousand
//    possibilities, no lockout, from anywhere. The owner's PIN was changed on 7 Aug and staff.pin
//    now holds a random value for everyone (verified: zero four-digit PINs remain), which closed
//    it — but the endpoint should never have depended on that, so it no longer does.
//    Failures are counted per IP in hk_auth_log and refused past a threshold.
//
// 2. A NON-CONSTANT-TIME COMPARE ON A SECRET. `===` stops at the first differing character and how
//    long that takes is measurable. Replaced with the same constant-time compare hk-auth uses.
//
// 3. AN UNPINNED esm.sh IMPORT. "@2" is resolved fresh at deploy time, so this deployed as a
//    different library each time and on 2026-08-03 a deploy failed outright because esm.sh could
//    not serve a sub-dependency. Pinned, matching hk-auth and the master-* functions.
//
// A session token is now accepted as well, and is the preferred credential. The app still sends
// cu.pin (the legacy bridge key), which keeps working; when it moves to the token this function is
// already ready and the staff table can go. See HANDOVER.md section 5.9.
// ---------------------------------------------------------------------------------------------
import { createClient } from "npm:@supabase/supabase-js@2.111.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown) =>
  new Response(JSON.stringify(o), { headers: { ...cors, "Content-Type": "application/json" } });

const MAX_FAILS_PER_IP = 10;    // inside the window below
const WINDOW_MIN       = 10;

const enc = new TextEncoder();
/* Constant-time compare — same reasoning as hk-auth's sameSecret. A plain === leaks how many
   leading characters were right, one network round trip at a time. */
function sameSecret(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const ipOf = (req: Request) =>
  (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";

// Deterministic 6-digit code for a given 10-min window (HMAC-SHA256, TOTP-style).
async function codeFor(windowIdx: number, seed: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(seed),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(windowIdx))));
  const off = sig[sig.length - 1] & 0x0f;
  const n = ((sig[off] & 0x7f) << 24) | (sig[off + 1] << 16) | (sig[off + 2] << 8) | sig[off + 3];
  return String(n % 1000000).padStart(6, "0");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const ip = ipOf(req);
  try {
    const body = await req.json();
    const cred = String(body?.token ?? body?.pin ?? "").trim();   // token preferred, pin legacy
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const OWNER_NAME = (Deno.env.get("OWNER_NAME") || "Harvey Betts").trim();

    /* THE BACKOFF. Counted per IP over a short window, because there is no account to count
       against until the credential matches — that is the nature of this endpoint. It never blocks a
       legitimate caller, who presents a correct credential first time. A logging failure must not
       become an outage, so the count is best-effort and a broken read fails OPEN on purpose: the
       master tools staying reachable matters more than a rate limit that only exists as defence in
       depth behind a 32-character secret. */
    let recentFails = 0;
    try {
      const since = new Date(Date.now() - WINDOW_MIN * 60000).toISOString();
      const { count } = await sb.from("hk_auth_log")
        .select("*", { count: "exact", head: true })
        .eq("event", "masterpin_fail").eq("ip", ip).gte("at", since);
      recentFails = count || 0;
    } catch { /* best effort */ }
    if (recentFails >= MAX_FAILS_PER_IP) {
      return json({ success: false, message: "Too many tries — wait a few minutes." });
    }

    const fail = async (why: string) => {
      try { await sb.from("hk_auth_log").insert({ event: "masterpin_fail", ip, detail: { why } }); } catch { /* best effort */ }
      return json({ success: false });          // same answer whichever way it failed
    };
    if (!cred) return await fail("empty");

    // Who is asking? Either the session says so, or the legacy bridge key does.
    let callerName = "";
    if (cred.split(".").length === 3) {
      // A Supabase session token. The auth server verifies the signature before a field is read.
      try {
        const { data, error } = await sb.auth.getUser(cred);
        if (error || !data?.user) return await fail("bad-token");
        const nm = String((data.user.app_metadata || {}).hk_name || "").trim();
        if (!nm) return await fail("token-no-name");
        // A valid token is not a live account. Re-read it, so Remove bites at once.
        const { data: acct } = await sb.from("hk_accounts").select("name,status").eq("name", nm).maybeSingle();
        if (!acct || acct.status !== "active") return await fail("token-inactive");
        callerName = nm;
      } catch { return await fail("token-error"); }
    } else {
      const { data: staff } = await sb.from("staff").select("name, pin, active").eq("active", true);
      const caller = (staff || []).find((s) => sameSecret(String(s.pin ?? "").trim(), cred));
      if (!caller) return await fail("no-match");
      callerName = String(caller.name);
    }

    // legacy managers list (optional) ...
    const { data: cfg } = await sb.from("config").select("value").eq("key", "pin_managers").maybeSingle();
    const managers: string[] = Array.isArray(cfg?.value) ? (cfg!.value as string[]) : [];
    // ... and the owner-controlled Master Access list
    const { data: acc } = await sb.from("app_access").select("master_admins").eq("id", 1).maybeSingle();
    const admins: string[] = Array.isArray(acc?.master_admins) ? (acc!.master_admins as string[]) : [];

    const allowed =
      callerName === OWNER_NAME ||      // the owner can always get a code
      admins.includes(callerName) ||    // anyone the owner granted Master Access
      managers.includes(callerName);    // legacy managers list
    if (!allowed) return await fail("not-admin");

    const seed = Deno.env.get("MASTER_PIN_SEED")!;
    const now = Math.floor(Date.now() / 1000);
    const code = await codeFor(Math.floor(now / 600), seed);
    return json({ success: true, code, expiresInSec: 600 - (now % 600) });
  } catch (e) {
    // Vague to the caller; the detail would be free reconnaissance.
    return json({ success: false });
  }
});
