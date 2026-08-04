# How a master action is authorised

Both `master-staff` and `master-write` share one `authorise()`. It used to accept
exactly two things:

1. `OWNER_KEY` — the owner's skeleton key, from project secrets.
2. **A cleartext 4-digit PIN, looked up in `staff.pin`.**

The second one is the reason for almost everything that went wrong on 2026-08-03:

- Resetting Harvey's PIN in the new system silently revoked his own Master Access,
  because the old table still held the old PIN and nothing kept the two in step.
- Every staff member's master credential was a 4-digit number sitting in a table
  in the clear — including the eight that were published in the page source.
- Clearing that table so everyone could re-register took Master Access away from
  Ross and Andrew, even though the Owner Access list still named them.

`authorise()` now accepts a **third** credential: the Supabase session the new
sign-in already issues.

```
OWNER_KEY            -> owner, always allowed              (unchanged)
session JWT          -> verified, name read from the token (NEW, preferred)
4-digit staff.pin    -> legacy, still accepted             (removed once staff is dropped)
```

## Why the token is safe to trust

`hk-auth` stamps `hk_name`, `hk_role`, `hk_site` and `hk_master` into the auth
user's `app_metadata` when the account is created, and Supabase signs that into
every access token with the project's current key. So the token is not a claim
the browser makes about itself — it is the auth server stating who this is, and
`sb.auth.getUser(jwt)` verifies the signature before we read a single field.

Two further checks happen after the signature passes, because a valid token is
not the same as a live account:

- the name must still be `active` in `hk_accounts` — so Remove takes effect on
  the next call rather than whenever the token happens to expire;
- the name must be the owner, or on `app_access.master_admins`, or on the legacy
  `config.pin_managers` list — exactly the rule that applied before.

## What this buys

- **No shared secret and nothing readable.** There is no value in any table that
  grants Master Access if you can see it.
- **The Owner Access list becomes the whole truth.** Put someone on it, they get
  master tools the moment they sign in. Take them off, they lose them.
- **A PIN reset can never revoke your own access again.** Nothing about master
  authorisation depends on `staff` any more.

## What has to happen before `staff` can be dropped

Nothing in these two functions. The legacy PIN path is kept only so a device
holding an old session is not cut off mid-shift; delete that branch and the
`staff` lookups go with it.
