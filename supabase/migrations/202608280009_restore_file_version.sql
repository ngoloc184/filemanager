-- Phase 4: file versioning support
-- restore_file_version: point current_version_id back at an older version.
-- This is a pointer swap only; every version row and storage object is kept,
-- so no historical data is ever overwritten or lost.
-- Run after 202608280008. Idempotent.

create or replace function public.restore_file_version(p_file_id uuid, p_version_id uuid)
returns public.file_versions
language plpgsql security definer
set search_path = public
as $$
declare
  fi public.files%rowtype;
  target public.file_versions%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.has_file_access(p_file_id, 'editor') then
    raise exception 'You do not have permission to update this file';
  end if;

  select * into fi from public.files where id = p_file_id;
  if not found then
    raise exception 'File not found';
  end if;
  if fi.deleted_at is not null then
    raise exception 'Cannot restore a version of a deleted file';
  end if;

  select * into target
  from public.file_versions
  where id = p_version_id and file_id = p_file_id;
  if not found then
    raise exception 'Version not found for this file';
  end if;

  update public.files
  set current_version_id = target.id,
      size = target.size,
      mime_type = target.mime_type,
      checksum = target.checksum
  where id = p_file_id;

  return target;
end;
$$;

grant execute on function public.restore_file_version(uuid, uuid) to authenticated;
