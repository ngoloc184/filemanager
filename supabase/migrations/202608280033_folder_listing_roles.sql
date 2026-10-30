-- Role-aware folder listing for My Files.
-- Run after 202608280029_chat_stickers.sql. Idempotent.
--
-- 1. My Files root listed every root item the caller could *view*, so other
--    users' public files (and legacy related users' items) showed up there
--    (audit root.sql). list_folder_items(null) now returns only the caller's
--    own root items; shared items stay reachable through Shared with me,
--    Search and links.
-- 2. Each listed item carries my_role ('owner' | 'admin' | 'editor' |
--    'viewer'), so the UI can offer the actions the database already allows
--    (editors rename and upload versions, folder owners delete and share
--    what collaborators put in their folders) instead of gating on owner_id.
-- 3. Listings are capped (p_limit, default 2000) and say when they are
--    truncated, instead of returning an unbounded folder.

-- =============================================
-- 1. Caller's role on one item
-- =============================================
create or replace function public.item_role_file(p_file_id uuid)
returns text
language plpgsql stable security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return null;
  end if;
  if exists (select 1 from public.files where id = p_file_id and owner_id = auth.uid()) then
    return 'owner';
  end if;
  if public.has_file_access(p_file_id, 'admin') then
    return 'admin';
  end if;
  if public.has_file_access(p_file_id, 'editor') then
    return 'editor';
  end if;
  if public.has_file_access(p_file_id, 'viewer') then
    return 'viewer';
  end if;
  return null;
end;
$$;

create or replace function public.item_role_folder(p_folder_id uuid)
returns text
language plpgsql stable security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return null;
  end if;
  if exists (select 1 from public.folders where id = p_folder_id and owner_id = auth.uid()) then
    return 'owner';
  end if;
  if public.has_folder_access(p_folder_id, 'admin') then
    return 'admin';
  end if;
  if public.has_folder_access(p_folder_id, 'editor') then
    return 'editor';
  end if;
  if public.has_folder_access(p_folder_id, 'viewer') then
    return 'viewer';
  end if;
  return null;
end;
$$;

-- =============================================
-- 2. Folder listing
-- =============================================
-- Returns {folders: [...], files: [...], truncated: boolean}. Every element is
-- the full table row plus my_role, sorted by lower(name). Each list holds at
-- most p_limit items (clamped to 1..5000); truncated is true when either list
-- had more.
create or replace function public.list_folder_items(
  p_folder_id uuid default null,
  p_limit int default 2000
)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_limit int := least(greatest(coalesce(p_limit, 2000), 1), 5000);
  v_folders jsonb;
  v_files jsonb;
  v_folder_count int;
  v_file_count int;
  v_truncated boolean := false;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  if p_folder_id is null then
    -- My Files root: only the caller's own items, never public or shared ones
    select coalesce(jsonb_agg(s.item order by s.sort_name, s.id), '[]'::jsonb), count(*)
    into v_folders, v_folder_count
    from (
      select to_jsonb(d) || jsonb_build_object('my_role', 'owner') as item,
             lower(d.name) as sort_name, d.id
      from public.folders d
      where d.owner_id = v_uid and d.parent_id is null and d.deleted_at is null
      order by lower(d.name), d.id
      limit v_limit + 1
    ) s;

    select coalesce(jsonb_agg(s.item order by s.sort_name, s.id), '[]'::jsonb), count(*)
    into v_files, v_file_count
    from (
      select to_jsonb(f) || jsonb_build_object('my_role', 'owner') as item,
             lower(f.name) as sort_name, f.id
      from public.files f
      where f.owner_id = v_uid and f.folder_id is null and f.deleted_at is null
      order by lower(f.name), f.id
      limit v_limit + 1
    ) s;
  else
    if not public.has_folder_access(p_folder_id, 'viewer') then
      raise exception 'Folder not found' using errcode = 'P0002';
    end if;

    select coalesce(jsonb_agg(s.item order by s.sort_name, s.id), '[]'::jsonb), count(*)
    into v_folders, v_folder_count
    from (
      select to_jsonb(d) || jsonb_build_object('my_role', r.my_role) as item,
             lower(d.name) as sort_name, d.id
      from public.folders d
      cross join lateral (select public.item_role_folder(d.id) as my_role) r
      where d.parent_id = p_folder_id and d.deleted_at is null and r.my_role is not null
      order by lower(d.name), d.id
      limit v_limit + 1
    ) s;

    select coalesce(jsonb_agg(s.item order by s.sort_name, s.id), '[]'::jsonb), count(*)
    into v_files, v_file_count
    from (
      select to_jsonb(f) || jsonb_build_object('my_role', r.my_role) as item,
             lower(f.name) as sort_name, f.id
      from public.files f
      cross join lateral (select public.item_role_file(f.id) as my_role) r
      where f.folder_id = p_folder_id and f.deleted_at is null and r.my_role is not null
      order by lower(f.name), f.id
      limit v_limit + 1
    ) s;
  end if;

  -- the extra (p_limit + 1)th row only signals truncation; drop it
  if v_folder_count > v_limit then
    v_folders := v_folders - v_limit;
    v_truncated := true;
  end if;
  if v_file_count > v_limit then
    v_files := v_files - v_limit;
    v_truncated := true;
  end if;

  return jsonb_build_object(
    'folders', v_folders,
    'files', v_files,
    'truncated', v_truncated
  );
end;
$$;

-- =============================================
-- 3. Indexes for the listing
-- =============================================
create index if not exists idx_files_owner_folder_active
  on public.files(owner_id, folder_id) where deleted_at is null;
create index if not exists idx_folders_owner_parent_active
  on public.folders(owner_id, parent_id) where deleted_at is null;

-- =============================================
-- 4. Privileges
-- =============================================
revoke all on function public.item_role_file(uuid) from public, anon;
revoke all on function public.item_role_folder(uuid) from public, anon;
revoke all on function public.list_folder_items(uuid, int) from public, anon;
grant execute on function public.item_role_file(uuid) to authenticated;
grant execute on function public.item_role_folder(uuid) to authenticated;
grant execute on function public.list_folder_items(uuid, int) to authenticated;
