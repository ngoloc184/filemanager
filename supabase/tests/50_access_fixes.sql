-- Regression tests for 202608280021_access_and_listing_fixes.sql.
-- Run with scripts/test-db.sh (plain PostgreSQL + supabase/tests stubs).
-- Everything runs in one transaction that is rolled back at the end.

\set ON_ERROR_STOP 1
\o /dev/null
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B '''bbbbbbbb-0000-0000-0000-00000000000b'''
\set F '''f0000000-0000-0000-0000-0000000000f1'''
\set X '''f1000000-0000-0000-0000-0000000000a1'''
\set Y '''f1000000-0000-0000-0000-0000000000a2'''
\set V '''f2000000-0000-0000-0000-0000000000b1'''

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

create function pg_temp.error_of(stmt text) returns text
language plpgsql as $$
begin
  execute stmt;
  return null;
exception when others then
  return sqlerrm;
end;
$$;

-- ---------------------------------------------------------------- fixtures
insert into auth.users (id, email) values
  (:A, 'alice@example.com'),
  (:B, 'bob@example.com');

insert into public.folders (id, owner_id, name) values (:F, :A, 'Team');
insert into public.files (id, folder_id, owner_id, name, original_name, updated_at) values
  (:X, :F, :A, 'budget.xlsx', 'budget.xlsx', now() - interval '1 day'),
  (:Y, :F, :A, 'notes.txt', 'notes.txt', now());
insert into public.file_versions (id, file_id, version_no, storage_path, uploaded_by)
values (:V, :X, 1, 'aaaaaaaa-0000-0000-0000-00000000000a/f1000000-0000-0000-0000-0000000000a1/v1/budget.xlsx', :A);
update public.files set current_version_id = :V where id = :X;
-- uploaded objects (register_file requires the object to exist in storage)
insert into storage.buckets (id, name) values ('uploads', 'uploads') on conflict (id) do nothing;
insert into storage.objects (bucket_id, name, metadata) values
  ('uploads', 'aaaaaaaa-0000-0000-0000-00000000000a/f1000000-0000-0000-0000-0000000000a1/v1/budget.xlsx', '{"size": 1}'),
  ('uploads', 'bbbbbbbb-0000-0000-0000-00000000000b/f1000000-0000-0000-0000-0000000000c1/v1/mine.txt', '{"size": 1}'),
  ('uploads', 'bbbbbbbb-0000-0000-0000-00000000000b/f1000000-0000-0000-0000-0000000000c2/v1/Report...final.txt', '{"size": 1}'),
  ('uploads', 'bbbbbbbb-0000-0000-0000-00000000000b/f1000000-0000-0000-0000-0000000000c3/../../aaaaaaaa-0000-0000-0000-00000000000a/x', '{"size": 1}');
-- Bob edits everything in the folder.
insert into public.folder_shares (folder_id, grantee_id, role, granted_by)
values (:F, :B, 'admin', :A);

grant execute on function pg_temp.check(boolean, text) to authenticated;
grant execute on function pg_temp.login(uuid) to authenticated;
grant execute on function pg_temp.error_of(text) to authenticated;

set local role authenticated;

-- ---------------------------------------------------------------- listings
select pg_temp.login(:A);
select pg_temp.check(
  (select count(*) from public.list_recent_files(30)) = 2,
  'recent files lists every recent file, not just one');

select pg_temp.login(:B);
select pg_temp.check(
  (select count(*) from public.list_recent_files(30)) = 2,
  'recent files include files shared through a folder share');
select pg_temp.check(
  (select count(*) from public.search_files(p_scope => 'shared')) = 2,
  'search finds files shared through a folder share');
select pg_temp.check(
  (select count(*) from public.search_files(p_query => 'budget')) = 1,
  'search by name includes shared files');

-- ---------------------------------------------------------------- direct table writes (grantee)
-- these may raise "permission denied" or silently match no row; either way
-- the checks below verify that nothing changed
select pg_temp.error_of(format('update public.files set owner_id = %L where id = %L',
  'bbbbbbbb-0000-0000-0000-00000000000b', 'f1000000-0000-0000-0000-0000000000a1'));
select pg_temp.error_of(format('update public.files set is_public = true where id = %L',
  'f1000000-0000-0000-0000-0000000000a1'));
select pg_temp.check(
  pg_temp.error_of(format('delete from public.files where id = %L', 'f1000000-0000-0000-0000-0000000000a2')) is not null
  or (select count(*) from public.files where id = :Y) = 1,
  'a grantee cannot delete a file row directly');

