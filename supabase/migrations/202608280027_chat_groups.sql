-- Group chats and richer messages, plus user profiles (display name, avatar).
-- Run after 202608280026_user_preferences.sql. Idempotent.
--
-- * a conversation is 'direct' (a pair, as before) or a 'group' with a name,
--   an avatar, a background and members with roles: owner ("trưởng nhóm"),
--   admin ("phó nhóm") and member;
-- * owners and admins add/remove members; only the owner appoints admins,
--   hands over ownership or disbands the group; renaming, the avatar, the
--   background and pins are open to every member unless the owner restricts
--   them to owners and admins (admin_only);
-- * messages can reply to a message, mention members and carry reactions;
--   up to 3 messages per conversation can be pinned; group changes are
--   recorded as system messages;
-- * profile pictures, group avatars and group backgrounds are stored in the
--   public bucket 'public-images' under users/<user id>/ and groups/<id>/;
-- * typing indicators use Realtime broadcast on the private topic
--   "typing:<conversation id>" (policies below, applied when Realtime exists).
-- Rollback (data loss for groups, pins and reactions):
--   drop table if exists public.chat_reactions, public.chat_pins;
--   delete from public.chat_conversations where kind = 'group';
--   alter table public.chat_messages drop column kind, drop column meta, drop column mentions, drop column reply_to_id;
--   alter table public.chat_members drop column role, drop column joined_at;
--   alter table public.chat_conversations drop column kind, drop column title, drop column avatar_path,
--     drop column background, drop column admin_only, drop column created_by;
--   alter table public.user_profiles drop column display_name, drop column avatar_path;
--   (then re-run 202608280025_chat.sql for the previous functions)

-- =============================================
-- Profiles
-- =============================================
alter table public.user_profiles add column if not exists display_name text;
alter table public.user_profiles add column if not exists avatar_path text;
alter table public.user_profiles drop constraint if exists user_profiles_display_name_check;
alter table public.user_profiles add constraint user_profiles_display_name_check
  check (display_name is null or length(display_name) between 1 and 60);

-- =============================================
-- Conversations, members, messages
-- =============================================
alter table public.chat_conversations add column if not exists kind text not null default 'direct';
alter table public.chat_conversations add column if not exists title text;
alter table public.chat_conversations add column if not exists avatar_path text;
alter table public.chat_conversations add column if not exists background text;
alter table public.chat_conversations add column if not exists admin_only boolean not null default false;
alter table public.chat_conversations add column if not exists created_by uuid references auth.users(id) on delete set null;
alter table public.chat_conversations alter column user_a drop not null;
alter table public.chat_conversations alter column user_b drop not null;
alter table public.chat_conversations drop constraint if exists chat_conversations_kind_check;
alter table public.chat_conversations add constraint chat_conversations_kind_check check (
  (kind = 'direct' and user_a is not null and user_b is not null and title is null)
  or (kind = 'group' and user_a is null and user_b is null and length(title) between 1 and 100)
);

alter table public.chat_members add column if not exists role text not null default 'member';
alter table public.chat_members add column if not exists joined_at timestamptz not null default now();
alter table public.chat_members drop constraint if exists chat_members_role_check;
alter table public.chat_members add constraint chat_members_role_check check (role in ('owner', 'admin', 'member'));

alter table public.chat_messages add column if not exists kind text not null default 'message';
alter table public.chat_messages add column if not exists meta jsonb;
alter table public.chat_messages add column if not exists mentions uuid[] not null default '{}';
alter table public.chat_messages add column if not exists reply_to_id uuid references public.chat_messages(id) on delete set null;
alter table public.chat_messages drop constraint if exists chat_messages_kind_check;
alter table public.chat_messages add constraint chat_messages_kind_check check (kind in ('message', 'system'));
-- system messages carry no text: what happened is in meta
alter table public.chat_messages drop constraint if exists chat_messages_check;
alter table public.chat_messages drop constraint if exists chat_messages_has_content;
alter table public.chat_messages add constraint chat_messages_has_content
  check (kind = 'system' or deleted_at is not null or body is not null or file_name is not null);

create table if not exists public.chat_reactions (
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  -- copied from the message: Realtime filters and row-level security use it
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- null = removed: an UPDATE instead of a DELETE, because Realtime cannot
  -- filter DELETE events or check row-level security for them
  emoji text check (emoji is null or emoji in ('👍', '❤️', '😆', '😮', '😭', '😡')),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);
