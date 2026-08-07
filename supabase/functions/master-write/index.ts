// master-write — add / edit / remove a part. Authorised by the OWNER_KEY, by a signed-in session
// from the new sign-in, or (legacy) by a master admin's 4-digit staff PIN.
//
// OWNER OVERRIDE: if masterPin equals the OWNER_KEY secret, the call is authorised regardless of
// anything else. This is the owner's skeleton key — it lets Harvey operate (and verify, which karts/
// tracks delegate to) any master function at any time. OWNER_KEY lives only in the project secrets,
// so only he has it.
//
// SITE-AWARE — and Sydney is no longer the exception:
//   * `parts` is the CATALOGUE, shared by every venue: description, internal description, prices,
//     supplier, brand, lead days, category, photo, QR flag. Same karts, same parts.
//   * `stock` (sku, site) is EVERYTHING THAT DIFFERS BY VENUE: qty, min_stock, location, auto_min,
//     yield_rate, stats_reset_at. Different levels.
//   * Sydney used to write its qty/min_stock/location onto the parts row, and auto_min/yield_rate
//     were global for all venues. Both are fixed here: every venue, Sydney included, writes its own
//     stock row, and the ordering rules are per venue.
//   * Adding a part seeds a zero-qty row at EVERY active site, so a new part exists everywhere the
//     moment it is created rather than appearing at one venue and being invisible at the others.
//   * remove deletes the parts row; the stock rows cascade away via the FK.
//
// Pinned npm: import rather than an unpinned esm.sh URL — see the note in master-access.
import { createClient } from "npm:@supabase/supabase-js@2.111.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown) =>
  new Response(JSON.stringify(o), { headers: { ...cors, "Content-Type": "application/json" } });

