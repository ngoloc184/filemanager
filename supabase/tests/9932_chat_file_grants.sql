-- Access given by sending a file in a chat is taken back on remove, leave,
-- unsend and disband; manual shares survive (202608280032_chat_file_grants.sql).
-- Run with scripts/test-db.sh (plain PostgreSQL + supabase/tests stubs).
-- Everything runs in one transaction that is rolled back at the end.

\set ON_ERROR_STOP 1
\o /dev/null
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B '''bbbbbbbb-0000-0000-0000-00000000000b'''
\set C '''cccccccc-0000-0000-0000-00000000000c'''
\set D '''dddddddd-0000-0000-0000-00000000000d'''
\set SECRET '''f3200000-0000-0000-0000-0000000000a1'''
\set OTHER '''f3200000-0000-0000-0000-0000000000a2'''
\set THIRD '''f3200000-0000-0000-0000-0000000000a3'''
\set BOTH '''f3200000-0000-0000-0000-0000000000a4'''
\set LAST '''f3200000-0000-0000-0000-0000000000a5'''

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
  (:D, 'dave@example.com');
insert into public.user_profiles (id, email) values
  (:A, 'alice@example.com'),
  (:B, 'bob@example.com'),
  (:C, 'carol@example.com'),
  (:D, 'dave@example.com')
on conflict (id) do nothing;
insert into public.files (id, owner_id, name, original_name, size, mime_type) values
  (:SECRET, :A, 'secret.txt', 'secret.txt', 10, 'text/plain'),
  (:OTHER, :A, 'other.txt', 'other.txt', 10, 'text/plain'),
  (:THIRD, :A, 'third.txt', 'third.txt', 10, 'text/plain'),
  (:BOTH, :A, 'both.txt', 'both.txt', 10, 'text/plain'),
  (:LAST, :A, 'last.txt', 'last.txt', 10, 'text/plain');

grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
grant execute on function pg_temp.login(uuid) to authenticated, anon;
grant execute on function pg_temp.error_of(text) to authenticated, anon;

set local role authenticated;

-- ---------------------------------------------------------------- send
select pg_temp.login(:A);
-- other.txt is shared by hand before it is ever sent
select public.share_file(:OTHER, 'bob@example.com', 'viewer');
select set_config('test.g', public.create_chat_group('G', array['bob@example.com', 'carol@example.com', 'dave@example.com'])::text, true);
select set_config('test.h', public.create_chat_group('H', array['dave@example.com'])::text, true);

select set_config('test.m_secret', public.send_chat_message(current_setting('test.g')::uuid, null, :SECRET)::text, true);
select public.send_chat_message(current_setting('test.g')::uuid, null, :OTHER);
-- third.txt is sent first, then shared by hand with Carol
select set_config('test.m_third', public.send_chat_message(current_setting('test.g')::uuid, null, :THIRD)::text, true);
select public.share_file(:THIRD, 'carol@example.com', 'viewer');
select public.send_chat_message(current_setting('test.g')::uuid, null, :BOTH);
select public.send_chat_message(current_setting('test.h')::uuid, null, :BOTH);
-- last.txt is sent twice in G
select set_config('test.m_last1', public.send_chat_message(current_setting('test.g')::uuid, null, :LAST)::text, true);
select set_config('test.m_last2', public.send_chat_message(current_setting('test.g')::uuid, null, :LAST)::text, true);

reset role;
select pg_temp.check(
  (select source from public.file_shares where file_id = :SECRET and grantee_id = :B) = 'chat'
  and (select source from public.file_shares where file_id = :OTHER and grantee_id = :B) = 'manual',
  'a share made by sending is a chat share; an earlier manual share stays manual');
select pg_temp.check(
  (select source from public.file_shares where file_id = :THIRD and grantee_id = :C) = 'manual'
  and (select source from public.file_shares where file_id = :THIRD and grantee_id = :B) = 'chat',
  'sharing by hand after a chat grant makes the share manual');
select pg_temp.check(
  (select count(*) from public.chat_file_grants where message_id = current_setting('test.m_secret')::uuid) = 3
  and not exists (select 1 from public.chat_file_grants where grantee_id = :A),
  'every other member gets a grant, never the sender');
set local role authenticated;

select pg_temp.login(:B);
select pg_temp.check(public.has_file_access(:SECRET, 'viewer'), 'Bob can open the file sent in the group');
select pg_temp.login(:C);
select pg_temp.check(public.has_file_access(:SECRET, 'viewer'), 'Carol can open the file sent in the group');
select pg_temp.check(
  pg_temp.error_of('select count(*) from public.chat_file_grants') is not null,
  'clients cannot read chat grants');
select pg_temp.check(
  pg_temp.error_of(format('select public.chat_revoke_file_grants(%L)', current_setting('test.g'))) is not null,
  'members cannot call the internal revocation');

-- ---------------------------------------------------------------- remove
select pg_temp.login(:A);
select public.remove_chat_member(current_setting('test.g')::uuid, :B);
select pg_temp.check(
  (select meta ->> 'type' = 'remove' and meta ->> 'user_id' = :B
   from public.list_chat_messages(current_setting('test.g')::uuid) order by created_at desc limit 1),
  'removing a member is recorded as a system message');

