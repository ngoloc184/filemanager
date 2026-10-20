-- Folder owners see what collaborators add to their folders, plus hardening.
-- Run after 202608280021_access_and_listing_fixes.sql. Idempotent.
--
-- 1. Folder owners can open and manage (admin level) files and subfolders
--    that people they shared the folder with uploaded or created inside it.
--    Before, those items were owned by the uploader only, so the folder owner
--    could not see them, and emptying the trash could leave their storage
--    objects behind or purge them from the uploader's side unseen.
--    Covered in has_folder_access / has_file_access and their set-based twin
--    assistant_accessible_files() (used by search, recent and the assistant).
-- 2. Trash purge (empty_trash, get_trash_storage_paths) now matches what
--    list_trash() shows: my trashed roots and everything inside them, but
--    never my files inside someone else's trashed folder.
-- 3. share_file / share_folder: re-sharing with an existing admin went through
--    "on conflict do update", letting an admin grantee downgrade another admin.
--    Only the owner may change an admin share (as update_*_share already did).
-- 4. Breadcrumbs (get_folder_ancestors) stop at the first folder the caller
--    cannot open instead of revealing the owner's private parent folders.
-- 5. register_file / add_file_version take the file size from Supabase Storage
--    instead of the size the client sends, so quota cannot be bypassed with
--    p_size = 0, and registering a path with no uploaded object is rejected.

-- =============================================
-- 1. Folder owner access
-- =============================================
create or replace function public.has_folder_access(dir_id uuid, required_role text default 'viewer')
returns boolean
language plpgsql stable security definer
set search_path = public
as $$
declare
  f public.folders%rowtype;
begin
  if auth.uid() is null then
    return false;
  end if;

  select * into f from public.folders where id = dir_id;
  if not found then
    return false;
  end if;

  if f.owner_id = auth.uid() then
    return true;
  end if;

  -- owners of an ancestor folder manage everything inside it, including
  -- subfolders collaborators created (also while it is in the trash, so the
  -- owner can restore or purge it)
  if exists (
    with recursive chain as (
      select p.id, p.parent_id, p.owner_id from public.folders p where p.id = f.parent_id
      union all
      select p.id, p.parent_id, p.owner_id
      from public.folders p
      join chain c on c.parent_id = p.id
    )
    select 1 from chain where owner_id = auth.uid()
  ) then
    return public.role_rank(required_role) <= public.role_rank('admin');
  end if;

  if f.deleted_at is not null then
    return false;
  end if;

  -- direct or inherited folder share (a share on an ancestor applies to all descendants)
  if exists (
    with recursive chain as (
      select id, parent_id from public.folders where id = dir_id
      union all
      select p.id, p.parent_id
      from public.folders p
      join chain c on c.parent_id = p.id
    )
    select 1
    from public.folder_shares fs
    where fs.folder_id in (select id from chain)
      and fs.grantee_id = auth.uid()
      and public.role_rank(fs.role) >= public.role_rank(required_role)
  ) then
    return true;
  end if;

  -- legacy related users get viewer access
  if public.role_rank(required_role) <= public.role_rank('viewer')
     and exists (
       select 1 from public.user_connections c
       where c.owner_id = f.owner_id and c.related_user_id = auth.uid()
     ) then
    return true;
  end if;

  return false;
end;
$$;

create or replace function public.has_file_access(f_id uuid, required_role text default 'viewer')
returns boolean
language plpgsql stable security definer
set search_path = public
as $$
declare
  fi public.files%rowtype;