// constant-time-ish compare for the owner key
function eqKey(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* ---------------------------------------------------------------------------
   HARDENED 7 AUGUST 2026. THIS FUNCTION IS THE ORACLE, NOT master-karts.

   An audit flagged master-karts as an unauthenticated yes/no oracle against the
   master credential. It is — but it gets that by forwarding here, and THIS
   endpoint is itself verify_jwt=false with CORS "*", so op:"verify" already
   answers {success:true|false} to anyone on the internet with no key at all,
   directly, from their own address. Fixing master-karts alone would have moved
   the oracle, not closed it. The control belongs at the bottom of the stack.

   Three changes, all in the legacy staff.pin branch:

   1. SHORT VALUES ARE REFUSED. Every active staff.pin is a 32-character random
      value (measured 7 Aug: 6 of 6, zero four-digit). A credential shorter than
      MIN_SECRET_LEN therefore CANNOT match anything, so refusing it removes
      only failures and cannot change who gets in. This is what actually kills
      the oracle — a rate limit slows a brute force, this makes it pointless.

   2. THE NULL COERCION IS CLOSED. staff.pin is nullable, and the old compare was
      String(s.pin).trim() === c — so a row with a NULL pin stringified to the
      literal "null" and would have matched a caller sending masterPin "null".
      Inert today (0 of 6 rows are NULL) and reachable with no credential at all.
      Now NULL and short stored values are skipped outright.

   3. CONSTANT-TIME COMPARE. `===` inside .find() short-circuits on both the
      first differing character and the row position, and .find() stopped early
      on a match. Every row is now compared, byte by byte, every time.

   The per-IP backoff is defence in depth behind those. It fails OPEN: a logging
   outage must not take the master tools down. Note that master-karts and
   master-tracks call this server-to-server from the edge runtime, so their
   failures all land on one platform address — the threshold is set well above
   any plausible legitimate failure rate for that reason. */
const MAX_FAILS_PER_IP = 20;
const WINDOW_MIN       = 10;
const MIN_SECRET_LEN   = 16;

const enc = new TextEncoder();
function sameSecret(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const ipOf = (req: Request) =>
  (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";

/* ============================================================================
   AUTHORISE A MASTER ACTION.  See supabase/functions/_shared/master-auth.md.

   Three credentials, in order of preference:
     1. OWNER_KEY          — the owner's skeleton key.
     2. A SESSION TOKEN    — issued by the new sign-in. Preferred.
     3. A 4-digit staff PIN — legacy, kept so an old session is not cut off
                              mid-shift. Goes when `staff` is dropped.

   The token is not a claim the browser makes about itself: hk-auth stamps
   hk_name into the auth user's app_metadata, Supabase signs it, and
   sb.auth.getUser(jwt) verifies that signature before a single field is read.
   A valid token still is not a live account, so the name is re-checked against
   hk_accounts on every call — which is what makes Remove take effect at once
   rather than whenever a token happens to expire.
   ========================================================================== */
async function authorise(sb: any, cred: string): Promise<{ ok: boolean; owner: boolean; viaKey: boolean; name: string }> {
  const OWNER_KEY = Deno.env.get("OWNER_KEY") || "";
  const OWNER_NAME = (Deno.env.get("OWNER_NAME") || "Harvey Betts").trim();
  const no = { ok: false, owner: false, viaKey: false, name: "" };

  if (OWNER_KEY && eqKey(String(cred), OWNER_KEY)) return { ok: true, owner: true, viaKey: true, name: OWNER_NAME };
  const c = String(cred || "").trim();
  if (!c) return no;

  // Who is on the list. Read once, used by whichever path identifies the caller.
  const [cfgRes, accRes] = await Promise.all([
    sb.from("config").select("value").eq("key", "pin_managers").maybeSingle(),
    sb.from("app_access").select("master_admins").eq("id", 1).maybeSingle(),
  ]);
  const managers: string[] = Array.isArray(cfgRes.data?.value) ? cfgRes.data.value : [];
  const admins: string[] = Array.isArray(accRes.data?.master_admins) ? accRes.data.master_admins : [];
  const permitted = (name: string) =>
    !!name && (name === OWNER_NAME || admins.includes(name) || managers.includes(name));

  // ---- 2. a session token from the new sign-in ----
  if (c.split(".").length === 3) {
    try {
      const { data, error } = await sb.auth.getUser(c);
      if (error || !data?.user) return no;
      const name = String((data.user.app_metadata || {}).hk_name || "").trim();
      if (!name) return no;
      const { data: acct } = await sb.from("hk_accounts").select("name,status,is_master").eq("name", name).maybeSingle();
      if (!acct || acct.status !== "active") return no;      // removed or disabled -> out immediately
      if (!(acct.is_master || permitted(name))) return no;
      return { ok: true, owner: name === OWNER_NAME, viaKey: false, name };
    } catch { return no; }
  }

  // ---- 3. legacy: the bridge key held in the old staff table ----
  // Short values cannot match anything here (every stored value is 32 chars), so
  // they are refused before the table is even read. See the note above.
  if (c.length < MIN_SECRET_LEN) return no;
  const { data: staff } = await sb.from("staff").select("name, pin, active").eq("active", true);
  let caller: any = null;
  for (const s of staff || []) {
    const stored = s?.pin == null ? "" : String(s.pin).trim();   // NOT String(null) -> "null"
    if (stored.length < MIN_SECRET_LEN) continue;
    if (sameSecret(stored, c) && !caller) caller = s;            // every row compared, always
  }
  if (!caller) return no;
  return { ok: permitted(caller.name), owner: caller.name === OWNER_NAME, viaKey: false, name: caller.name };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { masterPin, op, part } = await req.json();
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Defence in depth behind the length floor above. Fails OPEN — a logging
    // outage must never take the master tools off a workshop floor.
    const ip = ipOf(req);
    let recentFails = 0;
    try {
      const since = new Date(Date.now() - WINDOW_MIN * 60000).toISOString();
      const { count } = await sb.from("hk_auth_log")
        .select("*", { count: "exact", head: true })
        .eq("event", "masterwrite_fail").eq("ip", ip).gte("at", since);
      recentFails = count || 0;
    } catch { /* best effort */ }
    if (recentFails >= MAX_FAILS_PER_IP) {
      return json({ success: false, message: "Too many tries — wait a few minutes." });
    }

    const auth = await authorise(sb, String(masterPin));
    if (!auth.ok) {
      try { await sb.from("hk_auth_log").insert({ event: "masterwrite_fail", ip, detail: { op: String(op ?? "") } }); } catch { /* best effort */ }
      return json({ success: false, message: "Not authorised for Master Access" });
    }
    const isOwner = auth.owner;
    if (op === "verify") return json({ success: true, owner: isOwner });

    // ----- Ramp access events (level-6 clearances). Master-gated like everything here. -----
    if (op === "push-list") {
      const { data } = await sb.from("push_subs").select("name, site, updated_at").order("updated_at", { ascending: false }).limit(500);
      return json({ success: true, subs: data || [] });
    }
    if (op === "ramp-save") {
      // "" (empty) = applies to ALL sites; a real id scopes it to that venue. Don't coerce "" to sydney.
      const site = (part && typeof part.site === "string") ? part.site.trim() : "";
      const evs = Array.isArray(part?.events) ? part.events : [];
      const rows = evs.map((e: any) => ({
        id: e.id ?? undefined,
        site,
        name: String(e.name || "").trim().slice(0, 120),
        date: String(e.date || ""),
        date_to: (typeof e.date_to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.date_to)) ? e.date_to : null,
        start_t: String(e.start_t || ""),
        end_t: String(e.end_t || ""),
      })).filter((r: any) => r.name && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && /^\d{2}:\d{2}$/.test(r.start_t) && /^\d{2}:\d{2}$/.test(r.end_t));
      if (!rows.length) return json({ success: false, message: "No valid events" });
      const withId = rows.filter((r: any) => r.id != null);
      const fresh = rows.map((r: any) => { const { id, ...rest } = r; return id == null ? rest : null; }).filter(Boolean);
      if (fresh.length) { const { error } = await sb.from("ramp_events").insert(fresh); if (error) return json({ success: false, message: error.message }); }
      for (const r of withId) { const { id, ...rest } = r; const { error } = await sb.from("ramp_events").update(rest).eq("id", id); if (error) return json({ success: false, message: error.message }); }
      return json({ success: true, saved: rows.length });
    }
    if (op === "ramp-delete") {
      const id = Number(part?.id);
      if (!id) return json({ success: false, message: "Missing id" });
      const { error } = await sb.from("ramp_events").delete().eq("id", id);
      return error ? json({ success: false, message: error.message }) : json({ success: true });
    }

    if (op === "remove") {
      if (!part?.sku) return json({ success: false, message: "Missing SKU" });
      const { error } = await sb.from("parts").delete().eq("sku", String(part.sku).trim());
      if (error) throw error;
      return json({ success: true, message: "Part removed" });
    }

    // QR include/exclude flags — update ONLY qr_print, never touch catalogue fields.
    if (op === "qrflag") {
      const sku = String(part?.sku || "").trim();
      if (!sku) return json({ success: false, message: "Missing SKU" });
      const { error } = await sb.from("parts").update({ qr_print: part.qr_print !== false }).eq("sku", sku);
      if (error) throw error;
      return json({ success: true });
    }
    if (op === "qrflagall") {
      const { error } = await sb.from("parts").update({ qr_print: part?.qr_print !== false }).neq("sku", "");
      if (error) throw error;
      return json({ success: true });
    }

    // add / edit (upsert by SKU)
    const sku = String(part?.sku || "").trim();
    // RIMO part numbers are numeric; NS- codes (parts with no SKU) and other suppliers'
    // alphanumeric codes are valid too — the app enforces the per-supplier rules.
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(sku)) return json({ success: false, message: "SKU can only use letters, numbers, dots and dashes (max 40)" });
    // Guard: an add/edit must carry a real description — stops a malformed call blanking a row.
    if (!String(part?.description || "").trim()) return json({ success: false, message: "Missing description — not saving (guards against data wipe)" });
    const num = (v: unknown) => (v === "" || v === null || v === undefined ? null : Number(v));
    const site = String(part?.site || "sydney");

    // ---- SHARED CATALOGUE: the same part, whichever venue you are standing in ----
    const cat = {
      sku,
      description: String(part.description || "").trim(),
      internal_description: part.internal_description ? String(part.internal_description).trim() : null,
      price_eur: num(part.price_eur),
      price_aud: num(part.price_aud),
      // Optional product-photo override (QR labels). Set when the RIMO filename can't be derived
      // from the SKU — the app pastes the exact image URL here. http(s) only; empty clears it.
      image_url: (() => { const u = String(part.image_url || "").trim(); return /^https?:\/\//i.test(u) ? u : null; })(),
      // Supplier fields the app's part form has always sent but earlier versions silently dropped.
      is_rimo: part.is_rimo !== false,
      brand: part.brand ? String(part.brand).trim() : null,
      lead_days: (part.lead_days === "" || part.lead_days == null) ? null : Math.round(Number(part.lead_days)),
      category: part.category ? String(part.category).trim() : null,
    };
    // ---- PER-VENUE STOCK: how much is held here, and how this venue's ordering behaves ----
    // auto_min (the 🔒 lock) and yield_rate (scans before the minimum auto-tunes) USED TO LIVE ON
    // `parts`, which made them global: locking a part in Sydney locked it in Melbourne too. Sydney
    // has more karts and burns through parts faster, so those rules belong to the venue.
    const qty = Math.round(Number(part.qty) || 0);
    const min_stock = part.min_stock === "" || part.min_stock == null ? null : Math.round(Number(part.min_stock));
    const location = String(part.location || "").trim();
    const auto_min = part.lock ? false : true;
    const yield_rate = (part.yield_rate === "" || part.yield_rate == null) ? null : Math.round(Number(part.yield_rate));

    const { error: ce } = await sb.from("parts").upsert(cat, { onConflict: "sku" });
    if (ce) throw ce;

    const { data: wrote, error: se } = await sb.from("stock")
      .upsert({ sku, site, qty, min_stock, location, auto_min, yield_rate }, { onConflict: "sku,site" })
      .select("sku");
    if (se) throw se;
    if (!wrote || !wrote.length) return json({ success: false, message: "Stock write affected no rows — the catalogue saved but this venue's levels did not" });

    // A NEW part must exist at every venue, not only the one it was typed into. Seed the others at
    // zero held, with the same starting minimum and rules — from there each venue tunes its own.
    if (op === "add") {
      try {
        const { data: sites } = await sb.from("sites").select("id").eq("active", true);
        const others = (sites || []).map((s: any) => String(s.id)).filter((id: string) => id && id !== site);
        if (others.length) {
          // ignoreDuplicates: never overwrite levels a venue has already set.
          await sb.from("stock").upsert(
            others.map((id: string) => ({ sku, site: id, qty: 0, min_stock, location: "", auto_min, yield_rate })),
            { onConflict: "sku,site", ignoreDuplicates: true },
          );
        }
      } catch (_e) { /* best-effort: seeding other venues must never fail the save */ }
    }

    return json({ success: true, message: op === "add" ? "Part added" : "Part saved" });
  } catch (e) {
    return json({ success: false, message: String(e) });
  }
});
