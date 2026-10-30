-- Chat file grants: access given by sending a file in a chat is taken back
-- when it is no longer justified.
-- Run after 202608280031_ownership_safety.sql. Idempotent.
--
-- * file_shares.source tells a share made by sending a file in a chat
--   ('chat') from one made in the share dialog ('manual');
-- * chat_file_grants records which message gave which member access;
-- * removing a member, leaving, unsending a message and disbanding a group
--   delete the matching grants, then delete each 'chat' share that no other
--   grant in a conversation the person is still in justifies;
-- * manual shares are never touched; sharing or changing the role of a share
--   in the dialog makes it manual.
-- Rollback (chat shares then stay until revoked by hand):
--   drop function if exists public.chat_revoke_file_grants(uuid, uuid, uuid);
--   drop table if exists public.chat_file_grants;
--   alter table public.file_shares drop column if exists source;
--   (then re-run 202608280022_folder_owner_access.sql sections 3,
--    202608280006 update_file_share, 202608280027 member functions and
--    202608280029_chat_stickers.sql)

-- =============================================
-- Schema
-- =============================================
create table if not exists public.chat_file_grants (
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  file_id uuid not null references public.files(id) on delete cascade,
  grantee_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (message_id, grantee_id)
);

create index if not exists idx_chat_file_grants_file_grantee on public.chat_file_grants(file_id, grantee_id);
create index if not exists idx_chat_file_grants_conversation on public.chat_file_grants(conversation_id, grantee_id);

-- written and read only by the functions below
alter table public.chat_file_grants enable row level security;
revoke all on public.chat_file_grants from anon, authenticated;

-- The column and the backfill go together, so a re-run never turns a share
-- that was made manual since back into a chat share.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'file_shares' and column_name = 'source'
  ) then
    return;
  end if;

  alter table public.file_shares
    add column source text not null default 'manual' check (source in ('manual', 'chat'));

  -- every current member except the sender who has a share of a sent file;
  -- messages unsent before this migration count too, so their chat shares
  -- go when the member is removed, leaves or the group is disbanded
  insert into public.chat_file_grants (message_id, conversation_id, file_id, grantee_id, created_at)
  select msg.id, msg.conversation_id, msg.file_id, m.user_id, msg.created_at
  from public.chat_messages msg
  join public.chat_members m on m.conversation_id = msg.conversation_id and m.user_id <> msg.sender_id
  where msg.file_id is not null
    and msg.kind = 'message'
    and exists (select 1 from public.file_shares s where s.file_id = msg.file_id and s.grantee_id = m.user_id)
  on conflict (message_id, grantee_id) do nothing;

  -- a share is a chat share only when the sender made it while sending
  -- (send_chat_message writes it just before the message)
  update public.file_shares s
  set source = 'chat'
  where exists (
    select 1
    from public.chat_file_grants g
    join public.chat_messages msg on msg.id = g.message_id
    where g.file_id = s.file_id and g.grantee_id = s.grantee_id
      and s.granted_by = msg.sender_id
      and s.created_at between msg.created_at - interval '5 seconds' and msg.created_at + interval '5 seconds'
  );
end;
$$;

-- =============================================
-- Revocation (internal)
-- =============================================
-- Deletes the grants of a conversation (optionally of one person and/or one
-- message), then the 'chat' shares nothing else justifies any more.
create or replace function public.chat_revoke_file_grants(
  p_conversation_id uuid,
  p_grantee_id uuid default null,
  p_message_id uuid default null
)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_files uuid[];
  v_grantees uuid[];
begin
  with removed as (
    delete from public.chat_file_grants g
    where g.conversation_id = p_conversation_id
      and (p_grantee_id is null or g.grantee_id = p_grantee_id)
      and (p_message_id is null or g.message_id = p_message_id)
    returning g.file_id, g.grantee_id
  ),
  pairs as (
    select distinct file_id, grantee_id from removed
  )
  select array_agg(file_id), array_agg(grantee_id) into v_files, v_grantees from pairs;

  if v_files is null then
    return;
  end if;

  -- a separate statement, so it sees the grants deleted above as gone
  delete from public.file_shares s
  using unnest(v_files, v_grantees) as p(file_id, grantee_id)
  where s.file_id = p.file_id
    and s.grantee_id = p.grantee_id
    and s.source = 'chat'
    and not exists (
      select 1
      from public.chat_file_grants g
      join public.chat_members m on m.conversation_id = g.conversation_id and m.user_id = g.grantee_id
      where g.file_id = p.file_id and g.grantee_id = p.grantee_id
    );
