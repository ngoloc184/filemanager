-- Tests for 202608280031_ownership_safety.sql: moves cannot hand an item to a
-- new owner chain (audit escalate.sql), accounts that own files cannot be
-- deleted, and removing an account keeps its uploads, shares, links, comments
-- and activity with the user id cleared (audit offboard.sql).
-- Run with scripts/test-db.sh (plain PostgreSQL + supabase/tests stubs).
-- Everything runs in one transaction that is rolled back at the end.

\set ON_ERROR_STOP 1
\o /dev/null
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B '''bbbbbbbb-0000-0000-0000-00000000000b'''
\set C '''cccccccc-0000-0000-0000-00000000000c'''
\set D '''dddddddd-0000-0000-0000-00000000000d'''
\set E '''eeeeeeee-0000-0000-0000-00000000000e'''
\set F '''f0000000-0000-0000-0000-0000000000f1'''
\set S1 '''f0000000-0000-0000-0000-0000000000f2'''
\set S2 '''f0000000-0000-0000-0000-0000000000f3'''
\set G '''f0000000-0000-0000-0000-0000000000f4'''
\set H '''f0000000-0000-0000-0000-0000000000f5'''
\set T '''f0000000-0000-0000-0000-0000000000f6'''
\set X '''f1000000-0000-0000-0000-0000000000a1'''
\set Y '''f1000000-0000-0000-0000-0000000000b1'''
\set Z '''f1000000-0000-0000-0000-0000000000a2'''
\set XGOOD '''bbbbbbbb-0000-0000-0000-00000000000b/f1000000-0000-0000-0000-0000000000a1/v2/plan.txt'''
\set XEVIL '''aaaaaaaa-0000-0000-0000-00000000000a/f1000000-0000-0000-0000-0000000000a1/v3/plan.txt'''

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

-- ---------------------------------------------------------------- fixtures
insert into auth.users (id, email) values
  (:A, 'alice@example.com'),
  (:B, 'bob@example.com'),
  (:C, 'carol@example.com'),
  (:D, 'dave@example.com'),
  (:E, 'eve@example.com');
insert into public.user_profiles (id, email) values
  (:A, 'alice@example.com'),
  (:B, 'bob@example.com'),
  (:C, 'carol@example.com'),
  (:D, 'dave@example.com'),
  (:E, 'eve@example.com')
on conflict (id) do nothing;

-- Alice: Team (shared to Bob as editor) with Sub1 and Sub2, plus Archive.
-- Eve: Inbox, shared to Alice as editor. Trash: an Alice folder Dave trashed.
insert into public.folders (id, owner_id, name, parent_id) values
  (:F, :A, 'Team', null),
  (:S1, :A, 'Sub1', :F),
  (:S2, :A, 'Sub2', :F),
  (:G, :A, 'Archive', null),
  (:H, :E, 'Inbox', null);
insert into public.folders (id, owner_id, name, deleted_at, deleted_by)
values (:T, :A, 'Old', now(), :D);
insert into public.folder_shares (folder_id, grantee_id, role, granted_by) values
  (:F, :B, 'editor', :A),
  (:H, :A, 'editor', :E);

-- X: Alice's file in Team/Sub1. Y: a file Bob uploaded into Team.
-- Z: Alice's root file with versions by Alice, Carol and Dave.
insert into public.files (id, owner_id, folder_id, name, original_name) values
  (:X, :A, :S1, 'plan.txt', 'plan.txt'),
  (:Y, :B, :F, 'contract.pdf', 'contract.pdf'),
  (:Z, :A, null, 'budget.xlsx', 'budget.xlsx');
insert into public.file_versions (file_id, version_no, storage_path, uploaded_by) values
  (:Z, 1, 'aaaaaaaa-0000-0000-0000-00000000000a/f1000000-0000-0000-0000-0000000000a2/v1/budget.xlsx', :A),
  (:Z, 2, 'cccccccc-0000-0000-0000-00000000000c/f1000000-0000-0000-0000-0000000000a2/v2/budget.xlsx', :C),
  (:Z, 3, 'dddddddd-0000-0000-0000-00000000000d/f1000000-0000-0000-0000-0000000000a2/v3/budget.xlsx', :D);
-- Carol can view Z; Dave granted Bob's share and created a link.
insert into public.file_shares (file_id, grantee_id, role, granted_by) values
  (:Z, :C, 'viewer', :A),
  (:Z, :B, 'viewer', :D);
insert into public.share_links (file_id, created_by) values (:Z, :D);

