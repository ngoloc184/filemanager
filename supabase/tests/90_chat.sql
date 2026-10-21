-- Direct chat (202608280025_chat.sql).
-- Run with scripts/test-db.sh (plain PostgreSQL + supabase/tests stubs).
-- Everything runs in one transaction that is rolled back at the end.

\set ON_ERROR_STOP 1
\o /dev/null
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B '''bbbbbbbb-0000-0000-0000-00000000000b'''
\set C '''cccccccc-0000-0000-0000-00000000000c'''
\set FA '''f1000000-0000-0000-0000-0000000000a1'''
\set FA2 '''f1000000-0000-0000-0000-0000000000a2'''
\set FC '''f1000000-0000-0000-0000-0000000000c1'''

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

insert into auth.users (id, email) values
  (:A, 'alice@example.com'),
  (:B, 'bob@example.com'),
  (:C, 'carol@example.com');
insert into public.user_profiles (id, email) values
  (:A, 'alice@example.com'),
  (:B, 'bob@example.com'),
  (:C, 'carol@example.com')
on conflict (id) do nothing;

insert into public.files (id, owner_id, name, original_name, size, mime_type) values
  (:FA, :A, 'plan.pdf', 'plan.pdf', 100, 'application/pdf'),
  (:FA2, :A, 'budget.xlsx', 'budget.xlsx', 200, 'application/vnd.ms-excel'),
  (:FC, :C, 'carol.txt', 'carol.txt', 5, 'text/plain');
-- Bob can already edit budget.xlsx: sending it must not downgrade him
insert into public.file_shares (file_id, grantee_id, role, granted_by) values (:FA2, :B, 'editor', :A);

grant execute on function pg_temp.check(boolean, text) to authenticated;
grant execute on function pg_temp.login(uuid) to authenticated;
grant execute on function pg_temp.error_of(text) to authenticated;

set local role authenticated;

-- ---------------------------------------------------------------- start
select pg_temp.login(:A);
select set_config('test.conv', public.start_chat('Bob@Example.com')::text, true);
select pg_temp.check(public.start_chat('bob@example.com')::text = current_setting('test.conv'),
  'one conversation per pair (starting again returns it)');
select pg_temp.check(pg_temp.error_of($$select public.start_chat('nobody@example.com')$$) is not null,
  'unknown e-mails are rejected');
-- a chat with yourself: notes and files to self
select set_config('test.self', public.start_chat('alice@example.com')::text, true);
select pg_temp.check(public.start_chat('Alice@Example.com')::text = current_setting('test.self'),
  'one chat with yourself');
select pg_temp.check(current_setting('test.self') <> current_setting('test.conv'),
  'the chat with yourself is separate from the chat with Bob');
select public.send_chat_message(current_setting('test.self')::uuid, 'Ghi chú cho mình', :FA);
select pg_temp.check(
  (select other_id = :A and other_email = 'alice@example.com' and unread = 0 and last_file_name = 'plan.pdf'
   from public.list_chats() where id = current_setting('test.self')::uuid),
  'the chat with yourself is listed, with no unread messages');
select pg_temp.check((select count(*) from public.list_chat_messages(current_setting('test.self')::uuid)) = 1,
  'messages to yourself are readable');
reset role;
select pg_temp.check(not exists (select 1 from public.file_shares where file_id = :FA),
  'sending your own file to yourself creates no share');
set local role authenticated;
select pg_temp.login(:A);

select pg_temp.login(:B);
select pg_temp.check(public.start_chat('alice@example.com')::text = current_setting('test.conv'),
  'the other side finds the same conversation');

-- one transaction means one now(): pretend the chat was opened a minute ago
reset role;
update public.chat_members set last_read_at = now() - interval '1 minute';
set local role authenticated;

-- ---------------------------------------------------------------- messages
select pg_temp.login(:A);
select public.send_chat_message(current_setting('test.conv')::uuid, E'  Chào Bob\nGửi bạn kế hoạch  ', null);
select public.send_chat_message(current_setting('test.conv')::uuid, null, :FA);

select pg_temp.login(:B);
select pg_temp.check((select unread from public.list_chats() where id = current_setting('test.conv')::uuid) = 2,
  'the recipient sees two unread messages');
select pg_temp.check(public.chat_unread_count() = 2, 'unread total for the sidebar badge');
select pg_temp.check(
  (select body from public.list_chat_messages(current_setting('test.conv')::uuid) where file_id is null) = E'Chào Bob\nGửi bạn kế hoạch',
  'text keeps its line breaks, outer spaces trimmed');
