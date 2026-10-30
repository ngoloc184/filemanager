-- Storage hygiene (202608280037_storage_hygiene.sql): deleting old versions,
-- trash auto-purge, orphan candidates, unregistered uploads in the quota
-- (audit orphan.sql) and the stricter upload path policy.
-- Run with scripts/test-db.sh (plain PostgreSQL + supabase/tests stubs).
-- Everything runs in one transaction that is rolled back at the end.

\set ON_ERROR_STOP 1
\o /dev/null
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B '''bbbbbbbb-0000-0000-0000-00000000000b'''
\set C '''cccccccc-0000-0000-0000-00000000000c'''
-- Alice's file with three versions (v3 is current); Bob views it
\set X '''f1000000-0000-0000-0000-0000000000a1'''
\set V1 '''e0000000-0000-0000-0000-0000000000a1'''
\set V2 '''e0000000-0000-0000-0000-0000000000a2'''
\set V3 '''e0000000-0000-0000-0000-0000000000a3'''
\set P1 '''aaaaaaaa-0000-0000-0000-00000000000a/f1000000-0000-0000-0000-0000000000a1/e0000000-0000-0000-0000-0000000000a1/plan.txt'''
\set P2 '''aaaaaaaa-0000-0000-0000-00000000000a/f1000000-0000-0000-0000-0000000000a1/e0000000-0000-0000-0000-0000000000a2/plan.txt'''
\set P3 '''aaaaaaaa-0000-0000-0000-00000000000a/f1000000-0000-0000-0000-0000000000a1/e0000000-0000-0000-0000-0000000000a3/plan.txt'''
-- trash: T40 trashed 40 days ago, T5 5 days ago, TB 40 days ago but its
-- delete is refused; TF sits in folder D40 (trashed 40 days ago, with an
-- empty trashed subfolder D41); TB sits in folder D42 (trashed 40 days ago)
\set T40 '''f1000000-0000-0000-0000-0000000000b1'''
\set T5 '''f1000000-0000-0000-0000-0000000000b2'''
\set TB '''f1000000-0000-0000-0000-0000000000b3'''
\set TF '''f1000000-0000-0000-0000-0000000000b4'''
\set PT40 '''aaaaaaaa-0000-0000-0000-00000000000a/f1000000-0000-0000-0000-0000000000b1/e0000000-0000-0000-0000-0000000000b1/old.txt'''
\set PT5 '''aaaaaaaa-0000-0000-0000-00000000000a/f1000000-0000-0000-0000-0000000000b2/e0000000-0000-0000-0000-0000000000b2/recent.txt'''
\set PTB '''aaaaaaaa-0000-0000-0000-00000000000a/f1000000-0000-0000-0000-0000000000b3/e0000000-0000-0000-0000-0000000000b3/held.txt'''
\set PTF '''aaaaaaaa-0000-0000-0000-00000000000a/f1000000-0000-0000-0000-0000000000b4/e0000000-0000-0000-0000-0000000000b4/inside.txt'''
\set D40 '''d0000000-0000-0000-0000-0000000000d1'''
\set D41 '''d0000000-0000-0000-0000-0000000000d2'''
\set D42 '''d0000000-0000-0000-0000-0000000000d3'''
-- D43: an empty folder trashed 40 days ago whose delete is refused
\set D43 '''d0000000-0000-0000-0000-0000000000d4'''
-- storage objects
\set ORPHAN '''aaaaaaaa-0000-0000-0000-00000000000a/f2000000-0000-0000-0000-000000000001/e2000000-0000-0000-0000-000000000001/junk.bin'''
\set FRESH '''aaaaaaaa-0000-0000-0000-00000000000a/f2000000-0000-0000-0000-000000000002/e2000000-0000-0000-0000-000000000002/uploading.bin'''
\set MOVIE '''bbbbbbbb-0000-0000-0000-00000000000b/f3000000-0000-0000-0000-000000000001/e3000000-0000-0000-0000-000000000001/movie.mkv'''
\set CF1 '''f4000000-0000-0000-0000-000000000001'''
\set CV1 '''e4000000-0000-0000-0000-000000000001'''
\set CP1 '''cccccccc-0000-0000-0000-00000000000c/f4000000-0000-0000-0000-000000000001/e4000000-0000-0000-0000-000000000001/doc.txt'''
\set CF2 '''f4000000-0000-0000-0000-000000000002'''
\set CV2 '''e4000000-0000-0000-0000-000000000002'''
\set CP2 '''cccccccc-0000-0000-0000-00000000000c/f4000000-0000-0000-0000-000000000002/e4000000-0000-0000-0000-000000000002/more.txt'''

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
  (:B, 'bob@example.com'),
  (:C, 'carol@example.com');
