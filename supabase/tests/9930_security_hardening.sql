-- Security hardening (202608280030_security_hardening.sql): legacy storage
-- policies, legacy tables, internal helpers, the anon sweep and push
-- endpoint allowlist.
-- Run with scripts/test-db.sh (plain PostgreSQL + supabase/tests stubs).
-- Everything runs in one transaction that is rolled back at the end.

\set ON_ERROR_STOP 1
\o /dev/null
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B '''bbbbbbbb-0000-0000-0000-00000000000b'''
\set X '''f1000000-0000-0000-0000-0000000000a1'''
\set XPATH '''aaaaaaaa-0000-0000-0000-00000000000a/f1000000-0000-0000-0000-0000000000a1/v1/secret.pdf'''
\set BATCH '''99999999-0000-0000-0000-000000000099'''

begin;

create function pg_temp.check(ok boolean, msg text) returns void
language plpgsql as $$
begin
  if not coalesce(ok, false) then
    raise exception 'FAILED: %', msg;
  end if;
  raise warning 'ok - %', msg;
end;
$$;

create function pg_temp.login(uid uuid) returns void
language sql as $$
  select set_config('request.jwt.claim.sub', uid::text, true),
         set_config('request.jwt.claim.role', 'authenticated', true);
$$;

-- Returns the error message of a statement, or null when it succeeds.
create function pg_temp.error_of(stmt text) returns text
language plpgsql as $$
begin
  execute stmt;
  return null;
exception when others then
  return sqlerrm;
end;
$$;

-- Number of rows a statement touched.
create function pg_temp.row_count(stmt text) returns bigint
language plpgsql as $$
declare
  n bigint;
begin
  execute stmt;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------- fixtures
insert into auth.users (id, email) values
  (:A, 'alice@example.com'),
  (:B, 'bob@example.com');
insert into public.user_profiles (id, email) values
  (:A, 'alice@example.com'),
  (:B, 'bob@example.com')
on conflict (id) do nothing;

insert into storage.buckets (id, name) values ('uploads', 'uploads') on conflict do nothing;
insert into storage.objects (bucket_id, name, owner, metadata)
values ('uploads', :XPATH, :A, '{"size": 10}');

-- A legacy batch Bob created before this migration (history stays readable).
insert into public.upload_batches (id, title, created_by) values (:BATCH, 'old batch', :B);

grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
grant execute on function pg_temp.login(uuid) to authenticated, anon;
grant execute on function pg_temp.error_of(text) to authenticated, anon;
grant execute on function pg_temp.row_count(text) to authenticated, anon;

set local role authenticated;

-- ---------------------------------------------------------------- Alice: private file
select pg_temp.login(:A);
select public.register_file(:X, null, 'secret.pdf', 'secret.pdf', 'pdf', 'application/pdf', 10, :XPATH);

select pg_temp.check(
  (select count(*) from storage.objects where bucket_id = 'uploads') = 1,
  'the owner still reads her object through the file-version policy');

select pg_temp.check(
  pg_temp.error_of(format('update public.files set is_public = true where id = %L', 'f1000000-0000-0000-0000-0000000000a1')) is null
  and pg_temp.error_of(format('update public.files set is_public = false where id = %L', 'f1000000-0000-0000-0000-0000000000a1')) is null,
  'a direct column update still fires the activity trigger (EXECUTE is not checked on triggers)');

-- ---------------------------------------------------------------- Bob: legacy write paths
select pg_temp.login(:B);

select pg_temp.check(
  (select count(*) from public.upload_batches) = 1,
  'legacy batches stay readable (can_view_upload_batch still works in RLS)');

select pg_temp.check(
  pg_temp.error_of(format(
    'insert into public.upload_batches (title, created_by) values (%L, %L)',
    'x', 'bbbbbbbb-0000-0000-0000-00000000000b')) is not null,
  'legacy upload_batches cannot be inserted');

select pg_temp.check(
  pg_temp.error_of(format(
    'insert into public.uploaded_files (batch_id, original_filename, storage_path) values (%L, %L, %L)',
    '99999999-0000-0000-0000-000000000099', 'secret.pdf',
    'aaaaaaaa-0000-0000-0000-00000000000a/f1000000-0000-0000-0000-0000000000a1/v1/secret.pdf')) is not null,
  'legacy uploaded_files cannot be inserted (no pointing a row at another user''s object)');

