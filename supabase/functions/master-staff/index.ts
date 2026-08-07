// master-staff — list / replace the staff table, their per-site access, and the
// sites list. Authorised by the OWNER_KEY, by a signed-in session from the new
// sign-in, or (legacy) by a master admin's 4-digit staff PIN. The browser cannot
// read/write these tables directly (RLS); this is the only path.
//
// op "access-save" writes the home-tab access config (role defaults + per-account
// overrides) into the app_access table. app_access is anon-readable so the app can
// decide which tiles to show, but only this service-role function can change it.
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

const isMgr = (role: string) => role === "Manager" || role === "Assistant Manager";
const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

function eqKey(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* ============================================================================
   AUTHORISE A MASTER ACTION.  See supabase/functions/_shared/master-auth.md.

   Three credentials, in order of preference:
     1. OWNER_KEY          — the owner's skeleton key.
     2. A SESSION TOKEN    — issued by the new sign-in. Preferred.
     3. A 4-digit staff PIN — legacy, kept so an old session is not cut off
                              mid-shift. Goes when `staff` is dropped.

   Why the token can be trusted: hk-auth stamps hk_name into the auth user's
   app_metadata, Supabase signs that into every access token with the project's
   current key, and sb.auth.getUser(jwt) verifies the signature before a single
   field is read. It is the auth server stating who this is, not the browser.
   A valid token is still not a live account, so the name is re-checked against
   hk_accounts every call — which is what makes Remove bite immediately instead
   of whenever a token happens to expire.
   ========================================================================== */
async function authorise(sb: any, cred: string): Promise<{ ok: boolean; owner: boolean; viaKey: boolean; name: string }> {
  const OWNER_KEY = Deno.env.get("OWNER_KEY") || "";
  const OWNER_NAME = (Deno.env.get("OWNER_NAME") || "Harvey Betts").trim();
  const no = { ok: false, owner: false, viaKey: false, name: "" };

  if (OWNER_KEY && eqKey(String(cred), OWNER_KEY)) return { ok: true, owner: true, viaKey: true, name: OWNER_NAME };
  const c = String(cred || "").trim();
  if (!c) return no;

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
      if (!acct || acct.status !== "active") return no;
      if (!(acct.is_master || permitted(name))) return no;
      return { ok: true, owner: name === OWNER_NAME, viaKey: false, name };
    } catch { return no; }
  }

  // ---- 3. legacy: a 4-digit PIN in the old staff table ----
  const { data: staff } = await sb.from("staff").select("name, pin, active").eq("active", true);
  const caller = (staff || []).find((s: any) => String(s.pin).trim() === c);
  if (!caller) return no;
  return { ok: permitted(caller.name), owner: caller.name === OWNER_NAME, viaKey: false, name: caller.name };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json();
    const { masterPin, op, staff, sites, access } = body;
    const OWNER_NAME = (Deno.env.get("OWNER_NAME") || "Harvey Betts").trim();
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    /* `self-pin` WAS HERE, ABOVE THE AUTHORISE CALL. It is gone.
       It sat in front of the only authentication this function does, so it was an
       unauthenticated write: name + current PIN + new PIN, and it wrote straight
       to staff.pin. Not exploitable in practice — since accounts moved to
       hk_accounts, staff.pin holds a 32-character random value nobody can guess,
       and that same value is what its own check demanded. But that is an accident
       of the migration, not a design, and it is exactly the kind of thing that
       stops being true the next time something changes.
       It could not work anyway: it compared four typed digits against that
       32-character value, so it answered "Current PIN is wrong" to a correct PIN.
       And it wrote the new one to `staff`, which stopped deciding sign-ins when
       hk_accounts took over — so a match would have looked like it worked and
       then not worked.
       Changing your own PIN now goes to hk-auth's `change-pin`, which owns the
       hash, checks it on an approved device, and applies the same lockout and
       burned-PIN rules as the sign-in screen. */
    const auth = await authorise(sb, String(masterPin));
    if (!auth.ok) return json({ success: false, message: "Not authorised for Master Access" });
    const viaKey = auth.viaKey;

    /* THIS WROTE THE OWNER'S NEW PIN TO `staff.pin` AND REPORTED SUCCESS.
       `staff.pin` stopped deciding sign-ins when hk_accounts took over, so Owner
       controls said "saved" and the owner's actual sign-in PIN never changed —
       they carried on signing in with the old one. The same fault as the old
       Change PIN screen, and it survived longer because the owner is the only
       person who ever opens this screen.
       It also checked the new PIN against other rows in `staff` for a clash,
       which is meaningless now: every other row holds a 32-character random
       placeholder, and hk_accounts stores a hash, not a PIN, so there is nothing
       to clash with.
       The Owner-key gate stays exactly where it was — `viaKey` above is still
       what decides. Only the write moved, to hk-auth, which owns the hash and
       uses the very same hashSecret as set-pin and change-pin. One
       implementation, so it cannot drift out of step with sign-in. */
    if (op === "owner-set-pin") {
      if (!viaKey) return json({ success: false, message: "Enter your Owner key first — the owner PIN can only be changed with it." });
      const nw = String(body?.newPin ?? "").trim();
      if (!/^\d{4}$/.test(nw)) return json({ success: false, message: "PIN must be 4 digits" });
      try {
        const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/hk-auth`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: Deno.env.get("SUPABASE_ANON_KEY")!,
            Authorization: `Bearer ${Deno.env.get("SUPABASE_ANON_KEY")!}`,
          },
          body: JSON.stringify({ op: "owner-set-pin", owner_key: Deno.env.get("OWNER_KEY") || "", new_pin: nw }),
        });
        const m = await r.json().catch(() => ({} as any));
        if (!m?.success) return json({ success: false, message: String(m?.message ?? "Could not change the owner PIN.") });
        return json({ success: true, staff_pin_replaced: !!m.staff_pin_replaced });
      } catch {
        return json({ success: false, message: "Could not reach the sign-in service — try again in a moment." });
      }
    }

    if (op === "list") {
      const [st, ac, si] = await Promise.all([
        sb.from("staff").select("name, role, pin, emoji").order("name"),
        sb.from("account_sites").select("staff_name, site"),
        sb.from("sites").select("id, label, accent, position, active").order("position"),
      ]);
      if (st.error) return json({ success: false, message: st.error.message });
      return json({ success: true, staff: st.data || [], access: ac.data || [], sites: si.data || [] });
    }

    if (op === "save") {
      if (!Array.isArray(staff) || !staff.length) return json({ success: false, message: "No staff provided" });

      // --- OWNER PROTECTION ---
      // The owner account can never be removed, renamed away, demoted out of management, deactivated,
      // or have its PIN changed by anyone other than the owner. A non-owner caller's list is forced to
      // keep the owner exactly as it currently is (KEEPING THEIR REAL ROLE, e.g. Assistant Manager);
      // the owner (using OWNER_KEY) may change their own row but stays present and active. This is what
      // makes "my account can't be removed" true.
      {
        const { data: ownerCur } = await sb.from("staff").select("pin, role").eq("name", OWNER_NAME).maybeSingle();
        // keep the owner's actual stored role; only floor it to Manager if it somehow isn't a management role
        const ownerRole = ownerCur && isMgr(String(ownerCur.role ?? "")) ? String(ownerCur.role) : "Manager";
        const sArr = staff as Array<Record<string, unknown>>;
        // collapse any duplicate rows using the owner's name down to the earliest one
        let firstOwner = -1;
        for (let i = 0; i < sArr.length; i++) {
          if (String(sArr[i]?.name ?? "").trim() === OWNER_NAME) { firstOwner = i; break; }
        }
        for (let i = sArr.length - 1; i >= 0; i--) {
          if (String(sArr[i]?.name ?? "").trim() === OWNER_NAME && i !== firstOwner) sArr.splice(i, 1);
        }
        const oi = sArr.findIndex((s) => String(s?.name ?? "").trim() === OWNER_NAME);
        if (!viaKey) {
          // anyone NOT using the Owner Key (incl. someone signed into Harvey's account): force the owner's real record back
          if (ownerCur) {
            const keepSites = (oi >= 0 && Array.isArray(sArr[oi]?.sites)) ? sArr[oi].sites : undefined;
            const locked: Record<string, unknown> = { name: OWNER_NAME, role: ownerRole, pin: String(ownerCur.pin), active: true };
            if (keepSites) locked.sites = keepSites;
            if (oi >= 0) sArr[oi] = locked; else sArr.push(locked);
          } else if (oi >= 0) {
            if (!isMgr(String(sArr[oi].role ?? ""))) sArr[oi].role = "Manager";
            sArr[oi].active = true;
          }
        } else {
          // owner caller (OWNER_KEY): may change their own role/PIN, but stays present & active
          if (oi < 0 && ownerCur) sArr.push({ name: OWNER_NAME, role: ownerRole, pin: String(ownerCur.pin), active: true });
          else if (oi >= 0) { sArr[oi].active = true; }
        }
      }

      // all active site ids — managers always get every site
      const { data: siteRows } = await sb.from("sites").select("id").eq("active", true);
      const allSiteIds = (siteRows || []).map((s) => String(s.id));

      let managers = 0;
      for (const s of staff) {
        const name = String(s?.name ?? "").trim();
        const role = String(s?.role ?? "Mechanic").trim();
        if (!name) return json({ success: false, message: "Every staff member needs a name" });
        /* THE CLIENT NO LONGER SENDS A PIN, AND IF IT DOES IT IS IGNORED. See the block
           that builds `rows` below for why. Everything this used to validate — present,
           four digits, unique — is meaningless once the value cannot come from outside. */
        if (isMgr(role)) managers++;
      }
      if (!managers) return json({ success: false, message: "Keep at least one Manager" });

      /* ------------------------------------------------------------------------------
         THE PIN IS NO LONGER TAKEN FROM THE CLIENT. Changed 7 August 2026.

         This used to write `pin: String(s?.pin ?? "").trim()` — whatever the browser sent,
         straight into staff.pin, in plaintext. Combined with verify-pin (unauthenticated,
         CORS "*", plaintext compare) that made this screen able to arm a brute-force
         oracle: a manager adding someone with a four-digit PIN created a 10,000-guess
         account, reachable by anyone on the internet, that names its owner on success.

         Nobody had done it — all six rows held 32-char random values when this was
         measured — but that was luck, not a control, and this screen was the way to
         spend it.

         Now the server decides:
           - an existing person keeps the value already in staff.pin, untouched
           - a new person gets a fresh 32-char random one
         So a four-digit value cannot enter this table through this path at all, and any
         legacy four-digit row is upgraded to random the next time staff is saved.

         staff.pin is NOT a credential anyone types any more. Real PINs are PBKDF2 hashes
         in hk_accounts, set by each person on their own device. This column is only the
         legacy bridge key that older functions still compare against, which is why it has
         to stay populated and stay unguessable rather than simply being emptied.

         CONSEQUENCE, STATED PLAINLY: somebody added here cannot sign in on the old keypad.
         They sign up through hk-auth and choose their own PIN, which is how the new system
         is meant to work — and is the only way "nobody sees anybody's PIN" can be true. */
      const { data: existingStaff, error: exErr } = await sb.from("staff").select("name, pin");
      if (exErr) return json({ success: false, message: exErr.message });
      const pinByName: Record<string, string> = {};
      for (const r of existingStaff || []) {
        const n = String((r as Record<string, unknown>)?.name ?? "").trim();
        if (n) pinByName[n] = String((r as Record<string, unknown>)?.pin ?? "");
      }
      const randHex = (n: number) =>
        Array.from(crypto.getRandomValues(new Uint8Array(n)))
          .map((b) => b.toString(16).padStart(2, "0")).join("");

      const rows = staff.map((s: Record<string, unknown>) => {
        const role = String(s?.role ?? "Mechanic").trim();
        /* KEEP THE EMOJI THE ROLE ACTUALLY HAS. This forced every row to ⭐ or 🔧,
           so Facilities, Office and Owner all came back wearing a spanner and a
           saved list quietly lost its icons. Whatever the app sends is kept; the
           old two-way guess is only the fallback. */
        const emoji = (typeof s?.emoji === "string" && (s.emoji as string).trim())
          ? (s.emoji as string).trim().slice(0, 12)
          : (isMgr(role) ? "⭐" : "🔧");
        const name = String(s?.name ?? "").trim();
        const kept = pinByName[name] || "";
        return {
          name,
          role,
          // Keep an existing unguessable value; replace anything else (four digits,
          // empty, a new person) with a fresh random one.
          pin: /^[0-9a-f]{32}$/.test(kept) ? kept : randHex(16),
          emoji,
          active: true,
        };
      });

      // build the access rows from each staff member's sites[]; managers => all sites
      const accessRows: Array<{ staff_name: string; site: string }> = [];
      for (const s of staff as Array<Record<string, unknown>>) {
        const name = String(s?.name ?? "").trim();
        const role = String(s?.role ?? "Mechanic").trim();
        let mine = isMgr(role) ? allSiteIds.slice() : (Array.isArray(s?.sites) ? (s!.sites as unknown[]).map(String) : []);
        if (!mine.length) mine = ["sydney"]; // never lock someone out entirely
        const uniq = Array.from(new Set(mine));
        for (const site of uniq) if (allSiteIds.indexOf(site) >= 0) accessRows.push({ staff_name: name, site });
      }

      const del = await sb.from("staff").delete().neq("name", "__none__");
      if (del.error) return json({ success: false, message: del.error.message });
      const ins = await sb.from("staff").insert(rows);
      if (ins.error) return json({ success: false, message: ins.error.message });

      /* A ROLE CHANGED HERE HAS TO REACH THE ACCOUNT, OR IT DID NOTHING.
         This screen wrote roles to `staff` only, while everything a person can
         actually DO is decided from hk_accounts.app_role — what they see on the
         home screen, their emoji, and whether callerManager() lets them near the
         master tools. So promoting Alex to Assistant Manager here changed a row
         nobody consults: he kept a mechanic's tiles, a mechanic's spanner, and no
         Devices tab, and the screen showed the new role back to whoever set it.
         A change that appears to work and does nothing is worse than one that
         fails, because nobody goes looking.
         The role is mirrored onto the account. Names are the join between the two
         tables; a name with no account is simply skipped — plenty of `staff` rows
         are people who have not signed up yet. */
      try {
        const { data: accts } = await sb.from("hk_accounts").select("name,app_role").eq("status", "active");
        const byName = new Map((accts || []).map((a: any) => [String(a.name), String(a.app_role || "")]));
        for (const r of rows) {
          const want = String(r.role || "");
          if (!byName.has(r.name) || byName.get(r.name) === want) continue;
          await sb.from("hk_accounts").update({ app_role: want, updated_at: new Date().toISOString() }).eq("name", r.name);
        }
      } catch { /* the roster save must not fail over the mirror */ }
      // replace account_sites
      await sb.from("account_sites").delete().neq("staff_name", "__none__");
      if (accessRows.length) { const ai = await sb.from("account_sites").insert(accessRows); if (ai.error) return json({ success: false, message: ai.error.message }); }
      return json({ success: true, count: rows.length });
    }

    if (op === "site-delete") {
      const id = String((sites && sites[0] && (sites[0] as Record<string, unknown>).id) || "").trim();
      if (!id) return json({ success: false, message: "Missing site id to delete" });
      if (id === "sydney") return json({ success: false, message: "Sydney is the primary site and can't be deleted" });
      // make sure we never delete the last remaining site
      const { data: remaining } = await sb.from("sites").select("id");
      if ((remaining || []).length <= 1) return json({ success: false, message: "Can't delete the only site" });
      // remove the venue and any staff access rows pointing at it
      await sb.from("account_sites").delete().eq("site", id);
      const dl = await sb.from("sites").delete().eq("id", id);
      if (dl.error) return json({ success: false, message: dl.error.message });
      return json({ success: true, deleted: id });
    }

    if (op === "sites-save") {
      if (!Array.isArray(sites) || !sites.length) return json({ success: false, message: "No sites provided" });
      const rows = sites.map((s: Record<string, unknown>, i: number) => {
        const label = String(s?.label ?? "").trim();
        const id = String(s?.id ?? "").trim() || slug(label);
        return {
          id,
          label,
          accent: String(s?.accent ?? "#00CFFF").trim(),
          position: Number(s?.position ?? (i + 1)),
          active: s?.active === false ? false : true,
        };
      });
      for (const r of rows) {
        if (!r.id) return json({ success: false, message: "Each site needs a name" });
        if (!/^#[0-9a-fA-F]{6}$/.test(r.accent)) return json({ success: false, message: `${r.label}: accent must be a hex colour like #E040FB` });
      }
      const up = await sb.from("sites").upsert(rows, { onConflict: "id" });
      if (up.error) return json({ success: false, message: up.error.message });
      return json({ success: true, count: rows.length });
    }

    // save the home-tab access config (roles + per-account overrides).
    if (op === "access-save") {
      const rolesIn = Array.isArray(access?.roles) ? access.roles : null;
      if (!rolesIn) return json({ success: false, message: "No roles provided" });
      const cleanRoles = (rolesIn as Array<Record<string, unknown>>)
        .filter((r) => r && String(r?.name ?? "").trim())
        .map((r) => ({
          name: String(r.name).trim(),
          emoji: typeof r.emoji === "string" ? r.emoji.trim().slice(0, 12) : "",
          tabs: Array.isArray(r.tabs) ? (r.tabs as unknown[]).map(String) : [],
        }));
      const lower = cleanRoles.map((r) => r.name.toLowerCase());
      if (!lower.includes("manager") || !lower.includes("assistant manager")) {
        return json({ success: false, message: "Keep the Manager and Assistant Manager roles" });
      }
      const ovIn = (access?.overrides && typeof access.overrides === "object") ? access.overrides as Record<string, unknown> : {};
      const overrides: Record<string, string[]> = {};
      for (const k of Object.keys(ovIn)) {
        if (Array.isArray(ovIn[k])) overrides[k] = (ovIn[k] as unknown[]).map(String);
      }
      const up = await sb.from("app_access").upsert(
        { id: 1, roles: cleanRoles, overrides, updated_at: new Date().toISOString() },
        { onConflict: "id" },
      );
      if (up.error) return json({ success: false, message: up.error.message });
      return json({ success: true });
    }

    return json({ success: false, message: "Unknown op" });
  } catch (e) {
    return json({ success: false, message: String((e as Error)?.message ?? e) });
  }
});