begin
  if auth.uid() is null then
    return false;
  end if;

  select * into fi from public.files where id = f_id;
  if not found then
    return false;
  end if;

  if fi.owner_id = auth.uid() then
    return true;
  end if;

  -- owners of the containing folder (or any ancestor) manage files that
  -- collaborators uploaded into it, also while they are in the trash
  if fi.folder_id is not null and exists (
    with recursive chain as (
      select p.id, p.parent_id, p.owner_id from public.folders p where p.id = fi.folder_id
      union all
      select p.id, p.parent_id, p.owner_id
      from public.folders p
      join chain c on c.parent_id = p.id
    )
    select 1 from chain where owner_id = auth.uid()
  ) then
    return public.role_rank(required_role) <= public.role_rank('admin');
  end if;

  if fi.deleted_at is not null then
    return false;
  end if;

  -- direct file share
  if exists (
    select 1 from public.file_shares fs
    where fs.file_id = f_id
      and fs.grantee_id = auth.uid()
      and public.role_rank(fs.role) >= public.role_rank(required_role)
  ) then
    return true;
  end if;

  -- inherited share from the containing folder or any ancestor
  if fi.folder_id is not null and exists (
    with recursive chain as (
      select id, parent_id from public.folders where id = fi.folder_id
      union all
      select p.id, p.parent_id
      from public.folders p
      join chain c on c.parent_id = p.id
    )
    select 1
    from public.folder_shares fs
    where fs.folder_id in (select id from chain)
      and fs.grantee_id = auth.uid()
      and public.role_rank(fs.role) >= public.role_rank(required_role)
  ) then
    return true;
  end if;

  if public.role_rank(required_role) <= public.role_rank('viewer') then
    if fi.is_public then
      return true;
    end if;

    -- short-lived grant issued by access_share_link()
    if exists (
      select 1 from public.share_link_access sla
      where sla.file_id = f_id
        and sla.user_id = auth.uid()
        and sla.expires_at > now()
    ) then
      return true;
    end if;

    if exists (
      select 1 from public.user_connections c
      where c.owner_id = fi.owner_id and c.related_user_id = auth.uid()
    ) then
      return true;
    end if;
  end if;

  return false;
end;
$$;

create or replace function public.assistant_accessible_files()
returns table (file_id uuid, access text)
language sql stable security definer
set search_path = public
as $$
  with recursive
  me as (select auth.uid() as uid),
  shared_tree as (
    select fs.folder_id as id
    from public.folder_shares fs
    where fs.grantee_id = (select uid from me)
    union
    select child.id
    from public.folders child
    join shared_tree t on child.parent_id = t.id
  ),
  -- folders the caller owns and everything below them (collaborators may
  -- have uploaded files there)
  owned_tree as (
    select f.id
    from public.folders f
    where f.owner_id = (select uid from me)
    union
    select child.id
    from public.folders child
    join owned_tree t on child.parent_id = t.id
  )
  select
    fi.id,
    case
      when fi.owner_id = (select uid from me) then 'owner'
      when exists (
             select 1 from public.file_shares s
             where s.file_id = fi.id and s.grantee_id = (select uid from me)
           )
           or fi.folder_id in (select id from shared_tree)
           or fi.folder_id in (select id from owned_tree)
           or exists (
             select 1 from public.user_connections c
             where c.owner_id = fi.owner_id and c.related_user_id = (select uid from me)
           )
        then 'shared'
      when fi.is_public then 'public'
      else 'link'
    end
  from public.files fi
  where (select uid from me) is not null
    and fi.deleted_at is null
    and (
      fi.owner_id = (select uid from me)
      or fi.is_public
      or exists (
        select 1 from public.file_shares s
        where s.file_id = fi.id and s.grantee_id = (select uid from me)
      )
      or fi.folder_id in (select id from shared_tree)
      or fi.folder_id in (select id from owned_tree)
      or exists (
        select 1 from public.user_connections c
        where c.owner_id = fi.owner_id and c.related_user_id = (select uid from me)
      )
      or exists (
        select 1 from public.share_link_access l
        where l.file_id = fi.id and l.user_id = (select uid from me) and l.expires_at > now()
      )
    );
$$;

