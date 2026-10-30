-- Notification center: share/comment triggers, privacy and the client RPCs.
-- Run with scripts/test-db.sh (plain PostgreSQL + supabase/tests stubs).
-- Everything runs in one transaction that is rolled back at the end.

\set ON_ERROR_STOP 1
\o /dev/null
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B '''bbbbbbbb-0000-0000-0000-00000000000b'''
\set C '''cccccccc-0000-0000-0000-00000000000c'''
\set F '''f0000000-0000-0000-0000-0000000000f1'''
\set X '''f1000000-0000-0000-0000-0000000000a1'''
\set Y '''f1000000-0000-0000-0000-0000000000a2'''

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
  select set_config('request.jwt.claim.sub', coalesce(uid::text, ''), true),
         set_config('request.jwt.claim.role', case when uid is null then 'anon' else 'authenticated' end, true);
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
insert into public.files (id, folder_id, owner_id, name, original_name)
values (:Y, null, :A, 'photo.png', 'photo.png');

-- chat file shares record their source (T04); added here when that migration
-- is not applied, so the trigger's skip can be tested on its own
alter table public.file_shares add column if not exists source text;
insert into public.file_shares (file_id, grantee_id, role, granted_by, source)
values (:Y, :C, 'viewer', :A, 'chat');

select pg_temp.check(
  (select count(*) from public.notifications where user_id = :C) = 0,
  'a chat file share creates no notification');

select pg_temp.check(
  (select count(*) from public.user_preferences) = 0
  and (select column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'user_preferences' and column_name = 'activity_push') = 'true',
  'activity push is on by default');

grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
grant execute on function pg_temp.login(uuid) to authenticated, anon;
grant execute on function pg_temp.error_of(text) to authenticated, anon;

set local role authenticated;

-- ---------------------------------------------------------------- Alice shares with Bob
select pg_temp.login(:A);
select public.share_file(:X, 'bob@example.com', 'viewer');

select pg_temp.check(
  (select count(*) from public.list_notifications()) = 0
  and public.unread_notification_count() = 0,
  'the actor is not notified of their own share');

-- re-sharing (role change through the upsert) does not notify again
select public.share_file(:X, 'bob@example.com', 'editor');

-- ---------------------------------------------------------------- Bob
select pg_temp.login(:B);

select pg_temp.check(
  (select count(*) from public.notifications) = 1
  and (select count(*) from public.list_notifications()) = 1,
  'the grantee gets exactly one notification');

select pg_temp.check(
  (select kind = 'share.file'
      and title = 'alice@example.com shared “plan.txt” with you'
      and link = '/shared'
      and entity_type = 'file' and entity_id = :X
      and actor_id = :A and actor_name = 'alice@example.com'
      and read_at is null
   from public.list_notifications()),
  'share notification names the actor and the file');

select pg_temp.check(
  public.unread_notification_count() = 1,
  'unread count includes the new notification');

select pg_temp.check(
  pg_temp.error_of(format('select public.create_notification(%L, %L, %L)',
    'cccccccc-0000-0000-0000-00000000000c', 'share.file', 'forged')) like '%permission denied%',
  'users cannot call create_notification directly');

select pg_temp.check(
  pg_temp.error_of(format(
    'insert into public.notifications (user_id, kind, title) values (%L, %L, %L)',
    'cccccccc-0000-0000-0000-00000000000c', 'share.file', 'forged')) is not null,
  'users cannot insert notifications');

select pg_temp.check(
  pg_temp.error_of('update public.notifications set title = ''changed''') is not null
  and pg_temp.error_of('delete from public.notifications') is not null,
  'users cannot change or delete notifications directly');

select pg_temp.check(
  pg_temp.error_of('select * from public.notification_push_log') like '%permission denied%',
  'the push log is not readable by users');

select public.add_item_comment(:X, null, E'Looks good,\nbut check the totals.');

-- ---------------------------------------------------------------- Carol (no access)
select pg_temp.login(:C);

select pg_temp.check(
  (select count(*) from public.notifications) = 0
  and (select count(*) from public.list_notifications()) = 0
  and public.unread_notification_count() = 0,
  'other users see none of Bob''s or Alice''s notifications');

-- ---------------------------------------------------------------- Alice reads
select pg_temp.login(:A);

select pg_temp.check(
  (select count(*) from public.list_notifications()) = 1
  and (select kind = 'comment'
          and title = 'bob@example.com commented on “plan.txt”'
          and body = E'Looks good,\nbut check the totals.'
          and link = '/dashboard?folder=f0000000-0000-0000-0000-0000000000f1'
          and entity_type = 'file' and entity_id = :X
       from public.list_notifications()),
  'a comment notifies the item owner with a link to its folder');

-- commenting on your own item notifies nobody
select public.add_item_comment(:X, null, 'Note to self');
select pg_temp.check(
  (select count(*) from public.list_notifications()) = 1,
  'owners are not notified of their own comments');

select public.share_folder(:F, 'carol@example.com', 'viewer');

-- Bob cannot mark Alice's notification read
select set_config('test.alice_note', (select id::text from public.list_notifications()), true);
select pg_temp.login(:B);
select pg_temp.check(
  public.mark_notifications_read(array[current_setting('test.alice_note')::uuid]) = 0,
  'users cannot mark someone else''s notifications read');
select pg_temp.login(:A);
select pg_temp.check(public.unread_notification_count() = 1, 'the owner''s notification stays unread');

