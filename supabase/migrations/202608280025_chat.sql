-- Direct chat between two users: start by e-mail, exchange text and files in
-- real time (Supabase Realtime, postgres_changes on chat_messages).
-- Run after 202608280024_storage_quota_10gb.sql. Idempotent.
--
-- * one conversation per pair of users; a user may also chat with themselves
--   (notes and files to self: a conversation with a single member);
-- * members read through RLS (Realtime applies the same policies);
-- * every write goes through the functions below (membership, rate limit);
-- * sending a file shares it with the other member as viewer (an existing
--   share is never downgraded); only files the sender owns or administers
--   can be sent.
-- Rollback:
--   alter publication supabase_realtime drop table public.chat_messages, public.chat_members;
--   drop table if exists public.chat_messages, public.chat_members, public.chat_conversations cascade;
--   (and drop the functions below)

create table if not exists public.chat_conversations (
  id uuid primary key default gen_random_uuid(),
  -- the pair, smaller id first: one conversation per pair
  user_a uuid not null references auth.users(id) on delete cascade,
  user_b uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  unique (user_a, user_b)
);

-- smaller id first; equal ids = a chat with yourself
alter table public.chat_conversations drop constraint if exists chat_conversations_check;
alter table public.chat_conversations drop constraint if exists chat_conversations_pair_order;
alter table public.chat_conversations add constraint chat_conversations_pair_order check (user_a <= user_b);

create table if not exists public.chat_members (
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create index if not exists idx_chat_members_user on public.chat_members(user_id);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  body text check (body is null or length(body) <= 4000),
  file_id uuid references public.files(id) on delete set null,
  -- name kept so a message still makes sense after the file is gone
  file_name text check (file_name is null or length(file_name) <= 300),
  -- clock_timestamp(): messages keep a strict order even within one transaction
  created_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  check (deleted_at is not null or body is not null or file_name is not null)
);

create index if not exists idx_chat_messages_conversation on public.chat_messages(conversation_id, created_at desc);
create index if not exists idx_chat_messages_sender on public.chat_messages(sender_id, created_at desc);

-- =============================================
-- Access
-- =============================================
create or replace function public.is_chat_member(p_conversation_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.chat_members m
    where m.conversation_id = p_conversation_id and m.user_id = auth.uid()
  );
$$;

alter table public.chat_conversations enable row level security;
alter table public.chat_members enable row level security;
alter table public.chat_messages enable row level security;

drop policy if exists "chat_conversations_select" on public.chat_conversations;
create policy "chat_conversations_select"
  on public.chat_conversations for select to authenticated
  using (public.is_chat_member(id));

drop policy if exists "chat_members_select" on public.chat_members;
create policy "chat_members_select"
  on public.chat_members for select to authenticated
  using (public.is_chat_member(conversation_id));

drop policy if exists "chat_messages_select" on public.chat_messages;
create policy "chat_messages_select"
  on public.chat_messages for select to authenticated
  using (public.is_chat_member(conversation_id));

revoke insert, update, delete on public.chat_conversations from anon, authenticated;
revoke insert, update, delete on public.chat_members from anon, authenticated;
revoke insert, update, delete on public.chat_messages from anon, authenticated;

-- Realtime: deliver new/changed messages (and read receipts) to members.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_messages'
    ) then
      alter publication supabase_realtime add table public.chat_messages;
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_members'
    ) then
      alter publication supabase_realtime add table public.chat_members;
    end if;
  end if;
end;
$$;

-- =============================================
-- Start a chat
-- =============================================
create or replace function public.start_chat(p_email text)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_other uuid;
  v_id uuid;
  v_email text := lower(trim(coalesce(p_email, '')));
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if v_email = '' then
    raise exception 'Email is required';
  end if;
  select p.id into v_other from public.user_profiles p where lower(p.email) = v_email;
  if v_other is null then
    raise exception 'No registered user found for this email address';
  end if;

  insert into public.chat_conversations (user_a, user_b)
  values (least(auth.uid(), v_other), greatest(auth.uid(), v_other))
  on conflict (user_a, user_b) do nothing
  returning id into v_id;

  if v_id is null then
    select c.id into v_id from public.chat_conversations c
    where c.user_a = least(auth.uid(), v_other) and c.user_b = greatest(auth.uid(), v_other);
  else
    -- one member row for a chat with yourself, two otherwise
    insert into public.chat_members (conversation_id, user_id)
    select distinct v_id, u from unnest(array[auth.uid(), v_other]) as u
    on conflict do nothing;
  end if;
  return v_id;
end;
$$;

