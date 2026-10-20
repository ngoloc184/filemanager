-- Tests for 202608280022_folder_owner_access.sql: folder owners see what
-- collaborators add to their folders, trash/purge stays consistent, share
-- upserts cannot override admins, breadcrumbs stop at inaccessible folders,
-- and file sizes come from storage instead of the client.
-- Run with scripts/test-db.sh (plain PostgreSQL + supabase/tests stubs).
-- Everything runs in one transaction that is rolled back at the end.

\set ON_ERROR_STOP 1
\o /dev/null
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B '''bbbbbbbb-0000-0000-0000-00000000000b'''
\set C '''cccccccc-0000-0000-0000-00000000000c'''
\set D '''dddddddd-0000-0000-0000-00000000000d'''
\set F '''f0000000-0000-0000-0000-0000000000f1'''
\set G '''f0000000-0000-0000-0000-0000000000f2'''
\set X '''f1000000-0000-0000-0000-0000000000b1'''
\set Y '''f1000000-0000-0000-0000-0000000000a1'''
\set XPATH '''bbbbbbbb-0000-0000-0000-00000000000b/f1000000-0000-0000-0000-0000000000b1/v1/report.pdf'''

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
  (:B, 'bob@example.com'),
  (:C, 'carol@example.com'),
  (:D, 'dave@example.com');
insert into public.user_profiles (id, email) values
  (:A, 'alice@example.com'),
  (:B, 'bob@example.com'),
  (:C, 'carol@example.com'),
  (:D, 'dave@example.com')
on conflict (id) do nothing;

insert into public.folders (id, owner_id, name) values (:F, :A, 'Team');
insert into public.folder_shares (folder_id, grantee_id, role, granted_by)
values (:F, :B, 'editor', :A);
insert into public.files (id, owner_id, name, original_name) values (:Y, :A, 'plan.txt', 'plan.txt');

-- what Supabase Storage records after Bob uploads the object (real size 1234)
insert into storage.buckets (id, name) values ('uploads', 'uploads') on conflict (id) do nothing;
insert into storage.objects (bucket_id, name, owner, metadata)
values ('uploads', :XPATH, :B, '{"size": 1234, "mimetype": "application/pdf"}');

grant execute on function pg_temp.check(boolean, text) to authenticated;
grant execute on function pg_temp.login(uuid) to authenticated;
grant execute on function pg_temp.error_of(text) to authenticated;

set local role authenticated;

-- ---------------------------------------------------------------- Bob uploads into Alice's folder
select pg_temp.login(:B);
select public.register_file(:X, :F, 'report.pdf', 'report.pdf', 'pdf', 'application/pdf', 1, :XPATH);
select pg_temp.check(
  (select size from public.files where id = :X) = 1234
  and (select size from public.file_versions where file_id = :X) = 1234,
  'file size comes from storage, not from the size the client claims');

select pg_temp.check(
  pg_temp.error_of(format(
    'select public.register_file(gen_random_uuid(), null, %L, %L, %L, %L, 1, %L)',
    'ghost.pdf', 'ghost.pdf', 'pdf', 'application/pdf',
    'bbbbbbbb-0000-0000-0000-00000000000b/f1000000-0000-0000-0000-0000000000b9/v1/ghost.pdf')) like '%not found in storage%',
  'registering a file without an uploaded object is rejected');

-- Bob creates a subfolder in Alice's folder and shares only it with Carol
select public.create_folder(:F, 'Bob drafts');
select public.share_folder(
  (select id from public.folders where name = 'Bob drafts'), 'carol@example.com', 'viewer');

-- ---------------------------------------------------------------- Alice sees collaborators' items
select pg_temp.login(:A);
select pg_temp.check(public.has_file_access(:X, 'viewer'), 'folder owner can open files others uploaded into the folder');
select pg_temp.check(public.has_file_access(:X, 'admin'), 'folder owner manages files others uploaded into the folder');
select pg_temp.check(
  (select count(*) from public.files where folder_id = :F) = 1,
  'folder owner sees the file in the folder listing');
