-- Fixes found while reviewing access control and listings.
-- Run after 202608280020_item_comments.sql. Idempotent.
--
-- 1. list_recent_files returned a single row (declared "returns public.files"
--    instead of "returns setof"), so Recent showed at most one file.
-- 2. search_files ignored file/folder shares and share-link grants, so files
--    shared with you never appeared in Search.
-- 3. Direct table writes: Supabase grants authenticated users INSERT/UPDATE/
--    DELETE on public tables, and the RLS policies only checked "editor"/"admin"
--    access. A grantee could change owner_id (take over a file), make a shared
--    file public, or delete rows that only the owner may hard-delete. The app
--    writes these tables through security-definer RPCs; the one direct write
--    left is the owner toggling files.is_public.
-- 4. file_versions.storage_path came from the client unchecked. Registering a
--    file with another user's object path granted read/delete access to that
--    object through the storage policies. New paths must now live under
--    <uploader>/<file id>/ (the layout buildStoragePath() produces).
-- 5. restore_folder un-trashed everything in the subtree, including files and
--    folders the user had trashed separately before deleting the folder.
-- 6. Public share-link downloads never incremented view_count.
-- 7. search_files called lower() with two arguments
--    (nullif(lower(trim(...), ''), '')), which fails on every call, so the
--    Search page could not return results.

-- =============================================
-- 1. Recent files
-- =============================================
drop function if exists public.list_recent_files(integer);
create function public.list_recent_files(p_limit integer default 20)
returns setof public.files
language sql stable security definer
set search_path = public
as $$
  -- assistant_accessible_files() is the set-based form of
  -- has_file_access(id, 'viewer') (parity is covered by supabase/tests), so
  -- listings do not run a per-row access function over every user's files.
  select fi.*
  from public.files fi
  where fi.deleted_at is null
    and fi.id in (select a.file_id from public.assistant_accessible_files() a)
  order by fi.updated_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 200);
$$;
grant execute on function public.list_recent_files(integer) to authenticated;

-- =============================================
-- 2. Search respects every kind of share
-- =============================================
create or replace function public.search_files(
  p_query text default null,
  p_extension text default null,
  p_folder_id uuid default null,
  p_min_size bigint default null,
  p_max_size bigint default null,
  p_created_after timestamptz default null,
  p_created_before timestamptz default null,
  p_modified_after timestamptz default null,
  p_modified_before timestamptz default null,
  p_tag text default null,
  p_scope text default 'all',
  p_sort text default 'name',
  p_dir text default 'asc',
  p_page integer default 1,
  p_page_size integer default 50
)
returns table (
  file_id uuid,
  name text,
  folder_id uuid,
  folder_name text,
  owner_id uuid,
  extension text,
  mime_type text,
  size bigint,
  is_public boolean,
  current_version_id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  total_count bigint
)
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 50), 1), 200);
  v_query text := nullif(trim(coalesce(p_query, '')), '');
  v_ext text := nullif(lower(trim(coalesce(p_extension, ''))), '');
  v_tag text := nullif(trim(coalesce(p_tag, '')), '');
  v_scope text := coalesce(p_scope, 'all');
  v_sort text := coalesce(p_sort, 'name');
  v_dir text := lower(coalesce(p_dir, 'asc'));
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if v_scope not in ('all', 'mine', 'shared') then
    raise exception 'Invalid scope';
  end if;
  if v_sort not in ('name', 'size', 'created_at', 'updated_at') then
    raise exception 'Invalid sort field';
  end if;
  if v_dir not in ('asc', 'desc') then
    raise exception 'Invalid sort direction';
  end if;

  return query
  with accessible as (
    select fi.*
    from public.files fi
    where fi.deleted_at is null
      -- viewer access: set-based form of has_file_access(id, 'viewer')
      and fi.id in (select acc.file_id from public.assistant_accessible_files() acc)
      and (v_scope <> 'mine' or fi.owner_id = auth.uid())
      and (v_scope <> 'shared' or fi.owner_id <> auth.uid())
      and (v_query is null or fi.name ilike '%' || v_query || '%')
      and (v_ext is null or fi.extension = v_ext)
      and (p_folder_id is null or fi.folder_id = p_folder_id)
      and (p_min_size is null or fi.size >= p_min_size)
      and (p_max_size is null or fi.size <= p_max_size)
      and (p_created_after is null or fi.created_at >= p_created_after)
      and (p_created_before is null or fi.created_at <= p_created_before)
      and (p_modified_after is null or fi.updated_at >= p_modified_after)
      and (p_modified_before is null or fi.updated_at <= p_modified_before)
      and (
        v_tag is null
        or exists (
          select 1
          from public.file_tags ft
          join public.tags t on t.id = ft.tag_id
          where ft.file_id = fi.id and lower(t.name) = lower(v_tag)
        )
      )
  )
  select
    a.id,
    a.name,
    a.folder_id,
    d.name,
    a.owner_id,
    a.extension,
    a.mime_type,
    a.size,
    a.is_public,
    a.current_version_id,
    a.created_at,
    a.updated_at,
    count(*) over ()
  from accessible a
  left join public.folders d on d.id = a.folder_id
  order by
    case when v_sort = 'name' and v_dir = 'asc' then a.name end asc,
    case when v_sort = 'name' and v_dir = 'desc' then a.name end desc,
    case when v_sort = 'size' and v_dir = 'asc' then a.size end asc,
    case when v_sort = 'size' and v_dir = 'desc' then a.size end desc,
    case when v_sort = 'created_at' and v_dir = 'asc' then a.created_at end asc,
    case when v_sort = 'created_at' and v_dir = 'desc' then a.created_at end desc,
    case when v_sort = 'updated_at' and v_dir = 'asc' then a.updated_at end asc,
    case when v_sort = 'updated_at' and v_dir = 'desc' then a.updated_at end desc
  limit v_page_size
  offset (v_page - 1) * v_page_size;