end;
$$;

-- =============================================
-- Sending a file records the grant
-- =============================================
create or replace function public.send_chat_message(
  p_conversation_id uuid,
  p_body text default null,
  p_file_id uuid default null,
  p_reply_to uuid default null,
  p_mentions uuid[] default null,
  -- chosen by the sender's app so it can show the message before the reply
  p_id uuid default null,
  -- a sticker id (public/stickers/fluent/<id>.webp)
  p_sticker text default null
)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_body text := nullif(regexp_replace(coalesce(p_body, ''), '^\s+|\s+$', '', 'g'), '');
  v_file public.files%rowtype;
  v_mentions uuid[];
  v_recent integer;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.is_chat_member(p_conversation_id) then
    raise exception 'You are not a member of this conversation';
  end if;
  if v_body is null and p_file_id is null and p_sticker is null then
    raise exception 'Message is empty';
  end if;
  if length(v_body) > 4000 then
    raise exception 'Message is too long (max 4000 characters)';
  end if;
  if p_sticker is not null and p_sticker !~ '^[a-z0-9-]{1,80}$' then
    raise exception 'Unknown sticker';
  end if;
  if p_reply_to is not null and not exists (
    select 1 from public.chat_messages where id = p_reply_to and conversation_id = p_conversation_id and kind = 'message'
  ) then
    raise exception 'The message you reply to is not in this conversation';
  end if;

  select count(*) into v_recent from public.chat_messages
  where sender_id = auth.uid() and kind = 'message' and created_at > now() - interval '1 minute';
  if v_recent >= 30 then
    raise exception 'You are sending messages too quickly';
  end if;

  -- only members of this conversation can be mentioned
  select coalesce(array_agg(distinct u), '{}') into v_mentions
  from unnest(coalesce(p_mentions, '{}')) u
  where u <> auth.uid()
    and exists (select 1 from public.chat_members m where m.conversation_id = p_conversation_id and m.user_id = u);

  if p_file_id is not null then
    -- members are read twice below (shares, then grants): hold the conversation
    -- so a member removed meanwhile cannot keep a share without a grant
    perform 1 from public.chat_conversations where id = p_conversation_id for no key update;
    select * into v_file from public.files where id = p_file_id and deleted_at is null;
    if not found or not public.has_file_access(p_file_id, 'admin') then
      raise exception 'You can only send files you own or manage';
    end if;
    -- the other members can open the file; never downgrade an existing share
    insert into public.file_shares (file_id, grantee_id, role, granted_by, source)
    select p_file_id, m.user_id, 'viewer', auth.uid(), 'chat'
    from public.chat_members m
    where m.conversation_id = p_conversation_id and m.user_id <> auth.uid() and m.user_id <> v_file.owner_id
    on conflict (file_id, grantee_id) do nothing;
  end if;

  insert into public.chat_messages (id, conversation_id, sender_id, body, file_id, file_name, reply_to_id, mentions, meta)
  values (
    coalesce(p_id, gen_random_uuid()), p_conversation_id, auth.uid(), v_body, p_file_id, v_file.name, p_reply_to, v_mentions,
    case when p_sticker is not null then jsonb_build_object('sticker', p_sticker) end
  )
  returning chat_messages.id into v_id;

  if p_file_id is not null then
    -- which message gave whom access, so it can be taken back
    insert into public.chat_file_grants (message_id, conversation_id, file_id, grantee_id)
    select v_id, p_conversation_id, p_file_id, m.user_id
    from public.chat_members m
    where m.conversation_id = p_conversation_id and m.user_id <> auth.uid() and m.user_id <> v_file.owner_id
    on conflict (message_id, grantee_id) do nothing;
  end if;

  update public.chat_conversations set last_message_at = clock_timestamp() where id = p_conversation_id;
  -- my own message: everything up to it is read
  update public.chat_members set last_read_at = clock_timestamp()
  where conversation_id = p_conversation_id and user_id = auth.uid();
  return v_id;
end;
$$;

