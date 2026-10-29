-- Group chats, roles, pins, reactions, replies, mentions and profiles
-- (202608280027_chat_groups.sql).
-- Run with scripts/test-db.sh (plain PostgreSQL + supabase/tests stubs).
-- Everything runs in one transaction that is rolled back at the end.

\set ON_ERROR_STOP 1
\o /dev/null
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B '''bbbbbbbb-0000-0000-0000-00000000000b'''
\set C '''cccccccc-0000-0000-0000-00000000000c'''
\set D '''dddddddd-0000-0000-0000-00000000000d'''
\set FA '''f2000000-0000-0000-0000-0000000000a1'''

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
  (:C, 'carol@example.com'),
  (:D, 'dave@example.com');
insert into public.user_profiles (id, email) values
  (:A, 'alice@example.com'),
  (:B, 'bob@example.com'),
  (:C, 'carol@example.com'),
  (:D, 'dave@example.com')
on conflict (id) do nothing;
insert into public.files (id, owner_id, name, original_name, size, mime_type) values
  (:FA, :A, 'notes.txt', 'notes.txt', 10, 'text/plain');

grant execute on function pg_temp.check(boolean, text) to authenticated;
grant execute on function pg_temp.login(uuid) to authenticated;
grant execute on function pg_temp.error_of(text) to authenticated;

set local role authenticated;

-- ---------------------------------------------------------------- profiles
select pg_temp.login(:A);
select public.update_my_profile('  Alice Nguyễn  ', 'users/aaaaaaaa-0000-0000-0000-00000000000a/avatar-1.webp');
select pg_temp.check(
  (select display_name = 'Alice Nguyễn' and avatar_path like 'users/aaaaaaaa%' from public.get_my_profile()),
  'a user sets their display name and avatar');
select pg_temp.check(
  pg_temp.error_of($$select public.update_my_profile('x', 'users/bbbbbbbb-0000-0000-0000-00000000000b/a.png')$$) is not null,
  'an avatar must live in the user''s own folder');
select pg_temp.check(
  pg_temp.error_of(format('select public.update_my_profile(%L, null)', repeat('x', 61))) is not null,
  'display names are at most 60 characters');
select pg_temp.check(public.can_write_public_image('users/aaaaaaaa-0000-0000-0000-00000000000a/a.png')
  and not public.can_write_public_image('users/bbbbbbbb-0000-0000-0000-00000000000b/a.png')
  and not public.can_write_public_image('users/aaaaaaaa-0000-0000-0000-00000000000a/../x.png'),
  'users may only upload pictures into their own folder');

reset role;
insert into storage.buckets (id, name, public) values ('public-images', 'public-images', true) on conflict (id) do nothing;
insert into storage.objects (bucket_id, name)
select 'public-images', 'users/aaaaaaaa-0000-0000-0000-00000000000a/old-' || n || '.webp' from generate_series(1, 19) n;
set local role authenticated;
select pg_temp.login(:A);
select pg_temp.check(public.can_upload_public_image('users/aaaaaaaa-0000-0000-0000-00000000000a/new.webp'),
  'a 20th picture can be uploaded');
reset role;
insert into storage.objects (bucket_id, name) values ('public-images', 'users/aaaaaaaa-0000-0000-0000-00000000000a/old-20.webp');
set local role authenticated;
select pg_temp.login(:A);
select pg_temp.check(not public.can_upload_public_image('users/aaaaaaaa-0000-0000-0000-00000000000a/new.webp')
  and public.can_write_public_image('users/aaaaaaaa-0000-0000-0000-00000000000a/old-1.webp'),
  'at most 20 pictures per folder, while old ones can still be removed');

-- ---------------------------------------------------------------- create
select pg_temp.check(
  pg_temp.error_of($$select public.create_chat_group('Team', array['nobody@example.com'])$$) like '%nobody@example.com%',
  'unknown e-mails are named in the error');
select pg_temp.check(
  pg_temp.error_of($$select public.create_chat_group('   ', array['bob@example.com'])$$) is not null,
  'a group needs a name');
select pg_temp.check(
  pg_temp.error_of($$select public.create_chat_group('Solo', array['alice@example.com'])$$) is not null,
  'a group needs at least one other member');
select set_config('test.g', public.create_chat_group(' Dự án Cá Voi ', array['Bob@Example.com', 'carol@example.com'])::text, true);
select pg_temp.check(
  (select kind = 'group' and title = 'Dự án Cá Voi' and my_role = 'owner' and member_count = 3 and last_kind = 'system'
   from public.list_chats() where id = current_setting('test.g')::uuid),
  'the creator owns the new group with its members');
select pg_temp.check(
  (select count(*) from public.list_chat_members(current_setting('test.g')::uuid)) = 3
  and (select role from public.list_chat_members(current_setting('test.g')::uuid) where user_id = :A) = 'owner',
  'members are listed with their roles');