end;
$$;


-- =============================================
-- 3. Direct table writes
-- =============================================
revoke insert, update, delete on public.files from anon, authenticated;
revoke insert, update, delete on public.folders from anon, authenticated;
revoke insert, update, delete on public.file_versions from anon, authenticated;
-- visibility is the only column the client updates directly
grant update (is_public) on public.files to authenticated;

drop policy if exists "files_update" on public.files;
create policy "files_update"
  on public.files for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- =============================================
-- 4. Storage paths must belong to the uploader and the file
-- =============================================
create or replace function public.file_versions_storage_path_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Applies to requests from signed-in users (PostgREST runs them as role
  -- "authenticated", which stays set inside security-definer RPCs). Migrations,
  -- the SQL editor and the service role keep full control.
  if coalesce(current_setting('role', true), 'none') in ('authenticated', 'anon')
     and (new.storage_path is null
          or left(new.storage_path, 74) <> new.uploaded_by::text || '/' || new.file_id::text || '/'
          -- ".." as a whole path segment; dots inside names are fine
          or new.storage_path ~ '(^|/)\.\.(/|$)') then
    raise exception 'Invalid storage path for this file';
  end if;
  return new;
end;
$$;

drop trigger if exists file_versions_storage_path_guard on public.file_versions;
create trigger file_versions_storage_path_guard
  before insert or update of storage_path, file_id, uploaded_by on public.file_versions
  for each row execute function public.file_versions_storage_path_guard();

-- =============================================
-- 5. Restore only what was trashed together with the folder
-- =============================================
create or replace function public.restore_folder(p_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_deleted_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  select deleted_at into v_deleted_at
  from public.folders
  where id = p_id and owner_id = auth.uid();
  if not found then
    raise exception 'You do not have permission to restore this folder';
  end if;
  if v_deleted_at is null then
    return;
  end if;

  -- soft_delete_folder stamps the whole subtree with one timestamp; anything
  -- trashed earlier was deleted on its own and stays in the trash.
  with recursive subtree as (
    select id from public.folders where id = p_id
    union all
    select f.id from public.folders f
    join subtree s on f.parent_id = s.id
    where f.deleted_at >= v_deleted_at
  )
  update public.folders
  set deleted_at = null, deleted_by = null
  where id in (select id from subtree);

  with recursive subtree as (
    select id from public.folders where id = p_id
    union all
    select f.id from public.folders f
    join subtree s on f.parent_id = s.id
    where f.deleted_at is null
  )
  update public.files
  set deleted_at = null, deleted_by = null
  where folder_id in (select id from subtree)
    and deleted_at >= v_deleted_at;

  -- if the parent is still deleted, detach to root
  update public.folders f
  set parent_id = null
  where f.id = p_id
    and f.parent_id is not null
    and exists (
      select 1 from public.folders p
      where p.id = f.parent_id and p.deleted_at is not null
    );
end;
$$;

-- =============================================
-- 6. Count public share-link downloads
-- =============================================
create or replace function public.record_share_link_view(p_link_id uuid)
returns void
language sql security definer
set search_path = public
as $$
  update public.share_links
  set view_count = view_count + 1, last_used_at = now()
  where id = p_link_id;
$$;
-- only the server (service role) records public downloads
revoke all on function public.record_share_link_view(uuid) from public, anon, authenticated;
grant execute on function public.record_share_link_view(uuid) to service_role;
