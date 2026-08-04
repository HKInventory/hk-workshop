// master-access — the OWNER-controlled gate for who has Master Access in the app.
//
// Authority is the OWNER_KEY secret (set in Supabase → Edge Functions → Secrets, never in the app or
// the staff table), NOT a username. So renaming, deleting, or duplicating accounts can't grant or
// remove control — only whoever holds OWNER_KEY can, and OWNER_KEY lives only in the project secrets
// that you alone control. Every change is confirmed by a 6-digit code emailed to OWNER_EMAIL (Resend),
// so even a leaked OWNER_KEY can't change access without also having your inbox. The owner (OWNER_NAME)
// is always kept in the list and can never be removed, so you never lose the tab.
//
// Secrets required:
//   OWNER_KEY          — your private root password (anything long/random; only you know it)
//   OWNER_NAME         — your exact app account name, e.g. "Harvey Betts" (always retained in the list)
//   OWNER_EMAIL        — where codes are sent, e.g. harvbetts@gmail.com
//   RESEND_API_KEY     — your Resend API key
//   OWNER_FROM         — a verified Resend sender, e.g. "HK Workshop <noreply@yourdomain>"
//                        (until you verify a domain, "onboarding@resend.dev" works to YOUR own email)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — provided automatically by Supabase
//
// Deploy with "Verify JWT" OFF (same as the other master- functions).

/* npm:, NOT esm.sh, AND PINNED.
   "https://esm.sh/@supabase/supabase-js@2" is resolved fresh by esm.sh at deploy time, so the library
   this runs on changes without anybody editing the file — and on 2026-08-03 a deploy of hk-auth failed
   outright with "Module not found .../@supabase/auth-js@2.112.0/denonext/auth-js.mjs" because esm.sh
   could not serve a sub-dependency of whatever @2 meant that day. Nothing had changed; the CDN had.
   Deno resolves npm: specifiers from the registry directly. Pinned so the same source deploys to the
   same thing tomorrow as it did today. */
import { createClient } from "npm:@supabase/supabase-js@2.111.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown) =>
  new Response(JSON.stringify(o), { headers: { ...cors, "Content-Type": "application/json" } });