select pg_temp.login(:B);
select pg_temp.check(not public.has_file_access(:SECRET, 'viewer'), 'a removed member loses access to the chat file');
select pg_temp.check(
  not exists (select 1 from public.list_shared_with_me() where id = :SECRET),
  'the chat file is no longer shared with the removed member');
select pg_temp.check(
  public.has_file_access(:OTHER, 'viewer')
  and exists (select 1 from public.list_shared_with_me() where id = :OTHER),
  'a manual share made before sending survives removal');
select pg_temp.login(:C);
select pg_temp.check(public.has_file_access(:SECRET, 'viewer'), 'the other members keep access');

-- a file sent in two groups: removed from one, still in the other
select pg_temp.login(:A);
select public.remove_chat_member(current_setting('test.g')::uuid, :D);
select pg_temp.login(:D);
select pg_temp.check(public.has_file_access(:BOTH, 'viewer'), 'access given in another group the member is still in stays');
select pg_temp.check(not public.has_file_access(:SECRET, 'viewer'), 'access given only in the group left is gone');

-- ---------------------------------------------------------------- unsend
select pg_temp.login(:A);
select public.delete_chat_message(current_setting('test.m_third')::uuid);
select pg_temp.login(:C);
select pg_temp.check(public.has_file_access(:THIRD, 'viewer'), 'a manual share made after the chat grant survives unsending');

select pg_temp.login(:A);
select public.delete_chat_message(current_setting('test.m_last1')::uuid);
select pg_temp.login(:C);
select pg_temp.check(public.has_file_access(:LAST, 'viewer'), 'access stays while another message still gives it');
select pg_temp.login(:A);
select public.delete_chat_message(current_setting('test.m_last2')::uuid);
select pg_temp.login(:C);
select pg_temp.check(not public.has_file_access(:LAST, 'viewer'), 'unsending the last message that gave access takes it back');

-- ---------------------------------------------------------------- leave
select pg_temp.check(public.has_file_access(:SECRET, 'viewer'), 'Carol still has the group file before leaving');
select public.leave_chat_group(current_setting('test.g')::uuid);
select pg_temp.check(not public.has_file_access(:SECRET, 'viewer'), 'leaving the group takes the access back');
select pg_temp.check(public.has_file_access(:THIRD, 'viewer'), 'a manual share survives leaving');

-- ---------------------------------------------------------------- disband
select pg_temp.login(:A);
select public.delete_chat_group(current_setting('test.h')::uuid);
select pg_temp.login(:D);
select pg_temp.check(not public.has_file_access(:BOTH, 'viewer'), 'disbanding a group takes back every access it gave');

reset role;
select pg_temp.check(
  not exists (select 1 from public.chat_file_grants where conversation_id = current_setting('test.h')::uuid)
  and not exists (select 1 from public.file_shares where source = 'chat' and grantee_id in (:C, :D)),
  'no chat share is left without a grant');
select pg_temp.check(
  (select count(*) from public.file_shares where source = 'manual') = 2,
  'both manual shares are still there');

-- the last member leaving deletes the group and takes its shares back too
set local role authenticated;
select pg_temp.login(:A);
select set_config('test.k', public.create_chat_group('K', array['bob@example.com'])::text, true);
select public.send_chat_message(current_setting('test.k')::uuid, null, :SECRET);
select public.transfer_chat_ownership(current_setting('test.k')::uuid, :B);
select public.leave_chat_group(current_setting('test.k')::uuid);
select pg_temp.login(:B);
select pg_temp.check(public.has_file_access(:SECRET, 'viewer'), 'the grant stays while the receiver is still in the group');
select public.leave_chat_group(current_setting('test.k')::uuid);
select pg_temp.check(not exists (select 1 from public.chat_conversations where id = current_setting('test.k')::uuid)
  and not public.has_file_access(:SECRET, 'viewer'),
  'the last member leaving deletes the group and takes the access back');

-- ---------------------------------------------------------------- anon
reset role;
select pg_temp.check(
  not has_function_privilege('anon', 'public.chat_revoke_file_grants(uuid, uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.chat_revoke_file_grants(uuid, uuid, uuid)', 'execute')
  and has_function_privilege('service_role', 'public.chat_revoke_file_grants(uuid, uuid, uuid)', 'execute'),
  'only the service role may call the internal revocation');
select pg_temp.check(
  not has_function_privilege('anon', 'public.send_chat_message(uuid, text, uuid, uuid, uuid[], uuid, text)', 'execute')
  and not has_function_privilege('anon', 'public.delete_chat_message(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.remove_chat_member(uuid, uuid)', 'execute')
  and not has_function_privilege('anon', 'public.leave_chat_group(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.delete_chat_group(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.share_file(uuid, text, text)', 'execute')
  and not has_function_privilege('anon', 'public.share_folder(uuid, text, text)', 'execute')
  and not has_function_privilege('anon', 'public.update_file_share(uuid, text)', 'execute')
  and has_function_privilege('authenticated', 'public.remove_chat_member(uuid, uuid)', 'execute'),
  'anon cannot call the redefined functions; signed-in users still can');
set local role anon;
select pg_temp.check(
  pg_temp.error_of(format('select public.chat_revoke_file_grants(%L)', current_setting('test.g'))) is not null,
  'anon cannot call chat_revoke_file_grants');
select pg_temp.check(
  pg_temp.error_of('select count(*) from public.chat_file_grants') is not null,
  'anon cannot read chat grants');

reset role;
rollback;
