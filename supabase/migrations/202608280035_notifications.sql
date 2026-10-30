-- Notification center: one row per event for one user (shares, comments and,
-- later, documents and company events). Rows are written only by the internal
-- definer function create_notification (from triggers and other definer
-- RPCs); users read their own rows (RLS + Realtime) and mark them read.
-- Device push is server-side: POST /api/push/notifications pushes the actor's
-- fresh rows once each (notification_push_log).
-- Run after 202608280029_chat_stickers.sql. Idempotent.
-- Rollback:
--   drop trigger if exists file_shares_notify on public.file_shares;
--   drop trigger if exists folder_shares_notify on public.folder_shares;
--   drop trigger if exists item_comments_notify on public.item_comments;
--   drop function if exists public.notify_file_share();
--   drop function if exists public.notify_folder_share();
--   drop function if exists public.notify_item_comment();
--   drop function if exists public.list_notifications(timestamptz, integer);
--   drop function if exists public.unread_notification_count();
--   drop function if exists public.mark_notifications_read(uuid[]);
--   drop function if exists public.create_notification(uuid, text, text, text, text, text, uuid, uuid);
--   drop function if exists public.notification_actor_name(uuid);
--   drop table if exists public.notification_push_log, public.notifications;
--   alter table public.user_preferences drop column if exists activity_push;

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  org_id uuid,
  actor_id uuid references auth.users(id) on delete set null,
  kind text not null check (kind ~ '^[a-z_]+(\.[a-z_]+)*$'),
  entity_type text check (entity_type in ('file', 'folder', 'document', 'chat', 'org', 'dossier')),
  entity_id uuid,
  title text not null check (char_length(title) between 1 and 200),
  body text check (char_length(body) <= 500),
  -- an in-app path only: never another site, never protocol-relative
  link text check (link ~ '^/' and link !~ '^//' and link !~ '^/\\' and link !~ '[[:cntrl:]]'),
  created_at timestamptz not null default clock_timestamp(),
  read_at timestamptz
);

create index if not exists idx_notifications_user_created
  on public.notifications(user_id, created_at desc);
create index if not exists idx_notifications_user_unread
  on public.notifications(user_id) where read_at is null;
-- the push route looks up what the caller just caused
create index if not exists idx_notifications_actor_created
  on public.notifications(actor_id, created_at desc);

-- Private to the recipient; every write goes through definer functions.
alter table public.notifications enable row level security;

drop policy if exists "notifications_select_own" on public.notifications;
create policy "notifications_select_own"
  on public.notifications for select to authenticated
  using (user_id = auth.uid());

revoke all on public.notifications from anon, authenticated;
grant select on public.notifications to authenticated;

-- Realtime: deliver new notifications to the recipient's open tabs (the bell).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
    ) then
      alter publication supabase_realtime add table public.notifications;
    end if;
  end if;
end;
$$;

-- Notifications already pushed: each one goes to the devices once.
create table if not exists public.notification_push_log (
  notification_id uuid primary key references public.notifications(id) on delete cascade,
  pushed_at timestamptz default now()
);
alter table public.notification_push_log enable row level security;
revoke all on public.notification_push_log from anon, authenticated;

-- Device push for activity (shares, comments, documents); on unless turned off.
alter table public.user_preferences add column if not exists activity_push boolean not null default true;

-- =============================================
-- Writing notifications (internal)
-- =============================================

-- Display name of a user for notification titles.
create or replace function public.notification_actor_name(p_user_id uuid)
returns text
language sql stable security definer
set search_path = public
as $$
  select coalesce(
    (select coalesce(nullif(btrim(p.display_name), ''), p.email)
     from public.user_profiles p where p.id = p_user_id),
    'Someone'
  );
$$;

-- Adds one notification for p_user_id, caused by the caller. Nobody is
-- notified of their own actions; returns null when nothing was written.
create or replace function public.create_notification(
  p_user_id uuid,
  p_kind text,
  p_title text,
  p_body text default null,
  p_link text default null,
  p_entity_type text default null,
  p_entity_id uuid default null,
  p_org_id uuid default null
)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_user_id is null or p_user_id = auth.uid() then
    return null;
  end if;

  insert into public.notifications (user_id, org_id, actor_id, kind, entity_type, entity_id, title, body, link)
  values (
    p_user_id, p_org_id, auth.uid(), p_kind, p_entity_type, p_entity_id,
    left(p_title, 200), left(p_body, 500), p_link
  )
  returning id into v_id;
  return v_id;
end;
$$;

-- =============================================
-- RPCs
-- =============================================

-- The caller's notifications, newest first; page with p_before.
create or replace function public.list_notifications(p_before timestamptz default null, p_limit integer default 30)
returns table (
  id uuid,
  kind text,
  entity_type text,
  entity_id uuid,
  title text,
  body text,
  link text,
  created_at timestamptz,
  read_at timestamptz,
  actor_id uuid,
  actor_name text
)
language plpgsql stable security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  return query
  select n.id, n.kind, n.entity_type, n.entity_id, n.title, n.body, n.link,
         n.created_at, n.read_at, n.actor_id,
         coalesce(nullif(btrim(p.display_name), ''), p.email)
  from public.notifications n
  left join public.user_profiles p on p.id = n.actor_id
  where n.user_id = auth.uid()
    and (p_before is null or n.created_at < p_before)
  order by n.created_at desc, n.id desc
  limit least(greatest(coalesce(p_limit, 30), 1), 100);