-- ---------------------------------------------------------------- messages
select public.send_chat_message(current_setting('test.g')::uuid, 'Chào cả nhóm @Bob', null, null, array[:B, :D]::uuid[], 'e0000000-0000-0000-0000-000000000001');
select pg_temp.check(
  (select mentions = array[:B]::uuid[] from public.list_chat_messages(current_setting('test.g')::uuid)
   where id = 'e0000000-0000-0000-0000-000000000001'),
  'the sender''s message id is kept and only members can be mentioned');
select public.send_chat_message(current_setting('test.g')::uuid, null, :FA);

select pg_temp.login(:B);
select pg_temp.check(
  (select unread from public.list_chats() where id = current_setting('test.g')::uuid) = 2,
  'system messages do not count as unread');
select pg_temp.check(public.has_file_access(:FA, 'viewer'), 'a file sent to a group is shared with every member');
select public.send_chat_message(current_setting('test.g')::uuid, 'Trả lời Alice', null, 'e0000000-0000-0000-0000-000000000001');
select pg_temp.check(
  (select reply_body = 'Chào cả nhóm @Bob' and reply_sender_id = :A
   from public.list_chat_messages(current_setting('test.g')::uuid) where body = 'Trả lời Alice'),
  'a reply shows the message it answers');

-- stickers
select set_config('test.sticker', public.send_chat_message(current_setting('test.g')::uuid, null, null, null, null, null, 'thumbs-up')::text, true);
select pg_temp.check(
  (select meta ->> 'sticker' = 'thumbs-up' and body is null from public.list_chat_messages(current_setting('test.g')::uuid)
   where id = current_setting('test.sticker')::uuid),
  'a sticker message keeps its sticker id');
select pg_temp.check(
  pg_temp.error_of(format('select public.send_chat_message(%L, null, null, null, null, null, %L)', current_setting('test.g'), '../evil')) is not null,
  'unknown sticker ids are refused');
select public.delete_chat_message(current_setting('test.sticker')::uuid);
select pg_temp.check(
  (select meta is null and deleted_at is not null from public.list_chat_messages(current_setting('test.g')::uuid)
   where id = current_setting('test.sticker')::uuid),
  'an unsent sticker is gone');

-- reactions: one per person, the same emoji again removes it
select public.react_chat_message('e0000000-0000-0000-0000-000000000001', '❤️');
select public.react_chat_message('e0000000-0000-0000-0000-000000000001', '😆');
select pg_temp.check(
  (select reactions = jsonb_build_array(jsonb_build_object('emoji', '😆', 'user_id', :B))
   from public.list_chat_messages(current_setting('test.g')::uuid) where id = 'e0000000-0000-0000-0000-000000000001'),
  'a second reaction replaces the first');
select pg_temp.check(public.react_chat_message('e0000000-0000-0000-0000-000000000001', '😆') is null,
  'reacting with the same emoji again removes it');
select pg_temp.check(
  (select reactions = '[]'::jsonb from public.list_chat_messages(current_setting('test.g')::uuid) where id = 'e0000000-0000-0000-0000-000000000001')
  and (select count(*) from public.chat_reactions where message_id = 'e0000000-0000-0000-0000-000000000001') = 1,
  'a removed reaction is hidden (kept as an update so Realtime never needs a DELETE)');
select pg_temp.check(public.react_chat_message('e0000000-0000-0000-0000-000000000001', '👍') = '👍',
  'reacting again after removing works');
select pg_temp.check(
  pg_temp.error_of($$select public.react_chat_message('e0000000-0000-0000-0000-000000000001', '💩')$$) is not null,
  'only the offered reactions are accepted');

-- ---------------------------------------------------------------- pins
select public.pin_chat_message('e0000000-0000-0000-0000-000000000001');
select pg_temp.check((select count(*) from public.list_chat_pins(current_setting('test.g')::uuid)) = 1,
  'a member pins a message');
select public.pin_chat_message(id) from public.list_chat_messages(current_setting('test.g')::uuid)
where kind = 'message' and deleted_at is null and id <> 'e0000000-0000-0000-0000-000000000001';
select pg_temp.check((select count(*) from public.list_chat_pins(current_setting('test.g')::uuid)) = 3,
  'three messages can be pinned');
select pg_temp.login(:A);
select set_config('test.extra', public.send_chat_message(current_setting('test.g')::uuid, 'Tin thứ tư')::text, true);
select pg_temp.check(
  pg_temp.error_of(format('select public.pin_chat_message(%L)', current_setting('test.extra'))) like '%up to 3%',
  'a fourth pin is refused');