-- storage objects Bob uploads for new versions of X
insert into storage.buckets (id, name) values ('uploads', 'uploads') on conflict (id) do nothing;
insert into storage.objects (bucket_id, name, owner, metadata) values
  ('uploads', :XGOOD, :B, '{"size": 10}'),
  ('uploads', :XEVIL, :B, '{"size": 10}');

grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
grant execute on function pg_temp.login(uuid) to authenticated;
grant execute on function pg_temp.error_of(text) to authenticated, anon;

-- ---------------------------------------------------------------- anon and clients
set local role anon;
select pg_temp.check(
  pg_temp.error_of(format('select public.folder_chain_owners(%L)', :F)) is not null,
  'anon cannot call folder_chain_owners');
select pg_temp.check(
  pg_temp.error_of(format('select public.move_file(%L, %L)', :X, :S2)) is not null,
  'anon cannot call move_file');
select pg_temp.check(
  pg_temp.error_of(format('select public.move_folder(%L, %L)', :S1, :S2)) is not null,
  'anon cannot call move_folder');
reset role;

set local role authenticated;
select pg_temp.login(:A);
select pg_temp.check(
  pg_temp.error_of(format('select public.folder_chain_owners(%L)', :F)) like '%permission denied%',
  'folder_chain_owners is internal (signed-in users are denied too)');

-- ---------------------------------------------------------------- Alice (folder owner)
-- (d) Alice moves the file Bob uploaded into Team to another Alice folder
select pg_temp.check(
  pg_temp.error_of(format('select public.move_file(%L, %L)', :Y, :G)) is null,
  'folder owner moves a collaborator''s file to another folder she owns');
select pg_temp.check((select folder_id from public.files where id = :Y) = :G, 'the file is in Archive');
select pg_temp.check(
  pg_temp.error_of(format('select public.move_file(%L, %L)', :Y, :H)) like '%cannot move%',
  'folder owner cannot move a collaborator''s file into a third person''s folder');
select public.move_file(:Y, :F);

select pg_temp.check(
  pg_temp.error_of(format('select public.move_file(%L, %L)', :Z, :H)) is null,
  'the owner moves their own file into a folder someone else owns');
select pg_temp.check(
  pg_temp.error_of(format('select public.move_file(%L, null)', :Z)) is null,
  'the owner moves their own file back to My Files');

-- ---------------------------------------------------------------- Bob (editor on Team)
select pg_temp.login(:B);
select pg_temp.check(not public.has_file_access(:X, 'admin'), 'Bob is not admin of X before');

-- (a) escalation PoC: Bob moves Alice's file into a folder he owns
select public.create_folder(null, 'Mine');
select pg_temp.check(
  pg_temp.error_of(format('select public.move_file(%L, %L)', :X,
    (select id from public.folders where owner_id = :B and name = 'Mine'))) like '%cannot move%',
  'editor cannot move the owner''s file into a folder he owns');
select pg_temp.check(not public.has_file_access(:X, 'admin'), 'Bob is still not admin of X');
select pg_temp.check((select folder_id from public.files where id = :X) = :S1, 'X stays in Sub1');

select public.create_folder(:F, 'Bob sub');
select pg_temp.check(
  pg_temp.error_of(format('select public.move_file(%L, %L)', :X,
    (select id from public.folders where owner_id = :B and name = 'Bob sub'))) like '%cannot move%',
  'editor cannot move the owner''s file into his own subfolder inside the shared folder');

-- (b) moving between two Alice-owned subfolders of Team works
select pg_temp.check(
  pg_temp.error_of(format('select public.move_file(%L, %L)', :X, :S2)) is null,
  'editor moves the owner''s file between folders of the same owner');
select pg_temp.check((select folder_id from public.files where id = :X) = :S2, 'X is in Sub2');
select public.move_file(:X, :S1);

-- (c) non-owners cannot move to My Files
select pg_temp.check(
  pg_temp.error_of(format('select public.move_file(%L, null)', :X)) like 'Only the owner%',
  'editor cannot move the owner''s file to My Files');

-- (e) move_folder escalation
select pg_temp.check(
  pg_temp.error_of(format('select public.move_folder(%L, %L)', :S1,
    (select id from public.folders where owner_id = :B and name = 'Mine'))) like '%cannot move%',
  'editor cannot move the owner''s subfolder into a folder he owns');
select pg_temp.check(not public.has_folder_access(:S1, 'admin'), 'Bob is still not admin of Sub1');
select pg_temp.check(
  pg_temp.error_of(format('select public.move_folder(%L, null)', :S1)) like 'Only the owner%',
  'editor cannot move the owner''s subfolder to My Files');
select pg_temp.check(
  pg_temp.error_of(format('select public.move_folder(%L, %L)', :S2, :S1)) is null,
  'editor moves the owner''s subfolder inside the same owner''s tree');
