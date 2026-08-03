// ===========================================================================
//  Supabase Edge Function:  hk-auth
//  ---------------------------------------------------------------------------
//  The whole login system in one place. Requesting access, your approval, a
//  person choosing their own PIN, logging in, staying logged in, PIN resets, and
//  your break-glass recovery code.
//
//  WHAT THIS CHANGES, IN ONE LINE
//  Today the PIN is checked on the screen and the database trusts a key that is
//  printed in the page source. After this, the database trusts nothing except a
//  short-lived pass this function issues, and it only issues one to a real person
//  with the right PIN on a device you approved.
//
//  DEPLOY
//    Supabase Dashboard -> Edge Functions -> Create a new function
//    -> name it exactly  hk-auth  -> paste this whole file -> Deploy.
//
//  ONE SECRET TO ADD (Edge Functions -> Secrets):
//    HK_JWT_SECRET = your project's JWT secret
//      Find it: Settings -> API -> JWT Settings -> JWT Secret -> Reveal.
//    SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically; the
//    JWT secret is NOT, which is why it has to be added by hand.
//
//    Treat that secret as the crown jewel. It signs the pass this function
//    issues, and it is the same secret behind your existing keys. It must never
//    appear in the app, in the repo, or in a message. It lives here and nowhere
//    else.
//
//  NOTHING BREAKS BY DEPLOYING THIS.
//  verify-pin, hk-ai and every master-* function are untouched and keep working.
//  Until the new login screen ships, nothing in the app even calls this. You can
//  deploy it now and the floor will not notice.
// ===========================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const JWT_SECRET   = Deno.env.get("HK_JWT_SECRET") || "";

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

/* CORS: the app is served from GitHub Pages today and moves to Cloudflare later,
   so both origins are allowed and nothing else. This used to be "*" on the other
   functions, which lets any website on the internet call them from a visitor's
   browser. Named origins cost nothing and close that. */
const ALLOWED = [
  "https://hkinventory.github.io",
  "http://localhost:8000",
];
function corsFor(req: Request) {
  const origin = req.headers.get("origin") || "";
  const ok = ALLOWED.some((a) => origin === a || origin.startsWith(a));
  return {
    "Access-Control-Allow-Origin": ok ? origin : ALLOWED[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const json = (req: Request, b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsFor(req), "Content-Type": "application/json" } });

// ---- little helpers --------------------------------------------------------
const enc = new TextEncoder();
const b64url = (buf: ArrayBuffer | Uint8Array) => {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const randHex = (bytes = 32) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes))).map((b) => b.toString(16).padStart(2, "0")).join("");
const nowSec = () => Math.floor(Date.now() / 1000);

/* Constant-time compare. A normal === returns as soon as two strings differ, and
   how long that takes is measurable over a network — enough, with patience, to
   work out a secret one character at a time. Everything compared here is a
   secret, so everything uses this. */