async function sha256(s: string): Promise<string> {
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function code6(): string {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return String(a[0] % 1000000).padStart(6, "0");
}
// constant-time-ish string compare
function eq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const op = String(body.op || "");
    const ownerKey = String(body.ownerKey || "");

    const OWNER_KEY = Deno.env.get("OWNER_KEY") || "";
    const OWNER_NAME = (Deno.env.get("OWNER_NAME") || "Harvey Betts").trim();
    const OWNER_EMAIL = Deno.env.get("OWNER_EMAIL") || "";
    if (!OWNER_KEY) return json({ success: false, message: "Server not configured: OWNER_KEY missing" });
    /* EVERY operation requires the owner key. No key, no access — regardless of who is calling.
       Note for whoever hits "Not authorised" and cannot see why: eq() compares LENGTH first, and
       Deno.env.get returns the secret verbatim while the app trims what you type. A trailing space
       or newline on OWNER_KEY in the dashboard makes the two lengths differ forever, however
       carefully the key is typed. The app shows a character count next to the box for exactly this. */
    if (!eq(ownerKey, OWNER_KEY)) return json({ success: false, message: "Not authorised" });

    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // current list (owner key already verified above)
    if (op === "list") {
      const { data } = await sb.from("app_access").select("master_admins").eq("id", 1).maybeSingle();
      const admins = ((data?.master_admins as string[]) || []).slice();
      if (!admins.includes(OWNER_NAME)) admins.unshift(OWNER_NAME);
      return json({ success: true, admins, owner: OWNER_NAME });
    }

    // propose a new list -> store it + email a one-time code to confirm
    if (op === "request") {
      let admins = Array.isArray(body.admins)
        ? body.admins.map((x: unknown) => String(x).trim()).filter(Boolean)
        : null;
      if (!admins) return json({ success: false, message: "Missing admins list" });
      // the owner can never be removed
      if (!admins.includes(OWNER_NAME)) admins.unshift(OWNER_NAME);
      // de-dupe, keep order
      admins = [...new Set(admins)];

      /* ONLY GRANT TO ACCOUNTS THAT ACTUALLY EXIST — IN EITHER SYSTEM.
         This used to check the old `staff` table alone. That was fine when `staff` was the only
         roster, and became a trap the moment sign-ups moved to hk_accounts: clearing the old list so
         everyone re-registers would have made this screen unable to save at all — including unable
         to KEEP someone already on it — because the names it was being asked to approve no longer
         existed anywhere it was looking. The screen that controls Master Access would have been
         bricked by tidying a table it does not own.
         It now accepts a name found in either roster, plus anyone already on the current list, so
         this panel keeps working through the migration and after `staff` is finally dropped. The
         point of the check is to catch typos and ghosts, and it still does. */
      const [staffRes, acctRes, curRes] = await Promise.all([
        sb.from("staff").select("name").eq("active", true),
        sb.from("hk_accounts").select("name").eq("status", "active"),
        sb.from("app_access").select("master_admins").eq("id", 1).maybeSingle(),
      ]);
      const real = new Set<string>();
      for (const s of (staffRes.data || [])) real.add(String((s as { name: string }).name).trim());
      for (const a of (acctRes.data || [])) real.add(String((a as { name: string }).name).trim());
      for (const n of (((curRes.data?.master_admins as string[]) || []))) real.add(String(n).trim());
      const bad = admins.filter((n: string) => n !== OWNER_NAME && !real.has(n));
      if (bad.length) return json({ success: false, message: "Unknown staff: " + bad.join(", ") });

      const code = code6();
      const hash = await sha256(code + "|" + OWNER_KEY);
      const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      await sb.from("master_otp").upsert(
        { id: 1, code_hash: hash, payload: { admins }, expires_at: expires, created_at: new Date().toISOString() },
        { onConflict: "id" },
      );

      const RESEND = Deno.env.get("RESEND_API_KEY");
      if (!RESEND || !OWNER_EMAIL) {
        return json({ success: false, message: "Email not configured (RESEND_API_KEY / OWNER_EMAIL)" });
      }
      const from = Deno.env.get("OWNER_FROM") || "HK Workshop <onboarding@resend.dev>";
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: "Bearer " + RESEND, "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to: [OWNER_EMAIL],
          subject: "HK Workshop — confirm Master Access change",
          text:
            "A change to who has Master Access is waiting for your confirmation.\n\n" +
            "Confirmation code: " + code + "\n\n" +
            "New list will be:\n  " + admins.join("\n  ") + "\n\n" +
            "Enter this code in the app within 10 minutes to apply it.\n" +
            "If this wasn't you, do NOT enter it — and change your OWNER_KEY in Supabase, because someone has it.",
        }),
      });
      if (!r.ok) {
        const t = await r.text();
        return json({ success: false, message: "Email failed: " + t.slice(0, 160) });
      }
      return json({ success: true, message: "Code emailed to " + OWNER_EMAIL });
    }

    // confirm with the emailed code -> apply the change
    if (op === "confirm") {
      const otp = String(body.otp || "").trim();
      if (!/^\d{6}$/.test(otp)) return json({ success: false, message: "Enter the 6-digit code" });
      const { data: rec } = await sb.from("master_otp").select("code_hash, payload, expires_at").eq("id", 1).maybeSingle();
      if (!rec) return json({ success: false, message: "No pending change — request a code first" });
      if (new Date(rec.expires_at as string).getTime() < Date.now()) {
        await sb.from("master_otp").delete().eq("id", 1);
        return json({ success: false, message: "Code expired — request a new one" });
      }
      const hash = await sha256(otp + "|" + OWNER_KEY);
      if (!eq(hash, String(rec.code_hash))) return json({ success: false, message: "Wrong code" });

      let admins = ((rec.payload as { admins?: string[] })?.admins) || [];
      if (!admins.includes(OWNER_NAME)) admins.unshift(OWNER_NAME);
      admins = [...new Set(admins)];
      await sb.from("app_access").update({ master_admins: admins, updated_at: new Date().toISOString() }).eq("id", 1);
      await sb.from("master_otp").delete().eq("id", 1);
      return json({ success: true, message: "Master access updated", admins });
    }

    return json({ success: false, message: "Unknown op" });
  } catch (e) {
    return json({ success: false, message: String(e) });
  }
});
