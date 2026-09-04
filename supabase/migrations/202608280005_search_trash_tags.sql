-- Phase 2: server-side search, trash helpers, tag management
-- Run after 202608280004_migrate_batches_to_file_system.sql.
-- Idempotent.

-- =============================================
-- Trigram index for fast name search
-- =============================================
create extension if not exists pg_trgm;

create index if not exists idx_files_name_trgm
  on public.files using gin (name gin_trgm_ops);

create index if not exists idx_files_extension on public.files(extension);
create index if not exists idx_files_size on public.files(size);
create index if not exists idx_files_deleted_owner on public.files(owner_id) where deleted_at is not null;
create index if not exists idx_folders_deleted_owner on public.folders(owner_id) where deleted_at is not null;

-- =============================================
-- RPC: search_files (server-side search/filter/sort/pagination)
-- Only returns files the caller can access; never includes trashed items.
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
  v_ext text := nullif(lower(trim(coalesce(p_extension, '')), ''), '');
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
      and (
        fi.owner_id = auth.uid()
        or (
          fi.is_public
          or exists (
            select 1 from public.user_connections c
            where c.owner_id = fi.owner_id
              and c.related_user_id = auth.uid()
          )
        )
      )
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
-- RPC: list_trash (top-level trashed items for the owner)
-- =============================================
create or replace function public.list_trash()
returns table (
  item_type text,
  id uuid,
  name text,
  size bigint,
  deleted_at timestamptz,
  location text
)
language plpgsql stable security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  return query
  select
    'folder'::text,
    f.id,
    f.name,
    null::bigint,
    f.deleted_at,
    pf.name
  from public.folders f
  left join public.folders pf on pf.id = f.parent_id
  where f.owner_id = auth.uid()
    and f.deleted_at is not null
    and (
      f.parent_id is null
      or not exists (
        select 1 from public.folders p
        where p.id = f.parent_id and p.deleted_at is not null
      )
    )
  union all
  select
    'file'::text,
    fi.id,
    fi.name,
    fi.size,
    fi.deleted_at,
    df.name
  from public.files fi
  left join public.folders df on df.id = fi.folder_id
  where fi.owner_id = auth.uid()
    and fi.deleted_at is not null
    and (
      fi.folder_id is null
      or not exists (
        select 1 from public.folders p
        where p.id = fi.folder_id and p.deleted_at is not null
      )
    )
  order by deleted_at desc;
end;
$$;

-- =============================================
-- RPC: trash storage paths + empty trash
-- Storage objects are removed by the client between the two calls.
-- =============================================
create or replace function public.get_trash_storage_paths()
returns table (storage_path text)
language plpgsql stable security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  return query
  select fv.storage_path
  from public.file_versions fv
  join public.files fi on fi.id = fv.file_id
  where fi.owner_id = auth.uid()
    and fi.deleted_at is not null;
end;
$$;

create or replace function public.empty_trash()
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  folders_deleted integer;
  files_deleted integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  with removed as (
    delete from public.files
    where owner_id = auth.uid() and deleted_at is not null
    returning 1
  )
  select count(*) into files_deleted from removed;

  with removed as (
    delete from public.folders
    where owner_id = auth.uid() and deleted_at is not null
    returning 1
  )
  select count(*) into folders_deleted from removed;

  return jsonb_build_object(
    'folders_deleted', folders_deleted,
    'files_deleted', files_deleted
  );
end;
$$;

-- =============================================
-- RPC: tag management
-- =============================================
create or replace function public.set_file_tags(p_file_id uuid, p_tags text[])
returns table (tag_id uuid, name text)
language plpgsql security definer
set search_path = public
as $$
declare
  tag_name text;
  tag_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.has_file_access(p_file_id, 'editor') then
    raise exception 'You do not have permission to edit this file';
  end if;
  if exists (
    select 1 from public.files where id = p_file_id and deleted_at is not null
  ) then
    raise exception 'Cannot tag a deleted file';
  end if;

  delete from public.file_tags where file_id = p_file_id;

  if p_tags is not null then
    foreach tag_name in array p_tags loop
      tag_name := trim(tag_name);
      if tag_name = '' then
        continue;
      end if;
      if length(tag_name) > 50 then
        raise exception 'Tag name too long (max 50 characters)';
      end if;

      insert into public.tags (owner_id, name)
      values (auth.uid(), tag_name)
      on conflict (owner_id, name) do update set name = excluded.name
      returning public.tags.id into tag_id;

      insert into public.file_tags (file_id, tag_id)
      values (p_file_id, tag_id)
      on conflict do nothing;
    end loop;
  end if;

  return query
  select t.id, t.name
  from public.file_tags ft
  join public.tags t on t.id = ft.tag_id
  where ft.file_id = p_file_id
  order by t.name;
end;
$$;

create or replace function public.get_file_tags(p_file_id uuid)
returns table (tag_id uuid, name text)
language plpgsql stable security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.has_file_access(p_file_id, 'viewer') then
    raise exception 'You do not have permission to view this file';
  end if;

  return query
  select t.id, t.name
  from public.file_tags ft
  join public.tags t on t.id = ft.tag_id
  where ft.file_id = p_file_id
  order by t.name;
end;
$$;

create or replace function public.list_my_tags()
returns table (tag_id uuid, name text, file_count bigint)
language plpgsql stable security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  return query
  select t.id, t.name, count(fi.id)
  from public.tags t
  left join public.file_tags ft on ft.tag_id = t.id
  left join public.files fi on fi.id = ft.file_id and fi.deleted_at is null
  where t.owner_id = auth.uid()
  group by t.id, t.name
  order by t.name;
end;
$$;

-- =============================================
-- Grants
-- =============================================
grant execute on function
  public.search_files(text, text, uuid, bigint, bigint, timestamptz, timestamptz, timestamptz, timestamptz, text, text, text, text, integer, integer)
  to authenticated;
grant execute on function public.list_trash() to authenticated;
grant execute on function public.get_trash_storage_paths() to authenticated;
grant execute on function public.empty_trash() to authenticated;
grant execute on function public.set_file_tags(uuid, text[]) to authenticated;
grant execute on function public.get_file_tags(uuid) to authenticated;
grant execute on function public.list_my_tags() to authenticated;
