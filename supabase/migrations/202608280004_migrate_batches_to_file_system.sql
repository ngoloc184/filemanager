-- One-time data migration: upload_batches -> folders, uploaded_files -> files + file_versions.
-- Run after 202608280003_core_file_system.sql:
--   select public.migrate_batches_to_file_system();
-- Idempotent: safe to re-run. Legacy tables are never modified or dropped.

create or replace function public.migrate_batches_to_file_system()
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  b record;
  f record;
  v_folder uuid;
  v_file uuid;
  v_version uuid;
  v_name text;
  v_suffix integer;
  v_ext text;
  folders_created integer := 0;
  files_created integer := 0;
begin
  -- auth.uid() is null in the SQL Editor (runs as postgres/supabase_admin);
  -- allow those roles, block unauthenticated API connections
  if auth.uid() is null
     and current_user not in ('postgres', 'supabase_admin') then
    raise exception 'Authentication required';
  end if;

  -- preserve migrated timestamps (handle_updated_at would overwrite them)
  alter table public.folders disable trigger folders_set_updated_at;
  alter table public.files disable trigger files_set_updated_at;

  begin
    for b in select * from public.upload_batches order by created_at loop
      select id into v_folder from public.folders where legacy_batch_id = b.id;
      if v_folder is null then
        v_name := coalesce(nullif(trim(b.title), ''), 'Imported batch');
        v_suffix := 1;
        while exists (
          select 1 from public.folders
          where owner_id = b.created_by
            and parent_id is null
            and lower(name) = lower(v_name)
            and deleted_at is null
        ) loop
          v_suffix := v_suffix + 1;
          v_name := coalesce(nullif(trim(b.title), ''), 'Imported batch') || ' (' || v_suffix || ')';
        end loop;

        insert into public.folders (owner_id, name, comment, legacy_batch_id, created_at, updated_at)
        values (b.created_by, v_name, b.comment, b.id, b.created_at, coalesce(b.updated_at, b.created_at))
        returning id into v_folder;
        folders_created := folders_created + 1;
      end if;

      for f in select * from public.uploaded_files where batch_id = b.id order by uploaded_at loop
        if exists (select 1 from public.files where legacy_file_id = f.id) then
          continue;
        end if;

        v_ext := case
          when position('.' in f.original_filename) > 0
            then lower(reverse(split_part(reverse(f.original_filename), '.', 1)))
          else ''
        end;
        if length(v_ext) > 20 then
          v_ext := '';
        end if;

        insert into public.files (
          folder_id, owner_id, name, original_name, extension, mime_type, size,
          is_public, legacy_file_id, created_at, updated_at
        )
        values (
          v_folder, b.created_by, f.original_filename, f.original_filename, v_ext,
          coalesce(nullif(f.mime_type, ''), 'application/octet-stream'),
          coalesce(f.file_size, 0), coalesce(f.is_public, false), f.id,
          f.uploaded_at, f.uploaded_at
        )
        returning id into v_file;

        insert into public.file_versions (file_id, version_no, storage_path, size, mime_type, uploaded_by, created_at)
        values (
          v_file, 1, f.storage_path, coalesce(f.file_size, 0),
          coalesce(nullif(f.mime_type, ''), 'application/octet-stream'),
          b.created_by, f.uploaded_at
        )
        returning id into v_version;

        update public.files set current_version_id = v_version where id = v_file;
        files_created := files_created + 1;
      end loop;
    end loop;

  exception when others then
    alter table public.folders enable trigger folders_set_updated_at;
    alter table public.files enable trigger files_set_updated_at;
    raise;
  end;

  alter table public.folders enable trigger folders_set_updated_at;
  alter table public.files enable trigger files_set_updated_at;

  return jsonb_build_object(
    'folders_created', folders_created,
    'files_created', files_created
  );
end;
$$;

grant execute on function public.migrate_batches_to_file_system() to authenticated;