select pg_temp.check(
  (select count(*) from public.folders where parent_id = :F) = 1,
  'folder owner sees subfolders others created in the folder');
select pg_temp.check(
  (select count(*) from public.search_files(p_query => 'report')) = 1,
  'folder owner finds the file in search');
select pg_temp.check(
  exists (select 1 from public.list_recent_files(30) where id = :X),
  'folder owner sees the file in recent files');
select pg_temp.check(
  (select count(*) from public.files f
   where f.deleted_at is null and public.has_file_access(f.id, 'viewer')
     and f.id not in (select file_id from public.assistant_accessible_files())) = 0
  and (select count(*) from public.assistant_accessible_files() a
       where not public.has_file_access(a.file_id, 'viewer')) = 0,
  'assistant access list still matches has_file_access');

-- ---------------------------------------------------------------- breadcrumbs
select pg_temp.check(
  (select string_agg(name, '/' order by name) from public.get_folder_ancestors(
     (select id from public.folders where name = 'Bob drafts'))) = 'Bob drafts/Team',
  'folder owner sees the full breadcrumb');

select pg_temp.login(:C);
select pg_temp.check(
  (select string_agg(name, '/') from public.get_folder_ancestors(
     (select id from public.folders where name = 'Bob drafts'))) = 'Bob drafts',
  'breadcrumbs stop at the first folder the user cannot open');

-- ---------------------------------------------------------------- admin shares
select pg_temp.login(:A);
select public.share_file(:Y, 'bob@example.com', 'admin');
select public.share_file(:Y, 'dave@example.com', 'admin');
select public.share_folder(:F, 'dave@example.com', 'admin');
select pg_temp.login(:B);
select pg_temp.check(
  pg_temp.error_of(format('select public.share_file(%L, %L, %L)',
    'f1000000-0000-0000-0000-0000000000a1', 'dave@example.com', 'viewer')) is not null,
  'an admin grantee cannot downgrade another admin through share_file');
select pg_temp.check(
  pg_temp.error_of(format('select public.share_folder(%L, %L, %L)',
    'f0000000-0000-0000-0000-0000000000f1', 'dave@example.com', 'viewer')) is not null,
  'a non-owner cannot downgrade an admin through share_folder');
select pg_temp.check(
  pg_temp.error_of(format('select public.share_file(%L, %L, %L)',
    'f1000000-0000-0000-0000-0000000000a1', 'carol@example.com', 'viewer')) is null,
  'an admin grantee can still share with new people');
select pg_temp.login(:A);
select pg_temp.check(
  (select role from public.file_shares where file_id = :Y and grantee_id = :D) = 'admin',
  'the other admin keeps their role');
select pg_temp.check(
  pg_temp.error_of(format('select public.share_file(%L, %L, %L)',
    'f1000000-0000-0000-0000-0000000000a1', 'dave@example.com', 'viewer')) is null,
  'the owner can still change an admin''s role');

-- ---------------------------------------------------------------- trash
select public.soft_delete_folder(:F);

select pg_temp.login(:B);
select pg_temp.check(
  (select count(*) from public.get_trash_storage_paths()) = 0,
  'files hidden inside someone else''s trashed folder are not in my purge list');
select public.empty_trash();
select pg_temp.check(
  (select count(*) from public.files where id = :X) = 1,
  'emptying my trash does not delete my file inside someone else''s trashed folder');

select pg_temp.login(:A);
select pg_temp.check(
  exists (select 1 from public.get_trash_storage_paths() where storage_path = :XPATH),
  'the folder owner''s purge list includes files others uploaded into the trashed folder');
select public.empty_trash();

reset role;
select pg_temp.check(
  (select count(*) from public.files where id = :X) = 0
  and (select count(*) from public.folders where id = :F) = 0,
  'emptying the trash removes the folder with everything inside it');

rollback;
