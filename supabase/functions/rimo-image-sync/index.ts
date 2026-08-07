// rimo-image-sync — builds the SKU -> product-photo index from the RIMO shop, automatically.
//
// WHY: most RIMO image filenames start with the product number (1831003_11.jpg), but some embed
// the product NAME (Senkschraubet_8.jpg) and can't be derived from a SKU. This function walks the
// shop's public category pages (marked robots "index,follow" — the same pages Google crawls),
// harvests every product thumbnail, and for name-based filenames opens the product page to read
// its Product No. It stores sku -> filename in the rimo_images table; the part-image proxy then
// resolves ANY sku from that table with no manual work.
//
// HOW IT RUNS: stateful breadth-first crawl, ~18 pages per call (stays well inside function time
// limits). The app calls it in a loop until { done: true }. State (queue/seen/counters) lives in
// rimo_sync_state so the crawl resumes across calls. Re-running after "done" starts a fresh pass
// (worth doing every few months as RIMO adds parts). A polite 150ms gap between fetches.
//
// DEPLOY: Edge Functions -> create  rimo-image-sync  -> paste -> Deploy, **Verify JWT OFF**.
// Requires the rimo_images.sql migration. Auth: same rule as master-write (owner key or the
// bridge key of an active master admin).
//
// OPS (POST): { masterPin, op }
//   op "run"    -> process one batch, returns { queued, seen, found, done }
//   op "status" -> progress without crawling
//   op "reset"  -> clear state and start over (keeps found mappings)
//
// ---------------------------------------------------------------------------------------------
// FIRST COMMITTED TO GIT 7 AUGUST 2026. Deployed-only since June. Three fixes.
//
// 1. THE SAME CREDENTIAL BUGS AS master-write, WHICH WERE FIXED THERE THE SAME DAY.
//    authorise() did `String(s.pin).trim() === c` over every active staff row. Three faults in
//    one line, and this endpoint is verify_jwt=false with CORS "*", so anyone can reach it:
//
//      * staff.pin is NULLABLE, and String(null) is the four-character string "null". A row with
//        a NULL pin would therefore have matched a caller submitting masterPin "null" — no
//        credential needed at all. Inert today (0 of 6 active rows are NULL, measured) but real.
//      * `===` inside .find() short-circuits on the first differing character AND stops at the
//        first matching row, so both the value and its position leak through timing.
//      * No length floor, so a short guess was compared rather than refused.
//
//    Fixed identically to master-write: short credentials are refused before the table is read,
//    NULL and short STORED values are skipped, and every row is compared byte by byte every time.
//    Nothing legitimate changes — every active staff.pin is a 32-character random value, so a
//    shorter credential could never have matched anything.
//
// 2. HARVESTED FILENAMES WERE STORED WITHOUT VALIDATION. `filename` comes from regexes run over
//    crawled HTML and went straight into rimo_images, which part-image then concatenates into a
//    fetch URL. part-image now validates on read (fixed the same day); this validates on write,
//    so the table cannot hold a value that would be rejected later and silently lose a photo.
//
// 3. UNPINNED jsr: IMPORT — the specifier class that failed a deploy outright on 2026-08-03.
// ---------------------------------------------------------------------------------------------

import { createClient } from "npm:@supabase/supabase-js@2.111.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown) => new Response(JSON.stringify(o), { headers: { ...cors, "Content-Type": "application/json" } });

const HOST = "https://shop.rimo-germany.com";
const SEEDS = [
  "/en/article-new/", "/en/small-and-standard-parts/", "/en/tools/", "/en/workshop/",
  "/en/track-equipment/", "/en/kart-assemblies/", "/en/battery-technology/",
];
const BATCH = 18;            // pages per invocation
const PAUSE_MS = 150;        // politeness gap between fetches
const UA = "HK Workshop image indexer (contact: workshop app; fetches public catalogue pages only)";

// Shorter than this is guessable by exhaustion, so it is not a secret and is never compared.
const MIN_SECRET_LEN = 16;
// The same shape part-image will accept when it reads this back out of rimo_images.
const SAFE_NAME = /^[A-Za-z0-9._-]{1,48}$/;

