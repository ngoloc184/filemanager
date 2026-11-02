-- Custom chat stickers managed by site admins (Admin -> Stickers).
-- Run after 202608280043_dossiers_retention.sql. Idempotent.
--
-- * app_admins lists the site admins. Nobody becomes one from the app; appoint
--   them in the SQL Editor:
--     insert into public.app_admins (user_id)
--     select id from auth.users where email = 'someone@example.com'
--     on conflict do nothing;
--   is_app_admin() (RLS helper, uses auth.uid() only) tells whether the caller
--   is one.
-- * sticker_packs / custom_stickers: packs every signed-in user sees while
--   enabled; site admins see and write everything (RLS). A sticker image is
--   the object named exactly like its id ('cs-' + 10 characters) in the public
--   bucket 'stickers', so a message can show it from the id alone.
-- * sticker_hidden_groups: built-in Fluent groups hidden from the picker.
--   Hiding is a picker matter: send_chat_message does not enforce it, so old
--   recents can still be sent.
-- * send_chat_message (last defined in 202608280032_chat_file_grants.sql,
--   body kept as is except the sticker check): a 'cs-' sticker must exist in
--   an enabled pack, otherwise 'Unknown sticker'.
-- Rollback (deletes every custom sticker; their messages show a placeholder):
--   re-run the send_chat_message section of 202608280032_chat_file_grants.sql;
--   drop function if exists public.reorder_sticker_packs(uuid[]),
--     public.reorder_custom_stickers(uuid, text[]);
--   drop policy "stickers_insert" / "stickers_update" / "stickers_delete" /
--     "stickers_select" on storage.objects; empty and delete bucket 'stickers';
--   drop table if exists public.sticker_hidden_groups, public.custom_stickers,
--     public.sticker_packs cascade;
--   drop function if exists public.is_app_admin(); drop table if exists public.app_admins;

-- =============================================
-- Site admins
-- =============================================
create table if not exists public.app_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.app_admins enable row level security;

drop policy if exists "Users can see whether they are a site admin" on public.app_admins;
create policy "Users can see whether they are a site admin"
  on public.app_admins for select to authenticated
  using (user_id = auth.uid());

revoke all on table public.app_admins from public, anon, authenticated;
grant select on table public.app_admins to authenticated;
grant all on table public.app_admins to service_role;

create or replace function public.is_app_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select auth.uid() is not null
     and exists (select 1 from public.app_admins where user_id = auth.uid());
$$;

-- =============================================
-- Packs and stickers
-- =============================================
create table if not exists public.sticker_packs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 60 and char_length(name) <= 60),
  cover_sticker_id text,
  sort_order integer not null default 0,
  enabled boolean not null default true,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists sticker_packs_set_updated_at on public.sticker_packs;
create trigger sticker_packs_set_updated_at
  before update on public.sticker_packs
  for each row execute function public.handle_updated_at();

create table if not exists public.custom_stickers (
  id text primary key check (id ~ '^cs-[a-z0-9]{10}$'),
  pack_id uuid not null references public.sticker_packs(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60 and char_length(name) <= 60),
  keywords text[] not null default '{}'
    check (cardinality(keywords) <= 30 and array_position(keywords, null) is null),
  sort_order integer not null default 0,
  mime text not null check (mime in ('image/png', 'image/webp', 'image/gif', 'image/jpeg')),
  size_bytes integer not null check (size_bytes between 1 and 2097152),
  created_at timestamptz not null default now(),
  -- target of the pack cover below: a cover is always a sticker of its own pack
  constraint custom_stickers_pack_id_id_key unique (pack_id, id)
);

create index if not exists custom_stickers_pack_order_idx
  on public.custom_stickers (pack_id, sort_order);

-- deleting the cover sticker clears the cover, nothing else
alter table public.sticker_packs drop constraint if exists sticker_packs_cover_fkey;
alter table public.sticker_packs add constraint sticker_packs_cover_fkey
  foreign key (id, cover_sticker_id) references public.custom_stickers (pack_id, id)
  on delete set null (cover_sticker_id);