select pg_temp.check(
  pg_temp.error_of(format('update public.upload_batches set title = %L', 'renamed')) is not null
  and pg_temp.error_of('delete from public.upload_batches') is not null,
  'legacy batches cannot be updated or deleted');

select pg_temp.check(
  (select count(*) from storage.objects where bucket_id = 'uploads') = 0,
  'another user cannot read a private object');

select pg_temp.check(
  pg_temp.row_count($$delete from storage.objects where bucket_id = 'uploads'$$) = 0,
  'another user cannot delete a private object');

-- ---------------------------------------------------------------- Bob: internal helpers
select pg_temp.check(
  pg_temp.error_of(format(
    'select public.log_activity(%L, %L, %L, %L, %L, %L)',
    'file.deleted', 'file', 'f1000000-0000-0000-0000-0000000000a1', 'secret.pdf',
    'aaaaaaaa-0000-0000-0000-00000000000a', '{}')) like 'permission denied%',
  'activity cannot be forged with log_activity');

select pg_temp.check(
  pg_temp.error_of(format('select public.get_user_storage_usage_bytes(%L)', 'aaaaaaaa-0000-0000-0000-00000000000a')) like 'permission denied%'
  and pg_temp.error_of(format('select public.get_user_storage_quota_bytes(%L)', 'aaaaaaaa-0000-0000-0000-00000000000a')) like 'permission denied%'
  and pg_temp.error_of(format('select public.assert_storage_quota(%L, 1)', 'aaaaaaaa-0000-0000-0000-00000000000a')) like 'permission denied%'
  and pg_temp.error_of($$select public.share_resource_check('owner', 'admin')$$) like 'permission denied%',
  'storage and share helpers are internal');

select pg_temp.check(
  pg_temp.error_of($$select * from public.find_user_by_email('alice@example.com')$$) like 'permission denied%',
  'users cannot be looked up by e-mail through find_user_by_email');

select pg_temp.check(
  pg_temp.error_of('select public.migrate_batches_to_file_system()') like 'permission denied%',
  'signed-in users cannot run the batch migration');

select pg_temp.check(
  (select quota_bytes from public.get_storage_quota()) > 0,
  'get_storage_quota still works for a signed-in user');

-- ---------------------------------------------------------------- anon
set local role anon;

select pg_temp.check(
  pg_temp.error_of('select public.migrate_batches_to_file_system()') like 'permission denied%',
  'anon cannot run the batch migration');

select pg_temp.check(
  pg_temp.error_of(format('select public.get_user_storage_usage_bytes(%L)', 'aaaaaaaa-0000-0000-0000-00000000000a')) like 'permission denied%',
  'anon cannot read storage usage');

select pg_temp.check(
  pg_temp.error_of(format('select * from public.list_file_shares(%L)', 'f1000000-0000-0000-0000-0000000000a1')) like 'permission denied%'
  and pg_temp.error_of(format('select public.save_push_subscription(%L, %L, %L)', 'https://fcm.googleapis.com/fcm/send/anon', 'k', 'a')) like 'permission denied%',
  'anon cannot call client RPCs');

-- ---------------------------------------------------------------- push endpoints
set local role authenticated;
select pg_temp.login(:A);
select public.save_push_subscription('https://fcm.googleapis.com/fcm/send/a1', 'key-a', 'auth-a', 'Chrome');

select pg_temp.login(:B);
select pg_temp.check(
  pg_temp.error_of($$select public.save_push_subscription('https://evil.example.com/x', 'k', 'a')$$) like '%Unsupported push service%',
  'unknown push services are rejected');
select pg_temp.check(
  pg_temp.error_of($$select public.save_push_subscription('https://fcm.googleapis.com.evil.com/x', 'k', 'a')$$) is not null
  and pg_temp.error_of($$select public.save_push_subscription('http://fcm.googleapis.com/x', 'k', 'a')$$) is not null,
  'look-alike hosts and plain http are rejected');

