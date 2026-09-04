-- Core file system: folders, files, file_versions, tags, file_tags
-- Run after 202608280002_fix_batch_visibility_rls_recursion.sql.
-- Idempotent. Does NOT drop legacy tables (upload_batches, uploaded_files).

-- =============================================
-- Table: folders (nested, soft delete)
-- =============================================
create table if not exists public.folders (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references public.folders(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id),
  legacy_batch_id uuid,
  constraint folders_not_own_parent check (parent_id is distinct from id)
);

create index if not exists idx_folders_parent on public.folders(parent_id);
create index if not exists idx_folders_owner on public.folders(owner_id);
create unique index if not exists uq_folders_legacy_batch on public.folders(legacy_batch_id);
create unique index if not exists uq_folders_sibling_name
  on public.folders (owner_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name))
  where deleted_at is null;

-- =============================================
-- Table: files (soft delete, points to current version)
-- =============================================
create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid references public.folders(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  original_name text not null,
  extension text not null default '',
  mime_type text not null default 'application/octet-stream',
  size bigint not null default 0,
  checksum text,
  current_version_id uuid,
  is_public boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id),
  legacy_file_id uuid
);

create index if not exists idx_files_folder on public.files(folder_id);
create index if not exists idx_files_owner on public.files(owner_id);
create index if not exists idx_files_owner_active on public.files(owner_id, created_at desc) where deleted_at is null;
create unique index if not exists uq_files_legacy_file on public.files(legacy_file_id);

-- =============================================
-- Table: file_versions (immutable history)
-- =============================================
create table if not exists public.file_versions (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references public.files(id) on delete cascade,
  version_no integer not null check (version_no > 0),
  storage_path text not null,
  size bigint not null default 0,
  mime_type text not null default 'application/octet-stream',
  checksum text,
  uploaded_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (file_id, version_no)
);

create index if not exists idx_file_versions_file on public.file_versions(file_id);
create index if not exists idx_file_versions_storage_path on public.file_versions(storage_path);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'fk_files_current_version'
  ) then
    alter table public.files
      add constraint fk_files_current_version
      foreign key (current_version_id) references public.file_versions(id)
      on delete set null;
  end if;
end;
$$;

-- =============================================
-- Tables: tags, file_tags
-- =============================================
create table if not exists public.tags (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  created_at timestamptz not null default now(),
  unique (owner_id, name)
);

