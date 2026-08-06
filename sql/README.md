# SQL — what exists, what has been run, what is missing

Everything here is a one-off script for the Supabase SQL editor. There is no
migration tool: a file is run by hand, once, and the database keeps the result.
That is workable, but only if this list is honest about what has actually run —
so keep it up to date, because guessing has already cost real time.

Files used to sit loose in the repository root next to `index.html`. They are
here now. Nothing references them by path, only by name, so the move breaks
nothing.

---

## Run status

Checked against the live database on **6 August 2026**, not from memory.

| File | Status | How that was checked |
|---|---|---|
| `security_stage0.sql` | run | grants match |
| `security_stage1_schema.sql` | run | `hk_accounts` / `hk_devices` / `hk_sessions` exist |
| `security_fresh_start.sql` | run | 5 accounts, all with PINs |
| `staff_fresh_start.sql` | run | `staff` matches the account list |
| `security_orphans.sql` | run | `push_subs` holds only active accounts |
| `security_authenticated_writes.sql` | **Part 1 run** | no TRUNCATE/TRIGGER/REFERENCES left for anon or authenticated |
| `security_audit_findings.sql` | **partly superseded** | Tier 1 search_path pinning and Tier 2 function revokes are now applied; the `staff_pin_backup` drop is still outstanding |
| `security_display_account.sql` | **NOT run** | no device has a `display_secret`, no display auth user exists |
| `rimo_bms_retention.sql` | **superseded** | replaced by `rimo_bms_retention_v2.sql` |
| `rimo_bms_retention_v2.sql` | **steps 1–3 applied, step 4 outstanding** | new function and BRIN index are live; 1.13M rows still waiting to be reclaimed |
| `UNLOCK-HARVEY.sql` | run, one-off | recovery script, keep for reference |

Everything else (`kart_checks.sql`, `presence.sql`, `rf_*.sql`, `rimo_control.sql`,
`session_reset.sql`, `stock_reset.sql`) predates the security work and is long
since applied — the tables they create are all present and in use.

`session_reset.sql` and `stock_reset.sql` **truncate live tables**. They are kept
because they are occasionally the right tool, not because they are safe.

---

## Sixteen files the app tells you to run do not exist here

`index.html` and the edge functions name these in their comments. None of them
are in this repository:

```
chat_admin.sql        chat_groups.sql       chat_images.sql       chats_tasks.sql
hk_ai.sql             intelligence.sql      messages_shared.sql   ramp_push.sql
rf_debug.sql          rf_kart_admin.sql     rf_sync.sql           rimo_detail.sql
rimo_focus.sql        security_ramp.sql     staff_and_group.sql   user_avatars.sql
```

(`app_health_columns.sql` and `hk_app_health_setup.sql` are also referenced and
also absent — those two live in the **hkwsrunner** repository, which is correct.)

The tables they created are all present and working, so the SQL was written, run,
and then never committed. The practical consequence: **this repository cannot
rebuild the database.** If the project were ever lost, roughly a third of the
schema would have to be reverse-engineered from the app code.

Rather than trying to reconstruct sixteen lost files from memory, read the schema
back out of the live database whenever you need the truth. It is one query and it
cannot go stale:

```sql
-- Every table, with its real column list, as CREATE TABLE statements.
with tbl as (
  select c.oid, c.relname from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
)
select 'create table if not exists public.' || quote_ident(t.relname) || E' (\n' ||
       string_agg(format('  %-22s %s%s%s',
           a.attname,
           format_type(a.atttypid, a.atttypmod),
           case when a.attnotnull then ' not null' else '' end,
           case when d.adbin is not null
                then ' default ' || pg_get_expr(d.adbin, d.adrelid) else '' end),
         E',\n' order by a.attnum) || E'\n);'
  from tbl t
  join pg_attribute a on a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
  left join pg_attrdef d on d.adrelid = t.oid and d.adnum = a.attnum
 group by t.relname
 order by t.relname;

-- Indexes, views and function signatures.
select indexdef || ';' from pg_indexes where schemaname = 'public';
select 'create view public.' || c.relname || ' as ' || pg_get_viewdef(c.oid, true)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'v';
select pg_get_functiondef(p.oid) from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public';
```

---

## Before writing another one

Two habits would have prevented most of the trouble so far:

1. **Commit the file before running it**, not after. Every missing file above was
   run first and forgotten second.
2. **Put a read-only check at the bottom** that proves the change landed. Several
   of the security scripts already do this. It is the difference between "I ran
   it" and "it worked" — and this project has been bitten repeatedly by the gap
   between those two, in the database and in the app alike.