select public.save_push_subscription('https://updates.push.services.mozilla.com/wpush/v2/b0', 'k', 'a', 'Firefox');
select public.save_push_subscription('https://wns2-par02p.notify.windows.com/w/?token=b0', 'k', 'a', 'Edge');
select public.save_push_subscription('https://web.push.apple.com/b0', 'k', 'a', 'Safari');
select pg_temp.check(
  (select count(*) from public.push_subscriptions) = 3,
  'Mozilla, Windows and Apple push services are accepted');
reset role;
delete from public.push_subscriptions where user_id = :B;
set local role authenticated;

select public.save_push_subscription('https://fcm.googleapis.com/fcm/send/b' || g, 'k', 'a', 'Chrome')
from generate_series(1, 10) g;

-- b1 is the oldest device; b2 is old but was used recently
reset role;
update public.push_subscriptions set created_at = now() - interval '2 hours'
where endpoint = 'https://fcm.googleapis.com/fcm/send/b1';
update public.push_subscriptions set created_at = now() - interval '3 hours', last_used_at = now()
where endpoint = 'https://fcm.googleapis.com/fcm/send/b2';
update public.push_subscriptions set created_at = now() - interval '1 hour'
where user_id = :B and endpoint not in ('https://fcm.googleapis.com/fcm/send/b1', 'https://fcm.googleapis.com/fcm/send/b2');
set local role authenticated;

select public.save_push_subscription('https://fcm.googleapis.com/fcm/send/b11', 'k', 'a', 'Chrome');
select pg_temp.check(
  (select count(*) from public.push_subscriptions) = 10,
  'saving 11 devices keeps 10');
select pg_temp.check(
  not exists (select 1 from public.push_subscriptions where endpoint like '%/b1')
  and exists (select 1 from public.push_subscriptions where endpoint like '%/b2')
  and exists (select 1 from public.push_subscriptions where endpoint like '%/b11'),
  'the least recently used device is removed, the new one and recently used ones stay');

reset role;
select pg_temp.check(
  (select count(*) from public.push_subscriptions where user_id = :A) = 1,
  'pruning only touches the caller''s devices');
select pg_temp.check(
  pg_temp.error_of(format(
    'insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values (%L, %L, %L, %L)',
    'aaaaaaaa-0000-0000-0000-00000000000a', 'https://push.example.com/x', 'k', 'a')) is not null,
  'the table constraint rejects unknown push services');

-- ---------------------------------------------------------------- grants
-- Anon allow-list (keep in sync with the migration header): empty.
select pg_temp.check(
  not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind in ('f', 'p')
      and has_function_privilege('anon', p.oid, 'execute')
      and not exists (
        select 1 from pg_depend d
        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
      )
      and format('%s(%s)', p.proname, pg_get_function_identity_arguments(p.oid)) <> all (array[]::text[])
  ),
  'no public function is executable by anon outside the allow-list');

select pg_temp.check(
  has_function_privilege('authenticated', 'public.has_file_access(uuid, text)', 'execute')
  and has_function_privilege('authenticated', 'public.has_folder_access(uuid, text)', 'execute')
  and has_function_privilege('authenticated', 'public.can_view_upload_batch(uuid, uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.is_chat_member(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.list_trash()', 'execute')
  and has_function_privilege('authenticated', 'public.register_file(uuid, uuid, text, text, text, text, bigint, text, text, uuid)', 'execute'),
  'RLS helpers and client RPCs keep their authenticated grant');

select pg_temp.check(
  has_function_privilege('service_role', 'public.log_activity(text, text, uuid, text, uuid, jsonb)', 'execute')
  and has_function_privilege('service_role', 'public.get_user_storage_usage_bytes(uuid)', 'execute')
  and has_function_privilege('service_role', 'public.migrate_batches_to_file_system()', 'execute'),
  'server code (service_role) keeps the internal helpers');

select pg_temp.check(
  not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname in ('Users can upload to their own batches', 'Users can read permitted stored files', 'Users can delete their own stored files')
  )
  and (select count(*) from pg_policies
       where schemaname = 'storage' and tablename = 'objects'
         and policyname in ('Users can upload to their own namespace', 'Users can read accessible file versions', 'Users can delete accessible file versions')) = 3,
  'legacy storage policies are gone, the file-version policies remain');

rollback;
