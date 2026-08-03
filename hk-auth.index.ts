// ===========================================================================
//  Supabase Edge Function:  hk-auth
//  ---------------------------------------------------------------------------
//  The whole login system in one place. Requesting access, your approval, a
//  person choosing their own PIN, logging in, staying logged in, PIN resets,
//  device revocation, and the break-glass recovery code.
//
//  WHAT THIS CHANGES, IN ONE LINE
//  Today the PIN is checked on the screen and the database trusts a key that is
//  printed in the page source. After this, the database trusts nothing except a
//  real session, and a session is only ever handed out to a real person with the
//  right PIN on a device you approved.
//
//  WHY THIS DOES NOT MINT ITS OWN TOKENS
//  The first version signed its own passes with the project's shared HS256
//  secret. Then the dashboard showed what this project actually looks like: it
//  moved to ECC (P-256) signing keys two months ago, and the shared secret is now
//  the PREVIOUS key — still accepted while old tokens drain, with a Revoke button
//  sitting next to it. Self-signed passes would have worked perfectly until the
//  day someone tidied that up, then logged out the entire venue with no visible
//  cause. So this hands the token part to Supabase's own login system instead:
//  it always signs with whatever the current key is, renewal is native, and key
//  rotations stop being our problem. It also means there is no secret for you to
//  copy anywhere — the two keys this needs are injected automatically.
//
//  HOW THE PIN STILL GOVERNS EVERYTHING
//  Each person has a Supabase login whose password is 48 random characters
//  generated here and never shown to anyone — not to them, not to you, not in
//  this file. Nobody can use it because nobody knows it. The ONLY way to reach it
//  is to satisfy this function first: correct PIN, active account, approved
//  device. So the PIN and the device remain the real credentials; the random
//  password is just the mechanism that turns a passed check into a real session.
//
//  DEPLOY
//    Supabase Dashboard -> Edge Functions -> hk-auth -> paste this whole file
//    -> Deploy.  (Replaces the earlier version.)
//
//  NO SECRETS TO ADD. SUPABASE_URL, SUPABASE_ANON_KEY and
//  SUPABASE_SERVICE_ROLE_KEY are injected for you. Nothing else is needed.
//
//  NOTHING BREAKS BY DEPLOYING THIS. verify-pin, hk-ai and every master-* screen
//  are untouched. Until the new login screen ships, nothing calls this at all.
// ===========================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;

// Full access, used for everything this function decides. Never leaves the server.
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
// Public-level client, used ONLY to turn a passed check into a real session and
// to validate a token someone hands back to us.
const pub = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });

/* CORS: the app is on GitHub Pages today and moves to Cloudflare later, so both
   are named and nothing else is. The other functions in this project use "*",
   which lets any site on the internet call them from a visitor's browser. */
const ALLOWED = ["https://hkinventory.github.io", "http://localhost:8000"];
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

// ---- helpers ---------------------------------------------------------------
const enc = new TextEncoder();
const b64url = (buf: ArrayBuffer | Uint8Array) => {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const randHex = (bytes = 32) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes))).map((b) => b.toString(16).padStart(2, "0")).join("");

/* Constant-time compare. A normal === stops at the first differing character, and
   how long that takes is measurable over a network — enough, with patience, to
   recover a secret one character at a time. Everything compared here is a secret. */