const enc = new TextEncoder();
function sameSecret(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function eqKey(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function authorise(sb: any, cred: string): Promise<boolean> {
  const OWNER_KEY = Deno.env.get("OWNER_KEY") || "";
  const OWNER_NAME = (Deno.env.get("OWNER_NAME") || "Harvey Betts").trim();
  if (OWNER_KEY && eqKey(String(cred), OWNER_KEY)) return true;
  const c = String(cred || "").trim();
  // Refused before the table is read — see note 1. Cannot reject a real credential, because
  // every stored value is 32 characters.
  if (c.length < MIN_SECRET_LEN) return false;

  const { data: staff } = await sb.from("staff").select("name, pin, active").eq("active", true);
  let caller: any = null;
  for (const s of staff || []) {
    const stored = s?.pin == null ? "" : String(s.pin).trim();   // NOT String(null) -> "null"
    if (stored.length < MIN_SECRET_LEN) continue;
    if (sameSecret(stored, c) && !caller) caller = s;            // every row compared, always
  }
  if (!caller) return false;

  const { data: cfg } = await sb.from("config").select("value").eq("key", "pin_managers").maybeSingle();
  const managers: string[] = Array.isArray(cfg?.value) ? cfg.value : [];
  const { data: acc } = await sb.from("app_access").select("master_admins").eq("id", 1).maybeSingle();
  const admins: string[] = Array.isArray(acc?.master_admins) ? acc.master_admins : [];
  return caller.name === OWNER_NAME || admins.includes(caller.name) || managers.includes(caller.name);
}

// Category listing (or subcategory) page: /en/.../  optionally ?page=N. Product page: /en/slug.html
function isCategoryPath(p: string): boolean { return /^\/en\/[a-z0-9\-\/]+\/$/.test(p); }
function isProductPath(p: string): boolean { return /^\/en\/[a-z0-9\-]+\.html$/.test(p) && !p.startsWith("/en/info/") && !p.startsWith("/en/popup/"); }
function skuFromFilename(f: string): string | null { const m = f.match(/^(\d{5,})/); return m ? m[1] : null; }

function harvest(html: string, pageUrl: string, state: any, sb: any, ups: any[]) {
  // 1) product links with their thumbnail image (listing pages + related-product blocks)
  const linkImg = /<a[^>]+href="([^"]+\.html)"[^>]*>\s*<img[^>]+src="[^"]*\/product_images\/[a-z_]+\/([^"?]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = linkImg.exec(html))) {
    const file = decodeURIComponent(m[2]);
    const sku = skuFromFilename(file);
    if (sku) { ups.push({ sku, filename: file }); }
    else {
      try { const u = new URL(m[1], HOST); if (u.origin === HOST && isProductPath(u.pathname) && !state.seen[u.pathname]) { state.queue.push(u.pathname); state.seen[u.pathname] = 1; } } catch (_e) { /* skip */ }
    }
  }
  // 2) any bare product image URLs (covers layouts the link+img regex misses)
  const anyImg = /\/product_images\/[a-z_]+\/([^"'?\s)]+\.(?:jpe?g|png|gif|webp))/gi;
  while ((m = anyImg.exec(html))) {
    const file = decodeURIComponent(m[1]);
    const sku = skuFromFilename(file);
    if (sku) ups.push({ sku, filename: file });
  }
  // 3) on a PRODUCT page: pair its Product No. with its og:image (resolves name-based filenames)
  const isProduct = isProductPath(new URL(pageUrl).pathname);
  if (isProduct) {
    const no = html.match(/(?:Product\s*No\.?|Art\.?\s*Nr\.?)\s*:?\s*(?:<[^>]*>\s*)*([A-Za-z0-9][A-Za-z0-9\-]{2,})/i);
    const og = html.match(/property="og:image"\s+content="[^"]*\/product_images\/[a-z_]+\/([^"?]+)"/i)
            || html.match(/\/product_images\/info_images\/([^"'?\s)]+)/i);
    if (no && og) ups.push({ sku: no[1].trim(), filename: decodeURIComponent(og[1]) });
  } else {
    // 4) on a CATEGORY page: enqueue subcategories + pagination
    const links = /href="([^"#?]+)(\?page=\d+)?"/gi;
    while ((m = links.exec(html))) {
      try {
        const u = new URL(m[1] + (m[2] || ""), HOST);
        if (u.origin !== HOST) continue;
        const key = u.pathname + (u.search || "");
        if ((isCategoryPath(u.pathname)) && !state.seen[key]) { state.queue.push(key); state.seen[key] = 1; }
      } catch (_e) { /* skip */ }
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { masterPin, op } = await req.json();
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    if (!(await authorise(sb, String(masterPin)))) return json({ success: false, message: "Not authorised for Master Access" });

    const { data: st } = await sb.from("rimo_sync_state").select("value").eq("id", 1).maybeSingle();
    let state: any = (st && st.value) || null;

    if (op === "reset" || !state) {
      state = { queue: SEEDS.slice(), seen: Object.fromEntries(SEEDS.map((s) => [s, 1])), scanned: 0, found: 0, done: false };
      if (op === "reset") { await sb.from("rimo_sync_state").upsert({ id: 1, value: state, updated_at: new Date().toISOString() }); return json({ success: true, ...progress(state) }); }
    }
    if (op === "status") return json({ success: true, ...progress(state) });

    // op === "run": process one batch
    const ups: { sku: string; filename: string }[] = [];
    let n = 0;
    while (n < BATCH && state.queue.length) {
      const path = state.queue.shift();
      n++; state.scanned++;
      try {
        const r = await fetch(HOST + path, { headers: { "User-Agent": UA, "Accept-Language": "en" } });
        if (r.ok) harvest(await r.text(), HOST + path, state, sb, ups);
      } catch (_e) { /* skip page */ }
      if (state.queue.length && n < BATCH) await new Promise((rz) => setTimeout(rz, PAUSE_MS));
    }
    // de-dupe this batch's mappings (first hit wins; product-page pairs were pushed last so prefer existing)
    const seenSku: Record<string, boolean> = {};
    const rows = [];
    let rejected = 0;
    for (const u of ups) {
      const sku = String(u.sku).trim();
      if (!sku || seenSku[sku]) continue;
      const filename = String(u.filename ?? "").trim();
      /* Validated on the way IN, matching what part-image will accept on the way out. These come
         from regexes over crawled HTML, so anything at all can appear here; storing a value that
         part-image would later reject means a photo that silently never loads. */
      if (!SAFE_NAME.test(sku) || !SAFE_NAME.test(filename)) { rejected++; continue; }
      seenSku[sku] = true;
      rows.push({ sku, filename, updated_at: new Date().toISOString() });
    }
    if (rows.length) {
      const { error } = await sb.from("rimo_images").upsert(rows, { onConflict: "sku" });
      if (!error) state.found += rows.length;
    }
    if (!state.queue.length) state.done = true;
    await sb.from("rimo_sync_state").upsert({ id: 1, value: state, updated_at: new Date().toISOString() });
    return json({ success: true, ...progress(state), rejected });
  } catch (e) {
    return json({ success: false, message: String((e as Error)?.message || e) });
  }
});

function progress(state: any) {
  return { queued: state.queue.length, scanned: state.scanned, found: state.found, done: !!state.done };
}
