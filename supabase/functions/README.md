# Edge functions

The server-side half of the app. These run on Supabase, not in the browser, and
they are the only things that hold the service key.

```
supabase/functions/
  hk-auth/index.ts    the whole login system — request access, approve a device,
                      choose a PIN, sign in, stay signed in, reset, recovery
  hk-ai/index.ts      the assistant
```

These files **are** what is deployed. There is no second copy anywhere — a
duplicate of an auth function is the kind of thing that goes stale quietly and
then gets pasted over the good one.

## Deploying

Either way works. The dashboard is fine for one-off changes; the CLI is better
because what you deploy is exactly what is committed.

**From the repo (preferred)**

```sh
supabase login                       # once
supabase link --project-ref jnxdjzewfrcrexyscxul     # once
supabase functions deploy hk-auth
```

**From the dashboard**

> Supabase → Edge Functions → the function → paste the whole of its `index.ts` → Deploy

## Secrets

Nothing to add for `hk-auth`. `SUPABASE_URL`, `SUPABASE_ANON_KEY` and
`SUPABASE_SERVICE_ROLE_KEY` are injected automatically. It also uses the
`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` already set
project-wide for `notify-user` and `ramp-tick`, so approval notifications work
with no new configuration.

## Imports are pinned on purpose

Both functions import via `npm:` at a fixed version rather than
`https://esm.sh/@supabase/supabase-js@2`.

That unpinned URL is resolved fresh **at deploy time**, which meant two things:
the library silently changed underneath a file nobody had edited, and on
2026-08-03 a deploy failed outright — `Module not found
.../@supabase/auth-js@2.112.0/denonext/auth-js.mjs` — because esm.sh could not
serve one sub-dependency of whatever `@2` meant that day. For `hk-auth` that is
the whole workshop unable to sign in, at a moment nobody chose.

If you bump the version, bump it deliberately and redeploy while someone is
watching — not on a Saturday.