select pg_temp.login(:A);
select pg_temp.check(
  (select owner_id from public.files where id = :X) = :A,
  'a grantee cannot take ownership of a shared file');
select pg_temp.check(
  (select not is_public from public.files where id = :X),
  'a grantee cannot make a shared file public');
select pg_temp.check(
  (select count(*) from public.files where id = :Y) = 1,
  'the file a grantee tried to delete is still there');

-- the owner can still toggle visibility directly (used by the UI)
update public.files set is_public = true where id = :X;
select pg_temp.check(
  (select is_public from public.files where id = :X),
  'the owner can change visibility');
update public.files set is_public = false where id = :X;

-- ---------------------------------------------------------------- storage paths
select pg_temp.login(:B);
select pg_temp.check(
  pg_temp.error_of(format(
    'select public.register_file(gen_random_uuid(), null, %L, %L, %L, %L, 1, %L)',
    'steal.xlsx', 'steal.xlsx', 'xlsx', 'application/octet-stream',
    'aaaaaaaa-0000-0000-0000-00000000000a/f1000000-0000-0000-0000-0000000000a1/v1/budget.xlsx')) is not null,
  'register_file rejects a storage path outside the caller''s own file');
select pg_temp.check(
  pg_temp.error_of(format(
    'select public.register_file(gen_random_uuid(), null, %L, %L, %L, %L, 1, %L)',
    'steal.xlsx', 'steal.xlsx', 'xlsx', 'application/octet-stream',
    'aaaaaaaa-0000-0000-0000-00000000000a/f1000000-0000-0000-0000-0000000000a1/v1/budget.xlsx')) like '%storage path%',
  'it is the storage path guard that rejects it');

select pg_temp.check(
  pg_temp.error_of(format(
    'select public.add_file_version(%L, %L, 1, %L)',
    'f1000000-0000-0000-0000-0000000000a2',
    'aaaaaaaa-0000-0000-0000-00000000000a/f1000000-0000-0000-0000-0000000000a1/v1/budget.xlsx',
    'application/octet-stream')) is not null,
  'add_file_version rejects another file''s storage path');

select pg_temp.check(
  pg_temp.error_of(format(
    'select public.register_file(%L, null, %L, %L, %L, %L, 1, %L)',
    'f1000000-0000-0000-0000-0000000000c1', 'mine.txt', 'mine.txt', 'txt', 'text/plain',
    'bbbbbbbb-0000-0000-0000-00000000000b/f1000000-0000-0000-0000-0000000000c1/v1/mine.txt')) is null,
  'register_file accepts the caller''s own storage path');

select pg_temp.check(
  pg_temp.error_of(format(
    'select public.register_file(%L, null, %L, %L, %L, %L, 1, %L)',
    'f1000000-0000-0000-0000-0000000000c2', 'Report...final.txt', 'Report...final.txt', 'txt', 'text/plain',
    'bbbbbbbb-0000-0000-0000-00000000000b/f1000000-0000-0000-0000-0000000000c2/v1/Report...final.txt')) is null,
  'file names with consecutive dots are still accepted');

select pg_temp.check(
  pg_temp.error_of(format(
    'select public.register_file(%L, null, %L, %L, %L, %L, 1, %L)',
    'f1000000-0000-0000-0000-0000000000c3', 'x.txt', 'x.txt', 'txt', 'text/plain',
    'bbbbbbbb-0000-0000-0000-00000000000b/f1000000-0000-0000-0000-0000000000c3/../../aaaaaaaa-0000-0000-0000-00000000000a/x')) is not null,
  'path traversal segments are rejected');

-- ---------------------------------------------------------------- restore keeps separate trash
select pg_temp.login(:A);
select public.soft_delete_file(:Y);
-- one transaction means one now(); pretend Y was trashed a minute earlier
reset role;
update public.files set deleted_at = deleted_at - interval '1 minute' where id = :Y;
set local role authenticated;
select pg_temp.login(:A);
select public.soft_delete_folder(:F);
select public.restore_folder(:F);
select pg_temp.check(
  (select deleted_at is null from public.files where id = :X),
  'restoring a folder restores files trashed with it');
select pg_temp.check(
  (select deleted_at is not null from public.files where id = :Y),
  'restoring a folder keeps files that were trashed separately in the trash');

rollback;