-- "Thu hồi": also removes its sticker, reactions, pins and the access it gave
create or replace function public.delete_chat_message(p_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_conversation uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  update public.chat_messages
  set deleted_at = clock_timestamp(), body = null, meta = null
  where id = p_id and sender_id = auth.uid() and deleted_at is null and kind = 'message'
  returning conversation_id into v_conversation;
  if not found then
    raise exception 'You can only remove your own messages';
  end if;
  update public.chat_reactions set emoji = null where message_id = p_id and emoji is not null;
  delete from public.chat_pins where message_id = p_id;
  -- waits for a send in progress, so its grants are seen
  perform 1 from public.chat_conversations where id = v_conversation for no key update;
  perform public.chat_revoke_file_grants(v_conversation, null, p_id);
end;
$$;

-- =============================================
-- Membership changes take the access back
-- =============================================
create or replace function public.remove_chat_member(p_conversation_id uuid, p_user_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_me text := public.chat_role(p_conversation_id);
  v_target text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  select m.role into v_target from public.chat_members m
  where m.conversation_id = p_conversation_id and m.user_id = p_user_id;
  if v_me is null or v_me = 'member'
     or not exists (select 1 from public.chat_conversations where id = p_conversation_id and kind = 'group') then
    raise exception 'Only the owner and admins can remove members';
  end if;
  if v_target is null then
    raise exception 'This person is not in the group';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'Use "Leave group" to leave';
  end if;
  if v_target = 'owner' or (v_target = 'admin' and v_me <> 'owner') then
    raise exception 'Only the owner can remove an admin, and nobody can remove the owner';
  end if;
  -- the removed person still receives the notice; it also updates (locks)
  -- the conversation, so a send in progress finishes before the revocation
  perform public.chat_system_message(p_conversation_id, jsonb_build_object('type', 'remove', 'user_id', p_user_id));
  delete from public.chat_members where conversation_id = p_conversation_id and user_id = p_user_id;
  perform public.chat_revoke_file_grants(p_conversation_id, p_user_id);
end;
$$;

-- the owner must hand the group over first, unless nobody else is left
create or replace function public.leave_chat_group(p_conversation_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_role text := public.chat_role(p_conversation_id);
  v_others integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if v_role is null or not exists (select 1 from public.chat_conversations where id = p_conversation_id and kind = 'group') then
    raise exception 'You are not in this group';
  end if;
  select count(*) into v_others from public.chat_members
  where conversation_id = p_conversation_id and user_id <> auth.uid();
  if v_others = 0 then
    -- the grants would go with the conversation; take the shares back first
    perform 1 from public.chat_conversations where id = p_conversation_id for update;
    perform public.chat_revoke_file_grants(p_conversation_id);
    delete from public.chat_conversations where id = p_conversation_id;
    return;
  end if;
  if v_role = 'owner' then
    raise exception 'Hand the group over to another member before leaving';
  end if;
  perform public.chat_system_message(p_conversation_id, jsonb_build_object('type', 'leave'));
  delete from public.chat_members where conversation_id = p_conversation_id and user_id = auth.uid();
  perform public.chat_revoke_file_grants(p_conversation_id, auth.uid());
end;
$$;

-- "Giải tán nhóm": the owner deletes the group for everyone
create or replace function public.delete_chat_group(p_conversation_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if public.chat_role(p_conversation_id) is distinct from 'owner'
     or not exists (select 1 from public.chat_conversations where id = p_conversation_id and kind = 'group') then
    raise exception 'Only the group owner can disband the group';
  end if;
  -- lock first: a send in progress finishes before its grants are revoked
  perform 1 from public.chat_conversations where id = p_conversation_id for update;
  perform public.chat_revoke_file_grants(p_conversation_id);
  delete from public.chat_conversations where id = p_conversation_id;
end;
$$;

-- =============================================
-- Shares made in the dialog are manual
-- =============================================
create or replace function public.share_file(p_file_id uuid, p_grantee_email text, p_role text)
returns public.file_shares
language plpgsql security definer
set search_path = public
as $$
declare
  fi public.files%rowtype;
  grantee uuid;
  caller_role text;
  new_share public.file_shares%rowtype;
  v_email text := lower(trim(coalesce(p_grantee_email, '')));
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if p_role not in ('viewer', 'editor', 'admin') then
    raise exception 'Invalid role';
  end if;
  if v_email = '' then
    raise exception 'Email is required';
  end if;

  select * into fi from public.files where id = p_file_id;
  if not found then
    raise exception 'File not found';
  end if;
  if fi.deleted_at is not null then
    raise exception 'Cannot share a deleted file';
  end if;

  if fi.owner_id = auth.uid() then
    caller_role := 'owner';
  elsif exists (
    select 1 from public.file_shares
    where file_id = p_file_id and grantee_id = auth.uid() and role = 'admin'
  ) then
    caller_role := 'admin';
  else
    caller_role := null;
  end if;
  perform public.share_resource_check(caller_role, p_role);

  select p.id into grantee
  from public.user_profiles p
  where lower(p.email) = v_email;
  if grantee is null then
    raise exception 'No registered user found for this email address';
  end if;
  if grantee = auth.uid() then
    raise exception 'You cannot share with yourself';
  end if;
  if grantee = fi.owner_id then
    raise exception 'The owner already has full access';
  end if;

  if caller_role <> 'owner' and exists (
    select 1 from public.file_shares
    where file_id = p_file_id and grantee_id = grantee and role = 'admin'
  ) then
    raise exception 'Only the owner can change an admin share';
  end if;

  -- a share first given by a chat becomes manual and survives its revocation
  insert into public.file_shares (file_id, grantee_id, role, granted_by, source)
  values (p_file_id, grantee, p_role, auth.uid(), 'manual')
  on conflict (file_id, grantee_id)
  do update set role = excluded.role, granted_by = excluded.granted_by, source = 'manual'
  returning * into new_share;

  return new_share;
end;
$$;

-- folder_shares has no source: chats never share folders
create or replace function public.share_folder(p_folder_id uuid, p_grantee_email text, p_role text)
returns public.folder_shares
language plpgsql security definer
set search_path = public
as $$
declare
  fo public.folders%rowtype;
  grantee uuid;
  caller_role text;
  new_share public.folder_shares%rowtype;
  v_email text := lower(trim(coalesce(p_grantee_email, '')));
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if p_role not in ('viewer', 'editor', 'admin') then
    raise exception 'Invalid role';
  end if;
  if v_email = '' then
    raise exception 'Email is required';
  end if;

  select * into fo from public.folders where id = p_folder_id;
  if not found then
    raise exception 'Folder not found';
  end if;
  if fo.deleted_at is not null then
    raise exception 'Cannot share a deleted folder';
  end if;

  if fo.owner_id = auth.uid() then
    caller_role := 'owner';
  elsif exists (
    select 1 from public.folder_shares
    where folder_id = p_folder_id and grantee_id = auth.uid() and role = 'admin'
  ) then
    caller_role := 'admin';
  else
    caller_role := null;
  end if;
  perform public.share_resource_check(caller_role, p_role);

  select p.id into grantee
  from public.user_profiles p
  where lower(p.email) = v_email;
  if grantee is null then
    raise exception 'No registered user found for this email address';
  end if;
  if grantee = auth.uid() then
    raise exception 'You cannot share with yourself';
  end if;
  if grantee = fo.owner_id then
    raise exception 'The owner already has full access';
  end if;

  if caller_role <> 'owner' and exists (
    select 1 from public.folder_shares
    where folder_id = p_folder_id and grantee_id = grantee and role = 'admin'
  ) then
    raise exception 'Only the owner can change an admin share';
  end if;

  insert into public.folder_shares (folder_id, grantee_id, role, granted_by)
  values (p_folder_id, grantee, p_role, auth.uid())
  on conflict (folder_id, grantee_id)
  do update set role = excluded.role, granted_by = excluded.granted_by
  returning * into new_share;

  return new_share;
end;
$$;

-- changing the role in the dialog is a manual decision too
create or replace function public.update_file_share(p_share_id uuid, p_role text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  share public.file_shares%rowtype;
  caller_role text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if p_role not in ('viewer', 'editor', 'admin') then
    raise exception 'Invalid role';
  end if;

  select * into share from public.file_shares where id = p_share_id;
  if not found then
    raise exception 'Share not found';
  end if;

  if exists (select 1 from public.files where id = share.file_id and owner_id = auth.uid()) then
    caller_role := 'owner';
  elsif exists (
    select 1 from public.file_shares
    where file_id = share.file_id and grantee_id = auth.uid() and role = 'admin'
  ) then
    caller_role := 'admin';
  else
    caller_role := null;
  end if;
  perform public.share_resource_check(caller_role, p_role);
  if caller_role <> 'owner' and share.role = 'admin' then
    raise exception 'Only the owner can change an admin share';
  end if;

  update public.file_shares set role = p_role, source = 'manual' where id = p_share_id;
end;
$$;

-- =============================================
-- Grants
-- =============================================
revoke all on function public.chat_revoke_file_grants(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.chat_revoke_file_grants(uuid, uuid, uuid) to service_role;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.send_chat_message(uuid, text, uuid, uuid, uuid[], uuid, text)',
    'public.delete_chat_message(uuid)',
    'public.remove_chat_member(uuid, uuid)',
    'public.leave_chat_group(uuid)',
    'public.delete_chat_group(uuid)',
    'public.share_file(uuid, text, text)',
    'public.share_folder(uuid, text, text)',
    'public.update_file_share(uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
