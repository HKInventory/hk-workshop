// notify-user — sends a push notification to ONE person's subscribed phones (all their devices).
// Used for: task assignments ("New task for you"), task comments, and direct chat messages.
// Light auth: the caller must present the PIN of an ACTIVE staff member (the app always has it).
//
// DEPLOY: Edge Functions -> create  notify-user  -> paste -> Deploy, **Verify JWT OFF**.
// Uses the same VAPID secrets as ramp-tick (set once, shared project-wide):
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT
//
// POST { pin, toName, title, body, tag?, url? }
//
// ---------------------------------------------------------------------------------------------
// 7 AUGUST 2026. Pulled into git for the first time (it was one of nine deployed functions with no
// copy in this repository) and three things fixed. It does NOT carry the shape-check fault that
// broke hk-ai — checked line by line, there is no regex on the credential here.
//
// 1. THE IMPORT WAS UNPINNED: `jsr:@supabase/supabase-js@2`. Resolved fresh at deploy time, so
//    this ran a different library each deploy, and on 2026-08-03 an unpinned specifier failed a
//    deploy outright. Now npm: at the same fixed version every other function here uses.
// 2. IT RETURNED THE RAW ERROR to the caller on any throw. An error naming a table or column is
//    free reconnaissance for anyone probing an endpoint that needs no key to reach.
// 3. NON-CONSTANT-TIME COMPARE on the credential — `===` leaks how many leading characters were
//    right. Same fix as hk-auth and master-pin.
//
// STILL TRUE AND WORTH KNOWING: any holder of a valid bridge key can send a push with an
// attacker-chosen title and body to any named person. That is an insider-shaped risk rather than
// an open one, but a notification that looks like it came from management is worth closing when
// this moves onto the session (HANDOVER.md 5.9).
// ---------------------------------------------------------------------------------------------

import { createClient } from "npm:@supabase/supabase-js@2.111.0";
import webpush from "npm:web-push@3";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown) => new Response(JSON.stringify(o), { headers: { ...cors, "Content-Type": "application/json" } });

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
    const { pin, toName, title, body, tag, url } = await req.json();
    const pub = Deno.env.get("VAPID_PUBLIC_KEY") || "";
    const priv = Deno.env.get("VAPID_PRIVATE_KEY") || "";
    if (!pub || !priv) return json({ success: false, message: "VAPID keys not set" });
    webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") || "mailto:workshop@hyperkarting.example", pub, priv);

    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: staff } = await sb.from("staff").select("name, pin, active").eq("active", true);
    const caller = (staff || []).find((s: any) => sameSecret(String(s.pin ?? "").trim(), String(pin || "").trim()));
    if (!caller) return json({ success: false, message: "Not signed in" });

    const to = String(toName || "").trim();
    if (!to || !title) return json({ success: false, message: "Missing toName/title" });

    const { data: subs } = await sb.from("push_subs").select("endpoint, sub").eq("name", to);
    let sent = 0, pruned = 0;
    for (const s of subs || []) {
      try {
        await webpush.sendNotification(s.sub, JSON.stringify({ title: String(title).slice(0, 80), body: String(body || "").slice(0, 180), tag: tag || "hkws-msg", url: url || "./" }), { TTL: 3600 });
        sent++;
      } catch (e: any) {
        const code = e && (e.statusCode || e.status);
        if (code === 404 || code === 410) { await sb.from("push_subs").delete().eq("endpoint", s.endpoint); pruned++; }
      }
    }
    return json({ success: true, sent, pruned });
  } catch (e) {
    // Vague to the caller, detailed in the logs — the same rule hk-auth follows.
    console.error("[notify-user]", e);
    return json({ success: false, message: "Something went wrong." });
  }
});