insert into public.user_profiles (id, email) values
  (:A, 'alice@example.com'),
  (:B, 'bob@example.com'),
  (:C, 'carol@example.com')
on conflict (id) do nothing;
-- Carol has a tiny quota for the double-count check
update public.user_profiles set storage_quota_bytes = 1500 where id = :C;

insert into public.files (id, owner_id, name, original_name)
values (:X, :A, 'plan.txt', 'plan.txt');
insert into public.file_versions (id, file_id, version_no, storage_path, size, uploaded_by) values
  (:V1, :X, 1, :P1, 100, :A),
  (:V2, :X, 2, :P2, 200, :A),
  (:V3, :X, 3, :P3, 300, :A);
update public.files set current_version_id = :V3 where id = :X;
insert into public.file_shares (file_id, grantee_id, role, granted_by) values (:X, :B, 'viewer', :A);

insert into public.folders (id, owner_id, parent_id, name, deleted_at) values
  (:D40, :A, null, 'Old folder', now() - interval '40 days'),
  (:D42, :A, null, 'Held folder', now() - interval '40 days'),
  (:D43, :A, null, 'Refused folder', now() - interval '40 days');
insert into public.folders (id, owner_id, parent_id, name, deleted_at) values
  (:D41, :A, :D40, 'Old subfolder', now() - interval '40 days');
insert into public.files (id, owner_id, folder_id, name, original_name, deleted_at) values
  (:T40, :A, null, 'old.txt', 'old.txt', now() - interval '40 days'),
  (:T5, :A, null, 'recent.txt', 'recent.txt', now() - interval '5 days'),
  (:TB, :A, :D42, 'held.txt', 'held.txt', now() - interval '40 days'),
  -- trashed with the folder, a little later than the folder itself
  (:TF, :A, :D40, 'inside.txt', 'inside.txt', now() - interval '39 days');
insert into public.file_versions (file_id, version_no, storage_path, size, uploaded_by) values
  (:T40, 1, :PT40, 10, :A),
  (:T5, 1, :PT5, 10, :A),
  (:TB, 1, :PTB, 10, :A),
  (:TF, 1, :PTF, 10, :A);

-- a trigger refuses to delete TB (stands in for a frozen document / legal hold)
create function public.t9937_refuse_delete() returns trigger
language plpgsql as $$
begin
  raise exception 'blocked by test trigger';
end;
$$;
create trigger t9937_refuse_delete
  before delete on public.files
  for each row when (old.id = 'f1000000-0000-0000-0000-0000000000b3')
  execute function public.t9937_refuse_delete();
create trigger t9937_refuse_folder_delete
  before delete on public.folders
  for each row when (old.id = 'd0000000-0000-0000-0000-0000000000d4')
  execute function public.t9937_refuse_delete();

insert into storage.buckets (id, name) values ('uploads', 'uploads') on conflict (id) do nothing;
insert into storage.objects (bucket_id, name, owner, metadata, created_at) values
  ('uploads', :P2, :A, '{"size": 200}', now() - interval '3 days'),
  ('uploads', :P3, :A, '{"size": 300}', now() - interval '3 days'),
  ('uploads', :ORPHAN, :A, '{"size": 77}', now() - interval '2 days'),
  ('uploads', :FRESH, :A, '{"size": 5}', now() - interval '30 minutes'),
  ('uploads', 'superapp/tool.html', null, '{"size": 9}', now() - interval '2 days');