select pg_temp.check((select parent_id from public.folders where id = :S2) = :S1, 'Sub2 is inside Sub1');
select public.move_folder(:S2, :F);

-- Bob moving his own file is unchanged
select pg_temp.check(
  pg_temp.error_of(format('select public.move_file(%L, %L)', :Y,
    (select id from public.folders where owner_id = :B and name = 'Mine'))) is null,
  'Bob moves his own file out of the shared folder');

-- the storage path guard still runs for signed-in requests
select pg_temp.check(
  pg_temp.error_of(format('select public.add_file_version(%L, %L, 10, %L)', :X, :XEVIL, 'text/plain'))
    like 'Invalid storage path%',
  'a version stored under another user''s path is rejected');
select pg_temp.check(
  pg_temp.error_of(format('select public.add_file_version(%L, %L, 10, %L)', :X, :XGOOD, 'text/plain')) is null,
  'a version stored under the uploader''s path is accepted');

-- Carol comments on Z before her account is removed
select pg_temp.login(:C);
select public.add_item_comment(:Z, null, 'Numbers checked');
reset role;

-- ---------------------------------------------------------------- deleting accounts
-- (g) an account that still owns files or folders cannot be deleted
select pg_temp.check(
  pg_temp.error_of(format('delete from auth.users where id = %L', :B)) like '%foreign key%',
  'deleting a user who owns files fails on the foreign key');
select pg_temp.check(
  pg_temp.error_of(format('delete from auth.users where id = %L', :E)) like '%foreign key%',
  'deleting a user who owns only a folder fails on the foreign key');
select pg_temp.check(
  (select count(*) from public.files where owner_id = :B) = 1
  and exists (select 1 from auth.users where id = :B),
  'the failed delete leaves the account and its files');

-- (f) as postgres: Carol uploaded v2 of Alice's file
select pg_temp.check(
  pg_temp.error_of(format('delete from auth.users where id = %L', :C)) is null,
  'deleting a user who only uploaded a version succeeds');
select pg_temp.check(
  (select uploaded_by is null
          and storage_path = 'cccccccc-0000-0000-0000-00000000000c/f1000000-0000-0000-0000-0000000000a2/v2/budget.xlsx'
   from public.file_versions where file_id = :Z and version_no = 2),
  'the version stays with uploaded_by cleared');
select pg_temp.check(
  (select count(*) from public.item_comments where file_id = :Z and author_id is null) = 1,
  'the removed user''s comment stays without an author');
select pg_temp.check(
  exists (select 1 from public.activity_events where action = 'file.commented' and actor_id is null and owner_id = :A),
  'the removed user''s activity stays without an actor');

-- (f) as service_role: Dave uploaded v3, granted a share, made a link, trashed a folder
grant delete on auth.users to service_role;
set local role service_role;
select pg_temp.check(
  pg_temp.error_of(format('delete from auth.users where id = %L', :D)) is null,
  'service role deletes a user who only uploaded a version');
reset role;
select pg_temp.check(
  (select uploaded_by is null from public.file_versions where file_id = :Z and version_no = 3),
  'service role delete: uploaded_by cleared');
select pg_temp.check(
  (select granted_by is null from public.file_shares where file_id = :Z and grantee_id = :B),
  'shares the removed user granted stay');
select pg_temp.check(
  (select created_by is null from public.share_links where file_id = :Z),
  'links the removed user created stay');
select pg_temp.check(
  (select deleted_by is null and deleted_at is not null from public.folders where id = :T),
  'trashed items keep their trash state with deleted_by cleared');

-- ---------------------------------------------------------------- comments without an author
set local role authenticated;
select pg_temp.login(:B);
select pg_temp.check(public.has_file_access(:Z, 'viewer'), 'Bob keeps the share the removed user granted');
select pg_temp.check(
  pg_temp.error_of(format('select public.update_item_comment(%L, %L)',
    (select id from public.item_comments where file_id = :Z), 'edited')) is not null,
  'a viewer cannot edit a comment whose author was removed');
select pg_temp.check(
  pg_temp.error_of(format('select public.delete_item_comment(%L)',
    (select id from public.item_comments where file_id = :Z))) is not null,
  'a viewer cannot delete a comment whose author was removed');

select pg_temp.login(:A);
select pg_temp.check(
  pg_temp.error_of(format('select public.delete_item_comment(%L)',
    (select id from public.item_comments where file_id = :Z))) is null,
  'the owner can delete a comment whose author was removed');

reset role;

\o
\echo 'ownership safety tests: all passed'
rollback;
