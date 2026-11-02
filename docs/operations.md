# Operations

How to deploy and run the company features (security fixes, organization,
notifications, Documents, dossiers): migrations, environment, scheduled jobs,
monitoring, tests, storage, backups, offboarding and security notes. User
guides: [organization.md](organization.md), [documents.md](documents.md),
[chat.md](chat.md).

Items marked [Unverified] were not checked against a live Supabase project or
Vercel account.

## Migrations 030 → 043

Run each file once, **in this order**, in Supabase Dashboard → **SQL Editor**
(paste the whole file, **Run**), after `202608280029_chat_stickers.sql`.
Every file is written to be safe to run again (`create or replace`,
`if not exists`, `drop … if exists`); running 030–044 a second time on top of
themselves was tried on PGlite, not on hosted Supabase. A re-run puts back the
function versions of that file, so if you re-run an older file, re-run every
later file after it too: `can_read_document` from 036 is replaced by 045, and
`send_chat_message` from 032 by 044. Deploy the app after the last one; the
new pages call functions these files create.

| File | What it does | Manual step |
| --- | --- | --- |
| `202608280030_security_hardening.sql` | Drops the legacy storage policies (any user could read or delete any object), makes the legacy upload tables read-only, revokes internal helpers (`log_activity`, `migrate_batches_to_file_system`, quota helpers, `find_user_by_email` …) from clients, revokes every public function from `anon`, limits push endpoints to FCM, Mozilla, Windows and Apple (other subscriptions are deleted, at most 10 per user) | None. [Unverified] Whether the `alter default privileges` step is allowed on hosted Supabase; later migrations revoke explicitly anyway |
| `202608280031_ownership_safety.sql` | Moves can no longer give a new person admin rights (no moving others' items to My Files root); `files.owner_id` / `folders.owner_id` become ON DELETE RESTRICT, audit columns SET NULL | None. From now on an account that owns files cannot be deleted (see [Offboarding runbook](#offboarding-runbook)) |
| `202608280032_chat_file_grants.sql` | Records which chat message shared a file (`file_shares.source`, `chat_file_grants`) and takes the access back on remove, leave, unsend or disband | None |
| `202608280033_folder_listing_roles.sql` | `list_folder_items`: My Files root lists only your own items; each item carries `my_role` | None |
| `202608280034_organizations.sql` | Companies, departments, positions, members and roles, invitations, holidays, directory | None; create the first company on `/org` |
| `202608280035_notifications.sql` | `notifications` table, triggers for shares and comments, `notification_push_log`, `user_preferences.activity_push` | Check Database → Publications → `supabase_realtime` lists `notifications` (the bell updates live) |
| `202608280036_documents_core.sql` | Document lookups, registers, documents and child tables, access rules (`can_read_document`, `has_file_access` document clause), file freeze triggers, numbering helpers, core RPCs, `folders.purpose` | None |
| `202608280037_storage_hygiene.sql` | `delete_file_version`, trash auto-purge (`purge_old_trash`), orphan detection (`storage_orphan_candidates`), quota counts unregistered uploads, tighter upload policy | Set `CRON_SECRET` and the cron entries ([Scheduled jobs](#scheduled-jobs-vercel-cron)) |
| `202608280038_offboarding.sql` | `offboarding_preview`, `offboard_member`, internal `transfer_user_data` and `revoke_user_sessions` | `SUPABASE_SERVICE_ROLE_KEY` in the app for the sign-in block. [Unverified] Whether the function may delete from `auth.sessions` on hosted Supabase; the app reports it when it cannot |
| `202608280039_document_registers.sql` | Register and lookup admin RPCs, default seed of types and registers for new companies (and every existing one), number previews, register print data | None |
| `202608280040_documents_incoming.sql` | Incoming workflow: register, present, assign, sub-assign, report, complete, return, cancel, reopen | None |
| `202608280041_documents_outgoing.sql` | Outgoing/internal workflow: approval chain, approve/return/reject, sign, issue with numbering, recall, withdraw, follow-ups | None |
| `202608280042_document_search_reports.sql` | Inbox views, `search_documents`, `document_dashboard`, reports, `run_document_reminders` | The reminder cron entry |
| `202608280043_dossiers_retention.sql` | Retention codes (seeded for every company), dossiers, close / reopen / transfer, legal hold triggers | None |

`202608280044_custom_stickers.sql` (chat stickers managed by site admins)
follows 043; its header explains how to appoint a site admin.
`202608280045_documents_access_fixes.sql` follows 044: a recalled document
can no longer be read by the people or departments it was sent to (also
when they had already marked their info copy as read), and a main file
or attachment added to a registered incoming document locks at once. No
manual step.

`202608280046_qa_fixes.sql` follows 045: **Done** also lists documents you
completed and work you assigned once it is done; the incoming report counts
each document once; an author who is also a recipient gets one notification
on issue; accepting an invitation marks its notification read; a document
you cannot open answers 404 instead of 500; and the history shows the result
note of a completed document. Safe to run again.

## Environment variables

Set them in `.env.local` and in Vercel → Settings → Environment Variables,
then redeploy. Never commit real values.

| Variable | Used by | When missing |
| --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | `/api/cron/*`, `/api/push/*`, the sign-in block of `/api/org/offboard`, public share pages | cron routes answer 503; push is skipped; offboarding hands work over but cannot block sign-in (it says so) |
| `CRON_SECRET` | `/api/cron/cleanup`, `/api/cron/document-reminders` | both routes answer 401 (closed by default). Generate with `openssl rand -hex 32` |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push for chat, the bell and reminders | no device push; in-app notifications still work. Generate with `npm run push:keys` ([chat.md](chat.md#setup)) |

## Scheduled jobs (Vercel Cron)

`vercel.json` in the repository:

| Path | Schedule (UTC) | Vietnam time | Does |
| --- | --- | --- | --- |
| `/api/cron/cleanup` | `0 19 * * *` | 02:00 daily | hard-deletes files trashed more than 30 days ago (500 per run) and their objects, then removes uploads never registered for 24 h (500 per run) |
| `/api/cron/document-reminders` | `0 1 * * *` | 08:00 daily | due-tomorrow / due-today / overdue reminders, then device push |

[Unverified] Vercel evaluates cron schedules in UTC; the times above are
Vietnam time (UTC+7).

Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when `CRON_SECRET` is
set in the project. Another scheduler can send the same header or
`x-cron-secret: <secret>`; both GET and POST work. Test by hand:

```bash
curl -i -H "Authorization: Bearer $CRON_SECRET" https://<your-domain>/api/cron/cleanup
# {"purgedFiles":0,"removedObjects":0,"orphansRemoved":0}

curl -i -H "Authorization: Bearer $CRON_SECRET" https://<your-domain>/api/cron/document-reminders
# {"notifications":3,"sent":2}
```

Without the header the answer is 401. Running a job twice is harmless:
reminders are logged per assignment, kind and day. Each run logs one JSON
line (`cron.cleanup`, `cron.document_reminders`) with the counts.

[Unverified] Plan limits: on the Vercel Hobby plan cron jobs may run only once
a day and at an imprecise minute within the hour; both entries are daily so
they should fit, but check the current limits of your plan. `maxDuration` is
60 s per run.

## Health check

`GET /api/health` (no session needed) answers
`{"ok":true,"time":"…","db":"ok"}` with 200, or `"db":"error"` with 503 when
the database cannot be reached within 5 s. It reveals no configuration. Point
an uptime monitor at it (e.g. every 5 minutes, alert after 2 failures).

## Tests

* **Unit tests**: `npm test` (node:test over `src/**/*.test.ts`).
* **Database tests**: `scripts/test-db.sh` (also `npm run test:db`) applies
  `supabase/schema.sql` and every migration to a throwaway database and runs
  `supabase/tests/[1-9]*.sql`. It needs `psql` and a PostgreSQL 15+ server
  with `pg_trgm`, `unaccent` and `pgcrypto`:

  ```bash
  PGHOST=localhost PGPORT=5432 PGUSER=postgres PGPASSWORD=postgres scripts/test-db.sh
  ```

  It **drops and recreates** the database `filemanager_test` (or `TEST_DB`):
  never point it at a production server. `supabase/tests/00_supabase_stubs.sql`
  stands in for Supabase's `auth`, `storage` and roles.
* **PGlite**: the migrations and SQL tests were also run on PGlite (in-process
  PostgreSQL) during development. [Unverified] That runner is not part of the
  repository; use `scripts/test-db.sh` locally and in CI.
* **CI** (`.github/workflows/ci.yml`, on push and pull requests to `main`):
  job *checks* runs lint, `next typegen`, `tsc --noEmit`, `npm test`,
  `npm audit --omit=dev --audit-level=high` and `npm run build`; job *db* runs
  `scripts/test-db.sh` against `postgres:16`.

## Storage

* **File size limit**: the app does not cap upload size itself. Set one on the
  `uploads` bucket, in the Storage settings of the bucket (restrict file size;
  [Unverified] dashboard wording) or in the SQL Editor:

  ```sql
  update storage.buckets set file_size_limit = 524288000 where id = 'uploads'; -- 500 MB
  ```

  [Unverified] The project-wide upload limit of your Supabase plan also
  applies and may be lower; choose the bucket limit within it.
* **Quota**: each user has 10 GiB by default (`user_profiles.storage_quota_bytes`).
  Objects uploaded into a user's namespace but never registered as a file
  count toward that user's quota, and the cleanup job removes them after
  24 h.
* **Trash**: items stay 30 days in the trash, then the cleanup job deletes
  them. Files locked by a document or a legal hold are skipped (a WARNING in
  the database log) and the rest continue.
* Offboarding moves files to the successor without moving objects; the bytes
  then count toward the successor's quota.

## Backups

* Enable **daily backups** or **Point-in-Time Recovery** for the database.
  [Unverified] Where the dashboard shows them, whether PITR is a paid add-on
  and which options your plan includes.
* [Unverified] Supabase database backups do not include the Storage objects
  themselves (only their metadata rows). Copy the `uploads` bucket (and
  `public-images`, `stickers`) every night to separate storage, for example
  with `rclone sync` through Supabase's S3-compatible endpoint into an S3 or
  Backblaze bucket with versioning.
* Proposed targets: **RPO 24 h** (at most one day of data lost) and
  **RTO 4 h** (service back within four hours).
* **Restore drill, every quarter**: restore the latest database backup into a
  new Supabase project, sync the bucket copy into it, point a preview
  deployment at it, sign in, open a document and download its main file, and
  write down the time taken against the RTO.

## Offboarding runbook

1. A company admin opens **Organization → People → ⋯ → Offboard…**, picks the
   successor, reviews the handover list and confirms. Keep **Block sign-in
   for this account** ticked unless the person may keep using the app
   privately; the block applies to the whole account, not one company.
2. If the result page warns that sign-in could not be blocked, ban the user in
   Supabase (Authentication → Users → the user) [Unverified: dashboard
   wording], or check that `SUPABASE_SERVICE_ROLE_KEY` is set. The ban lasts
   about 100 years; it is lifted through the Auth admin API with
   `ban_duration: 'none'`.
3. **Do not delete the account first.** Deleting a user who still owns files
   or folders fails with a foreign-key error (ON DELETE RESTRICT since 031).
   After offboarding they own nothing and deletion is possible, but
   [Inference] deleting also removes their chat messages, personal tags,
   related users and membership history (those foreign keys cascade). A
   banned, offboarded account keeps the history intact; prefer that.
4. To bring a person back, send a new invitation; a left member cannot be
   reactivated by an admin.

## Security notes

* **Legacy storage policies removed (030)**: storage access goes only through
  the file-version policies (`has_file_access`) and the public image
  policies. Uploads must use the `<uid>/<uuid>/<uuid>/<name>` path shape
  (037).
* **Anonymous function grants revoked (030)**: no public function is callable
  by `anon`; internal helpers are `service_role` only. Every later migration
  revokes its new functions from `public` and `anon` explicitly, and the
  definer RPCs check `auth.uid()` first. The signed-out pages use the service
  role on the server only.
* **Activity cannot be forged**: `log_activity` is internal (030).
* **Push endpoint allowlist**: subscriptions and sends are limited to FCM,
  Mozilla autopush, Windows (WNS) and Apple push hosts, both in the database
  (030) and in `src/lib/push/endpoints.ts`, so a stored endpoint cannot make
  the server call another host.
* **`/setup` retired**: the old "Create admin" page set a metadata role that
  nothing read. `/setup` now redirects to `/register`; company admins are the
  `org_admin` role of a company.
* **Sign-in return** (`?next=`): only same-site paths are accepted
  (`safeNext` in `src/lib/auth-links.ts`); the Supabase Redirect URLs must
  allow `/auth/confirm` with a query string ([auth-email.md](auth-email.md)).
* **Cron routes** compare the secret in constant time and stay closed when it
  is not set.
* Sign-up is open; company data needs an active membership, joined only
  through an invitation to the matching e-mail.