create table if not exists public.file_tags (
  file_id uuid not null references public.files(id) on delete cascade,
  tag_id uuid not null references public.tags(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (file_id, tag_id)
);

create index if not exists idx_file_tags_tag on public.file_tags(tag_id);

-- =============================================
-- updated_at trigger helper + triggers
-- =============================================
create or replace function public.handle_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists folders_set_updated_at on public.folders;
create trigger folders_set_updated_at
  before update on public.folders
  for each row execute function public.handle_updated_at();

drop trigger if exists files_set_updated_at on public.files;
create trigger files_set_updated_at
  before update on public.files
  for each row execute function public.handle_updated_at();

-- =============================================
-- RLS helpers (single source of truth for access checks)
-- Follows the can_view_upload_batch pattern: security definer
-- functions avoid policy recursion.
-- Phase 3 will extend these with file_shares / folder_shares.
-- =============================================
create or replace function public.role_rank(role text)
returns integer
language sql immutable
as $$
  select case role
    when 'viewer' then 1
    when 'editor' then 2
    when 'admin' then 3
    when 'owner' then 4
    else 0
  end;
$$;

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

  -- soft-deleted folders are never visible to non-owners
  if f.deleted_at is not null then
    return false;
  end if;

  -- legacy related users get viewer access (parity with user_connections)
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

  -- soft-deleted files are never visible to non-owners
  if fi.deleted_at is not null then
    return false;
  end if;

  if public.role_rank(required_role) <= public.role_rank('viewer') then
    if fi.is_public then
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

-- =============================================
-- RLS policies
-- =============================================
alter table public.folders enable row level security;
alter table public.files enable row level security;
alter table public.file_versions enable row level security;
alter table public.tags enable row level security;
alter table public.file_tags enable row level security;

drop policy if exists "folders_select" on public.folders;
create policy "folders_select"
  on public.folders for select to authenticated
  using (public.has_folder_access(id, 'viewer'));

drop policy if exists "folders_insert" on public.folders;
create policy "folders_insert"
  on public.folders for insert to authenticated
  with check (owner_id = auth.uid());

drop policy if exists "folders_update" on public.folders;
create policy "folders_update"
  on public.folders for update to authenticated
  using (public.has_folder_access(id, 'editor'))
  with check (public.has_folder_access(id, 'editor'));

drop policy if exists "folders_delete" on public.folders;
create policy "folders_delete"
  on public.folders for delete to authenticated
  using (public.has_folder_access(id, 'admin'));

drop policy if exists "files_select" on public.files;
create policy "files_select"
  on public.files for select to authenticated
  using (public.has_file_access(id, 'viewer'));

drop policy if exists "files_insert" on public.files;
create policy "files_insert"
  on public.files for insert to authenticated
  with check (owner_id = auth.uid());

drop policy if exists "files_update" on public.files;
create policy "files_update"
  on public.files for update to authenticated
  using (public.has_file_access(id, 'editor'))
  with check (public.has_file_access(id, 'editor'));

drop policy if exists "files_delete" on public.files;
create policy "files_delete"
  on public.files for delete to authenticated
  using (public.has_file_access(id, 'admin'));

drop policy if exists "file_versions_select" on public.file_versions;
create policy "file_versions_select"
  on public.file_versions for select to authenticated
  using (public.has_file_access(file_id, 'viewer'));

drop policy if exists "file_versions_insert" on public.file_versions;
create policy "file_versions_insert"
  on public.file_versions for insert to authenticated
  with check (uploaded_by = auth.uid() and public.has_file_access(file_id, 'editor'));

drop policy if exists "file_versions_delete" on public.file_versions;
create policy "file_versions_delete"
  on public.file_versions for delete to authenticated
  using (public.has_file_access(file_id, 'admin'));

drop policy if exists "tags_all_own" on public.tags;
create policy "tags_all_own"
  on public.tags for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

drop policy if exists "file_tags_select" on public.file_tags;
create policy "file_tags_select"
  on public.file_tags for select to authenticated
  using (public.has_file_access(file_id, 'viewer'));

drop policy if exists "file_tags_insert" on public.file_tags;
create policy "file_tags_insert"
  on public.file_tags for insert to authenticated
  with check (public.has_file_access(file_id, 'editor'));

drop policy if exists "file_tags_delete" on public.file_tags;
create policy "file_tags_delete"
  on public.file_tags for delete to authenticated
  using (public.has_file_access(file_id, 'editor'));

-- =============================================
-- Storage policies (new layout: {owner_id}/{file_id}/{version_id}/{filename})
-- Legacy policies from 202608280001 are kept until legacy UI is fully retired.
-- =============================================
drop policy if exists "Users can upload to their own namespace" on storage.objects;
create policy "Users can upload to their own namespace"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users can read accessible file versions" on storage.objects;
create policy "Users can read accessible file versions"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'uploads'
    and exists (
      select 1
      from public.file_versions fv
      where fv.storage_path = storage.objects.name
        and public.has_file_access(fv.file_id, 'viewer')
    )
  );

drop policy if exists "Users can delete accessible file versions" on storage.objects;
create policy "Users can delete accessible file versions"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'uploads'
    and exists (
      select 1
      from public.file_versions fv
      where fv.storage_path = storage.objects.name
        and public.has_file_access(fv.file_id, 'admin')
    )
  );

-- =============================================
-- RPC: folder operations
-- =============================================
create or replace function public.create_folder(p_parent_id uuid, p_name text, p_comment text default null)
returns public.folders
language plpgsql security definer
set search_path = public
as $$
declare
  new_folder public.folders%rowtype;
  trimmed text := trim(coalesce(p_name, ''));
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if trimmed = '' then
    raise exception 'Folder name is required';
  end if;
  if p_parent_id is not null and not public.has_folder_access(p_parent_id, 'editor') then
    raise exception 'You do not have permission to create folders here';
  end if;
  if p_parent_id is not null and exists (
    select 1 from public.folders where id = p_parent_id and deleted_at is not null
  ) then
    raise exception 'Cannot create a folder inside a deleted folder';
  end if;

  insert into public.folders (parent_id, owner_id, name, comment)
  values (p_parent_id, auth.uid(), trimmed, p_comment)
  returning * into new_folder;

  return new_folder;
exception
  when unique_violation then
    raise exception 'A folder with this name already exists here';