function sameSecret(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/* PBKDF2-SHA256, deliberately slow, so a PIN cannot be read back out of the
   database — which is what stops anyone seeing it, you included.
   Said plainly: against someone holding this whole table a 4-digit PIN falls
   regardless of how it is stored, because there are only 10,000 of them. Hashing
   is not what makes a short PIN safe. Device approval and per-account lockout are. */
async function hashSecret(secret: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: 210000, hash: "SHA-256" }, key, 256);
  return b64url(bits);
}
async function sha256(s: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

/* TELL THE MANAGERS, WITHOUT MAKING ANYONE WATCH A SCREEN.
   Uses the VAPID keys already set project-wide for notify-user and ramp-tick, so
   there is nothing new to configure. Deliberately does NOT go through notify-user:
   that function authorises its caller by matching a PIN against the old staff
   table, and this one is the thing replacing that table — it already knows who is
   asking, because it decided.
   Never allowed to fail a request. A push that does not send is a missed
   notification; a push that throws would be a staff member unable to sign up. */
async function pushAdmins(title: string, body: string, tag: string) {
  try {
    /* Named vapidPub, not pub: there is a module-level `pub` holding the anon
       Supabase client, and shadowing it inside this function is a trap waiting for
       whoever edits it next. */
    const vapidPub  = Deno.env.get("VAPID_PUBLIC_KEY") || "";
    const vapidPriv = Deno.env.get("VAPID_PRIVATE_KEY") || "";
    if (!vapidPub || !vapidPriv) return;
    webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") || "mailto:workshop@hyperkarting.com.au", vapidPub, vapidPriv);

    const roles = await managerRoles();
    const { data: accts } = await db.from("hk_accounts")
      .select("name,app_role,is_master").eq("status", "active");
    const names = (accts || [])
      .filter((a: any) => a.is_master || roles.includes(String(a.app_role || "")))
      .map((a: any) => a.name);
    if (!names.length) return;

    const { data: subs } = await db.from("push_subs").select("endpoint,sub").in("name", names);
    for (const sub of (subs || [])) {
      try {
        await webpush.sendNotification(
          (sub as any).sub,
          JSON.stringify({ title, body, tag, url: "./" }),
          { TTL: 3600 });
      } catch (e: any) {
        // A phone that has been wiped or reinstalled answers 404/410 forever. Drop it.
        const code = e && (e.statusCode || e.status);
        if (code === 404 || code === 410) await db.from("push_subs").delete().eq("endpoint", (sub as any).endpoint);
      }
    }
  } catch { /* a notification is never worth failing a sign-up over */ }
}

const ipOf = (req: Request) =>
  (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";

async function log(event: string, name: string | null, device_id: string | null, ip: string, detail?: unknown) {
  try { await db.from("hk_auth_log").insert({ event, name, device_id, ip, detail: detail ?? null }); } catch { /* never block a login on logging */ }
}

// ---- tuning ---------------------------------------------------------------
const MAX_FAILS        = 5;      // wrong PINs before an account pauses
const LOCK_SECONDS     = 60;     // first pause; doubles each time
const LOCK_CAP_SECONDS = 900;
const MAIL_DOMAIN      = "hkws.hyperkarting.com.au";   // never receives mail; a stable unique handle

/* TWO TIERS, AND THEY ARE NOT THE SAME THING.
     is_master  — the builder. Harvey, and only Harvey. Grants and revokes admin,
                  sets the recovery code, changes who counts as an admin at all.
                  It is the root of the whole system, so it is one person.
     admin role — the day-to-day job: approving devices, resetting PINs, creating
                  accounts. Andrew (Owner) and Ross (Manager) do this through their
                  ROLE, without needing to be the builder.
   Splitting them means the people who run the floor can run the floor, while the
   one account that can rewrite who is trusted stays a single, deliberate thing.

   THE ROLE LIST IS DATA, NOT CODE.
   It was hardcoded here, which meant every new role Hyper Karting invented would
   silently have no admin rights until someone redeployed this function — and the
   roster already carries Owner, Facilities and Office, none of which I knew about
   when I first wrote the list. It now lives in hk_auth_config so Harvey can change
   it from the owner screen, and this constant is only the fallback for a fresh
   install. Facilities and Office are deliberately absent: ordinary accounts. */
const MANAGER_ROLES_DEFAULT = ["Owner", "Manager", "Assistant Manager"];
async function managerRoles(): Promise<string[]> {
  try {
    const { data } = await db.from("hk_auth_config").select("manager_roles").eq("id", 1).maybeSingle();
    const list = (data?.manager_roles as string[] | null) || null;
    if (list && list.length) return list;
  } catch { /* fall through to the default */ }
  return MANAGER_ROLES_DEFAULT;
}

/* Every account is backed by a Supabase login. Created on demand, with a random
   password nobody ever sees and email confirmation pre-set so no mail is sent.
   app_metadata carries who this is — those values land inside the session token,
   which is what the new database rules will read to decide what each person may
   touch. Refreshed on every login so a change of role or site takes effect at
   once rather than whenever someone next happens to be recreated. */
async function ensureAuthUser(acct: any) {
  let userId = acct.auth_user_id as string | null;
  let email  = acct.auth_email as string | null;
  let secret = acct.auth_secret as string | null;

  if (!email)  email  = `${acct.id}@${MAIL_DOMAIN}`;
  if (!secret) secret = randHex(24);   // 48 hex characters

  const meta = {
    hk_name: acct.name,
    hk_role: acct.app_role,
    hk_site: acct.site,
    hk_master: !!acct.is_master,
  };

  if (!userId) {
    const { data, error } = await db.auth.admin.createUser({
      email, password: secret, email_confirm: true,
      app_metadata: meta, user_metadata: { display_name: acct.name },
    });
    if (error || !data?.user) {
      // Already there from an earlier attempt — find it and reset it to a known state.
      const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const found = (list?.users || []).find((u: any) => u.email === email);
      if (!found) throw new Error("could not create login");
      userId = found.id;
      await db.auth.admin.updateUserById(userId, { password: secret, app_metadata: meta });
    } else {
      userId = data.user.id;
    }
  } else {
    await db.auth.admin.updateUserById(userId, { app_metadata: meta, ban_duration: "none" });
  }

  await db.from("hk_accounts").update({
    auth_user_id: userId, auth_email: email, auth_secret: secret,
    updated_at: new Date().toISOString(),
  }).eq("id", acct.id);

  return { userId, email, secret };
}

/* Turn a passed check into a real session. This is the only place the random
   password is ever used, and it never leaves the server. */
async function issueSession(acct: any, device_id: string) {
  const { email, secret } = await ensureAuthUser(acct);
  const { data, error } = await pub.auth.signInWithPassword({ email: email!, password: secret! });
  if (error || !data?.session) throw new Error("could not start session");

  await db.from("hk_sessions").insert({
    account_id: acct.id, device_id,
    refresh_hash: await sha256(data.session.refresh_token),
    expires_at: new Date(Date.now() + 14 * 86400000).toISOString(),
  });

  return {
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
    name: acct.name, role: acct.app_role, site: acct.site, is_master: !!acct.is_master,
  };
}

// ===========================================================================
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsFor(req) });
  if (req.method !== "POST")    return json(req, { success: false, message: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json(req, { success: false, message: "Bad request" }, 400); }

  const op   = String(body?.op || "");
  const ip   = ipOf(req);
  const did  = String(body?.device_id || "");
  const dkey = String(body?.device_key || "");

  /* Is the caller a device we approved? It must present the secret it generated
     when it first asked for access; only the hash is stored, so this table cannot
     be used to impersonate a device even by someone holding all of it. */
  async function approvedDevice() {
    if (!did || !dkey) return null;
    const { data } = await db.from("hk_devices").select("*").eq("device_id", did).maybeSingle();
    if (!data || data.status !== "approved") return null;
    if (!sameSecret(await sha256(dkey), data.key_hash)) return null;
    db.from("hk_devices").update({ last_seen: new Date().toISOString() }).eq("device_id", did).then(() => {}, () => {});
    return data;
  }

  /* Is the caller a logged-in manager? The token is validated by Supabase itself,
     then the account is re-read from the database rather than believed from the
     token: a session lasts up to an hour, and someone demoted or disabled inside
     that hour must lose manager powers at once, not when their token runs out. */
  async function callerManager() {
    const token = String(body?.token || "");
    if (!token) return null;
    const { data, error } = await pub.auth.getUser(token);
    if (error || !data?.user) return null;
    const { data: acct } = await db.from("hk_accounts").select("*").eq("auth_user_id", data.user.id).maybeSingle();
    if (!acct || acct.status !== "active") return null;
    const mgr = acct.is_master || (await managerRoles()).includes(String(acct.app_role || ""));
    return mgr ? acct : null;
  }

  try {
    switch (op) {

      /* ---- 1. A new device asks for access ---------------------------------
         Gated on the join code, so the queue cannot be reached from the open
         internet. Creates a PENDING device and approves nothing by itself. */
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
        pushAdmins("New device waiting",
          (String(body?.requested_name || "Someone")) + " wants to sign in on a new device. Master Access -> Devices to approve.",
          "hk-device");
        // Handed over once, and only ever lives on that device.
        return json(req, { success: true, device_id, device_key });
      }

      /* ---- 1b. Who has an account, for the picker on a shared device --------
         Requires an approved device on purpose. The sign-in screen used to read the
         staff list straight from a public table, which handed anyone who opened the
         page the name and role of every employee. A brand new device does not need
         the list — its owner types their own name — and a shared iPad that needs the
         picker has already been approved. So the list stops being public without
         anyone losing anything. */
      case "roster": {
        const dev = await approvedDevice();
        if (!dev) return json(req, { success: true, roster: [] });
        /* must_set_pin travels with the roster so the sign-in screen can send someone
           who has never set one straight to creating it, instead of showing a keypad
           for a PIN that does not exist yet. */
        const { data } = await db.from("hk_accounts")
          .select("name,app_role,must_set_pin").eq("status", "active").order("name");
        return json(req, { success: true, roster: data || [] });
      }

      /* ---- 2. "Am I approved yet?" — the waiting screen polls this ---------- */
      case "device-status": {
        if (!did) return json(req, { success: false });
        const { data } = await db.from("hk_devices").select("status,kind,owner_name,label").eq("device_id", did).maybeSingle();
        if (!data) return json(req, { success: true, status: "unknown" });
        return json(req, { success: true, status: data.status, kind: data.kind, owner_name: data.owner_name, label: data.label });
      }

      /* ---- 3. Choose a PIN --------------------------------------------------
         Only on an approved device, and only for an account flagged as needing
         one — true when it is new and when a manager has reset it. That flag is
         the whole reason nobody ever has to invent a temporary PIN and tell
         somebody what it is. */
      case "set-pin": {
        const dev = await approvedDevice();
        if (!dev) return json(req, { success: false, message: "This device isn't approved." });
        const name = String(body?.name || "");
        const pin  = String(body?.pin || "");
        if (!/^\d{4}$/.test(pin)) return json(req, { success: false, message: "PIN must be 4 digits." });
        /* THE OLD PINS ARE BURNED AND MUST NOT COME BACK.
           Eight staff PINs sat in the page source and in git history for months, so
           every one of them is public forever. The likeliest way this whole exercise
           gets quietly undone is somebody typing their familiar four digits at the
           "create your PIN" screen out of pure habit — which would hand the account
           straight back to anyone who read that file. Refusing them here is the only
           place that can be enforced; a note asking people not to would not survive
           first contact with a busy Saturday.
           Kept as a list rather than a rule because these are specific burned values,
           not a pattern. If another leaks, add it. */
        const BURNED = ["1234", "2345", "3456", "4567", "2075", "6969", "7890", "8901"];
        const WEAK   = ["4321", "0123", "1122", "1212", "2580"];
        if (/^(\d)\1{3}$/.test(pin) || WEAK.includes(pin))
          return json(req, { success: false, message: "Too easy to guess — pick another." });
        if (BURNED.includes(pin))
          return json(req, { success: false, message: "That was an old workshop PIN and is public now. Pick a different one." });

        const { data: acct } = await db.from("hk_accounts").select("*").eq("name", name).maybeSingle();
        if (!acct || acct.status !== "active") return json(req, { success: false, message: "No account for that name." });
        if (!acct.must_set_pin) return json(req, { success: false, message: "This account already has a PIN. Ask a manager to reset it." });
        if (dev.kind === "personal" && dev.owner_name && dev.owner_name !== name)
          return json(req, { success: false, message: "This device belongs to someone else." });

        const salt = randHex(16);
        await db.from("hk_accounts").update({
          pin_hash: await hashSecret(pin, salt), pin_salt: salt,
          must_set_pin: false, pin_set_at: new Date().toISOString(),
          failed_count: 0, locked_until: null, reset_requested_at: null,
          updated_at: new Date().toISOString(),
        }).eq("id", acct.id);
        if (dev.kind === "personal" && !dev.owner_name)
          await db.from("hk_devices").update({ owner_name: name }).eq("device_id", did);

        await log("pin_set", name, did, ip);
        const fresh = { ...acct, must_set_pin: false };
        return json(req, { success: true, ...(await issueSession(fresh, did)) });
      }

      /* ---- 4. Log in -------------------------------------------------------- */
      case "login": {
        const dev = await approvedDevice();
        if (!dev) return json(req, { success: false, code: "device", message: "This device isn't approved yet." });
        const name = String(body?.name || "");
        const pin  = String(body?.pin || "");

        const { data: acct } = await db.from("hk_accounts").select("*").eq("name", name).maybeSingle();

        /* One answer whichever way it failed. Different messages would let anyone
           with the app confirm who works here and who has been removed. */
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
          /* Backs off per ACCOUNT, not per venue. Every workshop tablet shares one
             wifi address, so anything counted per network would let five fat
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
        /* CLAIM AN UNOWNED PERSONAL DEVICE ON FIRST USE.
           The ownership check below only bites once owner_name is set, and approval
           does not always set it — a personal device approved without a name would
           accept ANY staff member, indefinitely, which is precisely what "personal"
           is supposed to prevent. set-pin bound it, but somebody signing in with an
           existing PIN never went through set-pin. It binds here too now, to the
           first person who successfully signs in on it. */
        if (dev.kind === "personal" && !dev.owner_name){
          await db.from("hk_devices").update({ owner_name: acct.name }).eq("device_id", did);
          await log("device_bound", acct.name, did, ip);
        }
        await log("login_ok", name, did, ip);
        return json(req, { success: true, ...(await issueSession(acct, did)) });
      }

      /* ---- 5. Your Devices screen ------------------------------------------- */
      case "devices-list": {
        const mgr = await callerManager();
        if (!mgr) return json(req, { success: false, message: "Managers only." }, 403);
        const { data } = await db.from("hk_devices")
          .select("device_id,label,kind,owner_name,status,requested_name,user_agent,platform,approved_by,approved_at,last_seen,created_at")
          .order("created_at", { ascending: false }).limit(200);
        return json(req, { success: true, devices: data || [] });
      }

      /* ---- 6. Approve / revoke a device --------------------------------------
         Where you choose personal or shared. Shared is the communal iPads: full
         staff picker and a shorter idle logout. Revoked is kept rather than
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
          if (patch.kind === "shared") patch.owner_name = null;

          /* CREATE THE ACCOUNT AT THE MOMENT OF APPROVAL, WITH THE ROLE.
             Accounts used to be seeded ahead of time from the old roster, which meant
             a name existed before anyone had asked for it and the role came from
             whatever that list happened to say. Now the person types their name when
             they ask, and the manager approving decides — in the same tap — whether
             they get an account and what they are. One decision, one place, and no
             pre-made accounts sitting unclaimed.
             upsert on name, so approving a second device for someone who already has
             an account updates their role rather than duplicating them, and never
             touches a PIN they have already set. */
          const nm = String(body?.account_name || "").trim().slice(0, 60);
          if (nm) {
            await db.from("hk_accounts").upsert({
              name: nm,
              app_role: String(body?.account_role || "Mechanic").slice(0, 40),
              site: String(body?.account_site || "sydney").slice(0, 40),
              status: "active", updated_at: new Date().toISOString(),
            }, { onConflict: "name" });
            if (patch.kind === "personal") patch.owner_name = nm;
            await log("account_created", mgr.name, target, ip, { target: nm, role: body?.account_role });
          }
        }
        await db.from("hk_devices").update(patch).eq("device_id", target);
        if (decision === "revoked") await db.from("hk_sessions").update({ revoked: true }).eq("device_id", target);
        await log(decision === "approved" ? "device_approved" : "device_revoked", mgr.name, target, ip, { kind: patch.kind });
        return json(req, { success: true });
      }

      /* ---- 7. Create an account, disable one, reset a forgotten PIN -----------
         A reset CLEARS the PIN, it does not set one. The person chooses the new
         one themselves on their own device. That is the difference between being
         unable to see a colleague's PIN and merely promising not to look. */
      case "account-upsert": {
        const mgr = await callerManager();
        if (!mgr) return json(req, { success: false, message: "Managers only." }, 403);
        const name = String(body?.name || "").trim().slice(0, 60);
        if (!name) return json(req, { success: false, message: "Name required" });
        const disabling = body?.status === "disabled";
        await db.from("hk_accounts").upsert({
          name,
          app_role: String(body?.app_role || "Mechanic"),
          site: String(body?.site || "sydney"),
          status: disabling ? "disabled" : "active",
          updated_at: new Date().toISOString(),
        }, { onConflict: "name" });

        if (disabling) {
          const { data: a } = await db.from("hk_accounts").select("id,auth_user_id").eq("name", name).maybeSingle();
          if (a) {
            await db.from("hk_sessions").update({ revoked: true }).eq("account_id", a.id);
            /* Ban the underlying login as well. Without this the person keeps
               working until their token expires AND can renew it indefinitely —
               "removed" would mean "removed once they close the app". */
            if (a.auth_user_id) {
              try { await db.auth.admin.updateUserById(a.auth_user_id, { ban_duration: "876000h", password: randHex(24) }); } catch { /* best effort */ }
            }
          }
        }
        await log("account_upsert", mgr.name, null, ip, { target: name, status: disabling ? "disabled" : "active" });
        return json(req, { success: true });
      }
      case "reset-pin": {
        const mgr = await callerManager();
        if (!mgr) return json(req, { success: false, message: "Managers only." }, 403);
        const name = String(body?.target_name || "");
        const { data: a } = await db.from("hk_accounts").select("id,auth_user_id").eq("name", name).maybeSingle();
        if (!a) return json(req, { success: false, message: "No such account" });
        await db.from("hk_accounts").update({
          pin_hash: null, pin_salt: null, must_set_pin: true,
          failed_count: 0, locked_until: null, reset_requested_at: null,
          updated_at: new Date().toISOString(),
        }).eq("id", a.id);
        await db.from("hk_sessions").update({ revoked: true }).eq("account_id", a.id);
        await log("pin_reset", mgr.name, null, ip, { target: name });
        return json(req, { success: true });
      }

      /* ---- 7b. "I've forgotten my PIN" ---------------------------------------
         Raised from the sign-in screen, so the person does not have to find a
         manager first and a manager does not have to be told twice. It only marks
         the account; nothing is cleared until a manager actually taps Reset, and
         even then the new PIN is chosen by the person, not issued to them.
         Requires an approved device, so this cannot be used to harass an account
         from outside. Answers the same either way, so it cannot be used to find
         out who works here. */
      case "request-reset": {
        const dev = await approvedDevice();
        if (!dev) return json(req, { success: true });          // deliberately silent
        const name = String(body?.name || "");
        const { data: acct } = await db.from("hk_accounts").select("id,name,status").eq("name", name).maybeSingle();
        if (acct && acct.status === "active"){
          await db.from("hk_accounts").update({ reset_requested_at: new Date().toISOString() }).eq("id", acct.id);
          await log("reset_requested", name, did, ip);
          pushAdmins("PIN reset needed", name + " has forgotten their PIN. Master Access -> Devices to clear it.", "hk-reset");
        }
        return json(req, { success: true });
      }

      /* ---- 7b-ii. "I'm not on this list" -------------------------------------
         The only way to ask for an account used to be to enrol a brand new
         device, because that is the screen where you type your name. On a
         workshop iPad or Mac that is already approved, nobody ever sees that
         screen — so a new starter at a shared machine had no route in at all,
         and wiping the accounts to start fresh would have stranded the whole
         floor behind Harvey. This is that route.

         The row is created as 'pending', and `roster` only ever returns
         'active', so asking does not put your name in front of anyone until a
         manager has approved it and chosen your role. Requires an approved
         device, so it cannot be reached from the open internet. */
      case "request-account": {
        const dev = await approvedDevice();
        if (!dev) return json(req, { success: false, message: "This device isn't approved." });
        const name = String(body?.name || "").trim().slice(0, 60);
        if (name.length < 2) return json(req, { success: false, message: "Type your full name." });

        const { data: existing } = await db.from("hk_accounts").select("id,status").eq("name", name).maybeSingle();
        if (existing?.status === "active") {
          /* Already has one. Say the same thing either way — a stranger must not
             be able to use this to find out who works here. */
          await log("account_request_dupe", name, did, ip);
          return json(req, { success: true });
        }
        if (existing) {
          await db.from("hk_accounts").update({ status: "pending", updated_at: new Date().toISOString() }).eq("id", existing.id);
        } else {
          await db.from("hk_accounts").insert({
            name, app_role: "Mechanic", site: String(body?.site || "sydney").slice(0, 40),
            status: "pending", must_set_pin: true,
          });
        }
        await log("account_requested", name, did, ip);
        pushAdmins("Someone wants an account",
          name + " has asked for access on a workshop device. Master Access -> Devices to approve and set their role.",
          "hk-account");
        return json(req, { success: true });
      }

      /* ---- 7b-iii. Approve or decline that request ---------------------------
         Approving is where the role is chosen, exactly as it is when approving a
         device — one decision, one place. Declining removes the row outright: an
         account nobody agreed to should leave no trace behind, and the person can
         always ask again. */
      case "account-decide": {
        const mgr = await callerManager();
        if (!mgr) return json(req, { success: false, message: "Managers only." }, 403);
        const name = String(body?.target_name || "").trim().slice(0, 60);
        const decision = String(body?.decision || "");
        if (!name) return json(req, { success: false, message: "Name required" });
        if (!["approved", "declined"].includes(decision)) return json(req, { success: false, message: "Unknown decision" });

        if (decision === "declined") {
          await db.from("hk_accounts").delete().eq("name", name).eq("status", "pending");
          await log("account_declined", mgr.name, null, ip, { target: name });
          return json(req, { success: true });
        }
        await db.from("hk_accounts").update({
          status: "active",
          app_role: String(body?.app_role || "Mechanic").slice(0, 40),
          site: String(body?.site || "sydney").slice(0, 40),
          updated_at: new Date().toISOString(),
        }).eq("name", name).eq("status", "pending");
        await log("account_approved", mgr.name, null, ip, { target: name, role: body?.app_role });
        return json(req, { success: true });
      }

      /* ---- 7c. The people list, for the manager's Staff panel ----------------
         Never returns a PIN or a hash — there is nothing here that could be turned
         back into someone's PIN, which is the point. */
      case "accounts-list": {
        const mgr = await callerManager();
        if (!mgr) return json(req, { success: false, message: "Managers only." }, 403);
        const { data } = await db.from("hk_accounts")
          .select("name,app_role,site,status,must_set_pin,pin_set_at,is_master,reset_requested_at,locked_until")
          .order("name");
        return json(req, { success: true, accounts: data || [] });
      }

      /* ---- 7d. How many things need a manager's attention --------------------
         Cheap enough to poll, so the Devices tab can carry a badge and a manager
         with the app open finds out without being told. */
      case "pending-count": {
        const mgr = await callerManager();
        if (!mgr) return json(req, { success: false }, 403);
        const { count: devs } = await db.from("hk_devices").select("*", { count: "exact", head: true }).eq("status", "pending");
        const { count: pins } = await db.from("hk_accounts").select("*", { count: "exact", head: true }).not("reset_requested_at", "is", null);
        const { count: accs } = await db.from("hk_accounts").select("*", { count: "exact", head: true }).eq("status", "pending");
        return json(req, { success: true, devices: devs || 0, resets: pins || 0, accounts: accs || 0 });
      }

      /* ---- 8. The join code --------------------------------------------------- */
      case "set-join-code": {
        const mgr = await callerManager();
        if (!mgr) return json(req, { success: false, message: "Managers only." }, 403);
        const code = String(body?.code || "").trim();
        if (!/^\d{4,8}$/.test(code)) return json(req, { success: false, message: "4 to 8 digits" });
        await db.from("hk_auth_config").update({ join_code: code, join_code_set_at: new Date().toISOString() }).eq("id", 1);
        await log("join_code_set", mgr.name, null, ip);
        return json(req, { success: true });
      }

      /* ---- 9. Break glass -----------------------------------------------------
         For exactly one situation: every device has forgotten, or your phone is
         gone, and there is nobody left who can approve you. Approves the device it
         is typed on, logs you in as master, and burns itself so it can never be
         reused. This exists so no step of this rollout can leave you locked out of
         your own system with no way back. */
      case "recovery": {
        const { data: cfg } = await db.from("hk_auth_config").select("recovery_hash").eq("id", 1).maybeSingle();
        if (!cfg?.recovery_hash) return json(req, { success: false, message: "No recovery code set." });
        const code = String(body?.code || "");
        if (!sameSecret(await sha256(code), cfg.recovery_hash)) {
          await log("recovery_fail", null, did, ip);
          return json(req, { success: false, message: "Not recognised." });
        }
        const { data: master } = await db.from("hk_accounts").select("*")
          .eq("is_master", true).eq("status", "active").limit(1).maybeSingle();
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

        if (master.must_set_pin) {
          // No PIN yet, so there is no session to give — send them to set one.
          return json(req, { success: true, device_id, device_key, must_set_pin: true, name: master.name,
                             message: "Recovery accepted. Set your PIN, then set a new recovery code." });
        }
        return json(req, { success: true, device_id, device_key, ...(await issueSession(master, device_id)),
                           message: "Recovery used. Set a new recovery code from Master Access." });
      }
      /* ---- 9b. Which roles count as an admin -------------------------------
         Builder only. Lets new roles be given admin rights without redeploying
         this function — which matters because roles here are clearly not fixed.
         Harvey cannot lock himself out with it: is_master is checked before the
         role list, so even removing every role leaves him in. */
      case "set-manager-roles": {
        const mgr = await callerManager();
        if (!mgr?.is_master) return json(req, { success: false, message: "Builder only." }, 403);
        const roles = Array.isArray(body?.roles)
          ? body.roles.map((r: unknown) => String(r).trim()).filter(Boolean).slice(0, 20) : [];
        if (!roles.length) return json(req, { success: false, message: "Need at least one role." });
        await db.from("hk_auth_config").update({ manager_roles: roles, updated_at: new Date().toISOString() }).eq("id", 1);
        await log("manager_roles_set", mgr.name, null, ip, { roles });
        return json(req, { success: true, roles });
      }
      case "set-recovery": {
        const mgr = await callerManager();
        if (!mgr?.is_master) return json(req, { success: false, message: "Master only." }, 403);
        const code = randHex(16);   // generated here, so a weak one can never be chosen
        await db.from("hk_auth_config").update({ recovery_hash: await sha256(code), recovery_set_at: new Date().toISOString() }).eq("id", 1);
        await log("recovery_set", mgr.name, null, ip);
        // Shown once. Only its hash is kept, so it can never be retrieved again.
        return json(req, { success: true, code });
      }

      /* ---- 10. Bootstrap check — is anything set up yet? ---------------------
         Read-only and harmless: the first-run screen uses it to decide whether to
         show "set the join code" or the normal login. */
      case "status": {
        const { data: cfg } = await db.from("hk_auth_config").select("join_code,recovery_hash,legacy_login_off").eq("id", 1).maybeSingle();
        const { count: approved } = await db.from("hk_devices").select("*", { count: "exact", head: true }).eq("status", "approved");
        const { count: total } = await db.from("hk_accounts").select("*", { count: "exact", head: true }).eq("status", "active");
        const { count: ready } = await db.from("hk_accounts").select("*", { count: "exact", head: true })
          .eq("status", "active").eq("must_set_pin", false);
        return json(req, { success: true,
          join_code_set: !!cfg?.join_code, recovery_set: !!cfg?.recovery_hash,
          approved_devices: approved || 0,
          /* Read without a session, because the sign-in screen has to know this
             BEFORE anyone has signed in. It is the only thing here that is public,
             and it reveals nothing: a boolean saying which sign-in screen to draw. */
          legacy_login_off: !!cfg?.legacy_login_off,
          accounts_total: total || 0, accounts_ready: ready || 0 });
      }

      /* ---- 11. Close the old sign-in ----------------------------------------
         THE OLD PAD IS THE HOLE, AND THIS IS WHAT SHUTS IT.
         Everything else here is worth nothing while the previous screen still
         accepts the eight PINs that were published — someone holding one simply
         uses that instead. It stays open through the changeover only so nobody is
         stranded, and this is the switch that ends that, under the builder's hand
         rather than on a date I picked.
         Refuses while anyone still has no PIN, because flipping it early is exactly
         how the floor gets locked out on a Saturday. Turning it back ON is always
         allowed — the way out is never blocked. */
      case "set-legacy-login": {
        const mgr = await callerManager();
        if (!mgr?.is_master) return json(req, { success: false, message: "Builder only." }, 403);
        const off = !!body?.off;
        /* THE GUARD WARNS, IT DOES NOT DECIDE.
           It refused outright while anyone still had no PIN, which was right for a
           venue mid-shift and wrong here: nobody is actually locked out by closing
           this. A device with nothing enrolled lands on "Set up this device", and
           that path never asks for an old PIN — so closing early is a redirect, not
           a wall. It costs someone a join code and an approval before they can work,
           which is a delay the owner is entitled to accept.
           So it still lists who is affected, and still stops an accidental click, but
           the builder can say "yes, I know" and proceed. Re-opening remains free. */
        if (off && !body?.force) {
          const { data: notReady } = await db.from("hk_accounts")
            .select("name").eq("status", "active").eq("must_set_pin", true);
          if (notReady && notReady.length) {
            return json(req, { success: false, blocked: true,
              waiting: notReady.map((a: any) => a.name),
              message: notReady.length + " have not set a PIN yet. They can still set one up — it just means doing that before they can work." });
          }
        }
        await db.from("hk_auth_config").update({ legacy_login_off: off, updated_at: new Date().toISOString() }).eq("id", 1);
        await log(off ? "legacy_login_closed" : "legacy_login_opened", mgr.name, null, ip);
        return json(req, { success: true, legacy_login_off: off });
      }

      default:
        return json(req, { success: false, message: "Unknown op" }, 400);
    }
  } catch (e) {
    console.error("[hk-auth]", e);
    /* Vague to the caller, detailed in the logs. An error naming a table or a
       column is free reconnaissance for anyone probing the endpoint. */
    return json(req, { success: false, message: "Something went wrong." }, 500);
  }
});
