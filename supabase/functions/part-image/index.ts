// part-image — CORS image proxy for RIMO product photos, looked up by part SKU.
//
// WHY THIS EXISTS
//   The QR-label PDF embeds the part photo onto a <canvas>. A cross-origin <img> taints the
//   canvas (RIMO serves no CORS headers), which blocks the export. So we fetch the image
//   server-side and re-serve it WITH CORS, letting the editor preview AND print the photo.
//
// FINDING THE RIGHT FILE
//   RIMO's "Art.Nr." is *usually* the image filename, but not always — many products add a
//   suffix (1872007 -> 1872007_01.jpg, 1384061 -> 1384061_1.jpg) or use .png, and a few use
//   the product name in the filename (unguessable). RIMO's search is robots-disallowed, so we
//   can't resolve by scraping; instead we try the common real-world filename patterns directly
//   against the public image folder and return the first that exists. The name-suffix cases
//   won't resolve automatically — set parts.image_url for those (it overrides this proxy).
//
// DEPLOY: Supabase -> Edge Functions -> function name exactly  part-image  -> paste -> Deploy,
//   **Verify JWT OFF** (it's loaded from a plain <img>, which can't send an auth header).
//
// CALL (GET):
//   {SB_FN}part-image?sku=1872007                 -> the image (info size)
//   {SB_FN}part-image?sku=1872007&size=popup      -> larger
//   {SB_FN}part-image?sku=1872007&debug=1         -> JSON: which patterns were tried + which hit
//
// ---------------------------------------------------------------------------------------------
// FIRST COMMITTED TO GIT 7 AUGUST 2026, with four fixes. It had been deployed-only since June.
//
// 1. THE ALLOWLIST CHECKED THE URL WE ASKED FOR, NOT THE ONE WE ARRIVED AT.
//    The ?u= branch validated `exact` properly — https, host shop.rimo-germany.com, path under
//    /images/product_images/, no "..". That check is sound and was never the hole. The hole is
//    that `fetch()` FOLLOWS REDIRECTS by default, and nothing re-checked where it landed. A 302
//    from that host to anywhere at all — a cloud metadata endpoint, an internal address, another
//    site — would be followed, and this function would return the body with
//    Access-Control-Allow-Origin "*" on it, unauthenticated, to any caller. An allowlist that
//    only inspects the request is not an allowlist.
//
//    Fixed by checking the FINAL url (r.url, which fetch sets to the post-redirect address)
//    against the same rule. Redirects are still followed, deliberately: refusing them outright
//    would break the day RIMO adds a canonical redirect, and that failure would look like
//    "photos stopped working" with no clue why.
//
// 2. THE INDEX FILENAME WAS CONCATENATED INTO THE URL UNVALIDATED. The sku is checked against
//    ^[A-Za-z0-9._-]{1,48}$ before being interpolated — but rimo_images.filename, pulled from the
//    database and unshifted onto the front of the candidate list, was not checked at all. That
//    table is written by rimo-image-sync from crawled page content. Same regex now applies to it.
//    (authenticated lost INSERT/UPDATE on rimo_images on 7 Aug, so the browser cannot poison it
//    either — but this is the check that makes it not matter.)
//
// 3. FOLDER[size] WAS A PROTOTYPE-CHAIN LOOKUP. `?size=constructor` returns Object's constructor
//    rather than falling back to info_images, and that gets stringified into a URL. Harmless in
//    practice — it 404s — but it is the kind of thing that stops being harmless when the value is
//    used somewhere else later. Own-property check now.
//
// 4. UNPINNED IMPORT. `jsr:@supabase/supabase-js@2` resolves fresh at deploy time; a deploy in
//    this project failed outright on 2026-08-03 for exactly that. Pinned.
//
// NOT CHANGED, and worth knowing: this is verify_jwt=false by necessity — it is loaded from a
// plain <img> tag, which cannot send an auth header. It reads nothing sensitive (one filename
// lookup) and writes nothing, so anonymous access is the correct trade here rather than an
// oversight. ?debug=1 discloses only which public filenames were tried, which is not a secret.
// ---------------------------------------------------------------------------------------------

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, range",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

import { createClient } from "npm:@supabase/supabase-js@2.111.0";

const FOLDER: Record<string, string> = {
  info: "info_images",
  popup: "popup_images",
  original: "original_images",
};

const RIMO_HOST = "shop.rimo-germany.com";
const RIMO_PATH = "/images/product_images/";
const SAFE_NAME = /^[A-Za-z0-9._-]{1,48}$/;
const MAX_BYTES = 12 * 1024 * 1024;   // a product photo is tens of KB; this is a runaway guard

