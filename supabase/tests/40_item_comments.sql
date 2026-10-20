-- Permission tests for file/folder comments.
-- Run with scripts/test-db.sh (plain PostgreSQL + supabase/tests stubs).
-- Everything runs in one transaction that is rolled back at the end.

\set ON_ERROR_STOP 1
\o /dev/null
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B '''bbbbbbbb-0000-0000-0000-00000000000b'''
\set C '''cccccccc-0000-0000-0000-00000000000c'''
\set F '''f0000000-0000-0000-0000-0000000000f1'''
\set X '''f1000000-0000-0000-0000-0000000000a1'''

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
  (:C, 'carol@example.com');
insert into public.user_profiles (id, email) values
  (:A, 'alice@example.com'),
  (:B, 'bob@example.com'),
  (:C, 'carol@example.com')
on conflict (id) do nothing;

insert into public.folders (id, owner_id, name) values (:F, :A, 'Reports');
insert into public.files (id, folder_id, owner_id, name, original_name)
values (:X, :F, :A, 'plan.txt', 'plan.txt');
-- Bob can view everything in the folder; Carol has no access.
insert into public.folder_shares (folder_id, grantee_id, role, granted_by)
values (:F, :B, 'viewer', :A);

grant execute on function pg_temp.check(boolean, text) to authenticated;
grant execute on function pg_temp.login(uuid) to authenticated;
grant execute on function pg_temp.error_of(text) to authenticated;

set local role authenticated;

-- ---------------------------------------------------------------- Bob (viewer)
select pg_temp.login(:B);

select pg_temp.check(
  (select body from public.add_item_comment(:X, null, E'\n  Dòng 1\nDòng 2\n\n')) = E'Dòng 1\nDòng 2',
  'viewer can comment; line breaks inside the comment are kept');

select pg_temp.check(
  (select count(*) from public.list_item_comments(:X, null)) = 1
  and (select author_email from public.list_item_comments(:X, null)) = 'bob@example.com',
  'comments list the author email');

select pg_temp.check(
  pg_temp.error_of(format('select public.add_item_comment(%L, null, %L)', 'f1000000-0000-0000-0000-0000000000a1', E'  \n ')) is not null,
  'blank comments are rejected');

select pg_temp.check(
  pg_temp.error_of(format('select public.add_item_comment(%L, %L, %L)', 'f1000000-0000-0000-0000-0000000000a1', 'f0000000-0000-0000-0000-0000000000f1', 'x')) is not null,
  'a comment targets exactly one item');

select pg_temp.check(
  pg_temp.error_of(format(
    'insert into public.item_comments (file_id, author_id, body) values (%L, %L, %L)',
    'f1000000-0000-0000-0000-0000000000a1', 'bbbbbbbb-0000-0000-0000-00000000000b', 'direct')) is not null,
  'comments cannot be inserted directly, only through the RPC');

select public.add_item_comment(null, :F, 'Folder note');
select pg_temp.check(
  (select comment_count from public.count_item_comments(array[:X]::uuid[], array[:F]::uuid[]) where item_id = :F) = 1,
  'folder comments are counted');

select public.update_item_comment(
  (select id from public.list_item_comments(:X, null)), E'Dòng 1\nDòng 2 (sửa)');
select pg_temp.check(
  (select body from public.list_item_comments(:X, null)) = E'Dòng 1\nDòng 2 (sửa)',
  'author can edit their comment');

-- ---------------------------------------------------------------- Carol (no access)
select pg_temp.login(:C);

select pg_temp.check(
  pg_temp.error_of(format('select * from public.list_item_comments(%L, null)', 'f1000000-0000-0000-0000-0000000000a1')) is not null,
  'users without access cannot read comments');
select pg_temp.check(
  pg_temp.error_of(format('select public.add_item_comment(%L, null, %L)', 'f1000000-0000-0000-0000-0000000000a1', 'hi')) is not null,
  'users without access cannot comment');
select pg_temp.check(
  (select count(*) from public.count_item_comments(array[:X]::uuid[], array[:F]::uuid[])) = 0,
  'counts hide items the caller cannot view');
select pg_temp.check(
  (select count(*) from public.item_comments) = 0,
  'RLS hides comments from users without access');

-- ---------------------------------------------------------------- Alice (owner)
select pg_temp.login(:A);

select pg_temp.check(
  pg_temp.error_of(format('select public.update_item_comment(%L, %L)',
    (select id from public.list_item_comments(:X, null)), 'rewritten')) is not null,
  'only the author can edit a comment');

select public.delete_item_comment((select id from public.list_item_comments(:X, null)));
select pg_temp.check(
  (select count(*) from public.list_item_comments(:X, null)) = 0,
  'item owner can delete any comment on it');

select pg_temp.check(
  exists (select 1 from public.list_activity(50) where action = 'file.commented' and resource_id = :X),
  'commenting is recorded in the owner''s activity');

select public.soft_delete_file(:X);
select pg_temp.check(
  pg_temp.error_of(format('select public.add_item_comment(%L, null, %L)', 'f1000000-0000-0000-0000-0000000000a1', 'late')) is not null,
  'items in the trash cannot be commented on');

-- ---------------------------------------------------------------- Bob deletes his folder comment
select pg_temp.login(:B);
select public.delete_item_comment((select id from public.list_item_comments(null, :F)));
select pg_temp.check(
  (select count(*) from public.list_item_comments(null, :F)) = 0,
  'author can delete their own comment');

rollback;
