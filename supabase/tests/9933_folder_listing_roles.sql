-- Role-aware folder listing (list_folder_items, item_role_file/folder).
-- Run with scripts/test-db.sh (plain PostgreSQL + supabase/tests stubs).
-- Everything runs in one transaction that is rolled back at the end.

\set ON_ERROR_STOP 1
\o /dev/null
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B '''bbbbbbbb-0000-0000-0000-00000000000b'''
\set C '''cccccccc-0000-0000-0000-00000000000c'''
\set PUB '''f1000000-0000-0000-0000-000000000001'''
\set SHR '''f1000000-0000-0000-0000-000000000002'''
\set PRV '''f1000000-0000-0000-0000-000000000003'''
\set TEAMFILE '''f1000000-0000-0000-0000-000000000004'''
\set BOBUP '''f1000000-0000-0000-0000-000000000005'''
\set BOBROOT '''f1000000-0000-0000-0000-000000000006'''
\set TEAM '''f0000000-0000-0000-0000-000000000001'''
\set SUB '''f0000000-0000-0000-0000-000000000002'''

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

create function pg_temp.logout() returns void
language sql as $$
  select set_config('request.jwt.claim.sub', '', true),
         set_config('request.jwt.claim.role', 'anon', true);
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

-- Names in one list of a list_folder_items result, in order.
create function pg_temp.names(listing jsonb, kind text) returns text
language sql as $$
  select coalesce(string_agg(e->>'name', ',' order by n), '')
  from jsonb_array_elements(listing->kind) with ordinality as t(e, n);
$$;

-- my_role of the item called `item_name` in a list_folder_items result.
create function pg_temp.role_in(listing jsonb, kind text, item_name text) returns text
language sql as $$
  select e->>'my_role' from jsonb_array_elements(listing->kind) e where e->>'name' = item_name;
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

-- the audit root.sql fixtures: a public file, a file shared to Bob and a
-- private file at Alice's root, plus a team folder Bob can edit
insert into public.files (id, owner_id, name, original_name, is_public) values
  (:PUB, :A, 'alice-public.pdf', 'x', true),
  (:SHR, :A, 'alice-shared.pdf', 'x', false),
  (:PRV, :A, 'alice-private.pdf', 'x', false);
insert into public.file_shares (file_id, grantee_id, role, granted_by)
values (:SHR, :B, 'viewer', :A);
insert into public.folders (id, owner_id, name) values (:TEAM, :A, 'Alice team');
insert into public.folder_shares (folder_id, grantee_id, role, granted_by)
values (:TEAM, :B, 'editor', :A);

-- inside the team folder: Alice's file, Bob's upload and Bob's subfolder
insert into public.files (id, folder_id, owner_id, name, original_name) values
  (:TEAMFILE, :TEAM, :A, 'Budget.xlsx', 'Budget.xlsx'),
  (:BOBUP, :TEAM, :B, 'agenda.docx', 'agenda.docx');
insert into public.folders (id, parent_id, owner_id, name) values (:SUB, :TEAM, :B, 'Bob notes');

-- Bob's own root file
insert into public.files (id, owner_id, name, original_name)
values (:BOBROOT, :B, 'bob-root.txt', 'bob-root.txt');

grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
grant execute on function pg_temp.login(uuid) to authenticated, anon;
grant execute on function pg_temp.logout() to authenticated, anon;
grant execute on function pg_temp.error_of(text) to authenticated, anon;
grant execute on function pg_temp.names(jsonb, text) to authenticated;
grant execute on function pg_temp.role_in(jsonb, text, text) to authenticated;

set local role authenticated;

-- ---------------------------------------------------------------- Bob
select pg_temp.login(:B);

select pg_temp.check(
  pg_temp.names(public.list_folder_items(null), 'files') = 'bob-root.txt'
  and pg_temp.names(public.list_folder_items(null), 'folders') = '',
  'root lists only the caller''s own items (no public, shared or team items of others)');

select pg_temp.check(
  pg_temp.role_in(public.list_folder_items(null), 'files', 'bob-root.txt') = 'owner'
  and (public.list_folder_items(null)->>'truncated')::boolean = false,
  'root items are marked owner and the listing is not truncated');

select pg_temp.check(
  pg_temp.names(public.list_folder_items(:TEAM), 'files') = 'agenda.docx,Budget.xlsx',
  'folder children are sorted case-insensitively by name');

select pg_temp.check(
  pg_temp.role_in(public.list_folder_items(:TEAM), 'files', 'Budget.xlsx') = 'editor',
  'editor share on the folder gives my_role editor on the owner''s file');

select pg_temp.check(
  pg_temp.role_in(public.list_folder_items(:TEAM), 'files', 'agenda.docx') = 'owner'
  and pg_temp.role_in(public.list_folder_items(:TEAM), 'folders', 'Bob notes') = 'owner',
  'Bob is owner of what he added inside the shared folder');