grant execute on function pg_temp.check(boolean, text) to authenticated, anon, service_role;
grant execute on function pg_temp.login(uuid) to authenticated, anon, service_role;
grant execute on function pg_temp.error_of(text) to authenticated, anon, service_role;
grant execute on function pg_temp.row_count(text) to authenticated, anon, service_role;

-- ---------------------------------------------------------------- grants
select pg_temp.check(
  not has_function_privilege('anon', 'public.delete_file_version(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.purge_old_trash(integer, integer)', 'execute')
  and not has_function_privilege('anon', 'public.storage_orphan_candidates(interval, integer)', 'execute')
  and not has_function_privilege('anon', 'public.is_own_unregistered_upload(text)', 'execute'),
  'anon cannot execute any new function');
select pg_temp.check(
  has_function_privilege('authenticated', 'public.delete_file_version(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.purge_old_trash(integer, integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.storage_orphan_candidates(interval, integer)', 'execute')
  and has_function_privilege('service_role', 'public.purge_old_trash(integer, integer)', 'execute')
  and has_function_privilege('service_role', 'public.storage_orphan_candidates(interval, integer)', 'execute'),
  'delete_file_version is for signed-in users; purge and orphan scan are service_role only');
select pg_temp.check(
  not has_function_privilege('authenticated', 'public.get_user_storage_usage_bytes(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.get_user_storage_usage_bytes(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.assert_storage_quota(uuid, bigint)', 'execute'),
  'the redefined quota helpers keep their internal-only grants');

set local role anon;
select pg_temp.check(
  pg_temp.error_of(format('select public.delete_file_version(%L)', 'e0000000-0000-0000-0000-0000000000a1')) is not null
  and pg_temp.error_of('select * from public.purge_old_trash()') is not null
  and pg_temp.error_of('select * from public.storage_orphan_candidates()') is not null,
  'anon calls are refused');
reset role;

-- ---------------------------------------------------------------- delete_file_version
set local role authenticated;

select pg_temp.login(:B);
select pg_temp.check(
  pg_temp.error_of(format('select public.delete_file_version(%L)', 'e0000000-0000-0000-0000-0000000000a2'))
    like '%permission%',
  'a viewer cannot delete a version');

select pg_temp.login(:A);
select pg_temp.check(
  public.delete_file_version(:V1) = :P1,
  'the admin deletes an old version and gets its storage path back');
select pg_temp.check(
  not exists (select 1 from public.file_versions where id = :V1)
  and (select count(*) from public.file_versions where file_id = :X) = 2,
  'the version row is gone, the others stay');
select pg_temp.check(
  exists (select 1 from public.activity_events
          where action = 'file.version_deleted' and resource_id = :X and (metadata ->> 'version_no')::int = 1),
  'the deletion is in the activity log');
select pg_temp.check(
  pg_temp.error_of(format('select public.delete_file_version(%L)', 'e0000000-0000-0000-0000-0000000000a3'))
    = 'The current version cannot be deleted',
  'the current version cannot be deleted');
select pg_temp.check(
  pg_temp.error_of(format('select public.delete_file_version(%L)', 'e0000000-0000-0000-0000-0000000000ff'))
    = 'Version not found',
  'an unknown version is reported');

select set_config('request.jwt.claim.sub', '', true);
select pg_temp.check(
  pg_temp.error_of(format('select public.delete_file_version(%L)', 'e0000000-0000-0000-0000-0000000000a2'))
    = 'Authentication required',
  'a call without a user is refused');
reset role;