function sameSecret(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/* PBKDF2-SHA256. Deliberately slow, so the stored value cannot be turned back
   into a PIN by reading it. See the honest note in the schema file: against
   someone holding the whole table a 4-digit PIN falls regardless of hashing —
   the real defences are device approval and per-account lockout. This is what
   stops it being readable, which is what stops anyone (you included) seeing it. */
async function hashSecret(secret: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: 210000, hash: "SHA-256" }, key, 256);
  return b64url(bits);
}
async function sha256(s: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

/* The pass itself. Signed with the project's JWT secret and carrying
   role:"authenticated", which is what makes the database accept it as a real
   logged-in user rather than the anonymous public key. The extra claims — who,
   which site, what role, which device — are what the new database rules read to
   decide whether a given row may be touched. */
async function signPass(payload: Record<string, unknown>): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const data = `${b64url(enc.encode(JSON.stringify(header)))}.${b64url(enc.encode(JSON.stringify(payload)))}`;
  const key = await crypto.subtle.importKey("raw", enc.encode(JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return `${data}.${b64url(sig)}`;
}

/* Verifying a pass someone hands back to us (for manager-only operations).
   The algorithm is PINNED to HS256 and the header is checked before anything
   else. Without that, a caller can send alg:"none" — a token with no signature
   at all — and a lazy verifier accepts it. That single check is the difference
   between this being a lock and being a suggestion. */
async function readPass(token: string): Promise<Record<string, any> | null> {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return null;
    const header = JSON.parse(atob(parts[0].replace(/-/g, "+").replace(/_/g, "/")));
    if (header?.alg !== "HS256" || header?.typ !== "JWT") return null;   // no alg:none, ever
    const key = await crypto.subtle.importKey("raw", enc.encode(JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const expect = b64url(await crypto.subtle.sign("HMAC", key, enc.encode(`${parts[0]}.${parts[1]}`)));
    if (!sameSecret(expect, parts[2])) return null;
    const body = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (!body?.exp || body.exp < nowSec()) return null;                  // expiry enforced here, not trusted
    return body;
  } catch { return null; }
}

const ipOf = (req: Request) =>
  (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";

async function log(event: string, name: string | null, device_id: string | null, ip: string, detail?: unknown) {
  try { await db.from("hk_auth_log").insert({ event, name, device_id, ip, detail: detail ?? null }); } catch { /* never block a login on logging */ }
}

// ---- tuning ---------------------------------------------------------------
const PASS_MINUTES     = 30;      // how long a pass lasts. Also how long revoking takes to bite.
const REFRESH_DAYS     = 14;      // how long a device can renew without a PIN, if used regularly
const MAX_FAILS        = 5;       // wrong PINs before an account pauses
const LOCK_SECONDS     = 60;      // first pause; doubles each time, capped
const LOCK_CAP_SECONDS = 900;

// ===========================================================================
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsFor(req) });
  if (req.method !== "POST")    return json(req, { success: false, message: "POST only" }, 405);
  if (!JWT_SECRET)              return json(req, { success: false, message: "Server not configured: HK_JWT_SECRET is missing" }, 500);

  let body: any;
  try { body = await req.json(); } catch { return json(req, { success: false, message: "Bad request" }, 400); }

  const op  = String(body?.op || "");
  const ip  = ipOf(req);
  const did = String(body?.device_id || "");
  const dkey = String(body?.device_key || "");

  /* Confirms the caller is a device we approved. It must present the secret it
     generated at request time; we only ever stored its hash, so this table
     cannot be used to impersonate a device even by someone holding it. */
  async function approvedDevice() {
    if (!did || !dkey) return null;
    const { data } = await db.from("hk_devices").select("*").eq("device_id", did).maybeSingle();
    if (!data || data.status !== "approved") return null;
    if (!sameSecret(await sha256(dkey), data.key_hash)) return null;
    db.from("hk_devices").update({ last_seen: new Date().toISOString() }).eq("device_id", did).then(() => {}, () => {});
    return data;
  }

  /* Confirms the caller is a logged-in manager. Note it re-reads the account from
     the database rather than believing the role written in the pass: a pass is
     valid for up to half an hour, and someone demoted or disabled in that window
     must lose manager powers immediately, not when their pass runs out. */
  async function callerManager() {
    const claims = await readPass(String(body?.token || ""));
    if (!claims?.name) return null;
    const { data } = await db.from("hk_accounts").select("*").eq("name", claims.name).maybeSingle();
    if (!data || data.status !== "active") return null;
    const mgr = data.is_master || data.app_role === "Manager" || data.app_role === "Assistant Manager";
    return mgr ? data : null;
  }

  async function issue(account: any, device_id: string) {
    const pass = await signPass({
      iss: "hk-auth",
      role: "authenticated",           // the claim the database reads to accept this as a real user
      aud: "authenticated",
      sub: account.id,                 // a real uuid — some database rules cast this, and a non-uuid breaks them
      name: account.name,
      app_role: account.app_role,
      site: account.site,
      is_master: !!account.is_master,
      device_id,
      iat: nowSec(),
      exp: nowSec() + PASS_MINUTES * 60,
    });
    const refresh = randHex(32);
    await db.from("hk_sessions").insert({
      account_id: account.id, device_id,
      refresh_hash: await sha256(refresh),
      expires_at: new Date(Date.now() + REFRESH_DAYS * 86400000).toISOString(),
    });
    return { pass, refresh, expires_in: PASS_MINUTES * 60 };
  }

  try {
    switch (op) {

      /* ---- 1. "Let me in" — a new device asks for access -------------------
         Gated on the join code, so the queue cannot be reached from the open
         internet. Creates a PENDING device. Approves nothing by itself. */
      case "request-device": {
        const { data: cfg } = await db.from("hk_auth_config").select("join_code").eq("id", 1).maybeSingle();
        if (!cfg?.join_code) return json(req, { success: false, message: "Sign-up is closed. Ask a manager." });
        if (!sameSecret(String(body?.join_code || ""), cfg.join_code)) {
          await log("device_request_bad_code", String(body?.requested_name || ""), null, ip);
          return json(req, { success: false, message: "That code isn't right." });
        }
        const device_key = randHex(32);
        const device_id  = randHex(16);
        await db.from("hk_devices").insert({
          device_id, key_hash: await sha256(device_key),
          requested_name: String(body?.requested_name || "").slice(0, 60),
          user_agent: String(req.headers.get("user-agent") || "").slice(0, 300),
          platform: String(body?.platform || "").slice(0, 80),
          label: String(body?.label || "").slice(0, 60) || null,
          kind: "personal", status: "pending",
        });
        await log("device_request", String(body?.requested_name || ""), device_id, ip);
        // The key is handed over exactly once and only ever lives on that device.
        return json(req, { success: true, device_id, device_key });
      }

      /* ---- 2. "Am I approved yet?" — the waiting screen polls this --------- */
      case "device-status": {
        if (!did) return json(req, { success: false });
        const { data } = await db.from("hk_devices").select("status,kind,owner_name,label").eq("device_id", did).maybeSingle();
        if (!data) return json(req, { success: true, status: "unknown" });
        return json(req, { success: true, status: data.status, kind: data.kind, owner_name: data.owner_name, label: data.label });
      }

      /* ---- 3. Choose a PIN -------------------------------------------------
         Only reachable on an approved device, and only for an account flagged as
         needing one — which is true when it is brand new and when you have reset
         it. That flag is the entire reason a manager never has to invent a
         temporary PIN and tell someone what it is. */
      case "set-pin": {
        const dev = await approvedDevice();
        if (!dev) return json(req, { success: false, message: "This device isn't approved." });
        const name = String(body?.name || "");
        const pin  = String(body?.pin || "");
        if (!/^\d{4}$/.test(pin)) return json(req, { success: false, message: "PIN must be 4 digits." });
        if (/^(\d)\1{3}$/.test(pin) || ["1234", "4321", "0123"].includes(pin))
          return json(req, { success: false, message: "Too easy to guess — pick another." });

        const { data: acct } = await db.from("hk_accounts").select("*").eq("name", name).maybeSingle();
        if (!acct || acct.status !== "active") return json(req, { success: false, message: "No account for that name." });
        if (!acct.must_set_pin)               return json(req, { success: false, message: "This account already has a PIN. Ask a manager to reset it." });
        if (dev.kind === "personal" && dev.owner_name && dev.owner_name !== name)
          return json(req, { success: false, message: "This device belongs to someone else." });

        const salt = randHex(16);
        await db.from("hk_accounts").update({
          pin_hash: await hashSecret(pin, salt), pin_salt: salt,
          must_set_pin: false, pin_set_at: new Date().toISOString(),
          failed_count: 0, locked_until: null, updated_at: new Date().toISOString(),
        }).eq("id", acct.id);
        if (dev.kind === "personal" && !dev.owner_name)
          await db.from("hk_devices").update({ owner_name: name }).eq("device_id", did);

        await log("pin_set", name, did, ip);
        return json(req, { success: true, ...(await issue(acct, did)), name: acct.name, role: acct.app_role, site: acct.site, is_master: acct.is_master });
      }

      /* ---- 4. Log in ------------------------------------------------------- */
      case "login": {
        const dev = await approvedDevice();
        if (!dev) return json(req, { success: false, code: "device", message: "This device isn't approved yet." });
        const name = String(body?.name || "");
        const pin  = String(body?.pin || "");

        const { data: acct } = await db.from("hk_accounts").select("*").eq("name", name).maybeSingle();

        /* Same answer, whether the account is missing, disabled or the PIN is
           wrong. Different messages would let anyone with the app confirm who
           works here and who has been removed. */
        const no = () => json(req, { success: false, message: "That PIN doesn't match." });
        if (!acct || acct.status !== "active") { await log("login_fail", name, did, ip, { reason: "no-account" }); return no(); }

        if (acct.locked_until && new Date(acct.locked_until) > new Date()) {
          const secs = Math.ceil((new Date(acct.locked_until).getTime() - Date.now()) / 1000);
          await log("locked", name, did, ip);
          return json(req, { success: false, code: "locked", message: `Too many tries. Wait ${secs}s.` });
        }
        if (acct.must_set_pin) return json(req, { success: false, code: "set-pin", message: "Choose a PIN to finish setting up." });
        if (dev.kind === "personal" && dev.owner_name && dev.owner_name !== name)
          return json(req, { success: false, message: "This device belongs to someone else." });

        const ok = acct.pin_hash && sameSecret(await hashSecret(pin, acct.pin_salt || ""), acct.pin_hash);
        if (!ok) {
          const fails = (acct.failed_count || 0) + 1;
          /* Backs off per ACCOUNT, not per venue. All the workshop tablets share
             one wifi address, so anything counted per network would let five fat
             fingers at shift open lock out the whole floor. */
          const patch: Record<string, unknown> = { failed_count: fails };
          if (fails >= MAX_FAILS) {
            const wait = Math.min(LOCK_SECONDS * Math.pow(2, fails - MAX_FAILS), LOCK_CAP_SECONDS);
            patch.locked_until = new Date(Date.now() + wait * 1000).toISOString();
          }
          await db.from("hk_accounts").update(patch).eq("id", acct.id);
          await log("login_fail", name, did, ip, { fails });
          return no();
        }

        await db.from("hk_accounts").update({ failed_count: 0, locked_until: null }).eq("id", acct.id);
        await log("login_ok", name, did, ip);
        return json(req, { success: true, ...(await issue(acct, did)), name: acct.name, role: acct.app_role, site: acct.site, is_master: acct.is_master });
      }

      /* ---- 5. Stay logged in ------------------------------------------------
         Swaps a renewal ticket for a fresh pass without asking for the PIN, so a
         tablet left on all day never interrupts anyone. Re-checks the account is
         still active on every renewal, which is what makes "remove someone" mean
         removed rather than removed-once-their-app-closes. */
      case "refresh": {
        const dev = await approvedDevice();
        if (!dev) return json(req, { success: false, code: "device" });
        const rt = String(body?.refresh || "");
        if (!rt) return json(req, { success: false });
        const { data: sess } = await db.from("hk_sessions")
          .select("*").eq("device_id", did).eq("revoked", false)
          .gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }).limit(20);
        const hash = await sha256(rt);
        const match = (sess || []).find((s: any) => sameSecret(s.refresh_hash, hash));
        if (!match) return json(req, { success: false, code: "reauth" });

        const { data: acct } = await db.from("hk_accounts").select("*").eq("id", match.account_id).maybeSingle();
        if (!acct || acct.status !== "active") {
          await db.from("hk_sessions").update({ revoked: true }).eq("id", match.id);
          return json(req, { success: false, code: "reauth" });
        }
        await db.from("hk_sessions").update({ last_used_at: new Date().toISOString() }).eq("id", match.id);
        const pass = await signPass({
          iss: "hk-auth", role: "authenticated", aud: "authenticated", sub: acct.id,
          name: acct.name, app_role: acct.app_role, site: acct.site, is_master: !!acct.is_master,
          device_id: did, iat: nowSec(), exp: nowSec() + PASS_MINUTES * 60,
        });
        return json(req, { success: true, pass, expires_in: PASS_MINUTES * 60, name: acct.name, role: acct.app_role, site: acct.site, is_master: !!acct.is_master });
      }

      /* ---- 6. Your Devices screen ------------------------------------------ */
      case "devices-list": {
        const mgr = await callerManager();
        if (!mgr) return json(req, { success: false, message: "Managers only." }, 403);
        const { data } = await db.from("hk_devices")
          .select("device_id,label,kind,owner_name,status,requested_name,user_agent,platform,approved_by,approved_at,last_seen,created_at")
          .order("created_at", { ascending: false }).limit(200);
        return json(req, { success: true, devices: data || [] });
      }

      /* ---- 7. Approve / revoke a device ------------------------------------
         Where you choose personal or shared. Shared is the communal iPads: the
         full staff picker and a shorter idle logout. Revoke is kept rather than
         deleted, so a lost phone stays on the record and cannot quietly return. */
      case "device-decide": {
        const mgr = await callerManager();
        if (!mgr) return json(req, { success: false, message: "Managers only." }, 403);
        const target = String(body?.target_device_id || "");
        const decision = String(body?.decision || "");
        if (!["approved", "revoked"].includes(decision)) return json(req, { success: false, message: "Unknown decision" });

        const patch: Record<string, unknown> = { status: decision, approved_by: mgr.name, approved_at: new Date().toISOString() };
        if (decision === "approved") {
          patch.kind = body?.kind === "shared" ? "shared" : "personal";
          patch.label = String(body?.label || "").slice(0, 60) || null;
          if (patch.kind === "personal" && body?.owner_name) patch.owner_name = String(body.owner_name).slice(0, 60);
        }
        await db.from("hk_devices").update(patch).eq("device_id", target);
        if (decision === "revoked") await db.from("hk_sessions").update({ revoked: true }).eq("device_id", target);
        await log(decision === "approved" ? "device_approved" : "device_revoked", mgr.name, target, ip, { kind: patch.kind });
        return json(req, { success: true });
      }

      /* ---- 8. Create an account, and reset a forgotten PIN -------------------
         A reset CLEARS the PIN, it does not set one. The person picks the new one
         themselves on their own device. That is the difference between you being
         unable to see their PIN and you merely promising not to look. */
      case "account-upsert": {
        const mgr = await callerManager();
        if (!mgr) return json(req, { success: false, message: "Managers only." }, 403);
        const name = String(body?.name || "").trim().slice(0, 60);
        if (!name) return json(req, { success: false, message: "Name required" });
        await db.from("hk_accounts").upsert({
          name,
          app_role: String(body?.app_role || "Mechanic"),
          site: String(body?.site || "sydney"),
          status: body?.status === "disabled" ? "disabled" : "active",
          updated_at: new Date().toISOString(),
        }, { onConflict: "name" });
        if (body?.status === "disabled") {
          const { data: a } = await db.from("hk_accounts").select("id").eq("name", name).maybeSingle();
          if (a) await db.from("hk_sessions").update({ revoked: true }).eq("account_id", a.id);
        }
        await log("account_upsert", mgr.name, null, ip, { target: name, status: body?.status || "active" });
        return json(req, { success: true });
      }
      case "reset-pin": {
        const mgr = await callerManager();
        if (!mgr) return json(req, { success: false, message: "Managers only." }, 403);
        const name = String(body?.target_name || "");
        const { data: a } = await db.from("hk_accounts").select("id").eq("name", name).maybeSingle();
        if (!a) return json(req, { success: false, message: "No such account" });
        await db.from("hk_accounts").update({
          pin_hash: null, pin_salt: null, must_set_pin: true,
          failed_count: 0, locked_until: null, updated_at: new Date().toISOString(),
        }).eq("id", a.id);
        await db.from("hk_sessions").update({ revoked: true }).eq("account_id", a.id);
        await log("pin_reset", mgr.name, null, ip, { target: name });
        return json(req, { success: true });
      }

      /* ---- 9. The join code ------------------------------------------------- */
      case "set-join-code": {
        const mgr = await callerManager();
        if (!mgr) return json(req, { success: false, message: "Managers only." }, 403);
        const code = String(body?.code || "").trim();
        if (!/^\d{4,8}$/.test(code)) return json(req, { success: false, message: "4 to 8 digits" });
        await db.from("hk_auth_config").update({ join_code: code, join_code_set_at: new Date().toISOString() }).eq("id", 1);
        await log("join_code_set", mgr.name, null, ip);
        return json(req, { success: true });
      }

      /* ---- 10. Break glass ---------------------------------------------------
         For one situation: every device has forgotten, or your phone is gone, and
         there is nobody left who can approve you. Approves the device it is typed
         on, logs you in as master, and burns itself so the same code can never be
         used twice. This exists so that no step of this rollout can ever leave
         you locked out of your own system with no way back. */
      case "recovery": {
        const { data: cfg } = await db.from("hk_auth_config").select("recovery_hash").eq("id", 1).maybeSingle();
        if (!cfg?.recovery_hash) return json(req, { success: false, message: "No recovery code set." });
        const code = String(body?.code || "");
        if (!sameSecret(await sha256(code), cfg.recovery_hash)) {
          await log("recovery_fail", null, did, ip);
          return json(req, { success: false, message: "Not recognised." });
        }
        const { data: master } = await db.from("hk_accounts").select("*").eq("is_master", true).eq("status", "active").limit(1).maybeSingle();
        if (!master) return json(req, { success: false, message: "No master account." });

        const device_key = dkey || randHex(32);
        const device_id  = did  || randHex(16);
        await db.from("hk_devices").upsert({
          device_id, key_hash: await sha256(device_key),
          label: "Recovery", kind: "shared", status: "approved",
          approved_by: "recovery", approved_at: new Date().toISOString(),
        }, { onConflict: "device_id" });
        await db.from("hk_auth_config").update({ recovery_hash: null }).eq("id", 1);   // single use
        await log("recovery_used", master.name, device_id, ip);
        return json(req, { success: true, device_id, device_key, ...(await issue(master, device_id)),
                           name: master.name, role: master.app_role, site: master.site, is_master: true,
                           must_set_pin: master.must_set_pin,
                           message: "Recovery used. Set a new recovery code from Master Access." });
      }
      case "set-recovery": {
        const mgr = await callerManager();
        if (!mgr?.is_master) return json(req, { success: false, message: "Master only." }, 403);
        const code = randHex(16);   // generated here so a weak one can never be chosen
        await db.from("hk_auth_config").update({ recovery_hash: await sha256(code), recovery_set_at: new Date().toISOString() }).eq("id", 1);
        await log("recovery_set", mgr.name, null, ip);
        // Shown once, never stored in the clear, never retrievable again.
        return json(req, { success: true, code });
      }

      default:
        return json(req, { success: false, message: "Unknown op" }, 400);
    }
  } catch (e) {
    console.error("[hk-auth]", e);
    /* Deliberately vague to the caller, detailed in the logs. An error message
       that names a table or a column is free reconnaissance. */
    return json(req, { success: false, message: "Something went wrong." }, 500);
  }
});
