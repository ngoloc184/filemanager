-- Storage hygiene: delete old versions, trash auto-purge, orphan cleanup,
-- and unregistered uploads count against the quota (audit orphan.sql).
-- Run after 202608280035_notifications.sql (036 is another task's).
-- Idempotent: create or replace / drop ... if exists only.
--
-- 1. delete_file_version(version_id) -> storage_path (client RPC). An admin
--    of the file deletes one old (not current) version. The row goes; the
--    client then removes the object (policy 6b allows it for the uploader;
--    otherwise the orphan job removes it within a day). Refused for a file
--    attached to a frozen document (document_files, when that table exists).
--    Logged as activity 'file.version_deleted'. Returns null when another
--    version row still points at the same object (nothing to remove).
-- 2. purge_old_trash(days, limit) (service_role only, /api/cron/cleanup):
--    hard-deletes trashed files older than the cutoff, plus trashed files
--    inside folders trashed before the cutoff, one file at a time. A file a
--    trigger refuses to delete (frozen document file, legal hold) is skipped
--    with a WARNING and the rest continue. Returns (file_id, storage_path) of
--    the files really deleted (versions cascade), then deletes the folders
--    trashed before the cutoff that are now empty (leaves first).
-- 3. storage_orphan_candidates(older_than, limit) (service_role only):
--    objects in bucket 'uploads' under a per-user namespace ('<uuid>/...')
--    older than the cutoff (at least 1 hour, default 24 h) that no row
--    references: file_versions, superapp_files (013-015; SuperApp objects
--    live under 'superapp/' and 'superapp-v/' and are never candidates
--    anyway), legacy uploaded_files, or a legacy upload batch folder
--    ('<batch id>/...').
-- 4. get_user_storage_usage_bytes(user) (internal, grants from 030 kept by
--    create or replace) also counts objects in the user's namespace
--    ('<user id>/...') that no file_versions row references, so an object
--    uploaded and never registered no longer bypasses the quota. The storage
--    part falls back to 0 when storage.objects is not readable (as
--    uploaded_object_size does in 022).
--    [Unverified] How fast a storage.objects prefix scan is on the hosted
--    bucket; "name like '<uuid>/%'" lets the planner use a (bucket_id, name)
--    index if one exists.
-- 5. assert_storage_quota (internal, grants kept): an upload is stored
--    before it is registered, so at register time the object is already
--    counted by (4). When an unregistered object of exactly the attempted
--    size exists in the owner's namespace, it is counted once, not twice.
--    Without this, a 3 GB upload with 6 GB used of 10 GB would be refused.
--    At worst (owner has an unrelated orphan of that exact size) one check
--    is short by one object; every later check counts everything.
-- 6. Storage policies on storage.objects:
--    a. "Users can upload to their own namespace" (003) also requires the
--       buildStoragePath shape '<uid>/<uuid>/<uuid>/<name>' (src/lib/storage.ts).
--       Every client upload into 'uploads' uses it: services/uploads.ts
--       (uploads and new versions), services/files.ts copyFile (storage copy
--       to a buildStoragePath key), lib/agent/tools.ts and
--       api/assistant/action (exports, copies). Text files are saved through
--       services/uploads.ts. SuperApp uploads ('superapp/...',
--       'superapp-v/...') use the service role, which bypasses RLS. No other
--       shape needed, so the regex is not widened.
--    b. New "Users can delete their own unregistered uploads": the uploader
--       may remove an object in their own namespace that no row references
--       (a failed registration, or a version just deleted through (1)).
--       The check runs through the definer helper is_own_unregistered_upload
--       so file_versions RLS cannot hide a row the caller cannot read.
--       Storage deletes with a WHERE clause, so the matching SELECT policy
--       "Users can read their own unregistered uploads" is added too.
--
-- Rollback:
--   drop function if exists public.delete_file_version(uuid);
--   drop function if exists public.purge_old_trash(integer, integer);
--   drop function if exists public.storage_orphan_candidates(interval, integer);
--   drop policy if exists "Users can delete their own unregistered uploads" on storage.objects;
--   drop policy if exists "Users can read their own unregistered uploads" on storage.objects;
--   drop function if exists public.is_own_unregistered_upload(text);
--   re-run get_user_storage_usage_bytes / assert_storage_quota from
--   202608280010_storage_quota.sql (then the 030 revoke loop for them) and
--   the "Users can upload to their own namespace" policy from 003.

-- =============================================
-- 1. Delete one old version
-- =============================================
create or replace function public.delete_file_version(p_version_id uuid)
returns text
language plpgsql security definer
set search_path = public
as $$
declare
  v public.file_versions%rowtype;
  fi public.files%rowtype;
  v_frozen boolean := false;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into v from public.file_versions where id = p_version_id;
  if not found then
    raise exception 'Version not found';
  end if;
  if not public.has_file_access(v.file_id, 'admin') then
    raise exception 'You do not have permission to delete versions of this file'
      using errcode = '42501';
  end if;

  -- lock the file: a concurrent restore_file_version must not make this
  -- version current while it is being deleted (the FK would null it)
  select * into fi from public.files where id = v.file_id for update;
  if fi.current_version_id = v.id then
    raise exception 'The current version cannot be deleted';
  end if;

  -- documents module (202608280036) may not be installed yet
  if to_regclass('public.document_files') is not null then
    execute 'select exists (select 1 from public.document_files df where df.file_id = $1 and df.frozen)'
      into v_frozen using v.file_id;
  end if;
  if v_frozen then
    raise exception 'This file is locked because the document was registered or issued';
  end if;

  delete from public.file_versions where id = v.id;

  perform public.log_activity(
    'file.version_deleted', 'file', fi.id, fi.name, fi.owner_id,
    jsonb_build_object('version_id', v.id, 'version_no', v.version_no, 'size', v.size)
  );

  -- the object stays when another version still points at it
  if exists (select 1 from public.file_versions o where o.storage_path = v.storage_path) then
    return null;
  end if;
  return v.storage_path;
end;
$$;

revoke all on function public.delete_file_version(uuid) from public, anon;
grant execute on function public.delete_file_version(uuid) to authenticated, service_role;

-- =============================================
-- 2. Trash auto-purge (cron)
-- =============================================
create or replace function public.purge_old_trash(p_days integer default 30, p_limit integer default 500)
returns table (file_id uuid, storage_path text)
language plpgsql security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_cutoff timestamptz := now() - make_interval(days => greatest(coalesce(p_days, 30), 0));
  v_file uuid;
  v_folder uuid;
  v_paths text[];
  v_path text;
  v_count integer;
begin
  for v_file in
    with recursive old_tree as (
      select f.id from public.folders f where f.deleted_at < v_cutoff
      union
      select c.id from public.folders c join old_tree t on c.parent_id = t.id
    )
    select fi.id
    from public.files fi
    where fi.deleted_at is not null
      and (fi.deleted_at < v_cutoff or fi.folder_id in (select ot.id from old_tree ot))
    order by fi.deleted_at, fi.id
    limit greatest(coalesce(p_limit, 500), 0)
  loop
    begin
      select coalesce(array_agg(distinct fv.storage_path), '{}'::text[]) into v_paths
      from public.file_versions fv
      where fv.file_id = v_file;

      -- versions cascade (file_versions.file_id on delete cascade)
      delete from public.files fi where fi.id = v_file;

      foreach v_path in array v_paths loop
        -- an object another remaining version points at must stay
        if not exists (select 1 from public.file_versions fv where fv.storage_path = v_path) then
          file_id := v_file;
          storage_path := v_path;
          return next;
        end if;
      end loop;
    exception
      when others then
        raise warning 'purge_old_trash: file % skipped: %', v_file, sqlerrm;
    end;
  end loop;

  -- trashed folders past the cutoff that are now empty, leaves first; one
  -- folder at a time so a refused folder does not keep the others
  loop
    v_count := 0;
    for v_folder in
      select f.id from public.folders f
      where f.deleted_at < v_cutoff
        and not exists (select 1 from public.files x where x.folder_id = f.id)
        and not exists (select 1 from public.folders c where c.parent_id = f.id)
    loop
      begin
        delete from public.folders f where f.id = v_folder;
        v_count := v_count + 1;
      exception
        when others then
          raise warning 'purge_old_trash: folder % skipped: %', v_folder, sqlerrm;
      end;
    end loop;
    exit when v_count = 0;
  end loop;
end;
$$;

revoke all on function public.purge_old_trash(integer, integer) from public, anon, authenticated;
grant execute on function public.purge_old_trash(integer, integer) to service_role;

-- =============================================
-- 3. Orphan objects (cron)
-- =============================================
create or replace function public.storage_orphan_candidates(
  p_older_than interval default interval '24 hours',
  p_limit integer default 500
)
returns table (name text)
language plpgsql stable security definer
set search_path = public
as $$
begin
  return query
  select o.name::text
  from storage.objects o
  where o.bucket_id = 'uploads'
    -- never touch an upload that may still be registering
    and o.created_at < now() - greatest(coalesce(p_older_than, interval '24 hours'), interval '1 hour')
    -- per-user namespace only ('<uuid>/...'); SuperApp and anything else stay
    and o.name ~ '^[0-9a-f-]{36}/'
    and not exists (select 1 from public.file_versions fv where fv.storage_path = o.name)
    and not exists (select 1 from public.superapp_files s where s.storage_path = o.name)
    and not exists (select 1 from public.uploaded_files u where u.storage_path = o.name)
    and not exists (select 1 from public.upload_batches b where b.id::text = split_part(o.name, '/', 1))
  order by o.created_at
  limit greatest(coalesce(p_limit, 500), 0);
end;
$$;

revoke all on function public.storage_orphan_candidates(interval, integer) from public, anon, authenticated;
grant execute on function public.storage_orphan_candidates(interval, integer) to service_role;

-- =============================================
-- 4. Usage counts unregistered uploads
-- =============================================
create or replace function public.get_user_storage_usage_bytes(p_user_id uuid)
returns bigint
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_registered bigint;
  v_unregistered bigint := 0;
begin
  select coalesce(sum(fv.size), 0) into v_registered
  from public.file_versions fv
  join public.files fi on fi.id = fv.file_id
  where fi.owner_id = p_user_id;

  if p_user_id is null then
    return v_registered;
  end if;

  begin
    select coalesce(sum(
      case when o.metadata ->> 'size' ~ '^[0-9]{1,18}$' then (o.metadata ->> 'size')::bigint else 0 end
    ), 0) into v_unregistered
    from storage.objects o
    where o.bucket_id = 'uploads'
      and o.name like p_user_id::text || '/%'
      and not exists (select 1 from public.file_versions fv where fv.storage_path = o.name);
  exception
    -- storage schema not readable here: count registered versions only
    when insufficient_privilege or undefined_table or undefined_column then
      v_unregistered := 0;
  end;

  return v_registered + v_unregistered;
end;
$$;

-- =============================================
-- 5. Quota check does not count the upload being registered twice
-- =============================================
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

  -- the object being registered was uploaded first and is already in
  -- used_bytes as an unregistered upload of this size
  begin
    if p_user_id is not null and exists (
      select 1 from storage.objects o
      where o.bucket_id = 'uploads'
        and o.name like p_user_id::text || '/%'
        and o.metadata ->> 'size' = p_additional_bytes::text
        and not exists (select 1 from public.file_versions fv where fv.storage_path = o.name)
    ) then
      used_bytes := greatest(used_bytes - p_additional_bytes, 0);
    end if;
  exception
    when insufficient_privilege or undefined_table or undefined_column then
      null;
  end;

  if used_bytes + p_additional_bytes > quota_bytes then
    raise exception 'Storage quota exceeded: used % bytes, quota % bytes, attempted % bytes',
      used_bytes, quota_bytes, p_additional_bytes;
  end if;
end;
$$;

-- =============================================
-- 6. Storage policies
-- =============================================
drop policy if exists "Users can upload to their own namespace" on storage.objects;
create policy "Users can upload to their own namespace"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
    -- buildStoragePath: <uid>/<file id>/<version id>/<sanitized name>
    and name ~ ('^' || auth.uid()::text || '/[0-9a-f-]{36}/[0-9a-f-]{36}/[^/]+$')
  );

-- RLS helper (called by the policy below as the caller): true when the
-- object is in the caller's own namespace and no row references it.
create or replace function public.is_own_unregistered_upload(p_name text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select auth.uid() is not null
    and p_name like auth.uid()::text || '/%'
    and not exists (select 1 from public.file_versions fv where fv.storage_path = p_name)
    and not exists (select 1 from public.superapp_files s where s.storage_path = p_name)
    and not exists (select 1 from public.uploaded_files u where u.storage_path = p_name);
$$;

revoke all on function public.is_own_unregistered_upload(text) from public, anon;
grant execute on function public.is_own_unregistered_upload(text) to authenticated, service_role;

-- a delete with a WHERE clause (what Storage runs) also needs the rows to
-- pass a SELECT policy
drop policy if exists "Users can read their own unregistered uploads" on storage.objects;
create policy "Users can read their own unregistered uploads"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'uploads'
    and public.is_own_unregistered_upload(name)
  );

drop policy if exists "Users can delete their own unregistered uploads" on storage.objects;
create policy "Users can delete their own unregistered uploads"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'uploads'
    and public.is_own_unregistered_upload(name)
  );