-- (stable functions see the statement's snapshot, so the checks come after)
select pg_temp.check(public.mark_notifications_read(null) = 1, 'mark_notifications_read(null) returns how many changed');
select pg_temp.check(
  public.unread_notification_count() = 0
  and (select read_at is not null from public.list_notifications()),
  'mark_notifications_read(null) marks all of the caller''s notifications read');

select pg_temp.check(
  public.mark_notifications_read(null) = 0,
  'marking again changes nothing');

-- ---------------------------------------------------------------- Bob marks his own
select pg_temp.login(:B);
select pg_temp.check(
  public.mark_notifications_read(array(select id from public.list_notifications())) = 1,
  'marking specific ids works');
select pg_temp.check(public.unread_notification_count() = 0, 'unread count follows');

-- ---------------------------------------------------------------- Carol: folder share
select pg_temp.login(:C);
select pg_temp.check(
  (select count(*) from public.list_notifications(null, 0)) = 1
  and (select kind = 'share.folder'
          and title = 'alice@example.com shared “Reports” with you'
          and entity_type = 'folder' and entity_id = :F
       from public.list_notifications(null, 500)),
  'a folder share notifies the grantee (limit is clamped to 1..100)');

select pg_temp.check(
  (select count(*) from public.list_notifications(now() - interval '1 day')) = 0,
  'p_before pages to older notifications');

-- ---------------------------------------------------------------- anon
select pg_temp.login(null);
set local role anon;

select pg_temp.check(
  pg_temp.error_of('select * from public.list_notifications()') like '%permission denied%',
  'anon cannot call list_notifications');
select pg_temp.check(
  pg_temp.error_of('select public.unread_notification_count()') like '%permission denied%'
  and pg_temp.error_of('select public.mark_notifications_read(null)') like '%permission denied%',
  'anon cannot call the other notification RPCs');
select pg_temp.check(
  pg_temp.error_of(format('select public.create_notification(%L, %L, %L)',
    'cccccccc-0000-0000-0000-00000000000c', 'share.file', 'forged')) like '%permission denied%',
  'anon cannot call create_notification');
select pg_temp.check(
  pg_temp.error_of('select * from public.notifications') like '%permission denied%',
  'anon cannot read the notifications table');

reset role;

-- ---------------------------------------------------------------- function privileges
select pg_temp.check(
  not has_function_privilege('authenticated', 'public.notify_file_share()', 'execute')
  and not has_function_privilege('anon', 'public.notify_item_comment()', 'execute')
  and not has_function_privilege('authenticated', 'public.notification_actor_name(uuid)', 'execute')
  and has_function_privilege('service_role', 'public.create_notification(uuid, text, text, text, text, text, uuid, uuid)', 'execute'),
  'trigger and internal functions are not callable by clients');

-- the service role (cron, server routes) has no auth.uid(): the actor is null
select pg_temp.login(null);
select pg_temp.check(
  public.create_notification(:B, 'document.reminder', repeat('x', 300), repeat('y', 600), '/documents') is not null,
  'the service role can create notifications');
select pg_temp.check(
  (select char_length(title) = 200 and char_length(body) = 500 and actor_id is null
   from public.notifications where user_id = :B and kind = 'document.reminder'),
  'create_notification truncates the title and body');

select pg_temp.check(
  public.create_notification(null, 'comment', 'nobody') is null,
  'a missing recipient writes nothing');

select pg_temp.check(
  pg_temp.error_of(format('select public.create_notification(%L, %L, %L, null, %L)',
    'bbbbbbbb-0000-0000-0000-00000000000b', 'comment', 'evil', '//evil.example')) is not null
  and pg_temp.error_of(format('select public.create_notification(%L, %L, %L, null, %L)',
    'bbbbbbbb-0000-0000-0000-00000000000b', 'comment', 'evil', 'https://evil.example')) is not null
  and pg_temp.error_of(format('select public.create_notification(%L, %L, %L, null, %L)',
    'bbbbbbbb-0000-0000-0000-00000000000b', 'comment', 'evil', E'/\\evil.example')) is not null
  and pg_temp.error_of(format('select public.create_notification(%L, %L, %L, null, %L)',
    'bbbbbbbb-0000-0000-0000-00000000000b', 'comment', 'evil', E'/\t/evil.example')) is not null
  and pg_temp.error_of(format('select public.create_notification(%L, %L, %L, null, %L)',
    'bbbbbbbb-0000-0000-0000-00000000000b', 'Bad Kind', 'x', '/shared')) is not null,
  'links to other sites and malformed kinds are rejected');

-- ---------------------------------------------------------------- a failing notification
-- every new notification row is rejected; the share and the comment still land
alter table public.notifications add constraint notifications_test_block check (false) not valid;
select pg_temp.check(
  pg_temp.error_of(format(
    'insert into public.file_shares (file_id, grantee_id, role, granted_by) values (%L, %L, %L, %L)',
    'f1000000-0000-0000-0000-0000000000a1', 'cccccccc-0000-0000-0000-00000000000c', 'viewer',
    'aaaaaaaa-0000-0000-0000-00000000000a')) is null
  and pg_temp.error_of(format(
    'insert into public.item_comments (file_id, author_id, body) values (%L, %L, %L)',
    'f1000000-0000-0000-0000-0000000000a1', 'bbbbbbbb-0000-0000-0000-00000000000b', 'still saved')) is null,
  'a failing notification never breaks the share or the comment');
-- (a new statement, so the rows written above are visible)
select pg_temp.check(
  exists (select 1 from public.file_shares where file_id = :X and grantee_id = :C)
  and exists (select 1 from public.item_comments where file_id = :X and body = 'still saved')
  and (select count(*) from public.notifications where user_id = :C and kind = 'share.file') = 0,
  'the share and the comment were saved without their notifications');

rollback;