end;
$$;

create or replace function public.rename_folder(p_id uuid, p_name text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  trimmed text := trim(coalesce(p_name, ''));
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if trimmed = '' then
    raise exception 'Folder name is required';
  end if;
  if not public.has_folder_access(p_id, 'editor') then
    raise exception 'You do not have permission to rename this folder';
  end if;

  update public.folders set name = trimmed where id = p_id;
exception
  when unique_violation then
    raise exception 'A folder with this name already exists here';
end;
$$;

create or replace function public.update_folder_comment(p_id uuid, p_comment text)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.has_folder_access(p_id, 'editor') then
    raise exception 'You do not have permission to edit this folder';
  end if;

  update public.folders
  set comment = nullif(trim(coalesce(p_comment, '')), '')
  where id = p_id;
end;
$$;

create or replace function public.move_folder(p_id uuid, p_new_parent_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.has_folder_access(p_id, 'editor') then
    raise exception 'You do not have permission to move this folder';
  end if;
  if p_new_parent_id is not null and not public.has_folder_access(p_new_parent_id, 'editor') then
    raise exception 'You do not have permission to move folders there';
  end if;
  if p_new_parent_id = p_id then
    raise exception 'Cannot move a folder into itself';
  end if;
  if p_new_parent_id is not null and exists (
    with recursive ancestors as (
      select id, parent_id from public.folders where id = p_new_parent_id
      union all
      select f.id, f.parent_id
      from public.folders f
      join ancestors a on f.id = a.parent_id
    )
    select 1 from ancestors where id = p_id
  ) then
    raise exception 'Cannot move a folder into its own subfolder';
  end if;

  update public.folders set parent_id = p_new_parent_id where id = p_id;
exception
  when unique_violation then
    raise exception 'A folder with this name already exists there';
end;
$$;

create or replace function public.soft_delete_folder(p_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.has_folder_access(p_id, 'admin') then
    raise exception 'You do not have permission to delete this folder';
  end if;

  with recursive subtree as (
    select id from public.folders where id = p_id
    union all
    select f.id from public.folders f join subtree s on f.parent_id = s.id
  )
  update public.folders
  set deleted_at = now(), deleted_by = auth.uid()
  where id in (select id from subtree) and deleted_at is null;

  with recursive subtree as (
    select id from public.folders where id = p_id
    union all
    select f.id from public.folders f join subtree s on f.parent_id = s.id
  )
  update public.files
  set deleted_at = now(), deleted_by = auth.uid()
  where folder_id in (select id from subtree) and deleted_at is null;
end;
$$;

create or replace function public.restore_folder(p_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not exists (
    select 1 from public.folders where id = p_id and owner_id = auth.uid()
  ) then
    raise exception 'You do not have permission to restore this folder';
  end if;

  with recursive subtree as (
    select id from public.folders where id = p_id
    union all
    select f.id from public.folders f join subtree s on f.parent_id = s.id
  )
  update public.folders
  set deleted_at = null, deleted_by = null
  where id in (select id from subtree);

  with recursive subtree as (
    select id from public.folders where id = p_id
    union all
    select f.id from public.folders f join subtree s on f.parent_id = s.id
  )
  update public.files
  set deleted_at = null, deleted_by = null
  where folder_id in (select id from subtree);

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

create or replace function public.hard_delete_folder(p_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not exists (
    select 1 from public.folders where id = p_id and owner_id = auth.uid()
  ) then
    raise exception 'You do not have permission to delete this folder';
  end if;

  delete from public.folders where id = p_id;
end;
$$;

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
    where f.deleted_at is null
  )
  select c.id, c.name, c.parent_id
  from chain c
  order by c.depth desc;
end;
$$;

-- =============================================
-- RPC: file operations
-- =============================================
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
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.has_file_access(p_file_id, 'editor') then
    raise exception 'You do not have permission to update this file';
  end if;
  if exists (
    select 1 from public.files where id = p_file_id and deleted_at is not null
  ) then
    raise exception 'Cannot add a version to a deleted file';
  end if;

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

create or replace function public.rename_file(p_id uuid, p_name text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  trimmed text := trim(coalesce(p_name, ''));
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if trimmed = '' then
    raise exception 'File name is required';
  end if;
  if not public.has_file_access(p_id, 'editor') then
    raise exception 'You do not have permission to rename this file';
  end if;

  update public.files set name = trimmed where id = p_id;
end;
$$;

create or replace function public.move_file(p_id uuid, p_folder_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.has_file_access(p_id, 'editor') then
    raise exception 'You do not have permission to move this file';
  end if;
  if p_folder_id is not null then
    if not public.has_folder_access(p_folder_id, 'editor') then
      raise exception 'You do not have permission to move files there';
    end if;
    if exists (
      select 1 from public.folders where id = p_folder_id and deleted_at is not null
    ) then
      raise exception 'Cannot move into a deleted folder';
    end if;
  end if;

  update public.files set folder_id = p_folder_id where id = p_id;
end;
$$;

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

create or replace function public.soft_delete_file(p_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.has_file_access(p_id, 'admin') then
    raise exception 'You do not have permission to delete this file';
  end if;

  update public.files
  set deleted_at = now(), deleted_by = auth.uid()
  where id = p_id and deleted_at is null;
end;
$$;

create or replace function public.restore_file(p_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not exists (
    select 1 from public.files where id = p_id and owner_id = auth.uid()
  ) then
    raise exception 'You do not have permission to restore this file';
  end if;

  update public.files
  set deleted_at = null, deleted_by = null
  where id = p_id;

  -- if the parent folder is deleted, detach to root
  update public.files f
  set folder_id = null
  where f.id = p_id
    and f.folder_id is not null
    and exists (
      select 1 from public.folders d
      where d.id = f.folder_id and d.deleted_at is not null
    );
end;
$$;

create or replace function public.hard_delete_file(p_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not exists (
    select 1 from public.files where id = p_id and owner_id = auth.uid()
  ) then
    raise exception 'You do not have permission to delete this file';
  end if;

  delete from public.files where id = p_id;
end;
$$;

create or replace function public.get_file_version_paths(p_file_id uuid)
returns table (version_id uuid, storage_path text)
language plpgsql stable security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.has_file_access(p_file_id, 'admin') then
    raise exception 'You do not have permission to view this file';
  end if;

  return query
  select fv.id, fv.storage_path
  from public.file_versions fv
  where fv.file_id = p_file_id
  order by fv.version_no;
end;
$$;

create or replace function public.get_folder_storage_paths(p_folder_id uuid)
returns table (storage_path text)
language plpgsql stable security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not exists (
    select 1 from public.folders where id = p_folder_id and owner_id = auth.uid()
  ) then
    raise exception 'You do not have permission to view this folder';
  end if;

  return query
  with recursive subtree as (
    select id from public.folders where id = p_folder_id
    union all
    select f.id from public.folders f join subtree s on f.parent_id = s.id
  )
  select fv.storage_path
  from public.file_versions fv
  join public.files fi on fi.id = fv.file_id
  where fi.folder_id in (select id from subtree);
end;
$$;

-- =============================================
-- Grants
-- =============================================
grant execute on function public.role_rank(text) to authenticated;
grant execute on function public.has_folder_access(uuid, text) to authenticated;
grant execute on function public.has_file_access(uuid, text) to authenticated;
grant execute on function public.create_folder(uuid, text, text) to authenticated;
grant execute on function public.rename_folder(uuid, text) to authenticated;
grant execute on function public.update_folder_comment(uuid, text) to authenticated;
grant execute on function public.move_folder(uuid, uuid) to authenticated;
grant execute on function public.soft_delete_folder(uuid) to authenticated;
grant execute on function public.restore_folder(uuid) to authenticated;
grant execute on function public.hard_delete_folder(uuid) to authenticated;
grant execute on function public.get_folder_ancestors(uuid) to authenticated;
grant execute on function
  public.register_file(uuid, uuid, text, text, text, text, bigint, text, text, uuid)
  to authenticated;
grant execute on function
  public.add_file_version(uuid, text, bigint, text, text, uuid)
  to authenticated;
grant execute on function public.rename_file(uuid, text) to authenticated;
grant execute on function public.move_file(uuid, uuid) to authenticated;
grant execute on function public.copy_file(uuid, uuid, text, text, uuid) to authenticated;
grant execute on function public.soft_delete_file(uuid) to authenticated;
grant execute on function public.restore_file(uuid) to authenticated;
grant execute on function public.hard_delete_file(uuid) to authenticated;
grant execute on function public.get_file_version_paths(uuid) to authenticated;
grant execute on function public.get_folder_storage_paths(uuid) to authenticated;