-- ---------------------------------------------------------------- settings
select pg_temp.login(:C);
select public.rename_chat_group(current_setting('test.g')::uuid, 'Nhóm mới');
select public.set_chat_group_background(current_setting('test.g')::uuid, 'preset:ocean');
select pg_temp.check(
  (select title = 'Nhóm mới' and background = 'preset:ocean' from public.list_chats() where id = current_setting('test.g')::uuid),
  'any member renames the group and sets its background');
select pg_temp.check(
  pg_temp.error_of(format('select public.set_chat_group_background(%L, %L)', current_setting('test.g'), 'image:groups/other/x.png')) is not null,
  'a background image must belong to the group');
select pg_temp.check(
  pg_temp.error_of(format('select public.set_chat_group_admin_only(%L, true)', current_setting('test.g'))) is not null,
  'only the owner restricts the settings');

select pg_temp.login(:A);
select public.set_chat_group_admin_only(current_setting('test.g')::uuid, true);
select pg_temp.login(:C);
select pg_temp.check(
  pg_temp.error_of(format('select public.rename_chat_group(%L, %L)', current_setting('test.g'), 'Hacked')) is not null
  and pg_temp.error_of(format('select public.unpin_chat_message(%L)', 'e0000000-0000-0000-0000-000000000001')) is not null
  and not public.can_write_public_image('groups/' || current_setting('test.g') || '/bg.png'),
  'with admin_only, plain members cannot rename, unpin or upload pictures');

-- ---------------------------------------------------------------- members and roles
select pg_temp.check(
  pg_temp.error_of(format('select public.add_chat_members(%L, array[%L])', current_setting('test.g'), 'dave@example.com')) is not null,
  'plain members cannot add people');
select pg_temp.login(:A);
select pg_temp.check(public.add_chat_members(current_setting('test.g')::uuid, array['dave@example.com', 'bob@example.com']) = 1,
  'the owner adds a member (existing members are skipped)');
select public.set_chat_member_role(current_setting('test.g')::uuid, :B, 'admin');
select pg_temp.login(:B);
select public.rename_chat_group(current_setting('test.g')::uuid, 'Nhóm của Bob');
select public.remove_chat_member(current_setting('test.g')::uuid, :D);
select pg_temp.check(
  (select count(*) from public.list_chat_members(current_setting('test.g')::uuid)) = 3,
  'an admin can rename with admin_only on and remove a member');
select pg_temp.check(
  pg_temp.error_of(format('select public.remove_chat_member(%L, %L)', current_setting('test.g'), 'aaaaaaaa-0000-0000-0000-00000000000a')) is not null,
  'nobody removes the owner');
select pg_temp.check(
  pg_temp.error_of(format('select public.set_chat_member_role(%L, %L, %L)', current_setting('test.g'), 'cccccccc-0000-0000-0000-00000000000c', 'admin')) is not null,
  'only the owner appoints admins');

select pg_temp.login(:D);
select pg_temp.check((select count(*) from public.list_chats() where id = current_setting('test.g')::uuid) = 0
  and pg_temp.error_of(format('select * from public.list_chat_messages(%L)', current_setting('test.g'))) is not null,
  'a removed member no longer sees the group');

select pg_temp.login(:A);
select pg_temp.check(
  pg_temp.error_of(format('select public.leave_chat_group(%L)', current_setting('test.g'))) like '%Hand the group over%',
  'the owner must hand the group over before leaving');
select public.transfer_chat_ownership(current_setting('test.g')::uuid, :C);
select public.leave_chat_group(current_setting('test.g')::uuid);
select pg_temp.login(:C);
select pg_temp.check(
  (select my_role = 'owner' and member_count = 2 from public.list_chats() where id = current_setting('test.g')::uuid),
  'the new owner keeps the group after the old one leaves');
select pg_temp.check(
  (select count(*) from public.list_chat_messages(current_setting('test.g')::uuid) where kind = 'system') >= 8,
  'group changes are recorded as system messages');

-- outsiders and direct writes
select pg_temp.login(:D);
select pg_temp.check((select count(*) from public.chat_reactions) = 0 and (select count(*) from public.chat_pins) = 0,
  'outsiders see no reactions or pins');
select pg_temp.check(pg_temp.error_of(format(
  'insert into public.chat_pins (conversation_id, message_id) values (%L, %L)',
  current_setting('test.g'), 'e0000000-0000-0000-0000-000000000001')) is not null,
  'pins cannot be written directly');

select pg_temp.login(:C);
select public.delete_chat_group(current_setting('test.g')::uuid);
select pg_temp.check((select count(*) from public.list_chats() where id = current_setting('test.g')::uuid) = 0,
  'the owner disbands the group');

-- direct chats still work as before
select pg_temp.login(:A);
select set_config('test.d', public.start_chat('bob@example.com')::text, true);
select pg_temp.check(
  (select kind = 'direct' and other_id = :B and title is null from public.list_chats() where id = current_setting('test.d')::uuid),
  'direct chats are listed with the other person');

rollback;
