-- Phase 5: storage quota and usage tracking.
-- Quota is counted per file owner: all file_versions belonging to files owned by a user
-- count toward that user's quota, including files currently in trash.
-- Run after 202608280009. Idempotent.

alter table public.user_profiles
  add column if not exists storage_quota_bytes bigint not null default 1073741824;

create or replace function public.get_user_storage_usage_bytes(p_user_id uuid)
returns bigint
language sql stable security definer
set search_path = public
as $$
  select coalesce(sum(fv.size), 0)
  from public.file_versions fv
  join public.files fi on fi.id = fv.file_id
  where fi.owner_id = p_user_id;
$$;

create or replace function public.get_user_storage_quota_bytes(p_user_id uuid)
returns bigint
language sql stable security definer
set search_path = public
as $$
  select coalesce(
    (select up.storage_quota_bytes from public.user_profiles up where up.id = p_user_id),
    1073741824
  );
$$;

create or replace function public.assert_storage_quota(p_user_id uuid, p_additional_bytes bigint)
returns void
language plpgsql stable security definer
set search_path = public
as $$
declare
  used_bytes bigint;
  quota_bytes bigint;
begin
  if coalesce(p_additional_bytes, 0) <= 0 then
    return;
  end if;

  used_bytes := public.get_user_storage_usage_bytes(p_user_id);
  quota_bytes := public.get_user_storage_quota_bytes(p_user_id);

  if used_bytes + p_additional_bytes > quota_bytes then
    raise exception 'Storage quota exceeded: used % bytes, quota % bytes, attempted % bytes',
      used_bytes, quota_bytes, p_additional_bytes;
  end if;
end;
$$;

create or replace function public.get_storage_quota()
returns table (used_bytes bigint, quota_bytes bigint)
language sql stable security definer
set search_path = public
as $$
  select public.get_user_storage_usage_bytes(auth.uid()),
         public.get_user_storage_quota_bytes(auth.uid());
$$;

grant execute on function public.get_user_storage_usage_bytes(uuid) to authenticated;
grant execute on function public.get_user_storage_quota_bytes(uuid) to authenticated;
grant execute on function public.assert_storage_quota(uuid, bigint) to authenticated;
grant execute on function public.get_storage_quota() to authenticated;

-- Replace register_file with quota enforcement.
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

  perform public.assert_storage_quota(auth.uid(), coalesce(p_size, 0));

  insert into public.files (id, folder_id, owner_id, name, original_name, extension, mime_type, size, checksum)
  values (
    p_id, p_folder_id, auth.uid(), trimmed,
    coalesce(nullif(trim(p_original_name), ''), trimmed),
    lower(coalesce(p_extension, '')),
    coalesce(nullif(p_mime_type, ''), 'application/octet-stream'),
    coalesce(p_size, 0), p_checksum
  )
  returning * into new_file;

  insert into public.file_versions (id, file_id, version_no, storage_path, size, mime_type, checksum, uploaded_by)
  values (version_id, p_id, 1, p_storage_path, coalesce(p_size, 0), new_file.mime_type, p_checksum, auth.uid());

  update public.files set current_version_id = version_id where id = p_id;
  new_file.current_version_id := version_id;

  return new_file;
end;
$$;

-- Replace add_file_version with quota enforcement against the file owner.
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

  perform public.assert_storage_quota(file_owner, coalesce(p_size, 0));

  select coalesce(max(version_no), 0) + 1 into next_no
  from public.file_versions
  where file_id = p_file_id;

  insert into public.file_versions (id, file_id, version_no, storage_path, size, mime_type, checksum, uploaded_by)
  values (
    version_id, p_file_id, next_no, p_storage_path, coalesce(p_size, 0),
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

-- Replace copy_file with quota enforcement for the user creating the copy.
create or replace function public.copy_file(
  p_id uuid,
  p_folder_id uuid,
  p_name text,
  p_storage_path text,
  p_new_id uuid default null
)
returns public.files
language plpgsql security definer
set search_path = public
as $$
declare
  src public.files%rowtype;
  src_version public.file_versions%rowtype;
  new_file public.files%rowtype;
  new_id uuid := coalesce(p_new_id, gen_random_uuid());
  version_id uuid := gen_random_uuid();
  trimmed text := trim(coalesce(p_name, ''));
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  select * into src from public.files where id = p_id;
  if not found then
    raise exception 'File not found';
  end if;
  if not public.has_file_access(p_id, 'viewer') then
    raise exception 'You do not have permission to copy this file';
  end if;
  if p_folder_id is not null then
    if not public.has_folder_access(p_folder_id, 'editor') then
      raise exception 'You do not have permission to copy files there';
    end if;
  end if;
  if trimmed = '' then
    trimmed := src.name;
  end if;

  select * into src_version
  from public.file_versions
  where file_id = p_id and id = src.current_version_id;
  if not found then
    raise exception 'File has no version to copy';
  end if;

  perform public.assert_storage_quota(auth.uid(), src_version.size);

  insert into public.files (id, folder_id, owner_id, name, original_name, extension, mime_type, size, checksum, is_public)
  values (new_id, p_folder_id, auth.uid(), trimmed, src.original_name, src.extension,
          src.mime_type, src.size, src.checksum, false)
  returning * into new_file;

  insert into public.file_versions (id, file_id, version_no, storage_path, size, mime_type, checksum, uploaded_by)
  values (version_id, new_id, 1, p_storage_path, src_version.size, src_version.mime_type, src_version.checksum, auth.uid());

  update public.files set current_version_id = version_id where id = new_id;
  new_file.current_version_id := version_id;

  return new_file;
end;
$$;

grant execute on function public.register_file(uuid, uuid, text, text, text, text, bigint, text, text, uuid) to authenticated;
grant execute on function public.add_file_version(uuid, text, bigint, text, text, uuid) to authenticated;
grant execute on function public.copy_file(uuid, uuid, text, text, uuid) to authenticated;