-- =============================================
-- Conversations of the caller
-- =============================================
create or replace function public.list_chats()
returns table (
  id uuid,
  other_id uuid,
  other_email text,
  last_message_at timestamptz,
  last_body text,
  last_file_name text,
  last_sender_id uuid,
  last_deleted boolean,
  unread integer,
  other_last_read_at timestamptz
)
language sql stable security definer
set search_path = public
as $$
  select
    c.id,
    o.user_id,
    up.email,
    c.last_message_at,
    lm.body,
    lm.file_name,
    lm.sender_id,
    lm.deleted_at is not null,
    (
      select count(*)::integer from public.chat_messages x
      where x.conversation_id = c.id
        and x.sender_id <> auth.uid()
        and x.deleted_at is null
        and x.created_at > me.last_read_at
    ),
    o.last_read_at
  from public.chat_members me
  join public.chat_conversations c on c.id = me.conversation_id
  -- the other member, or the caller in a chat with themselves
  join lateral (
    select m2.user_id, m2.last_read_at
    from public.chat_members m2
    where m2.conversation_id = c.id
    order by (m2.user_id = me.user_id), m2.user_id
    limit 1
  ) o on true
  left join public.user_profiles up on up.id = o.user_id
  left join lateral (
    select m.body, m.file_name, m.sender_id, m.deleted_at
    from public.chat_messages m
    where m.conversation_id = c.id
    order by m.created_at desc
    limit 1
  ) lm on true
  where me.user_id = auth.uid()
  order by c.last_message_at desc
  limit 200;
$$;

-- =============================================
-- Messages
-- =============================================
create or replace function public.list_chat_messages(
  p_conversation_id uuid,
  p_before timestamptz default null,
  p_limit integer default 50
)
returns table (
  id uuid,
  sender_id uuid,
  body text,
  file_id uuid,
  file_name text,
  file_size bigint,
  file_mime text,
  file_folder_id uuid,
  file_version_id uuid,
  file_available boolean,
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
    m.id, m.sender_id,
    case when m.deleted_at is null then m.body end,
    case when m.deleted_at is null and ok.allowed then m.file_id end,
    case when m.deleted_at is null then m.file_name end,
    case when ok.allowed then f.size end,
    case when ok.allowed then f.mime_type end,
    case when ok.allowed then f.folder_id end,
    case when ok.allowed then f.current_version_id end,
    coalesce(ok.allowed, false),
    m.created_at, m.deleted_at
  from public.chat_messages m
  left join public.files f on f.id = m.file_id
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

create or replace function public.send_chat_message(
  p_conversation_id uuid,
  p_body text default null,
  p_file_id uuid default null
)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_body text := nullif(regexp_replace(coalesce(p_body, ''), '^\s+|\s+$', '', 'g'), '');
  v_file public.files%rowtype;
  v_other uuid;
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

  select count(*) into v_recent from public.chat_messages
  where sender_id = auth.uid() and created_at > now() - interval '1 minute';
  if v_recent >= 30 then
    raise exception 'You are sending messages too quickly';
  end if;

  select m.user_id into v_other from public.chat_members m
  where m.conversation_id = p_conversation_id and m.user_id <> auth.uid();

  if p_file_id is not null then
    select * into v_file from public.files where id = p_file_id and deleted_at is null;
    if not found or not public.has_file_access(p_file_id, 'admin') then
      raise exception 'You can only send files you own or manage';
    end if;
    -- the other member can open the file; never downgrade an existing share
    if v_other is not null and v_other <> v_file.owner_id then
      insert into public.file_shares (file_id, grantee_id, role, granted_by)
      values (p_file_id, v_other, 'viewer', auth.uid())
      on conflict (file_id, grantee_id) do nothing;
    end if;
  end if;

  insert into public.chat_messages (conversation_id, sender_id, body, file_id, file_name)
  values (p_conversation_id, auth.uid(), v_body, p_file_id, v_file.name)
  returning chat_messages.id into v_id;

  update public.chat_conversations set last_message_at = clock_timestamp() where id = p_conversation_id;
  -- my own message: everything up to it is read
  update public.chat_members set last_read_at = clock_timestamp()
  where conversation_id = p_conversation_id and user_id = auth.uid();
  return v_id;
end;
$$;

-- "Thu hồi": the sender removes a message (text and file link are hidden)
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
  where id = p_id and sender_id = auth.uid() and deleted_at is null;
  if not found then
    raise exception 'You can only remove your own messages';
  end if;
end;
$$;

create or replace function public.mark_chat_read(p_conversation_id uuid)
returns void
language sql security definer
set search_path = public
as $$
  update public.chat_members set last_read_at = clock_timestamp()
  where conversation_id = p_conversation_id and user_id = auth.uid();
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
    and x.sender_id <> auth.uid()
    and x.deleted_at is null
    and x.created_at > me.last_read_at;
$$;

revoke all on function public.is_chat_member(uuid) from public, anon;
revoke all on function public.start_chat(text) from public, anon;
revoke all on function public.list_chats() from public, anon;
revoke all on function public.list_chat_messages(uuid, timestamptz, integer) from public, anon;
revoke all on function public.send_chat_message(uuid, text, uuid) from public, anon;
revoke all on function public.delete_chat_message(uuid) from public, anon;
revoke all on function public.mark_chat_read(uuid) from public, anon;
revoke all on function public.chat_unread_count() from public, anon;
grant execute on function public.is_chat_member(uuid) to authenticated;
grant execute on function public.start_chat(text) to authenticated;
grant execute on function public.list_chats() to authenticated;
grant execute on function public.list_chat_messages(uuid, timestamptz, integer) to authenticated;
grant execute on function public.send_chat_message(uuid, text, uuid) to authenticated;
grant execute on function public.delete_chat_message(uuid) to authenticated;
grant execute on function public.mark_chat_read(uuid) to authenticated;
grant execute on function public.chat_unread_count() to authenticated;
