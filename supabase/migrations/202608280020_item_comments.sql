-- Comments on files and folders: a thread of multi-line comments per item.
-- Anyone who can view an item can read and add comments; authors edit their
-- own comments; authors and the item's owner/admins can delete them.
-- Run after 202608280019_saved_links.sql. Idempotent.
-- Rollback:
--   drop function if exists public.list_item_comments(uuid, uuid);
--   drop function if exists public.add_item_comment(uuid, uuid, text);
--   drop function if exists public.update_item_comment(uuid, text);
--   drop function if exists public.delete_item_comment(uuid);
--   drop function if exists public.count_item_comments(uuid[], uuid[]);
--   drop function if exists public.comment_target_check(uuid, uuid, text);
--   drop function if exists public.clean_comment_body(text);
--   drop table if exists public.item_comments;

create table if not exists public.item_comments (
  id uuid primary key default gen_random_uuid(),
  file_id uuid references public.files(id) on delete cascade,
  folder_id uuid references public.folders(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (length(btrim(body)) > 0 and length(body) <= 5000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (file_id is not null and folder_id is null)
    or (file_id is null and folder_id is not null)
  )
);

create index if not exists idx_item_comments_file
  on public.item_comments(file_id, created_at) where file_id is not null;
create index if not exists idx_item_comments_folder
  on public.item_comments(folder_id, created_at) where folder_id is not null;

drop trigger if exists item_comments_set_updated_at on public.item_comments;
create trigger item_comments_set_updated_at
  before update on public.item_comments
  for each row execute function public.handle_updated_at();

-- Reads follow item access; every write goes through the RPCs below.
alter table public.item_comments enable row level security;

drop policy if exists "item_comments_select" on public.item_comments;
create policy "item_comments_select"
  on public.item_comments for select to authenticated
  using (
    (file_id is not null and public.has_file_access(file_id, 'viewer'))
    or (folder_id is not null and public.has_folder_access(folder_id, 'viewer'))
  );

-- =============================================
-- Helpers
-- =============================================

-- Trims surrounding blank lines/spaces but keeps line breaks inside the text.
create or replace function public.clean_comment_body(p_body text)
returns text
language plpgsql immutable
set search_path = public
as $$
declare
  cleaned text := regexp_replace(coalesce(p_body, ''), '^\s+|\s+$', '', 'g');
begin
  if cleaned = '' then
    raise exception 'Comment cannot be empty';
  end if;
  if length(cleaned) > 5000 then
    raise exception 'Comment is too long (max 5000 characters)';
  end if;
  return cleaned;
end;
$$;

-- Validates that exactly one item is given and the caller has p_role on it.
create or replace function public.comment_target_check(p_file_id uuid, p_folder_id uuid, p_role text)
returns void
language plpgsql stable security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if (p_file_id is null) = (p_folder_id is null) then
    raise exception 'Specify either a file or a folder';
  end if;
  if p_file_id is not null and not public.has_file_access(p_file_id, p_role) then
    raise exception 'You do not have access to this file';
  end if;
  if p_folder_id is not null and not public.has_folder_access(p_folder_id, p_role) then
    raise exception 'You do not have access to this folder';
  end if;
end;
$$;

-- =============================================
-- RPCs
-- =============================================
create or replace function public.list_item_comments(p_file_id uuid, p_folder_id uuid)
returns table (
  id uuid,
  author_id uuid,
  author_email text,
  body text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql stable security definer
set search_path = public
as $$
begin
  perform public.comment_target_check(p_file_id, p_folder_id, 'viewer');

  return query
  select c.id, c.author_id, up.email, c.body, c.created_at, c.updated_at
  from public.item_comments c
  left join public.user_profiles up on up.id = c.author_id
  where (p_file_id is not null and c.file_id = p_file_id)
     or (p_folder_id is not null and c.folder_id = p_folder_id)
  order by c.created_at, c.id;
end;
$$;

create or replace function public.add_item_comment(p_file_id uuid, p_folder_id uuid, p_body text)
returns table (
  id uuid,
  author_id uuid,
  author_email text,
  body text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql security definer
set search_path = public
as $$
declare
  v_body text := public.clean_comment_body(p_body);
  v_id uuid;
  v_name text;
  v_owner uuid;
  v_deleted timestamptz;
begin
  perform public.comment_target_check(p_file_id, p_folder_id, 'viewer');

  if p_file_id is not null then
    select f.name, f.owner_id, f.deleted_at into v_name, v_owner, v_deleted
    from public.files f where f.id = p_file_id;
  else
    select d.name, d.owner_id, d.deleted_at into v_name, v_owner, v_deleted
    from public.folders d where d.id = p_folder_id;
  end if;
  if v_deleted is not null then
    raise exception 'Cannot comment on an item in the trash';
  end if;

  insert into public.item_comments (file_id, folder_id, author_id, body)
  values (p_file_id, p_folder_id, auth.uid(), v_body)
  returning item_comments.id into v_id;

  perform public.log_activity(
    case when p_file_id is not null then 'file.commented' else 'folder.commented' end,
    case when p_file_id is not null then 'file' else 'folder' end,
    coalesce(p_file_id, p_folder_id),
    v_name,
    v_owner,
    jsonb_build_object('comment_id', v_id)
  );

  return query
  select c.id, c.author_id, up.email, c.body, c.created_at, c.updated_at
  from public.item_comments c
  left join public.user_profiles up on up.id = c.author_id
  where c.id = v_id;
end;
$$;

create or replace function public.update_item_comment(p_id uuid, p_body text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_body text := public.clean_comment_body(p_body);
  c public.item_comments%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  select * into c from public.item_comments where item_comments.id = p_id;
  if not found or c.author_id <> auth.uid() then
    raise exception 'You can only edit your own comments';
  end if;
  -- the author may have lost access to the item since writing the comment
  perform public.comment_target_check(c.file_id, c.folder_id, 'viewer');

  update public.item_comments set body = v_body where item_comments.id = p_id;
end;
$$;

create or replace function public.delete_item_comment(p_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  c public.item_comments%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  select * into c from public.item_comments where item_comments.id = p_id;
  if not found then
    raise exception 'Comment not found';
  end if;
  if not (
    (c.author_id = auth.uid()
      and ((c.file_id is not null and public.has_file_access(c.file_id, 'viewer'))
        or (c.folder_id is not null and public.has_folder_access(c.folder_id, 'viewer'))))
    or (c.file_id is not null and public.has_file_access(c.file_id, 'admin'))
    or (c.folder_id is not null and public.has_folder_access(c.folder_id, 'admin'))
  ) then
    raise exception 'You do not have permission to delete this comment';
  end if;

  delete from public.item_comments where item_comments.id = p_id;
end;
$$;

-- Comment counts for a listing; items the caller cannot view are left out.
create or replace function public.count_item_comments(p_file_ids uuid[], p_folder_ids uuid[])
returns table (item_id uuid, comment_count integer)
language sql stable security definer
set search_path = public
as $$
  select c.file_id, count(*)::integer
  from public.item_comments c
  where auth.uid() is not null
    and c.file_id = any(coalesce(p_file_ids, '{}'))
    and public.has_file_access(c.file_id, 'viewer')
  group by c.file_id
  union all
  select c.folder_id, count(*)::integer
  from public.item_comments c
  where auth.uid() is not null
    and c.folder_id = any(coalesce(p_folder_ids, '{}'))
    and public.has_folder_access(c.folder_id, 'viewer')
  group by c.folder_id;
$$;

-- internal helper: Supabase grants new functions to anon/authenticated directly,
-- so revoking from "public" alone would leave it callable as an access oracle
revoke execute on function public.comment_target_check(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.list_item_comments(uuid, uuid) to authenticated;
grant execute on function public.add_item_comment(uuid, uuid, text) to authenticated;
grant execute on function public.update_item_comment(uuid, text) to authenticated;
grant execute on function public.delete_item_comment(uuid) to authenticated;
grant execute on function public.count_item_comments(uuid[], uuid[]) to authenticated;