/** The one rule, applied to the requested URL AND to wherever the request actually ended up. */
function onRimo(url: string): boolean {
  try {
    const p = new URL(url);
    return p.protocol === "https:" && p.hostname === RIMO_HOST &&
           p.pathname.startsWith(RIMO_PATH) && !p.pathname.includes("..");
  } catch { return false; }
}

/** Fetch, then verify where we LANDED. Returns null unless it is a real image still on RIMO. */
async function fetchImage(src: string): Promise<{ buf: ArrayBuffer; ct: string } | null> {
  const r = await fetch(src, { headers: { "User-Agent": "Mozilla/5.0 (HK Workshop image proxy)" } });
  // r.url is the post-redirect address. This is the check the original was missing.
  if (!onRimo(r.url)) {
    console.error(`part-image: refused a redirect off RIMO — ${src} -> ${r.url}`);
    return null;
  }
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  if (!r.ok || !ct.startsWith("image")) return null;
  const len = Number(r.headers.get("content-length") || "0");
  if (len > MAX_BYTES) return null;
  const buf = await r.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) return null;
  return { buf, ct };
}

// Ordered by how common each pattern is, so a normal part hits on the first try.
function candidates(sku: string): string[] {
  return [
    sku + ".jpg",
    sku + "_01.jpg",
    sku + "_1.jpg",
    sku + ".png",
    sku + "_01.png",
    sku + "_1.png",
    sku + "_02.jpg",
    sku + "_2.jpg",
    sku + "_0.jpg",
  ];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "GET") return new Response("GET only", { status: 405, headers: cors });

  const u = new URL(req.url);
  const sku = (u.searchParams.get("sku") || "").trim();
  const size = (u.searchParams.get("size") || "info").toLowerCase();
  const debug = u.searchParams.get("debug") === "1";

  // Exact-URL mode: ?u=<full RIMO image URL>. Used for parts whose filename embeds the product
  // name (underivable from the SKU) — the app stores the pasted URL on the part and routes it
  // through here so it still gets CORS headers for the printable label.
  const exact = (u.searchParams.get("u") || "").trim();
  if (exact) {
    if (!onRimo(exact)) return new Response("bad url", { status: 400, headers: cors });
    try {
      const got = await fetchImage(exact);
      if (got) {
        return new Response(got.buf, { headers: { ...cors, "Content-Type": got.ct, "Cache-Control": "public, max-age=2592000, immutable" } });
      }
    } catch (_e) { /* fall through */ }
    return new Response("not found", { status: 404, headers: cors });
  }

  // SKU is interpolated into a fetched path — allow only safe characters (blocks SSRF / traversal).
  if (!SAFE_NAME.test(sku)) {
    return new Response("bad sku", { status: 400, headers: cors });
  }

  // Own-property lookup: `?size=constructor` must fall back to info, not reach Object.prototype.
  const folder = Object.prototype.hasOwnProperty.call(FOLDER, size) ? FOLDER[size] : FOLDER.info;
  const base = `https://${RIMO_HOST}${RIMO_PATH}${folder}/`;
  const names = candidates(sku);
  // The crawled index (built by rimo-image-sync) knows the EXACT filename — including the
  // name-based ones no pattern can guess — so consult it first, then fall back to guessing.
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data } = await sb.from("rimo_images").select("filename").eq("sku", sku).maybeSingle();
    const fn = data && data.filename ? String(data.filename) : "";
    // Checked exactly like the sku is. It comes from crawled page content, not from us.
    if (fn && SAFE_NAME.test(fn) && !names.includes(fn)) names.unshift(fn);
  } catch (_e) { /* index unavailable -> pattern guessing still works */ }
  const tried: string[] = [];

  for (const name of names) {
    const src = base + name;
    tried.push(name);
    try {
      const got = await fetchImage(src);
      if (got) {
        if (debug) return new Response(JSON.stringify({ sku, found: name, url: src, tried }, null, 2), { headers: { ...cors, "Content-Type": "application/json" } });
        return new Response(got.buf, {
          headers: { ...cors, "Content-Type": got.ct, "Cache-Control": "public, max-age=2592000, immutable", "X-Rimo-File": name },
        });
      }
    } catch (_e) { /* try the next pattern */ }
  }

  if (debug) return new Response(JSON.stringify({ sku, found: null, tried }, null, 2), { headers: { ...cors, "Content-Type": "application/json" } });
  return new Response("not found", { status: 404, headers: cors });
});