create table if not exists public.sticker_hidden_groups (
  -- the keys of STICKER_GROUPS in src/lib/stickers/suggest.ts
  group_key text primary key
    check (group_key in ('smileys', 'people', 'nature', 'food', 'activities', 'travel', 'objects', 'symbols')),
  hidden_by uuid default auth.uid() references auth.users(id) on delete set null,
  hidden_at timestamptz not null default now()
);

-- =============================================
-- RLS: everyone signed in reads what is enabled; site admins write
-- =============================================
alter table public.sticker_packs enable row level security;
alter table public.custom_stickers enable row level security;
alter table public.sticker_hidden_groups enable row level security;

drop policy if exists "Enabled sticker packs are visible" on public.sticker_packs;
create policy "Enabled sticker packs are visible"
  on public.sticker_packs for select to authenticated
  using (enabled or public.is_app_admin());
drop policy if exists "Site admins add sticker packs" on public.sticker_packs;
create policy "Site admins add sticker packs"
  on public.sticker_packs for insert to authenticated
  with check (public.is_app_admin());
drop policy if exists "Site admins edit sticker packs" on public.sticker_packs;
create policy "Site admins edit sticker packs"
  on public.sticker_packs for update to authenticated
  using (public.is_app_admin()) with check (public.is_app_admin());
drop policy if exists "Site admins delete sticker packs" on public.sticker_packs;
create policy "Site admins delete sticker packs"
  on public.sticker_packs for delete to authenticated
  using (public.is_app_admin());

drop policy if exists "Stickers of enabled packs are visible" on public.custom_stickers;
create policy "Stickers of enabled packs are visible"
  on public.custom_stickers for select to authenticated
  using (
    public.is_app_admin()
    or exists (select 1 from public.sticker_packs p where p.id = pack_id and p.enabled)
  );
drop policy if exists "Site admins add stickers" on public.custom_stickers;
create policy "Site admins add stickers"
  on public.custom_stickers for insert to authenticated
  with check (public.is_app_admin());
drop policy if exists "Site admins edit stickers" on public.custom_stickers;
create policy "Site admins edit stickers"
  on public.custom_stickers for update to authenticated
  using (public.is_app_admin()) with check (public.is_app_admin());
drop policy if exists "Site admins delete stickers" on public.custom_stickers;
create policy "Site admins delete stickers"
  on public.custom_stickers for delete to authenticated
  using (public.is_app_admin());

drop policy if exists "Hidden sticker groups are visible" on public.sticker_hidden_groups;
create policy "Hidden sticker groups are visible"
  on public.sticker_hidden_groups for select to authenticated
  using (true);
drop policy if exists "Site admins hide sticker groups" on public.sticker_hidden_groups;
create policy "Site admins hide sticker groups"
  on public.sticker_hidden_groups for insert to authenticated
  with check (public.is_app_admin());
drop policy if exists "Site admins show sticker groups" on public.sticker_hidden_groups;
create policy "Site admins show sticker groups"
  on public.sticker_hidden_groups for delete to authenticated
  using (public.is_app_admin());

-- the id, pack and image facts of a sticker never change after upload (its
-- storage object is named by the id); admins edit only these columns.
-- created_by / hidden_by are not readable from the app: like app_admins,
-- they would tell every user who the site admins are.
revoke all on table public.sticker_packs, public.custom_stickers, public.sticker_hidden_groups
  from public, anon, authenticated;
grant insert, delete on table public.sticker_packs, public.custom_stickers, public.sticker_hidden_groups
  to authenticated;
grant select on table public.custom_stickers to authenticated;
grant select (id, name, cover_sticker_id, sort_order, enabled, created_at, updated_at)
  on table public.sticker_packs to authenticated;
grant select (group_key, hidden_at) on table public.sticker_hidden_groups to authenticated;
grant update (name, cover_sticker_id, sort_order, enabled) on table public.sticker_packs to authenticated;
grant update (name, keywords, sort_order) on table public.custom_stickers to authenticated;
grant all on table public.sticker_packs, public.custom_stickers, public.sticker_hidden_groups to service_role;