-- a frozen document file (only when the documents tables are not installed:
-- a minimal stand-in table, rolled back with the rest)
do $$
begin
  if to_regclass('public.document_files') is null then
    create table public.document_files (file_id uuid not null, frozen boolean not null default false);
    insert into public.document_files (file_id, frozen) values ('f1000000-0000-0000-0000-0000000000a1', true);
    perform set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-00000000000a', true);
    if pg_temp.error_of(format('select public.delete_file_version(%L)', 'e0000000-0000-0000-0000-0000000000a2'))
       is distinct from 'This file is locked because the document was registered or issued' then
      raise exception 'FAILED: a version of a frozen document file cannot be deleted';
    end if;
    raise warning 'ok - a version of a frozen document file cannot be deleted';
    drop table public.document_files;
  else
    -- the real documents tables (202608280036): a document whose file is frozen
    execute $q$insert into public.organizations (id, name, code, created_by)
      values ('0a000000-0000-0000-0000-000000009937', 'Hygiene Co', 'HYG', 'aaaaaaaa-0000-0000-0000-00000000000a')$q$;
    execute $q$insert into public.documents (id, org_id, direction, subject)
      values ('0d000000-0000-0000-0000-000000009937', '0a000000-0000-0000-0000-000000009937', 'incoming', 'Frozen')$q$;
    execute $q$insert into public.document_files (document_id, file_id, kind, frozen)
      values ('0d000000-0000-0000-0000-000000009937', 'f1000000-0000-0000-0000-0000000000a1', 'main', true)$q$;
    perform set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-00000000000a', true);
    if pg_temp.error_of(format('select public.delete_file_version(%L)', 'e0000000-0000-0000-0000-0000000000a2'))
       is distinct from 'This file is locked because the document was registered or issued' then
      raise exception 'FAILED: a version of a frozen document file cannot be deleted';
    end if;
    raise warning 'ok - a version of a frozen document file cannot be deleted (documents installed)';
    execute $q$update public.document_files set frozen = false
      where file_id = 'f1000000-0000-0000-0000-0000000000a1'$q$;
    if pg_temp.error_of(format('select public.delete_file_version(%L)', 'e0000000-0000-0000-0000-0000000000a2'))
       is not null then
      raise exception 'FAILED: an unfrozen document file''s old version can be deleted';
    end if;
    raise warning 'ok - an unfrozen document file''s old version can be deleted';
    execute $q$delete from public.document_files where file_id = 'f1000000-0000-0000-0000-0000000000a1'$q$;
    -- put v2 back for the checks below
    insert into public.file_versions (id, file_id, version_no, storage_path, size, uploaded_by)
    values ('e0000000-0000-0000-0000-0000000000a2', 'f1000000-0000-0000-0000-0000000000a1', 2,
      'aaaaaaaa-0000-0000-0000-00000000000a/f1000000-0000-0000-0000-0000000000a1/e0000000-0000-0000-0000-0000000000a2/plan.txt',
      200, 'aaaaaaaa-0000-0000-0000-00000000000a');
  end if;
end;
$$;

-- ---------------------------------------------------------------- purge_old_trash
set local role authenticated;
select pg_temp.login(:A);
select pg_temp.check(
  pg_temp.error_of('select * from public.purge_old_trash()') like '%permission denied%',
  'authenticated cannot call purge_old_trash');
select pg_temp.check(
  pg_temp.error_of('select * from public.storage_orphan_candidates()') like '%permission denied%',
  'authenticated cannot call storage_orphan_candidates');
reset role;

set local role service_role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
create temporary table purged as select * from public.purge_old_trash(30, 500);

select pg_temp.check(
  (select count(*) from purged) = 2
  and exists (select 1 from purged where file_id = :T40 and storage_path = :PT40)
  and exists (select 1 from purged where file_id = :TF and storage_path = :PTF),
  'files trashed before the cutoff (alone or with their folder) are purged with their paths');
select pg_temp.check(
  not exists (select 1 from public.files where id in (:T40, :TF))
  and not exists (select 1 from public.file_versions where file_id in (:T40, :TF)),
  'their rows and versions are gone');
select pg_temp.check(
  exists (select 1 from public.files where id = :T5)
  and not exists (select 1 from purged where file_id = :T5),
  'a file trashed 5 days ago is kept');