-- =============================================
-- 2. Trash purge matches the trash list
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
  with recursive
  -- the caller's trashed folders that list_trash() shows (parent not trashed)
  roots as (
    select f.id
    from public.folders f
    where f.owner_id = auth.uid()
      and f.deleted_at is not null
      and (f.parent_id is null
           or not exists (select 1 from public.folders p
                          where p.id = f.parent_id and p.deleted_at is not null))
  ),
  tree as (
    select id from roots
    union
    select child.id from public.folders child join tree t on child.parent_id = t.id
  )
  select fv.storage_path
  from public.file_versions fv
  join public.files fi on fi.id = fv.file_id
  where fi.deleted_at is not null
    and (
      -- files inside the caller's trashed folders, whoever uploaded them
      fi.folder_id in (select id from tree)
      -- the caller's own files trashed on their own (shown in list_trash)
      or (fi.owner_id = auth.uid()
          and (fi.folder_id is null
               or not exists (select 1 from public.folders p
                              where p.id = fi.folder_id and p.deleted_at is not null)))
    );
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

  -- Same items as list_trash()/get_trash_storage_paths(): never purge a file
  -- that sits inside someone else's trashed folder (it is not in my trash
  -- list, and that folder's owner may still restore it).
  with recursive
  roots as (
    select f.id
    from public.folders f
    where f.owner_id = auth.uid()
      and f.deleted_at is not null
      and (f.parent_id is null
           or not exists (select 1 from public.folders p
                          where p.id = f.parent_id and p.deleted_at is not null))
  ),
  tree as (
    select id from roots
    union
    select child.id from public.folders child join tree t on child.parent_id = t.id
  ),
  removed as (
    delete from public.files fi
    where fi.deleted_at is not null
      and (
        fi.folder_id in (select id from tree)
        or (fi.owner_id = auth.uid()
            and (fi.folder_id is null
                 or not exists (select 1 from public.folders p
                                where p.id = fi.folder_id and p.deleted_at is not null)))
      )
    returning 1
  )
  select count(*) into files_deleted from removed;

  with removed as (
    delete from public.folders f
    where f.owner_id = auth.uid()
      and f.deleted_at is not null
      and (f.parent_id is null
           or not exists (select 1 from public.folders p
                          where p.id = f.parent_id and p.deleted_at is not null))
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
-- 3. Admin shares can only be changed by the owner
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

  insert into public.file_shares (file_id, grantee_id, role, granted_by)
  values (p_file_id, grantee, p_role, auth.uid())
  on conflict (file_id, grantee_id)
  do update set role = excluded.role, granted_by = excluded.granted_by
  returning * into new_share;

  return new_share;
end;
$$;

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

-- =============================================
-- 4. Breadcrumbs
-- =============================================
create or replace function public.get_folder_ancestors(p_id uuid)
returns table (id uuid, name text, parent_id uuid)
language plpgsql stable security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.has_folder_access(p_id, 'viewer') then
    raise exception 'You do not have permission to view this folder';
  end if;

  return query
  with recursive chain as (
    select f.id, f.name, f.parent_id, 1 as depth
    from public.folders f
    where f.id = p_id
    union all
    select f.id, f.name, f.parent_id, c.depth + 1
    from public.folders f
    join chain c on c.parent_id = f.id
    -- stop at the first folder the caller cannot open, so a shared folder
    -- does not reveal the names of the owner's private parent folders
    where f.deleted_at is null
      and public.has_folder_access(f.id, 'viewer')
  )
  select c.id, c.name, c.parent_id
  from chain c
  order by c.depth desc;
end;
$$;

-- =============================================
-- 5. Sizes come from storage
-- =============================================
create or replace function public.uploaded_object_size(p_storage_path text, p_claimed_size bigint)
returns bigint
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_found boolean := false;
  v_size bigint;
begin
  begin
    select true, nullif(o.metadata ->> 'size', '')::bigint
    into v_found, v_size
    from storage.objects o
    where o.bucket_id = 'uploads' and o.name = p_storage_path;
  exception
    -- storage schema not readable here: keep the previous behaviour rather
    -- than blocking every upload
    when insufficient_privilege or undefined_table or undefined_column then
      return greatest(coalesce(p_claimed_size, 0), 0);
  end;

  if not coalesce(v_found, false) then
    raise exception 'Uploaded file not found in storage';
  end if;
  return greatest(coalesce(v_size, p_claimed_size, 0), 0);
end;
$$;
revoke execute on function public.uploaded_object_size(text, bigint) from public, anon, authenticated;

create or replace function public.register_file(
  p_id uuid,
  p_folder_id uuid,
  p_name text,
  p_original_name text,
  p_extension text,
  p_mime_type text,
  p_size bigint,
  p_storage_path text,
  p_checksum text default null,
  p_version_id uuid default null
)
returns public.files
language plpgsql security definer
set search_path = public
as $$
declare
  new_file public.files%rowtype;
  version_id uuid := coalesce(p_version_id, gen_random_uuid());
  trimmed text := trim(coalesce(p_name, ''));
  v_size bigint;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if trimmed = '' then
    raise exception 'File name is required';
  end if;
  if p_folder_id is not null then
    if not public.has_folder_access(p_folder_id, 'editor') then
      raise exception 'You do not have permission to upload here';
    end if;
    if exists (
      select 1 from public.folders where id = p_folder_id and deleted_at is not null
    ) then
      raise exception 'Cannot upload into a deleted folder';
    end if;
  end if;

  v_size := public.uploaded_object_size(p_storage_path, p_size);
  perform public.assert_storage_quota(auth.uid(), v_size);

  insert into public.files (id, folder_id, owner_id, name, original_name, extension, mime_type, size, checksum)
  values (
    p_id, p_folder_id, auth.uid(), trimmed,
    coalesce(nullif(trim(p_original_name), ''), trimmed),
    lower(coalesce(p_extension, '')),
    coalesce(nullif(p_mime_type, ''), 'application/octet-stream'),
    v_size, p_checksum
  )
  returning * into new_file;

  insert into public.file_versions (id, file_id, version_no, storage_path, size, mime_type, checksum, uploaded_by)
  values (version_id, p_id, 1, p_storage_path, v_size, new_file.mime_type, p_checksum, auth.uid());

  update public.files set current_version_id = version_id where id = p_id;
  new_file.current_version_id := version_id;

  return new_file;
end;
$$;

create or replace function public.add_file_version(
  p_file_id uuid,
  p_storage_path text,
  p_size bigint,
  p_mime_type text,
  p_checksum text default null,
  p_version_id uuid default null
)
returns public.file_versions
language plpgsql security definer
set search_path = public
as $$
declare
  new_version public.file_versions%rowtype;
  version_id uuid := coalesce(p_version_id, gen_random_uuid());
  next_no integer;
  file_owner uuid;
  v_size bigint;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.has_file_access(p_file_id, 'editor') then
    raise exception 'You do not have permission to update this file';
  end if;

  select owner_id into file_owner
  from public.files
  where id = p_file_id;
  if not found then
    raise exception 'File not found';
  end if;
  if exists (
    select 1 from public.files where id = p_file_id and deleted_at is not null
  ) then
    raise exception 'Cannot add a version to a deleted file';
  end if;

  v_size := public.uploaded_object_size(p_storage_path, p_size);
  perform public.assert_storage_quota(file_owner, v_size);

  select coalesce(max(version_no), 0) + 1 into next_no
  from public.file_versions
  where file_id = p_file_id;

  insert into public.file_versions (id, file_id, version_no, storage_path, size, mime_type, checksum, uploaded_by)
  values (
    version_id, p_file_id, next_no, p_storage_path, v_size,
    coalesce(nullif(p_mime_type, ''), 'application/octet-stream'), p_checksum, auth.uid()
  )
  returning * into new_version;

  update public.files
  set current_version_id = version_id,
      size = new_version.size,
      mime_type = new_version.mime_type,
      checksum = coalesce(new_version.checksum, checksum)
  where id = p_file_id;

  return new_version;
end;
$$;