alter table public.chat_reactions alter column emoji drop not null;
create index if not exists idx_chat_reactions_conversation on public.chat_reactions(conversation_id);
-- foreign keys used by cascades and lookups
create index if not exists idx_chat_messages_reply_to on public.chat_messages(reply_to_id) where reply_to_id is not null;

create table if not exists public.chat_pins (
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  pinned_by uuid references auth.users(id) on delete set null,
  pinned_at timestamptz not null default clock_timestamp(),
  primary key (conversation_id, message_id)
);

create index if not exists idx_chat_pins_message on public.chat_pins(message_id);

alter table public.chat_reactions enable row level security;
alter table public.chat_pins enable row level security;

drop policy if exists "chat_reactions_select" on public.chat_reactions;
create policy "chat_reactions_select"
  on public.chat_reactions for select to authenticated
  using (public.is_chat_member(conversation_id));

drop policy if exists "chat_pins_select" on public.chat_pins;
create policy "chat_pins_select"
  on public.chat_pins for select to authenticated
  using (public.is_chat_member(conversation_id));

revoke insert, update, delete on public.chat_reactions from anon, authenticated;
revoke insert, update, delete on public.chat_pins from anon, authenticated;

-- Realtime: reactions and pins. Group changes (name, background, members)
-- reach clients as system messages, so chat_conversations is not published
-- (its last_message_at changes with every message).
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['chat_reactions', 'chat_pins'] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end;
$$;

-- =============================================
-- Helpers
-- =============================================
-- the caller's role in a conversation (null when not a member)
create or replace function public.chat_role(p_conversation_id uuid)
returns text
language sql stable security definer
set search_path = public
as $$
  select m.role from public.chat_members m
  where m.conversation_id = p_conversation_id and m.user_id = auth.uid();
$$;

-- may the caller change the group's name, avatar, background and pins?
create or replace function public.can_edit_chat_group(p_conversation_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.chat_conversations c
    join public.chat_members m on m.conversation_id = c.id and m.user_id = auth.uid()
    where c.id = p_conversation_id
      and c.kind = 'group'
      and (not c.admin_only or m.role in ('owner', 'admin'))
  );
$$;