select pg_temp.check(
  exists (select 1 from public.files where id = :TB)
  and not exists (select 1 from purged where file_id = :TB),
  'a file whose delete is refused is skipped, not returned');
select pg_temp.check(
  not exists (select 1 from public.folders where id in (:D40, :D41)),
  'old trashed folders that are now empty are deleted, subfolders first');
select pg_temp.check(
  exists (select 1 from public.folders where id = :D42),
  'an old trashed folder that still holds a file is kept');
select pg_temp.check(
  exists (select 1 from public.folders where id = :D43),
  'an empty old folder whose delete is refused is skipped (the others above still went)');
select pg_temp.check(
  exists (select 1 from public.files where id = :X),
  'active files are never purged');
select pg_temp.check(
  (select count(*) from public.purge_old_trash(30, 500)) = 0,
  'a second run has nothing left to purge');
select pg_temp.check(
  (select count(*) from public.purge_old_trash(1, 500)) = 1,
  'a shorter retention picks up the 5-day-old file');

-- ---------------------------------------------------------------- orphan candidates
select pg_temp.check(
  exists (select 1 from public.storage_orphan_candidates() where name = :ORPHAN),
  'an unregistered object older than 24 h is a candidate');
select pg_temp.check(
  not exists (select 1 from public.storage_orphan_candidates() where name in (:P2, :P3)),
  'registered objects are not candidates');
select pg_temp.check(
  not exists (select 1 from public.storage_orphan_candidates() where name = :FRESH),
  'a 30-minute-old upload is not a candidate yet');
select pg_temp.check(
  not exists (select 1 from public.storage_orphan_candidates('0 seconds', 500) where name = :FRESH),
  'the cutoff never goes below 1 hour');
select pg_temp.check(
  not exists (select 1 from public.storage_orphan_candidates() where name like 'superapp/%'),
  'objects outside the per-user namespaces are never candidates');
reset role;

-- ---------------------------------------------------------------- audit orphan.sql
set local role authenticated;
select pg_temp.login(:B);
select pg_temp.check(
  pg_temp.row_count(format(
    $q$insert into storage.objects (bucket_id, name, owner, metadata) values ('uploads', %L, %L, '{"size": 5000000000}')$q$,
    'bbbbbbbb-0000-0000-0000-00000000000b/f3000000-0000-0000-0000-000000000001/e3000000-0000-0000-0000-000000000001/movie.mkv',
    'bbbbbbbb-0000-0000-0000-00000000000b')) = 1,
  'Bob can upload in the buildStoragePath shape');
select pg_temp.check(
  (select used_bytes from public.get_storage_quota()) >= 5000000000,
  'an unregistered object counts against the uploader''s quota');
select pg_temp.check(
  pg_temp.error_of(format(
    $q$insert into storage.objects (bucket_id, name, owner, metadata) values ('uploads', %L, %L, '{"size": 1}')$q$,
    'bbbbbbbb-0000-0000-0000-00000000000b/junk/1/movie.mkv',
    'bbbbbbbb-0000-0000-0000-00000000000b')) is not null,
  'an object outside the <uid>/<uuid>/<uuid>/<name> shape is refused');
select pg_temp.check(
  pg_temp.error_of(format(
    $q$insert into storage.objects (bucket_id, name, owner, metadata) values ('uploads', %L, %L, '{"size": 1}')$q$,
    'aaaaaaaa-0000-0000-0000-00000000000a/f3000000-0000-0000-0000-000000000002/e3000000-0000-0000-0000-000000000002/x.bin',
    'bbbbbbbb-0000-0000-0000-00000000000b')) is not null,
  'an object in someone else''s namespace is refused');
select pg_temp.check(
  pg_temp.row_count(format('delete from storage.objects where bucket_id = %L and name = %L', 'uploads',
    'aaaaaaaa-0000-0000-0000-00000000000a/f2000000-0000-0000-0000-000000000001/e2000000-0000-0000-0000-000000000001/junk.bin')) = 0,
  'Bob cannot delete Alice''s unregistered object');
