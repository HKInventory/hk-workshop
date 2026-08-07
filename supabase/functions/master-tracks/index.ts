// ===========================================================================
//  Supabase Edge Function:  master-tracks
//  Privileged writes for the Beacon Designer (track blueprint image + beacons).
//
//  Deploy it the SAME way as your other functions (Supabase dashboard ->
//  Edge Functions -> Create function -> name it "master-tracks" -> paste this
//  -> Deploy). No secrets to add: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY /
//  SUPABASE_ANON_KEY are injected automatically.
//
//  Security: the master code is verified by delegating to your existing
//  "master-write" function (op: "verify"), so this function never needs to know
//  how the code is stored. All DB writes use the service-role key, which stays
//  on the server. The browser only ever holds the anon key.
//
//  App calls it as:
//    fetch(SB_FN+'master-tracks', {method:'POST', headers:HDRS,
//      body: JSON.stringify({ masterPin, op:'save', trackId, blueprintUrl, beacons }) })
//  Reads (loading tracks into the designer) use the anon key + RLS select.
//
// ---------------------------------------------------------------------------
//  FIRST COMMITTED TO GIT 7 AUGUST 2026. Deployed-only since June. Four fixes.
//
//  1. A MISSING FIELD DESTROYED THE BLUEPRINT. This is the serious one.
//
//         const blueprintUrl = body?.blueprintUrl == null ? null : String(...)
//         ...update({ blueprint_url: blueprintUrl, has_map: !!blueprintUrl })
//
//     `== null` is true for undefined as well as null, so a save that simply did
//     not MENTION blueprintUrl wrote NULL over it and set has_map false. The
//     blueprint is a 195,091-character data: URI. It exists in that column and
//     nowhere else — it cannot be re-derived, re-fetched or reconstructed, only
//     re-drawn by hand. One partial save, one older client, one retry that
//     dropped a field, and it was gone silently with a success response.
//
//     Absent and null now mean different things, which is the only way this can
//     be safe: the key being ABSENT means "leave it alone", and an explicit null
//     means "clear it". Same for beacons — an absent list no longer deletes every
//     beacon on the track.
//
//  2. THE CREDENTIAL CEILING EXCLUDED THE PREFERRED CREDENTIAL. masterPin was
//     capped at 200 characters, described as "a 6-digit rotating code OR a longer
//     OWNER_KEY". A session JWT from the new sign-in is several hundred
//     characters, so a signed-in manager was rejected with "Missing code" before
//     master-write ever saw it — silently forcing everything back onto the legacy
//     bridge key. Raised to 4096.
//
//  3. blueprintUrl WAS STORED WITH NO SCHEME CHECK. It is written to a column
//     that the app renders. Now restricted to the two things it is ever
//     legitimately: an inline data:image/... URI, or an https:// URL.
//
//  4. UNPINNED esm.sh IMPORT — the specifier class that failed a deploy outright
//     on 2026-08-03. Pinned, matching every other function here.
//
//  Not changed: the unauthenticated yes/no oracle an audit flagged here. It was
//  real, but it lives in master-write, which this delegates to, and was closed
//  there on 7 Aug (short credentials refused, constant-time compare, per-IP
//  backoff). Fixing it here as well would have moved it, not closed it.
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

// A blueprint is either pasted inline as a data URI or linked over https. Nothing else.
const OK_BLUEPRINT = /^(data:image\/[a-z0-9.+-]+;base64,|https:\/\/)/i;

// Reuse the existing master-write `verify` so we don't duplicate code-checking logic.
async function verifyMaster(masterPin: string): Promise<boolean> {
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/master-write`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
      body: JSON.stringify({ masterPin, op: "verify" }),
    });
    const j = await r.json().catch(() => ({} as any));
    return !!(j && j.success);
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ success: false, message: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ success: false, message: "Bad JSON" }, 400); }

  const masterPin = String(body?.masterPin ?? "");
  const op = String(body?.op ?? "");
  // Accepts the OWNER_KEY, a session JWT (several hundred chars — see note 2), or the legacy
  // bridge key. master-write decides which; this only rejects lengths that cannot be any of them.
  if (!masterPin || masterPin.length < 4 || masterPin.length > 4096) return json({ success: false, message: "Missing code" }, 400);
  if (!(await verifyMaster(masterPin))) return json({ success: false, message: "Invalid or expired code" }, 401);

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  if (op === "save") {
    const trackId = String(body?.trackId ?? "");
    if (!trackId) return json({ success: false, message: "No trackId" }, 400);

    /* ABSENT IS NOT THE SAME AS NULL. See note 1 — this distinction is the whole fix.
       Not mentioning blueprintUrl leaves the existing one untouched; sending an explicit
       null clears it on purpose. */
    const hasBlueprint = Object.prototype.hasOwnProperty.call(body ?? {}, "blueprintUrl");
    const hasBeacons = Array.isArray(body?.beacons);

    const patch: Record<string, unknown> = { synced_at: new Date().toISOString() };
    if (hasBlueprint) {
      const raw = body.blueprintUrl;
      if (raw == null) {
        patch.blueprint_url = null;
        patch.has_map = false;
      } else {
        const s = String(raw);
        if (s.length > 6_000_000) return json({ success: false, message: "Blueprint too large" }, 413);
        if (!OK_BLUEPRINT.test(s)) return json({ success: false, message: "Blueprint must be a data:image URI or an https URL" }, 400);
        patch.blueprint_url = s;
        patch.has_map = true;
      }
    }

    // 1) update the track's designer columns
    const up = await db.from("tracks").update(patch).eq("id", trackId).select("id");
    if (up.error) return json({ success: false, message: up.error.message }, 500);
    if (!up.data || !up.data.length) return json({ success: false, message: `No track with id ${trackId} — nothing was saved` }, 404);

    // 2) replace this track's beacons, but ONLY if the caller actually sent a list.
    //    An absent beacons key used to arrive as [] and delete every beacon on the track.
    if (!hasBeacons) return json({ success: true, blueprint: hasBlueprint ? "updated" : "unchanged", beacons: "unchanged" });

    const beacons = body.beacons;
    if (beacons.length > 200) return json({ success: false, message: "Too many beacons" }, 400);

    const del = await db.from("beacons").delete().eq("track_id", trackId);
    if (del.error) return json({ success: false, message: del.error.message }, 500);

    const rows = beacons.slice(0, 200).map((b: any, i: number) => ({
      track_id: trackId,
      name: String(b?.name ?? "Beacon").slice(0, 80),
      sn: String(b?.sn ?? "").slice(0, 60),
      fn: String(b?.fn ?? "").slice(0, 60),
      color: /^#[0-9a-fA-F]{3,8}$/.test(String(b?.color ?? "")) ? String(b.color) : "#00CFFF",
      x: Math.max(0, Math.min(100, Number(b?.x) || 0)),
      y: Math.max(0, Math.min(100, Number(b?.y) || 0)),
      position: i,
    }));
    if (rows.length) {
      const ins = await db.from("beacons").insert(rows);
      if (ins.error) return json({ success: false, message: ins.error.message }, 500);
    }
    return json({ success: true, blueprint: hasBlueprint ? "updated" : "unchanged", beacons: rows.length });
  }

  return json({ success: false, message: "Unknown op" }, 400);
});
