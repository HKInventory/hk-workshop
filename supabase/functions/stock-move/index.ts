// stock-move — take / restock. EVERY SITE READS AND WRITES ITS OWN `stock` ROW.
//
// Sydney used to be special-cased onto the shared `parts` row: qty, min_stock and location for the
// founding venue lived on the record every venue shares. That is what made per-venue ordering
// levels impossible — Sydney's numbers WERE the catalogue's numbers, so a second venue could only
// ever be the odd one out, and a third would have made it worse. `parts` is now the catalogue
// (description, prices, supplier, category) and `stock` (sku, site) carries everything that
// differs by venue: qty, min_stock, location, auto_min, yield_rate, stats_reset_at.
//
// Adding Perth is one insert and it inherits every rule automatically.
//
// ---------------------------------------------------------------------------------------------
// 7 AUGUST 2026. Pulled into git for the first time (one of nine deployed functions with no copy
// in this repository). It does NOT carry the shape-check fault that broke hk-ai — checked line by
// line, there is no regex on the credential. Three things fixed, NO change to any stock logic:
//
// 1. THE IMPORT WAS UNPINNED: "https://esm.sh/@supabase/supabase-js@2", resolved fresh by esm.sh
//    at deploy time. That is a third party able to change the library under a file nobody edited,
//    and on 2026-08-03 it failed a deploy outright. Now pinned to the version every other function
//    here already runs.
// 2. IT RETURNED THE RAW ERROR to the caller — String(e) on any throw. This endpoint needs no key
//    to reach, so an error naming a table or a column was free reconnaissance.
// 3. NON-CONSTANT-TIME COMPARE on the credential. Same fix as hk-auth and master-pin.
//
// The quantity arithmetic, the partial upsert, the affected-no-rows check and the smart-minimum
// block are untouched. This function moves real stock on a live floor; the fixes above are the
// only differences from v19.
// ---------------------------------------------------------------------------------------------
import { createClient } from "npm:@supabase/supabase-js@2.111.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown) =>
  new Response(JSON.stringify(o), { headers: { ...cors, "Content-Type": "application/json" } });

const enc = new TextEncoder();
function sameSecret(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { pin, sku, qty, type, site: rawSite } = await req.json();
    const site = String(rawSite || "sydney");
    const q = parseInt(qty, 10);
    if (!q || q < 1) return json({ success: false, message: "Invalid quantity" });

    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: staff } = await sb.from("staff").select("name, pin, active").eq("active", true);
    const who = (staff || []).find((s) => sameSecret(String(s.pin ?? "").trim(), String(pin ?? "").trim()));
    if (!who) return json({ success: false, message: "Unknown PIN" });

    const cleanSku = String(sku).trim();
    // The catalogue row still decides whether the SKU exists at all, and carries the fallback
    // behaviour for a venue that has not set its own yet.
    const { data: p, error: pe } = await sb.from("parts")
      .select("sku, auto_min, yield_rate").eq("sku", cleanSku).single();
    if (pe || !p) return json({ success: false, message: "SKU " + cleanSku + " not found" });

    const label = site.charAt(0).toUpperCase() + site.slice(1);

    // This venue's row. maybeSingle so a part not yet held here reads as zero rather than erroring.
    const { data: srow, error: se } = await sb.from("stock")
      .select("qty, min_stock, auto_min, yield_rate").eq("sku", cleanSku).eq("site", site).maybeSingle();
    if (se) throw se;

    const cur = srow ? (Number(srow.qty) || 0) : 0;
    let newQty: number;
    if (type === "restock") {
      newQty = cur + q;
    } else {
      if (cur < q) {
        return json({ success: false, message: cur === 0 ? "None held at " + label : "Only " + cur + " in stock at " + label });
      }
      newQty = cur - q;
    }

    // Partial upsert: PostgREST only SETs the columns present in the payload, so min_stock,
    // location and the behaviour columns on an existing row are left exactly as they are.
    const { data: wrote, error: ue } = await sb.from("stock")
      .upsert({ sku: cleanSku, site, qty: newQty }, { onConflict: "sku,site" })
      .select("sku");
    if (ue) throw ue;
    // A write that silently affects nothing is the failure mode that hides for weeks. Say so now.
    if (!wrote || !wrote.length) return json({ success: false, message: "Stock write affected no rows — nothing was changed" });

    await sb.from("logs").insert({ staff_name: who.name, sku: cleanSku, action: type === "restock" ? "RESTOCK" : "TAKEN", qty: q, remaining_qty: newQty, site });

    // ----- smart minimum, per venue -----
    // Sydney has more karts than Melbourne and burns through parts faster, so the tuned minimum
    // has to be the VENUE's, computed from the VENUE's usage. Both halves of that are now true:
    // the logs query is already filtered by site, and the result lands on this site's stock row.
    try {
      // auto_min and yield_rate come from the venue's own row, falling back to the catalogue for a
      // row that predates the migration. `false` is a real value here — check for null, not falsy.
      const autoMin = (srow && srow.auto_min != null) ? srow.auto_min : p.auto_min;
      if (autoMin !== false) {
        // Yield gate: how many scans before the minimum starts tuning itself. Was hardcoded to 6,
        // which meant a high-use part set to 75 in the sheet had its minimum rewritten by this
        // function long before the app agreed the gate was open. It now reads the same number the
        // app does. (The app counts lifetime scans since reset; this counts the 90-day window —
        // that difference is pre-existing and unchanged here.)
        const yr = (srow && srow.yield_rate != null) ? Number(srow.yield_rate) : (p.yield_rate != null ? Number(p.yield_rate) : 0);
        const minScans = yr > 0 ? yr : 6;
        const since = new Date(Date.now() - 90 * 864e5).toISOString();
        const { data: lg } = await sb.from("logs")
          .select("qty, ts").eq("sku", cleanSku).eq("action", "TAKEN").eq("site", site).gte("ts", since);
        const takes = (lg || []) as Array<{ qty: number; ts: string }>;
        if (takes.length >= minScans) {
          const units = takes.reduce((a, r) => a + (Number(r.qty) || 0), 0);
          let earliest = Date.now();
          for (const r of takes) { const t = new Date(r.ts).getTime(); if (t < earliest) earliest = t; }
          let spanDays = (Date.now() - earliest) / 864e5;
          if (spanDays < 14) spanDays = 14;
          if (spanDays > 90) spanDays = 90;
          const newMin = Math.ceil((units / spanDays) * 90 * 1.3);
          const curMin = srow ? Number(srow.min_stock) : NaN;
          // Never write a row that has not changed — see the 324M realtime message incident.
          if (newMin > 0 && newMin !== curMin) {
            await sb.from("stock").update({ min_stock: newMin }).eq("sku", cleanSku).eq("site", site);
          }
        }
      }
    } catch (_e) { /* best-effort: a tuning failure must never fail the scan */ }

    const word = type === "restock" ? "restocked" : "taken";
    return json({ success: true, remaining: newQty, message: "Done! " + q + " x " + cleanSku + " " + word + " by " + who.name + " (" + label + "). " + newQty + " remaining." });
  } catch (e) {
    // Vague to the caller, detailed in the logs — the same rule hk-auth follows.
    console.error("[stock-move]", e);
    return json({ success: false, message: "Something went wrong — nothing was changed." });
  }
});