select pg_temp.check(
  pg_temp.row_count(format('delete from storage.objects where bucket_id = %L and name = %L', 'uploads',
    'aaaaaaaa-0000-0000-0000-00000000000a/f1000000-0000-0000-0000-0000000000a1/e0000000-0000-0000-0000-0000000000a2/plan.txt')) = 0,
  'a viewer cannot delete a registered object');
select pg_temp.check(
  pg_temp.row_count(format('delete from storage.objects where bucket_id = %L and name = %L', 'uploads',
    'bbbbbbbb-0000-0000-0000-00000000000b/f3000000-0000-0000-0000-000000000001/e3000000-0000-0000-0000-000000000001/movie.mkv')) = 1,
  'Bob deletes his own unregistered object');
select pg_temp.check(
  (select used_bytes from public.get_storage_quota()) = 0,
  'his usage drops back');

-- ---------------------------------------------------------------- no double count at registration
select pg_temp.login(:C);
select pg_temp.check(
  pg_temp.row_count(format(
    $q$insert into storage.objects (bucket_id, name, owner, metadata) values ('uploads', %L, %L, '{"size": 1000}')$q$,
    'cccccccc-0000-0000-0000-00000000000c/f4000000-0000-0000-0000-000000000001/e4000000-0000-0000-0000-000000000001/doc.txt',
    'cccccccc-0000-0000-0000-00000000000c')) = 1,
  'Carol uploads 1000 bytes');
select pg_temp.check(
  (select used_bytes from public.get_storage_quota()) = 1000,
  'the upload counts before it is registered');
select pg_temp.check(
  pg_temp.error_of(format(
    'select public.register_file(%L, null, %L, %L, %L, %L, 1000, %L, null, %L)',
    'f4000000-0000-0000-0000-000000000001', 'doc.txt', 'doc.txt', 'txt', 'text/plain',
    'cccccccc-0000-0000-0000-00000000000c/f4000000-0000-0000-0000-000000000001/e4000000-0000-0000-0000-000000000001/doc.txt',
    'e4000000-0000-0000-0000-000000000001')) is null,
  'registering it fits a 1500-byte quota (the object is not counted twice)');
select pg_temp.check(
  (select used_bytes from public.get_storage_quota()) = 1000,
  'after registration it is counted once');
select pg_temp.check(
  pg_temp.row_count(format(
    $q$insert into storage.objects (bucket_id, name, owner, metadata) values ('uploads', %L, %L, '{"size": 1000}')$q$,
    'cccccccc-0000-0000-0000-00000000000c/f4000000-0000-0000-0000-000000000002/e4000000-0000-0000-0000-000000000002/more.txt',
    'cccccccc-0000-0000-0000-00000000000c')) = 1,
  'Carol uploads another 1000 bytes');
select pg_temp.check(
  pg_temp.error_of(format(
    'select public.register_file(%L, null, %L, %L, %L, %L, 1000, %L, null, %L)',
    'f4000000-0000-0000-0000-000000000002', 'more.txt', 'more.txt', 'txt', 'text/plain',
    'cccccccc-0000-0000-0000-00000000000c/f4000000-0000-0000-0000-000000000002/e4000000-0000-0000-0000-000000000002/more.txt',
    'e4000000-0000-0000-0000-000000000002')) like 'Storage quota exceeded%',
  'a second file that does not fit is still refused');
select pg_temp.check(
  pg_temp.row_count(format('delete from storage.objects where bucket_id = %L and name = %L', 'uploads',
    'cccccccc-0000-0000-0000-00000000000c/f4000000-0000-0000-0000-000000000002/e4000000-0000-0000-0000-000000000002/more.txt')) = 1,
  'the refused upload can be removed by its uploader');
reset role;

drop trigger t9937_refuse_delete on public.files;
drop trigger t9937_refuse_folder_delete on public.folders;
drop function public.t9937_refuse_delete();

rollback;
