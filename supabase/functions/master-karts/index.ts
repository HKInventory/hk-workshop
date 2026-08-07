// ===========================================================================
//  Supabase Edge Function:  master-karts
//  Privileged write for Master Access -> Karts: mark a kart "long term damaged"
//  (can't fix right now). The kart keeps its real type; this only flips an
//  overlay flag so it moves to the Long Term pile and drops out of the usable
//  counts. Reads (the kart list) use the anon key + RLS, exactly like Kart Info.
//
//  Deploy it the SAME way as your other functions (Supabase dashboard ->
//  Edge Functions -> Create function -> name it exactly  master-karts  ->
//  paste this -> Deploy). No secrets to add: SUPABASE_URL /
//  SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY are injected automatically.
//
//  Security: the master code is verified by delegating to your existing
//  "master-write" function (op:"verify"), so this function never needs to know
//  how the code is stored. The DB write uses the service-role key, which stays
//  on the server. The browser only ever holds the anon key.
//
//  App calls it as:
//    fetch(SB_FN+'master-karts', {method:'POST', headers:HDRS,
//      body: JSON.stringify({ masterPin, op:'setLongTerm', rfId, longTerm, by })})
//  Returns: { success:true, rfId, longTerm }  or  { success:false, message }
//
// ---------------------------------------------------------------------------
//  FIRST COMMITTED TO GIT 7 AUGUST 2026. Deployed-only since May. Four fixes.
//
//  1. THE "No rfId" GUARD DID NOT CATCH A MISSING rfId.
//         const rfId = Number(body?.rfId);
//         if (!Number.isFinite(rfId)) return ... "No rfId"
//     Number(null), Number(""), Number([]) and Number(false) are all 0, and 0 is
//     finite. So every one of those passed the guard and the update targeted
//     rf_id = 0. No such kart exists today, so nothing was hit — but the check
//     did not do what it plainly reads as doing, and that is the kind of thing
//     that is only ever discovered by the row it eventually destroys. Now
//     requires a positive integer that was actually supplied.
//
//  2. THE UPDATE REPORTED SUCCESS WHEN IT CHANGED NOTHING. .update().eq() with no
//     .select() leaves error null when the filter matches no rows, so the caller
//     got {success:true} for a kart that does not exist. master-write guards
//     exactly this on its own stock write ("Stock write affected no rows"), so
//     the pattern was known here and simply not applied. Now 404s instead.
//
//  3. THE CREDENTIAL CEILING EXCLUDED THE PREFERRED CREDENTIAL. masterPin was
//     capped at 200 characters. A session JWT from the new sign-in is several
//     hundred, so a signed-in manager was rejected with "Missing code" before
//     master-write ever saw it, silently forcing everything back onto the legacy
//     bridge key. Raised to 4096.
//
//  4. UNPINNED esm.sh IMPORT — the last one in this project. This specifier class
//     failed a deploy outright on 2026-08-03 when esm.sh could not serve a
//     sub-dependency. Pinned, matching every other function here.
//
//  KNOWN AND NOT FULLY FIXED: long_term_by is whatever the caller puts in
//  body.by, with no relation to the authenticated identity, so anyone holding a
//  master credential can attribute a kart being pulled out of service to someone
//  else. Closing it properly needs master-write's op:"verify" to return the
//  resolved caller name — today it returns only {success, owner:boolean}, having
//  computed the real name internally and discarded it. verifyMaster() below is
//  written to use a `name` field the moment master-write starts sending one, so
//  that fix becomes a one-line change there rather than a change in both.
//
//  The unauthenticated yes/no oracle an audit flagged here is deliberately NOT
//  fixed here either: it lives in master-write, which this delegates to, and was
//  closed there on 7 Aug. Fixing it in both places would have moved it.
// ===========================================================================
import { createClient } from "npm:@supabase/supabase-js@2.111.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

/* Reuse the existing master-write `verify` so we don't duplicate code-checking logic.
   Returns the resolved caller name when master-write supplies one — see the note above on
   long_term_by. It does not today, so `name` is null and attribution falls back to body.by. */
async function verifyMaster(masterPin: string): Promise<{ ok: boolean; name: string | null }> {
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/master-write`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
      body: JSON.stringify({ masterPin, op: "verify" }),
    });
    const j = await r.json().catch(() => ({} as any));
    const name = (j && typeof j.name === "string" && j.name.trim()) ? j.name.trim().slice(0, 80) : null;
    return { ok: !!(j && j.success), name };
  } catch {
    return { ok: false, name: null };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ success: false, message: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ success: false, message: "Bad JSON" }, 400); }

  const masterPin = String(body?.masterPin ?? "");
  const op = String(body?.op ?? "");
  // Accepts the OWNER_KEY, a session JWT (several hundred chars — see note 3), or the legacy
  // bridge key. master-write decides which; this only rejects lengths that cannot be any of them.
  if (!masterPin || masterPin.length < 4 || masterPin.length > 4096) return json({ success: false, message: "Missing code" }, 400);
  const auth = await verifyMaster(masterPin);
  if (!auth.ok) return json({ success: false, message: "Invalid or expired code" }, 401);

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  if (op === "setLongTerm") {
    /* Number(null) / Number("") / Number([]) / Number(false) are all 0, and 0 is finite — so the
       old Number.isFinite() check passed every one of them and targeted rf_id = 0. Require the
       field to be present AND a positive integer. See note 1. */
    const raw = body?.rfId;
    const rfId = (typeof raw === "number" || (typeof raw === "string" && raw.trim() !== "")) ? Number(raw) : NaN;
    if (!Number.isInteger(rfId) || rfId <= 0) return json({ success: false, message: "No rfId" }, 400);

    const longTerm = body?.longTerm === true;
    // Prefer a server-resolved identity; fall back to the client's claim until master-write
    // returns one. See the note at the top — this is attribution, not authorisation.
    const by = auth.name || (String(body?.by ?? "").slice(0, 80) || null);

    const upd = await db.from("rf_karts")
      .update({
        long_term: longTerm,
        long_term_at: longTerm ? new Date().toISOString() : null,
        long_term_by: longTerm ? by : null,
      })
      .eq("rf_id", rfId)
      .select("rf_id");
    if (upd.error) return json({ success: false, message: upd.error.message }, 500);
    // No .select() here meant a kart that does not exist came back as success. See note 2.
    if (!upd.data || !upd.data.length) return json({ success: false, message: `No kart with rf_id ${rfId} — nothing was changed` }, 404);
    return json({ success: true, rfId, longTerm, by });
  }

  return json({ success: false, message: "Unknown op" }, 400);
});