select pg_temp.check(
  public.list_folder_items(:TEAM)->'files'->0 ?& array[
    'id', 'folder_id', 'owner_id', 'name', 'original_name', 'extension', 'mime_type',
    'size', 'checksum', 'current_version_id', 'is_public', 'created_at', 'updated_at',
    'deleted_at', 'deleted_by', 'legacy_file_id', 'my_role'],
  'file elements keep every files column plus my_role');

select pg_temp.check(
  public.list_folder_items(:TEAM)->'folders'->0 ?& array[
    'id', 'parent_id', 'owner_id', 'name', 'comment', 'created_at', 'updated_at',
    'deleted_at', 'deleted_by', 'legacy_batch_id', 'my_role'],
  'folder elements keep every folders column plus my_role');

select pg_temp.check(
  public.item_role_file(:SHR) = 'viewer'
  and public.item_role_file(:PUB) = 'viewer'
  and public.item_role_file(:PRV) is null
  and public.item_role_folder(:TEAM) = 'editor',
  'item_role_* report the caller''s highest role, or null without access');

select pg_temp.check(
  jsonb_array_length(public.list_folder_items(:TEAM, 1)->'files') = 1
  and (public.list_folder_items(:TEAM, 1)->>'truncated')::boolean
  and pg_temp.names(public.list_folder_items(:TEAM, 1), 'files') = 'agenda.docx',
  'the limit caps each list and flags truncation');

select pg_temp.check(
  jsonb_array_length(public.list_folder_items(:TEAM, 0)->'files') = 1
  and (public.list_folder_items(:TEAM, 2)->>'truncated')::boolean = false,
  'the limit is clamped to at least 1; an exact fit is not truncated');

-- trashed children are not listed
select public.soft_delete_file(:BOBUP);
select pg_temp.check(
  pg_temp.names(public.list_folder_items(:TEAM), 'files') = 'Budget.xlsx',
  'trashed files are left out');
select public.restore_file(:BOBUP);

-- ---------------------------------------------------------------- Alice (folder owner)
select pg_temp.login(:A);

select pg_temp.check(
  pg_temp.role_in(public.list_folder_items(:TEAM), 'files', 'agenda.docx') = 'admin'
  and pg_temp.role_in(public.list_folder_items(:TEAM), 'folders', 'Bob notes') = 'admin',
  'folder owner gets admin on what a collaborator added');

select pg_temp.check(
  pg_temp.role_in(public.list_folder_items(:TEAM), 'files', 'Budget.xlsx') = 'owner',
  'owner role on own file');

select pg_temp.check(
  pg_temp.names(public.list_folder_items(null), 'files') = 'alice-private.pdf,alice-public.pdf,alice-shared.pdf'
  and pg_temp.names(public.list_folder_items(null), 'folders') = 'Alice team',
  'Alice''s root lists her own items only');

-- ---------------------------------------------------------------- Carol (no access)
select pg_temp.login(:C);

select pg_temp.check(
  pg_temp.error_of(format('select public.list_folder_items(%L)', 'f0000000-0000-0000-0000-000000000001'))
    = 'Folder not found',
  'users without access cannot list the folder');

select pg_temp.check(
  pg_temp.error_of(format('select public.list_folder_items(%L)', gen_random_uuid())) = 'Folder not found',
  'unknown folders are not found');

select pg_temp.check(
  pg_temp.names(public.list_folder_items(null), 'files') = ''
  and pg_temp.names(public.list_folder_items(null), 'folders') = '',
  'Carol''s root is empty even though Alice has a public file');

select pg_temp.check(
  public.item_role_file(:PUB) = 'viewer' and public.item_role_file(:TEAMFILE) is null,
  'public files are viewable, others are not');

-- ---------------------------------------------------------------- anon
select pg_temp.logout();
set local role anon;

select pg_temp.check(
  pg_temp.error_of('select public.list_folder_items(null)') like 'permission denied%',
  'anon cannot call list_folder_items');
select pg_temp.check(
  pg_temp.error_of(format('select public.item_role_file(%L)', 'f1000000-0000-0000-0000-000000000001')) like 'permission denied%',
  'anon cannot call item_role_file');
select pg_temp.check(
  pg_temp.error_of(format('select public.item_role_folder(%L)', 'f0000000-0000-0000-0000-000000000001')) like 'permission denied%',
  'anon cannot call item_role_folder');

-- signed out but with the authenticated role: list_folder_items refuses
reset role;
set local role authenticated;
select pg_temp.check(
  pg_temp.error_of('select public.list_folder_items(null)') = 'Not signed in',
  'list_folder_items requires a signed-in user');

rollback;