-- =============================================
-- Ordering (sort_order = position in the given list; others keep theirs)
-- =============================================
create or replace function public.reorder_sticker_packs(p_ids uuid[])
returns void
language plpgsql
set search_path = public
as $$
begin
  if not public.is_app_admin() then
    raise exception 'Only site admins can manage stickers' using errcode = '42501';
  end if;
  if p_ids is null or array_position(p_ids, null) is not null
     or cardinality(p_ids) <> (select count(distinct x) from unnest(p_ids) x) then
    raise exception 'Each pack must be listed once' using errcode = '22023';
  end if;
  update public.sticker_packs p
  set sort_order = x.ord::integer
  from unnest(p_ids) with ordinality as x(id, ord)
  where p.id = x.id and p.sort_order is distinct from x.ord::integer;
end;
$$;

create or replace function public.reorder_custom_stickers(p_pack_id uuid, p_ids text[])
returns void
language plpgsql
set search_path = public
as $$
begin
  if not public.is_app_admin() then
    raise exception 'Only site admins can manage stickers' using errcode = '42501';
  end if;
  if p_ids is null or array_position(p_ids, null) is not null
     or cardinality(p_ids) <> (select count(distinct x) from unnest(p_ids) x) then
    raise exception 'Each sticker must be listed once' using errcode = '22023';
  end if;
  update public.custom_stickers s
  set sort_order = x.ord::integer
  from unnest(p_ids) with ordinality as x(id, ord)
  where s.pack_id = p_pack_id and s.id = x.id and s.sort_order is distinct from x.ord::integer;
end;
$$;

-- =============================================
-- Images: public bucket 'stickers', one object per sticker named by its id
-- =============================================
insert into storage.buckets (id, name, public)
values ('stickers', 'stickers', true)
on conflict (id) do update set public = true;

do $$
begin
  -- size and type limits, where the storage schema has them (Supabase does)
  if exists (select 1 from information_schema.columns
             where table_schema = 'storage' and table_name = 'buckets' and column_name = 'file_size_limit') then
    execute $q$update storage.buckets
      set file_size_limit = 2097152,
          allowed_mime_types = array['image/png', 'image/webp', 'image/gif', 'image/jpeg']
      where id = 'stickers'$q$;
  end if;
end;
$$;

drop policy if exists "stickers_insert" on storage.objects;
drop policy if exists "stickers_update" on storage.objects;
drop policy if exists "stickers_delete" on storage.objects;
drop policy if exists "stickers_select" on storage.objects;
create policy "stickers_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'stickers' and name ~ '^cs-[a-z0-9]{10}$' and public.is_app_admin());
create policy "stickers_update" on storage.objects for update to authenticated
  using (bucket_id = 'stickers' and name ~ '^cs-[a-z0-9]{10}$' and public.is_app_admin())
  with check (bucket_id = 'stickers' and name ~ '^cs-[a-z0-9]{10}$' and public.is_app_admin());
create policy "stickers_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'stickers' and name ~ '^cs-[a-z0-9]{10}$' and public.is_app_admin());
-- images are public anyway (public URL); this lets signed-in clients list them
create policy "stickers_select" on storage.objects for select to authenticated
  using (bucket_id = 'stickers');

-- =============================================
-- Sending: a custom sticker must be in an enabled pack
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
  -- a custom sticker (Admin -> Stickers) must exist in an enabled pack
  if p_sticker like 'cs-%' and not exists (
    select 1 from public.custom_stickers s
    join public.sticker_packs p on p.id = s.pack_id
    where s.id = p_sticker and p.enabled
  ) then
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

-- =============================================
-- Grants
-- =============================================
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.is_app_admin()',
    'public.reorder_sticker_packs(uuid[])',
    'public.reorder_custom_stickers(uuid, text[])',
    'public.send_chat_message(uuid, text, uuid, uuid, uuid[], uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