-- pins: any member of a direct chat; in a group as for other group settings
create or replace function public.can_pin_chat(p_conversation_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select public.is_chat_member(p_conversation_id)
    and coalesce((select c.kind = 'direct' from public.chat_conversations c where c.id = p_conversation_id), false)
    or public.can_edit_chat_group(p_conversation_id);
$$;

-- records a group change; internal (not callable by clients)
create or replace function public.chat_system_message(p_conversation_id uuid, p_meta jsonb)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.chat_messages (conversation_id, sender_id, kind, meta)
  values (p_conversation_id, auth.uid(), 'system', p_meta);
  update public.chat_conversations set last_message_at = clock_timestamp() where id = p_conversation_id;
end;
$$;

-- users for a list of e-mails; raises when one is unknown
create or replace function public.chat_users_by_email(p_emails text[])
returns uuid[]
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_emails text[];
  v_ids uuid[];
  v_missing text[];
begin
  select coalesce(array_agg(distinct lower(trim(e))), '{}') into v_emails
  from unnest(coalesce(p_emails, '{}')) e where trim(e) <> '';
  select coalesce(array_agg(p.id), '{}') into v_ids
  from public.user_profiles p where lower(p.email) = any (v_emails);
  select coalesce(array_agg(e), '{}') into v_missing
  from unnest(v_emails) e
  where not exists (select 1 from public.user_profiles p where lower(p.email) = e);
  if cardinality(v_missing) > 0 then
    raise exception 'No registered user found for: %', array_to_string(v_missing, ', ');
  end if;
  return v_ids;
end;
$$;

create or replace function public.chat_valid_file_name(p_name text)
returns boolean
language sql immutable
as $$
  select p_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$';
$$;

-- =============================================
-- Profiles
-- =============================================
create or replace function public.get_my_profile()
returns table (id uuid, email text, display_name text, avatar_path text)
language sql stable security definer
set search_path = public
as $$
  select p.id, p.email, p.display_name, p.avatar_path
  from public.user_profiles p where p.id = auth.uid();
$$;

create or replace function public.update_my_profile(p_display_name text, p_avatar_path text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_name text := nullif(regexp_replace(coalesce(p_display_name, ''), '^\s+|\s+$', '', 'g'), '');
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if length(v_name) > 60 then
    raise exception 'Display name is too long (max 60 characters)';
  end if;
  if p_avatar_path is not null and not (
    split_part(p_avatar_path, '/', 1) = 'users'
    and split_part(p_avatar_path, '/', 2) = auth.uid()::text
    and array_length(string_to_array(p_avatar_path, '/'), 1) = 3
    and public.chat_valid_file_name(split_part(p_avatar_path, '/', 3))
  ) then
    raise exception 'Invalid avatar';
  end if;
  update public.user_profiles
  set display_name = v_name, avatar_path = p_avatar_path
  where id = auth.uid();
  if not found then
    raise exception 'Profile not found';
  end if;
end;
$$;

-- =============================================
-- Groups
-- =============================================
create or replace function public.create_chat_group(p_title text, p_emails text[])
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_title text := nullif(regexp_replace(coalesce(p_title, ''), '^\s+|\s+$', '', 'g'), '');
  v_users uuid[];
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if v_title is null then
    raise exception 'Group name is required';
  end if;
  if length(v_title) > 100 then
    raise exception 'Group name is too long (max 100 characters)';
  end if;
  v_users := array(select u from unnest(public.chat_users_by_email(p_emails)) u where u <> auth.uid());
  if cardinality(v_users) = 0 then
    raise exception 'Add at least one other member';
  end if;
  if cardinality(v_users) > 199 then
    raise exception 'A group can have at most 200 members';
  end if;

  insert into public.chat_conversations (kind, title, created_by)
  values ('group', v_title, auth.uid())
  returning id into v_id;
  insert into public.chat_members (conversation_id, user_id, role) values (v_id, auth.uid(), 'owner');
  insert into public.chat_members (conversation_id, user_id, role)
  select v_id, u, 'member' from unnest(v_users) u;
  perform public.chat_system_message(v_id, jsonb_build_object('type', 'create', 'title', v_title));
  return v_id;
end;
$$;

create or replace function public.rename_chat_group(p_conversation_id uuid, p_title text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_title text := nullif(regexp_replace(coalesce(p_title, ''), '^\s+|\s+$', '', 'g'), '');
begin
  if not public.can_edit_chat_group(p_conversation_id) then
    raise exception 'You cannot change this group';
  end if;
  if v_title is null or length(v_title) > 100 then
    raise exception 'Group name must be 1 to 100 characters';
  end if;
  update public.chat_conversations set title = v_title where id = p_conversation_id;
  perform public.chat_system_message(p_conversation_id, jsonb_build_object('type', 'rename', 'title', v_title));
end;
$$;

create or replace function public.set_chat_group_avatar(p_conversation_id uuid, p_avatar_path text)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not public.can_edit_chat_group(p_conversation_id) then
    raise exception 'You cannot change this group';
  end if;
  if p_avatar_path is not null and not (
    p_avatar_path like 'groups/' || p_conversation_id::text || '/%'
    and array_length(string_to_array(p_avatar_path, '/'), 1) = 3
    and public.chat_valid_file_name(split_part(p_avatar_path, '/', 3))
  ) then
    raise exception 'Invalid group picture';
  end if;
  update public.chat_conversations set avatar_path = p_avatar_path where id = p_conversation_id;
  perform public.chat_system_message(p_conversation_id, jsonb_build_object('type', 'avatar'));
end;
$$;

-- background: null (default), 'preset:<key>' or 'image:groups/<id>/<file>'
create or replace function public.set_chat_group_background(p_conversation_id uuid, p_background text)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not public.can_edit_chat_group(p_conversation_id) then
    raise exception 'You cannot change this group';
  end if;
  if p_background is not null
     and p_background !~ '^preset:[a-z0-9-]{1,32}$'
     and not (
       p_background like 'image:groups/' || p_conversation_id::text || '/%'
       and array_length(string_to_array(p_background, '/'), 1) = 3
       and public.chat_valid_file_name(split_part(p_background, '/', 3))
     ) then
    raise exception 'Invalid background';
  end if;
  update public.chat_conversations set background = p_background where id = p_conversation_id;
  perform public.chat_system_message(p_conversation_id, jsonb_build_object('type', 'background'));
end;
$$;

-- only the owner: restrict name, avatar, background and pins to owner/admins
create or replace function public.set_chat_group_admin_only(p_conversation_id uuid, p_admin_only boolean)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if public.chat_role(p_conversation_id) is distinct from 'owner'
     or not exists (select 1 from public.chat_conversations where id = p_conversation_id and kind = 'group') then
    raise exception 'Only the group owner can change this setting';
  end if;
  update public.chat_conversations set admin_only = coalesce(p_admin_only, false) where id = p_conversation_id;
  perform public.chat_system_message(p_conversation_id, jsonb_build_object('type', 'admin_only', 'value', coalesce(p_admin_only, false)));
end;
$$;

create or replace function public.add_chat_members(p_conversation_id uuid, p_emails text[])
returns integer
language plpgsql security definer
set search_path = public
as $$
declare
  v_new uuid[];
  v_count integer;
begin
  if public.chat_role(p_conversation_id) not in ('owner', 'admin')
     or public.chat_role(p_conversation_id) is null
     or not exists (select 1 from public.chat_conversations where id = p_conversation_id and kind = 'group') then
    raise exception 'Only the owner and admins can add members';
  end if;
  v_new := array(
    select u from unnest(public.chat_users_by_email(p_emails)) u
    where not exists (select 1 from public.chat_members m where m.conversation_id = p_conversation_id and m.user_id = u)
  );
  if cardinality(v_new) = 0 then
    return 0;
  end if;
  select count(*) into v_count from public.chat_members where conversation_id = p_conversation_id;
  if v_count + cardinality(v_new) > 200 then
    raise exception 'A group can have at most 200 members';
  end if;
  insert into public.chat_members (conversation_id, user_id, role)
  select p_conversation_id, u, 'member' from unnest(v_new) u;
  perform public.chat_system_message(p_conversation_id, jsonb_build_object('type', 'add', 'user_ids', to_jsonb(v_new)));
  return cardinality(v_new);
end;
$$;

create or replace function public.remove_chat_member(p_conversation_id uuid, p_user_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_me text := public.chat_role(p_conversation_id);
  v_target text;
begin
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
  delete from public.chat_members where conversation_id = p_conversation_id and user_id = p_user_id;
  perform public.chat_system_message(p_conversation_id, jsonb_build_object('type', 'remove', 'user_id', p_user_id));
end;
$$;

-- the owner appoints or dismisses admins ('admin' | 'member')
create or replace function public.set_chat_member_role(p_conversation_id uuid, p_user_id uuid, p_role text)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if public.chat_role(p_conversation_id) is distinct from 'owner' then
    raise exception 'Only the group owner can appoint admins';
  end if;
  if p_role not in ('admin', 'member') then
    raise exception 'Invalid role';
  end if;
  update public.chat_members set role = p_role
  where conversation_id = p_conversation_id and user_id = p_user_id and role <> 'owner';
  if not found then
    raise exception 'This person is not a member you can change';
  end if;
  perform public.chat_system_message(p_conversation_id, jsonb_build_object('type', 'role', 'user_id', p_user_id, 'role', p_role));
end;
$$;

create or replace function public.transfer_chat_ownership(p_conversation_id uuid, p_user_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if public.chat_role(p_conversation_id) is distinct from 'owner' then
    raise exception 'Only the group owner can hand over the group';
  end if;
  if p_user_id = auth.uid()
     or not exists (select 1 from public.chat_members where conversation_id = p_conversation_id and user_id = p_user_id) then
    raise exception 'Choose another member of the group';
  end if;
  update public.chat_members set role = 'admin' where conversation_id = p_conversation_id and user_id = auth.uid();
  update public.chat_members set role = 'owner' where conversation_id = p_conversation_id and user_id = p_user_id;
  perform public.chat_system_message(p_conversation_id, jsonb_build_object('type', 'owner', 'user_id', p_user_id));
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
  if v_role is null or not exists (select 1 from public.chat_conversations where id = p_conversation_id and kind = 'group') then
    raise exception 'You are not in this group';
  end if;
  select count(*) into v_others from public.chat_members
  where conversation_id = p_conversation_id and user_id <> auth.uid();
  if v_others = 0 then
    delete from public.chat_conversations where id = p_conversation_id;
    return;
  end if;
  if v_role = 'owner' then
    raise exception 'Hand the group over to another member before leaving';
  end if;
  perform public.chat_system_message(p_conversation_id, jsonb_build_object('type', 'leave'));
  delete from public.chat_members where conversation_id = p_conversation_id and user_id = auth.uid();
end;
$$;

-- "Giải tán nhóm": the owner deletes the group for everyone
create or replace function public.delete_chat_group(p_conversation_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if public.chat_role(p_conversation_id) is distinct from 'owner'
     or not exists (select 1 from public.chat_conversations where id = p_conversation_id and kind = 'group') then
    raise exception 'Only the group owner can disband the group';
  end if;
  delete from public.chat_conversations where id = p_conversation_id;
end;
$$;

create or replace function public.list_chat_members(p_conversation_id uuid)
returns table (
  user_id uuid,
  email text,
  display_name text,
  avatar_path text,
  role text,
  last_read_at timestamptz,
  joined_at timestamptz
)
language plpgsql stable security definer
set search_path = public
as $$
begin
  if not public.is_chat_member(p_conversation_id) then
    raise exception 'You are not a member of this conversation';
  end if;
  return query
  select m.user_id, p.email, p.display_name, p.avatar_path, m.role, m.last_read_at, m.joined_at
  from public.chat_members m
  left join public.user_profiles p on p.id = m.user_id
  where m.conversation_id = p_conversation_id
  order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, m.joined_at, m.user_id;
end;
$$;

-- =============================================
-- Conversations of the caller (direct and groups)
-- =============================================
drop function if exists public.list_chats();
create function public.list_chats()
returns table (
  id uuid,
  kind text,
  title text,
  avatar_path text,
  background text,
  admin_only boolean,
  my_role text,
  member_count integer,
  other_id uuid,
  other_email text,
  other_name text,
  other_avatar text,
  last_message_at timestamptz,
  last_body text,
  last_file_name text,
  last_sender_id uuid,
  last_sender_name text,
  last_kind text,
  last_meta jsonb,
  last_deleted boolean,
  unread integer,
  other_last_read_at timestamptz
)
language sql stable security definer
set search_path = public
as $$
  select
    c.id,
    c.kind,
    c.title,
    c.avatar_path,
    c.background,
    c.admin_only,
    me.role,
    (select count(*)::integer from public.chat_members x where x.conversation_id = c.id),
    o.user_id,
    op.email,
    op.display_name,
    op.avatar_path,
    c.last_message_at,
    lm.body,
    lm.file_name,
    lm.sender_id,
    coalesce(lp.display_name, lp.email),
    lm.kind,
    lm.meta,
    lm.deleted_at is not null,
    (
      select count(*)::integer from public.chat_messages x
      where x.conversation_id = c.id
        and x.kind = 'message'
        and x.sender_id <> auth.uid()
        and x.deleted_at is null
        and x.created_at > me.last_read_at
    ),
    o.last_read_at
  from public.chat_members me
  join public.chat_conversations c on c.id = me.conversation_id
  -- direct chats: the other member, or the caller in a chat with themselves
  left join lateral (
    select m2.user_id, m2.last_read_at
    from public.chat_members m2
    where m2.conversation_id = c.id and c.kind = 'direct'
    order by (m2.user_id = me.user_id), m2.user_id
    limit 1
  ) o on true
  left join public.user_profiles op on op.id = o.user_id
  left join lateral (
    select m.body, m.file_name, m.sender_id, m.deleted_at, m.kind, m.meta
    from public.chat_messages m
    where m.conversation_id = c.id
    order by m.created_at desc
    limit 1
  ) lm on true
  left join public.user_profiles lp on lp.id = lm.sender_id
  where me.user_id = auth.uid()
  order by c.last_message_at desc
  limit 200;
$$;

-- =============================================
-- Messages
-- =============================================
drop function if exists public.list_chat_messages(uuid, timestamptz, integer);
create function public.list_chat_messages(
  p_conversation_id uuid,
  p_before timestamptz default null,
  p_limit integer default 50
)
returns table (
  id uuid,
  sender_id uuid,
  kind text,
  meta jsonb,
  body text,
  mentions uuid[],
  file_id uuid,
  file_name text,
  file_size bigint,
  file_mime text,
  file_folder_id uuid,
  file_version_id uuid,
  file_available boolean,
  reply_to_id uuid,
  reply_sender_id uuid,
  reply_body text,
  reply_file_name text,
  reply_deleted boolean,
  reactions jsonb,
  created_at timestamptz,
  deleted_at timestamptz
)
language plpgsql stable security definer
set search_path = public
as $$
begin
  if not public.is_chat_member(p_conversation_id) then
    raise exception 'You are not a member of this conversation';
  end if;
  return query
  select
    m.id, m.sender_id, m.kind, m.meta,
    case when m.deleted_at is null then m.body end,
    m.mentions,
    case when m.deleted_at is null and ok.allowed then m.file_id end,
    case when m.deleted_at is null then m.file_name end,
    case when ok.allowed then f.size end,
    case when ok.allowed then f.mime_type end,
    case when ok.allowed then f.folder_id end,
    case when ok.allowed then f.current_version_id end,
    coalesce(ok.allowed, false),
    m.reply_to_id,
    r.sender_id,
    case when r.deleted_at is null then left(r.body, 300) end,
    case when r.deleted_at is null then r.file_name end,
    r.deleted_at is not null,
    coalesce((
      select jsonb_agg(jsonb_build_object('emoji', x.emoji, 'user_id', x.user_id) order by x.created_at)
      from public.chat_reactions x where x.message_id = m.id and x.emoji is not null
    ), '[]'::jsonb),
    m.created_at, m.deleted_at
  from public.chat_messages m
  left join public.files f on f.id = m.file_id
  left join public.chat_messages r on r.id = m.reply_to_id
  left join lateral (
    select (m.deleted_at is null and f.id is not null and f.deleted_at is null
            and public.has_file_access(f.id, 'viewer')) as allowed
  ) ok on true
  where m.conversation_id = p_conversation_id
    and (p_before is null or m.created_at < p_before)
  order by m.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 100);
end;
$$;

drop function if exists public.send_chat_message(uuid, text, uuid);
create or replace function public.send_chat_message(
  p_conversation_id uuid,
  p_body text default null,
  p_file_id uuid default null,
  p_reply_to uuid default null,
  p_mentions uuid[] default null,
  -- chosen by the sender's app so it can show the message before the reply
  p_id uuid default null
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
  if v_body is null and p_file_id is null then
    raise exception 'Message is empty';
  end if;
  if length(v_body) > 4000 then
    raise exception 'Message is too long (max 4000 characters)';
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
    select * into v_file from public.files where id = p_file_id and deleted_at is null;
    if not found or not public.has_file_access(p_file_id, 'admin') then
      raise exception 'You can only send files you own or manage';
    end if;
    -- the other members can open the file; never downgrade an existing share
    insert into public.file_shares (file_id, grantee_id, role, granted_by)
    select p_file_id, m.user_id, 'viewer', auth.uid()
    from public.chat_members m
    where m.conversation_id = p_conversation_id and m.user_id <> auth.uid() and m.user_id <> v_file.owner_id
    on conflict (file_id, grantee_id) do nothing;
  end if;

  insert into public.chat_messages (id, conversation_id, sender_id, body, file_id, file_name, reply_to_id, mentions)
  values (coalesce(p_id, gen_random_uuid()), p_conversation_id, auth.uid(), v_body, p_file_id, v_file.name, p_reply_to, v_mentions)
  returning chat_messages.id into v_id;

  update public.chat_conversations set last_message_at = clock_timestamp() where id = p_conversation_id;
  -- my own message: everything up to it is read
  update public.chat_members set last_read_at = clock_timestamp()
  where conversation_id = p_conversation_id and user_id = auth.uid();
  return v_id;
end;
$$;

-- "Thu hồi": also removes its reactions and pins
create or replace function public.delete_chat_message(p_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  update public.chat_messages
  set deleted_at = clock_timestamp(), body = null
  where id = p_id and sender_id = auth.uid() and deleted_at is null and kind = 'message';
  if not found then
    raise exception 'You can only remove your own messages';
  end if;
  update public.chat_reactions set emoji = null where message_id = p_id and emoji is not null;
  delete from public.chat_pins where message_id = p_id;
end;
$$;

-- one reaction per person and message: the same emoji again removes it
create or replace function public.react_chat_message(p_message_id uuid, p_emoji text)
returns text
language plpgsql security definer
set search_path = public
as $$
declare
  v_conversation uuid;
  v_current text;
begin
  select m.conversation_id into v_conversation from public.chat_messages m
  where m.id = p_message_id and m.kind = 'message' and m.deleted_at is null;
  if v_conversation is null or not public.is_chat_member(v_conversation) then
    raise exception 'Message not found';
  end if;
  if p_emoji not in ('👍', '❤️', '😆', '😮', '😭', '😡') then
    raise exception 'Unsupported reaction';
  end if;
  select emoji into v_current from public.chat_reactions where message_id = p_message_id and user_id = auth.uid();
  if v_current = p_emoji then
    update public.chat_reactions set emoji = null where message_id = p_message_id and user_id = auth.uid();
    return null;
  end if;
  insert into public.chat_reactions (message_id, conversation_id, user_id, emoji)
  values (p_message_id, v_conversation, auth.uid(), p_emoji)
  on conflict (message_id, user_id) do update set emoji = excluded.emoji, created_at = now();
  return p_emoji;
end;
$$;

create or replace function public.pin_chat_message(p_message_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_conversation uuid;
begin
  select m.conversation_id into v_conversation from public.chat_messages m
  where m.id = p_message_id and m.kind = 'message' and m.deleted_at is null;
  if v_conversation is null or not public.is_chat_member(v_conversation) then
    raise exception 'Message not found';
  end if;
  if not public.can_pin_chat(v_conversation) then
    raise exception 'Only the owner and admins can pin messages in this group';
  end if;
  -- one pin change at a time per conversation, so the limit holds
  perform 1 from public.chat_conversations where id = v_conversation for update;
  if exists (select 1 from public.chat_pins where conversation_id = v_conversation and message_id = p_message_id) then
    return;
  end if;
  if (select count(*) from public.chat_pins where conversation_id = v_conversation) >= 3 then
    raise exception 'You can pin up to 3 messages. Unpin one first.';
  end if;
  insert into public.chat_pins (conversation_id, message_id, pinned_by) values (v_conversation, p_message_id, auth.uid());
  perform public.chat_system_message(v_conversation, jsonb_build_object('type', 'pin', 'message_id', p_message_id));
end;
$$;

create or replace function public.unpin_chat_message(p_message_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_conversation uuid;
begin
  select p.conversation_id into v_conversation from public.chat_pins p where p.message_id = p_message_id;
  if v_conversation is null or not public.is_chat_member(v_conversation) then
    raise exception 'This message is not pinned';
  end if;
  if not public.can_pin_chat(v_conversation) then
    raise exception 'Only the owner and admins can unpin messages in this group';
  end if;
  delete from public.chat_pins where message_id = p_message_id;
  perform public.chat_system_message(v_conversation, jsonb_build_object('type', 'unpin', 'message_id', p_message_id));
end;
$$;

create or replace function public.list_chat_pins(p_conversation_id uuid)
returns table (
  message_id uuid,
  pinned_by uuid,
  pinned_at timestamptz,
  sender_id uuid,
  body text,
  file_name text,
  created_at timestamptz
)
language plpgsql stable security definer
set search_path = public
as $$
begin
  if not public.is_chat_member(p_conversation_id) then
    raise exception 'You are not a member of this conversation';
  end if;
  return query
  select p.message_id, p.pinned_by, p.pinned_at, m.sender_id, left(m.body, 300), m.file_name, m.created_at
  from public.chat_pins p
  join public.chat_messages m on m.id = p.message_id
  where p.conversation_id = p_conversation_id
  order by p.pinned_at desc;
end;
$$;

-- unread messages over all conversations (sidebar badge)
create or replace function public.chat_unread_count()
returns integer
language sql stable security definer
set search_path = public
as $$
  select count(*)::integer
  from public.chat_members me
  join public.chat_messages x on x.conversation_id = me.conversation_id
  where me.user_id = auth.uid()
    and x.kind = 'message'
    and x.sender_id <> auth.uid()
    and x.deleted_at is null
    and x.created_at > me.last_read_at;
$$;

-- =============================================
-- Grants
-- =============================================
do $$
declare
  f text;
begin
  -- internal helpers: not callable by clients
  foreach f in array array[
    'public.chat_system_message(uuid, jsonb)',
    'public.chat_users_by_email(text[])'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'public.chat_role(uuid)',
    'public.can_edit_chat_group(uuid)',
    'public.can_pin_chat(uuid)',
    'public.get_my_profile()',
    'public.update_my_profile(text, text)',
    'public.create_chat_group(text, text[])',
    'public.rename_chat_group(uuid, text)',
    'public.set_chat_group_avatar(uuid, text)',
    'public.set_chat_group_background(uuid, text)',
    'public.set_chat_group_admin_only(uuid, boolean)',
    'public.add_chat_members(uuid, text[])',
    'public.remove_chat_member(uuid, uuid)',
    'public.set_chat_member_role(uuid, uuid, text)',
    'public.transfer_chat_ownership(uuid, uuid)',
    'public.leave_chat_group(uuid)',
    'public.delete_chat_group(uuid)',
    'public.list_chat_members(uuid)',
    'public.list_chats()',
    'public.list_chat_messages(uuid, timestamptz, integer)',
    'public.send_chat_message(uuid, text, uuid, uuid, uuid[], uuid)',
    'public.delete_chat_message(uuid)',
    'public.react_chat_message(uuid, text)',
    'public.pin_chat_message(uuid)',
    'public.unpin_chat_message(uuid)',
    'public.list_chat_pins(uuid)',
    'public.chat_unread_count()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

-- =============================================
-- Images: profile pictures, group avatars and backgrounds (public bucket)
-- =============================================
insert into storage.buckets (id, name, public)
values ('public-images', 'public-images', true)
on conflict (id) do update set public = true;

do $$
begin
  -- size and type limits, where the storage schema has them (Supabase does)
  if exists (select 1 from information_schema.columns
             where table_schema = 'storage' and table_name = 'buckets' and column_name = 'file_size_limit') then
    execute $q$update storage.buckets
      set file_size_limit = 5242880,
          allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
      where id = 'public-images'$q$;
  end if;
end;
$$;

-- users/<own id>/<file>, or groups/<id>/<file> for members who may edit the group
create or replace function public.can_write_public_image(p_name text)
returns boolean
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_parts text[] := string_to_array(p_name, '/');
begin
  if auth.uid() is null or array_length(v_parts, 1) <> 3 or not public.chat_valid_file_name(v_parts[3]) then
    return false;
  end if;
  if v_parts[1] = 'users' then
    return v_parts[2] = auth.uid()::text;
  end if;
  if v_parts[1] = 'groups' and v_parts[2] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return public.can_edit_chat_group(v_parts[2]::uuid);
  end if;
  return false;
end;
$$;
revoke all on function public.can_write_public_image(text) from public, anon;
grant execute on function public.can_write_public_image(text) to authenticated;

-- new files: also at most 20 per folder (the bucket is outside the storage quota)
create or replace function public.can_upload_public_image(p_name text)
returns boolean
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_folder text := split_part(p_name, '/', 1) || '/' || split_part(p_name, '/', 2) || '/';
begin
  if not public.can_write_public_image(p_name) then
    return false;
  end if;
  return (select count(*) from storage.objects o
          where o.bucket_id = 'public-images' and o.name like v_folder || '%') < 20;
end;
$$;
revoke all on function public.can_upload_public_image(text) from public, anon;
grant execute on function public.can_upload_public_image(text) to authenticated;

drop policy if exists "public_images_insert" on storage.objects;
drop policy if exists "public_images_update" on storage.objects;
drop policy if exists "public_images_delete" on storage.objects;
drop policy if exists "public_images_select" on storage.objects;
create policy "public_images_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'public-images' and public.can_upload_public_image(name));
create policy "public_images_update" on storage.objects for update to authenticated
  using (bucket_id = 'public-images' and public.can_write_public_image(name))
  with check (bucket_id = 'public-images' and public.can_write_public_image(name));
create policy "public_images_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'public-images' and public.can_write_public_image(name));
-- reading goes through the public URL; this only lets writers manage their files
create policy "public_images_select" on storage.objects for select to authenticated
  using (bucket_id = 'public-images' and public.can_write_public_image(name));

-- =============================================
-- Realtime authorization: typing indicators on "typing:<conversation id>"
-- (enforced once "Allow public access" is off in the Realtime settings)
-- =============================================
create or replace function public.is_chat_topic_member(p_topic text)
returns boolean
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_id text := split_part(coalesce(p_topic, ''), ':', 2);
begin
  if split_part(p_topic, ':', 1) <> 'typing'
     or v_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return public.is_chat_member(v_id::uuid);
end;
$$;
revoke all on function public.is_chat_topic_member(text) from public, anon;
grant execute on function public.is_chat_topic_member(text) to authenticated;

do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute 'drop policy if exists "chat_typing_receive" on realtime.messages';
    execute 'drop policy if exists "chat_typing_send" on realtime.messages';
    execute $p$create policy "chat_typing_receive" on realtime.messages for select to authenticated
      using (realtime.messages.extension in ('broadcast', 'presence') and public.is_chat_topic_member((select realtime.topic())))$p$;
    execute $p$create policy "chat_typing_send" on realtime.messages for insert to authenticated
      with check (realtime.messages.extension in ('broadcast', 'presence') and public.is_chat_topic_member((select realtime.topic())))$p$;
  end if;
end;
$$;