select pg_temp.check(
  (select file_available and file_name = 'plan.pdf' from public.list_chat_messages(current_setting('test.conv')::uuid) where file_name is not null),
  'the recipient can open a file sent in the chat');
select pg_temp.check(public.has_file_access(:FA, 'viewer') and not public.has_file_access(:FA, 'editor'),
  'sending a file shares it as viewer only');
select pg_temp.check((select last_body from public.list_chats() where id = current_setting('test.conv')::uuid) is null
  and (select last_file_name from public.list_chats() where id = current_setting('test.conv')::uuid) = 'plan.pdf',
  'the list previews the last message');

select public.mark_chat_read(current_setting('test.conv')::uuid);
select pg_temp.check((select unread from public.list_chats() where id = current_setting('test.conv')::uuid) = 0,
  'reading clears the unread count');

select pg_temp.login(:A);
select public.send_chat_message(current_setting('test.conv')::uuid, 'Thêm bảng ngân sách', :FA2);
reset role;
select pg_temp.check((select role from public.file_shares where file_id = :FA2 and grantee_id = :B) = 'editor',
  'an existing editor share is not downgraded');
set local role authenticated;

-- ---------------------------------------------------------------- outsiders
select pg_temp.login(:C);
select pg_temp.check((select count(*) from public.chat_messages) = 0
  and (select count(*) from public.chat_conversations) = 0
  and (select count(*) from public.list_chats()) = 0,
  'outsiders see no conversations or messages (including chats with oneself)');
select pg_temp.check(pg_temp.error_of(format('select * from public.list_chat_messages(%L)', current_setting('test.self'))) is not null,
  'nobody else can read a chat with oneself');
select pg_temp.check(pg_temp.error_of(format('select * from public.list_chat_messages(%L)', current_setting('test.conv'))) is not null,
  'outsiders cannot list messages');
select pg_temp.check(pg_temp.error_of(format('select public.send_chat_message(%L, %L)', current_setting('test.conv'), 'hi')) is not null,
  'outsiders cannot post');
select pg_temp.check(pg_temp.error_of(format(
  'insert into public.chat_messages (conversation_id, sender_id, body) values (%L, %L, %L)',
  current_setting('test.conv'), 'cccccccc-0000-0000-0000-00000000000c', 'x')) is not null,
  'messages cannot be inserted directly');

-- ---------------------------------------------------------------- files you may not send
select pg_temp.login(:B);
select pg_temp.check(pg_temp.error_of(format('select public.send_chat_message(%L, null, %L)', current_setting('test.conv'), 'f1000000-0000-0000-0000-0000000000c1')) is not null,
  'cannot send a file you cannot manage');
select pg_temp.check(pg_temp.error_of(format('select public.send_chat_message(%L, null, %L)', current_setting('test.conv'), 'f1000000-0000-0000-0000-0000000000a1')) is not null,
  'a viewer cannot forward a file');
select pg_temp.check(pg_temp.error_of(format('select public.send_chat_message(%L, %L)', current_setting('test.conv'), '   ')) is not null,
  'empty messages are rejected');

-- ---------------------------------------------------------------- unsend
select pg_temp.login(:A);
select pg_temp.check(pg_temp.error_of(format('select public.delete_chat_message(%L)',
  (select id from public.list_chat_messages(current_setting('test.conv')::uuid) where body = 'Thêm bảng ngân sách'))) is null,
  'the sender can unsend');
select pg_temp.check(
  (select deleted_at is not null and body is null and file_id is null from public.list_chat_messages(current_setting('test.conv')::uuid)
   where file_name is null and deleted_at is not null limit 1),
  'an unsent message shows neither text nor file');
select pg_temp.login(:B);
select pg_temp.check(pg_temp.error_of(format('select public.delete_chat_message(%L)',
  (select id from public.list_chat_messages(current_setting('test.conv')::uuid) where file_name = 'plan.pdf'))) is not null,
  'nobody else can unsend');

-- ---------------------------------------------------------------- rate limit
select pg_temp.login(:A);
select public.send_chat_message(current_setting('test.conv')::uuid, 'spam ' || n, null) from generate_series(1, 26) n;
select pg_temp.check(pg_temp.error_of(format('select public.send_chat_message(%L, %L)', current_setting('test.conv'), 'one too many')) is not null,
  'more than 30 messages a minute are refused');

rollback;
