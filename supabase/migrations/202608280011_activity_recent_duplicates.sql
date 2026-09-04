-- Phase 6: activity log, recent files, duplicate detection.
-- Activity is written by database triggers so the audit trail cannot be bypassed by the UI.
-- Run after 202608280010. Idempotent.

create table if not exists public.activity_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references auth.users(id) on delete cascade,
  owner_id uuid references auth.users(id) on delete cascade,
  action text not null,
  resource_type text not null check (resource_type in ('file', 'folder', 'share', 'link')),
  resource_id uuid,
  resource_name text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_activity_events_actor
  on public.activity_events(actor_id, created_at desc);
create index if not exists idx_activity_events_owner
  on public.activity_events(owner_id, created_at desc);

alter table public.activity_events enable row level security;

drop policy if exists "activity_events_select" on public.activity_events;
create policy "activity_events_select"
  on public.activity_events for select to authenticated
  using (actor_id = auth.uid() or owner_id = auth.uid());

create or replace function public.log_activity(
  p_action text,
  p_resource_type text,
  p_resource_id uuid,
  p_resource_name text,
  p_owner_id uuid,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return;
  end if;

  insert into public.activity_events (
    actor_id, owner_id, action, resource_type, resource_id, resource_name, metadata
  ) values (
    auth.uid(), p_owner_id, p_action, p_resource_type, p_resource_id, p_resource_name,
    coalesce(p_metadata, '{}'::jsonb)
  );
exception
  when others then
    null;
end;
$$;

-- No grant to authenticated: activity must only be written by trusted server-side functions/triggers.

-- =============================================
-- Files trigger
-- =============================================
create or replace function public.activity_files_trigger_fn()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_activity(
      'file.created', 'file', new.id, new.name, new.owner_id,
      jsonb_build_object('size', new.size, 'mime_type', new.mime_type)
    );
  elsif tg_op = 'UPDATE' then
    if old.deleted_at is null and new.deleted_at is not null then
      perform public.log_activity(
        'file.deleted', 'file', new.id, new.name, new.owner_id,
        jsonb_build_object('deleted_by', new.deleted_by)
      );
    elsif old.deleted_at is not null and new.deleted_at is null then
      perform public.log_activity(
        'file.restored', 'file', new.id, new.name, new.owner_id, '{}'::jsonb
      );
    elsif old.folder_id is distinct from new.folder_id then
      perform public.log_activity(
        'file.moved', 'file', new.id, new.name, new.owner_id,
        jsonb_build_object('from_folder_id', old.folder_id, 'to_folder_id', new.folder_id)
      );
    elsif old.name is distinct from new.name then
      perform public.log_activity(
        'file.renamed', 'file', new.id, new.name, new.owner_id,
        jsonb_build_object('old_name', old.name)
      );
    elsif old.is_public is distinct from new.is_public then
      perform public.log_activity(
        'file.visibility_changed', 'file', new.id, new.name, new.owner_id,
        jsonb_build_object('is_public', new.is_public)
      );
    end if;
  elsif tg_op = 'DELETE' then
    perform public.log_activity(
      'file.hard_deleted', 'file', old.id, old.name, old.owner_id, '{}'::jsonb
    );
  end if;

  return null;
exception
  when others then
    return null;
end;
$$;

drop trigger if exists activity_files on public.files;
create trigger activity_files
  after insert or update or delete on public.files
  for each row execute function public.activity_files_trigger_fn();

-- =============================================
-- Folders trigger
-- =============================================
create or replace function public.activity_folders_trigger_fn()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_activity(
      'folder.created', 'folder', new.id, new.name, new.owner_id,
      jsonb_build_object('parent_id', new.parent_id)
    );
  elsif tg_op = 'UPDATE' then
    if old.deleted_at is null and new.deleted_at is not null then
      perform public.log_activity(
        'folder.deleted', 'folder', new.id, new.name, new.owner_id,
        jsonb_build_object('deleted_by', new.deleted_by)
      );
    elsif old.deleted_at is not null and new.deleted_at is null then
      perform public.log_activity(
        'folder.restored', 'folder', new.id, new.name, new.owner_id, '{}'::jsonb
      );
    elsif old.parent_id is distinct from new.parent_id then
      perform public.log_activity(
        'folder.moved', 'folder', new.id, new.name, new.owner_id,
        jsonb_build_object('from_parent_id', old.parent_id, 'to_parent_id', new.parent_id)
      );
    elsif old.name is distinct from new.name then
      perform public.log_activity(
        'folder.renamed', 'folder', new.id, new.name, new.owner_id,
        jsonb_build_object('old_name', old.name)
      );
    end if;
  elsif tg_op = 'DELETE' then
    perform public.log_activity(
      'folder.hard_deleted', 'folder', old.id, old.name, old.owner_id, '{}'::jsonb
    );
  end if;

  return null;
exception
  when others then
    return null;
end;
$$;

drop trigger if exists activity_folders on public.folders;
create trigger activity_folders
  after insert or update or delete on public.folders
  for each row execute function public.activity_folders_trigger_fn();

-- =============================================
-- File versions trigger (new versions only; initial version is covered by file.created)
-- =============================================
create or replace function public.activity_file_versions_trigger_fn()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_name text;
begin
  if tg_op = 'INSERT' and new.version_no > 1 then
    select fi.owner_id, fi.name into v_owner, v_name
    from public.files fi
    where fi.id = new.file_id;

    if found then
      perform public.log_activity(
        'file.version_added', 'file', new.file_id, v_name, v_owner,
        jsonb_build_object('version_id', new.id, 'version_no', new.version_no, 'size', new.size)
      );
    end if;
  end if;

  return null;
exception
  when others then
    return null;
end;
$$;

drop trigger if exists activity_file_versions on public.file_versions;
create trigger activity_file_versions
  after insert on public.file_versions
  for each row execute function public.activity_file_versions_trigger_fn();

-- =============================================
-- Share triggers
-- =============================================
create or replace function public.activity_file_shares_trigger_fn()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_name text;
  v_email text;
  rec public.file_shares%rowtype;
begin
  if tg_op = 'DELETE' then
    rec := old;
  else
    rec := new;
  end if;

  select fi.owner_id, fi.name into v_owner, v_name
  from public.files fi
  where fi.id = rec.file_id;

  select up.email into v_email
  from public.user_profiles up
  where up.id = rec.grantee_id;

  if tg_op = 'INSERT' then
    perform public.log_activity(
      'share.granted', 'share', rec.file_id, v_name, v_owner,
      jsonb_build_object('resource', 'file', 'grantee_email', v_email, 'role', rec.role)
    );
  elsif tg_op = 'UPDATE' and old.role is distinct from new.role then
    perform public.log_activity(
      'share.updated', 'share', new.file_id, v_name, v_owner,
      jsonb_build_object('resource', 'file', 'grantee_email', v_email, 'old_role', old.role, 'role', new.role)
    );
  elsif tg_op = 'DELETE' then
    perform public.log_activity(
      'share.revoked', 'share', old.file_id, v_name, v_owner,
      jsonb_build_object('resource', 'file', 'grantee_email', v_email, 'role', old.role)
    );
  end if;

  return null;
exception
  when others then
    return null;
end;
$$;

drop trigger if exists activity_file_shares on public.file_shares;
create trigger activity_file_shares
  after insert or update or delete on public.file_shares
  for each row execute function public.activity_file_shares_trigger_fn();

create or replace function public.activity_folder_shares_trigger_fn()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_name text;
  v_email text;
  rec public.folder_shares%rowtype;
begin
  if tg_op = 'DELETE' then
    rec := old;
  else
    rec := new;
  end if;

  select fo.owner_id, fo.name into v_owner, v_name
  from public.folders fo
  where fo.id = rec.folder_id;

  select up.email into v_email
  from public.user_profiles up
  where up.id = rec.grantee_id;

  if tg_op = 'INSERT' then
    perform public.log_activity(
      'share.granted', 'share', rec.folder_id, v_name, v_owner,
      jsonb_build_object('resource', 'folder', 'grantee_email', v_email, 'role', rec.role)
    );
  elsif tg_op = 'UPDATE' and old.role is distinct from new.role then
    perform public.log_activity(
      'share.updated', 'share', new.folder_id, v_name, v_owner,
      jsonb_build_object('resource', 'folder', 'grantee_email', v_email, 'old_role', old.role, 'role', new.role)
    );
  elsif tg_op = 'DELETE' then
    perform public.log_activity(
      'share.revoked', 'share', old.folder_id, v_name, v_owner,
      jsonb_build_object('resource', 'folder', 'grantee_email', v_email, 'role', old.role)
    );
  end if;

  return null;
exception
  when others then
    return null;
end;
$$;

drop trigger if exists activity_folder_shares on public.folder_shares;
create trigger activity_folder_shares
  after insert or update or delete on public.folder_shares
  for each row execute function public.activity_folder_shares_trigger_fn();

create or replace function public.activity_share_links_trigger_fn()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_name text;
  rec public.share_links%rowtype;
begin
  if tg_op = 'DELETE' then
    rec := old;
  else
    rec := new;
  end if;

  if rec.file_id is not null then
    select fi.owner_id, fi.name into v_owner, v_name
    from public.files fi
    where fi.id = rec.file_id;
  else
    select fo.owner_id, fo.name into v_owner, v_name
    from public.folders fo
    where fo.id = rec.folder_id;
  end if;

  if tg_op = 'INSERT' then
    perform public.log_activity(
      'link.created', 'link', coalesce(rec.file_id, rec.folder_id), v_name, v_owner,
      jsonb_build_object(
        'resource', case when rec.file_id is not null then 'file' else 'folder' end,
        'role', rec.role,
        'allow_download', rec.allow_download,
        'expires_at', rec.expires_at
      )
    );
  elsif tg_op = 'UPDATE' and old.disabled is distinct from new.disabled then
    perform public.log_activity(
      case when new.disabled then 'link.disabled' else 'link.enabled' end,
      'link', coalesce(new.file_id, new.folder_id), v_name, v_owner,
      jsonb_build_object('resource', case when new.file_id is not null then 'file' else 'folder' end)
    );
  elsif tg_op = 'DELETE' then
    perform public.log_activity(
      'link.deleted', 'link', coalesce(old.file_id, old.folder_id), v_name, v_owner,
      jsonb_build_object('resource', case when old.file_id is not null then 'file' else 'folder' end)
    );
  end if;

  return null;
exception
  when others then
    return null;
end;
$$;

drop trigger if exists activity_share_links on public.share_links;
create trigger activity_share_links
  after insert or update or delete on public.share_links
  for each row execute function public.activity_share_links_trigger_fn();

-- =============================================
-- Restore version: add explicit activity event
-- =============================================
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

  perform public.log_activity(
    'file.version_restored', 'file', p_file_id, fi.name, fi.owner_id,
    jsonb_build_object('version_id', target.id, 'version_no', target.version_no)
  );

  return target;
end;
$$;

grant execute on function public.restore_file_version(uuid, uuid) to authenticated;

-- =============================================
-- Read APIs
-- =============================================
create or replace function public.list_activity(p_limit integer default 50)
returns table (
  id uuid,
  actor_id uuid,
  actor_email text,
  owner_id uuid,
  action text,
  resource_type text,
  resource_id uuid,
  resource_name text,
  metadata jsonb,
  created_at timestamptz
)
language sql stable security definer
set search_path = public
as $$
  select ae.id,
         ae.actor_id,
         up.email,
         ae.owner_id,
         ae.action,
         ae.resource_type,
         ae.resource_id,
         ae.resource_name,
         ae.metadata,
         ae.created_at
  from public.activity_events ae
  left join public.user_profiles up on up.id = ae.actor_id
  where ae.actor_id = auth.uid()
     or ae.owner_id = auth.uid()
  order by ae.created_at desc
  limit coalesce(p_limit, 50);
$$;

create or replace function public.list_recent_files(p_limit integer default 20)
returns public.files
language sql stable security definer
set search_path = public
as $$
  select fi.*
  from public.files fi
  where fi.deleted_at is null
    and public.has_file_access(fi.id, 'viewer')
  order by fi.updated_at desc
  limit coalesce(p_limit, 20);
$$;

create or replace function public.find_duplicate_files(p_checksum text)
returns table (id uuid, name text, size bigint, updated_at timestamptz)
language sql stable security definer
set search_path = public
as $$
  select fi.id, fi.name, fi.size, fi.updated_at
  from public.files fi
  where p_checksum is not null
    and fi.checksum = p_checksum
    and fi.deleted_at is null
    and public.has_file_access(fi.id, 'viewer')
  order by fi.updated_at desc
  limit 5;
$$;

grant execute on function public.list_activity(integer) to authenticated;
grant execute on function public.list_recent_files(integer) to authenticated;
grant execute on function public.find_duplicate_files(text) to authenticated;