end;
$$;

create or replace function public.unread_notification_count()
returns integer
language plpgsql stable security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  return (
    select count(*)::integer from public.notifications n
    where n.user_id = auth.uid() and n.read_at is null
  );
end;
$$;

-- Marks the given notifications (null: all of them) read; returns how many changed.
create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns integer
language plpgsql security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  update public.notifications n
  set read_at = now()
  where n.user_id = auth.uid()
    and n.read_at is null
    and (p_ids is null or n.id = any(p_ids));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- =============================================
-- Triggers: shares and comments
-- =============================================
-- A failing notification never breaks the share or comment itself.

create or replace function public.notify_file_share()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_name text;
begin
  begin
    -- shares made by chat file messages are not announced (the message is)
    if coalesce(to_jsonb(new) ->> 'source', 'manual') = 'chat' then
      return null;
    end if;
    select f.name into v_name from public.files f where f.id = new.file_id;
    perform public.create_notification(
      new.grantee_id,
      'share.file',
      public.notification_actor_name(coalesce(auth.uid(), new.granted_by))
        || ' shared “' || coalesce(v_name, 'a file') || '” with you',
      null,
      '/shared',
      'file',
      new.file_id
    );
  exception when others then
    raise warning 'notify_file_share: %', sqlerrm;
  end;
  return null;
end;
$$;

create or replace function public.notify_folder_share()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_name text;
begin
  begin
    if coalesce(to_jsonb(new) ->> 'source', 'manual') = 'chat' then
      return null;
    end if;
    select d.name into v_name from public.folders d where d.id = new.folder_id;
    perform public.create_notification(
      new.grantee_id,
      'share.folder',
      public.notification_actor_name(coalesce(auth.uid(), new.granted_by))
        || ' shared “' || coalesce(v_name, 'a folder') || '” with you',
      null,
      '/shared',
      'folder',
      new.folder_id
    );
  exception when others then
    raise warning 'notify_folder_share: %', sqlerrm;
  end;
  return null;
end;
$$;

-- Tells the item's owner; the link opens the item's folder in My Files, the
-- way search results do (/dashboard?folder=<id>).
create or replace function public.notify_item_comment()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_name text;
  v_link text;
  v_folder uuid;
begin
  begin
    if new.file_id is not null then
      select f.owner_id, f.name, f.folder_id into v_owner, v_name, v_folder
      from public.files f where f.id = new.file_id;
      v_link := case when v_folder is null then '/dashboard' else '/dashboard?folder=' || v_folder end;
    else
      select d.owner_id, d.name into v_owner, v_name
      from public.folders d where d.id = new.folder_id;
      v_link := '/dashboard?folder=' || new.folder_id;
    end if;

    if v_owner is null or v_owner = new.author_id then
      return null;
    end if;
    perform public.create_notification(
      v_owner,
      'comment',
      public.notification_actor_name(coalesce(auth.uid(), new.author_id))
        || ' commented on “' || coalesce(v_name, 'an item') || '”',
      left(new.body, 140),
      v_link,
      case when new.file_id is not null then 'file' else 'folder' end,
      coalesce(new.file_id, new.folder_id)
    );
  exception when others then
    raise warning 'notify_item_comment: %', sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists file_shares_notify on public.file_shares;
create trigger file_shares_notify
  after insert on public.file_shares
  for each row execute function public.notify_file_share();

drop trigger if exists folder_shares_notify on public.folder_shares;
create trigger folder_shares_notify
  after insert on public.folder_shares
  for each row execute function public.notify_folder_share();

drop trigger if exists item_comments_notify on public.item_comments;
create trigger item_comments_notify
  after insert on public.item_comments
  for each row execute function public.notify_item_comment();

-- =============================================
-- Privileges
-- =============================================
-- Supabase grants new functions to anon/authenticated directly, so each one is
-- revoked explicitly; triggers fire without EXECUTE on their function.
revoke all on function public.notification_actor_name(uuid) from public, anon, authenticated;
revoke all on function public.create_notification(uuid, text, text, text, text, text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.notify_file_share() from public, anon, authenticated;
revoke all on function public.notify_folder_share() from public, anon, authenticated;
revoke all on function public.notify_item_comment() from public, anon, authenticated;
revoke all on function public.list_notifications(timestamptz, integer) from public, anon;
revoke all on function public.unread_notification_count() from public, anon;
revoke all on function public.mark_notifications_read(uuid[]) from public, anon;

grant execute on function public.notification_actor_name(uuid) to service_role;
grant execute on function public.create_notification(uuid, text, text, text, text, text, uuid, uuid) to service_role;
grant execute on function public.list_notifications(timestamptz, integer) to authenticated;
grant execute on function public.unread_notification_count() to authenticated;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;
