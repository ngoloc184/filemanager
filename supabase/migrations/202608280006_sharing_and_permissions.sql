-- Phase 3: sharing & permissions
-- file_shares / folder_shares (role-based user sharing, inherited down folder trees)
-- share_links (token links with password/expiry, signed-in recipients)
-- Run after 202608280005_search_trash_tags.sql. Idempotent.

create extension if not exists pgcrypto;

-- =============================================
-- Tables
-- =============================================
create table if not exists public.file_shares (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references public.files(id) on delete cascade,
  grantee_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('viewer', 'editor', 'admin')),
  granted_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (file_id, grantee_id)
);

create index if not exists idx_file_shares_grantee on public.file_shares(grantee_id);

create table if not exists public.folder_shares (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid not null references public.folders(id) on delete cascade,
  grantee_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('viewer', 'editor', 'admin')),
  granted_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (folder_id, grantee_id)
);

create index if not exists idx_folder_shares_grantee on public.folder_shares(grantee_id);

create table if not exists public.share_links (
  id uuid primary key default gen_random_uuid(),
  file_id uuid references public.files(id) on delete cascade,
  folder_id uuid references public.folders(id) on delete cascade,
  token text not null unique default encode(gen_random_bytes(24), 'hex'),
  role text not null default 'viewer' check (role in ('viewer', 'editor')),
  password_hash text,
  allow_download boolean not null default true,
  expires_at timestamptz,
  disabled boolean not null default false,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  view_count integer not null default 0,
  check (
    (file_id is not null and folder_id is null)
    or (file_id is null and folder_id is not null)
  )
);

create index if not exists idx_share_links_file on public.share_links(file_id);
create index if not exists idx_share_links_folder on public.share_links(folder_id);
create index if not exists idx_share_links_created_by on public.share_links(created_by);

-- Short-lived access grants issued by access_share_link(); checked by has_file_access.
create table if not exists public.share_link_access (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  file_id uuid not null references public.files(id) on delete cascade,
  share_link_id uuid not null references public.share_links(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists idx_share_link_access_lookup
  on public.share_link_access(file_id, user_id, expires_at);

-- =============================================
-- RLS
-- =============================================
alter table public.file_shares enable row level security;
alter table public.folder_shares enable row level security;
alter table public.share_links enable row level security;
alter table public.share_link_access enable row level security;

drop policy if exists "file_shares_select" on public.file_shares;
create policy "file_shares_select"
  on public.file_shares for select to authenticated
  using (grantee_id = auth.uid() or public.has_file_access(file_id, 'admin'));

drop policy if exists "folder_shares_select" on public.folder_shares;
create policy "folder_shares_select"
  on public.folder_shares for select to authenticated
  using (grantee_id = auth.uid() or public.has_folder_access(folder_id, 'admin'));

drop policy if exists "share_links_select" on public.share_links;
create policy "share_links_select"
  on public.share_links for select to authenticated
  using (
    created_by = auth.uid()
    or (file_id is not null and public.has_file_access(file_id, 'admin'))
    or (folder_id is not null and public.has_folder_access(folder_id, 'admin'))
  );

drop policy if exists "share_link_access_select_own" on public.share_link_access;
create policy "share_link_access_select_own"
  on public.share_link_access for select to authenticated
  using (user_id = auth.uid());

-- =============================================
-- Extended access helpers (single source of truth)
-- Adds: direct file shares, folder shares inherited down the tree.
-- Keeps: owner, is_public, legacy user_connections, share_link_access.
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

-- =============================================
-- RPC: user sharing
-- =============================================
create or replace function public.share_resource_check(p_caller_resource_role text, p_granted_role text)
returns void
language plpgsql immutable security definer
set search_path = public
as $$
begin
  if public.role_rank(coalesce(p_caller_resource_role, '')) < public.role_rank('admin') then
    raise exception 'You do not have permission to share this item';
  end if;
  if p_caller_resource_role <> 'owner' and p_granted_role = 'admin' then
    raise exception 'Only the owner can grant admin access';
  end if;
end;
$$;

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

  insert into public.folder_shares (folder_id, grantee_id, role, granted_by)
  values (p_folder_id, grantee, p_role, auth.uid())
  on conflict (folder_id, grantee_id)
  do update set role = excluded.role, granted_by = excluded.granted_by
  returning * into new_share;

  return new_share;
end;
$$;

create or replace function public.update_file_share(p_share_id uuid, p_role text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  share public.file_shares%rowtype;
  caller_role text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if p_role not in ('viewer', 'editor', 'admin') then
    raise exception 'Invalid role';
  end if;

  select * into share from public.file_shares where id = p_share_id;
  if not found then
    raise exception 'Share not found';
  end if;

  if exists (select 1 from public.files where id = share.file_id and owner_id = auth.uid()) then
    caller_role := 'owner';
  elsif exists (
    select 1 from public.file_shares
    where file_id = share.file_id and grantee_id = auth.uid() and role = 'admin'
  ) then
    caller_role := 'admin';
  else
    caller_role := null;
  end if;
  perform public.share_resource_check(caller_role, p_role);
  if caller_role <> 'owner' and share.role = 'admin' then
    raise exception 'Only the owner can change an admin share';
  end if;

  update public.file_shares set role = p_role where id = p_share_id;
end;
$$;

create or replace function public.update_folder_share(p_share_id uuid, p_role text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  share public.folder_shares%rowtype;
  caller_role text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if p_role not in ('viewer', 'editor', 'admin') then
    raise exception 'Invalid role';
  end if;

  select * into share from public.folder_shares where id = p_share_id;
  if not found then
    raise exception 'Share not found';
  end if;

  if exists (select 1 from public.folders where id = share.folder_id and owner_id = auth.uid()) then
    caller_role := 'owner';
  elsif exists (
    select 1 from public.folder_shares
    where folder_id = share.folder_id and grantee_id = auth.uid() and role = 'admin'
  ) then
    caller_role := 'admin';
  else
    caller_role := null;
  end if;
  perform public.share_resource_check(caller_role, p_role);
  if caller_role <> 'owner' and share.role = 'admin' then
    raise exception 'Only the owner can change an admin share';
  end if;

  update public.folder_shares set role = p_role where id = p_share_id;
end;
$$;

create or replace function public.unshare_file(p_share_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  share public.file_shares%rowtype;
  is_owner boolean;
  is_admin boolean;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into share from public.file_shares where id = p_share_id;
  if not found then
    raise exception 'Share not found';
  end if;

  is_owner := exists (select 1 from public.files where id = share.file_id and owner_id = auth.uid());
  is_admin := exists (
    select 1 from public.file_shares
    where file_id = share.file_id and grantee_id = auth.uid() and role = 'admin'
  );
  if not is_owner and not is_admin then
    raise exception 'You do not have permission to remove this share';
  end if;
  if not is_owner and share.role = 'admin' then
    raise exception 'Only the owner can remove an admin share';
  end if;

  delete from public.file_shares where id = p_share_id;
end;
$$;

create or replace function public.unshare_folder(p_share_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  share public.folder_shares%rowtype;
  is_owner boolean;
  is_admin boolean;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into share from public.folder_shares where id = p_share_id;
  if not found then
    raise exception 'Share not found';
  end if;

  is_owner := exists (select 1 from public.folders where id = share.folder_id and owner_id = auth.uid());
  is_admin := exists (
    select 1 from public.folder_shares
    where folder_id = share.folder_id and grantee_id = auth.uid() and role = 'admin'
  );
  if not is_owner and not is_admin then
    raise exception 'You do not have permission to remove this share';
  end if;
  if not is_owner and share.role = 'admin' then
    raise exception 'Only the owner can remove an admin share';
  end if;

  delete from public.folder_shares where id = p_share_id;
end;
$$;

create or replace function public.list_file_shares(p_file_id uuid)
returns table (share_id uuid, grantee_id uuid, grantee_email text, role text, created_at timestamptz)
language plpgsql stable security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.has_file_access(p_file_id, 'admin') then
    raise exception 'You do not have permission to view shares for this file';
  end if;

  return query
  select fs.id, fs.grantee_id, p.email, fs.role, fs.created_at
  from public.file_shares fs
  join public.user_profiles p on p.id = fs.grantee_id
  where fs.file_id = p_file_id
  order by p.email;
end;
$$;

create or replace function public.list_folder_shares(p_folder_id uuid)
returns table (share_id uuid, grantee_id uuid, grantee_email text, role text, created_at timestamptz)
language plpgsql stable security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.has_folder_access(p_folder_id, 'admin') then
    raise exception 'You do not have permission to view shares for this folder';
  end if;

  return query
  select fs.id, fs.grantee_id, p.email, fs.role, fs.created_at
  from public.folder_shares fs
  join public.user_profiles p on p.id = fs.grantee_id
  where fs.folder_id = p_folder_id
  order by p.email;
end;
$$;

create or replace function public.list_shared_with_me()
returns table (
  item_type text,
  id uuid,
  name text,
  role text,
  owner_email text,
  shared_at timestamptz,
  size bigint,
  mime_type text,
  current_version_id uuid
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
    'folder'::text, fo.id, fo.name, fs.role, p.email, fs.created_at,
    null::bigint, null::text, null::uuid
  from public.folder_shares fs
  join public.folders fo on fo.id = fs.folder_id
  join public.user_profiles p on p.id = fo.owner_id
  where fs.grantee_id = auth.uid() and fo.deleted_at is null
  union all
  select
    'file'::text, fi.id, fi.name, fs.role, p.email, fs.created_at,
    fi.size, fi.mime_type, fi.current_version_id
  from public.file_shares fs
  join public.files fi on fi.id = fs.file_id
  join public.user_profiles p on p.id = fi.owner_id
  where fs.grantee_id = auth.uid() and fi.deleted_at is null
  order by 6 desc;
end;
$$;

-- =============================================
-- RPC: share links
-- =============================================
create or replace function public.create_share_link(
  p_file_id uuid,
  p_role text default 'viewer',
  p_password text default null,
  p_allow_download boolean default true,
  p_expires_at timestamptz default null
)
returns public.share_links
language plpgsql security definer
set search_path = public
as $$
declare
  new_link public.share_links%rowtype;
  pw text := nullif(p_password, '');
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if p_role not in ('viewer', 'editor') then
    raise exception 'Invalid role';
  end if;
  if not public.has_file_access(p_file_id, 'admin') then
    raise exception 'You do not have permission to share this file';
  end if;
  if exists (select 1 from public.files where id = p_file_id and deleted_at is not null) then
    raise exception 'Cannot share a deleted file';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'Expiration must be in the future';
  end if;

  insert into public.share_links (file_id, role, password_hash, allow_download, expires_at, created_by)
  values (
    p_file_id, p_role,
    case when pw is not null then crypt(pw, gen_salt('bf')) end,
    coalesce(p_allow_download, true), p_expires_at, auth.uid()
  )
  returning * into new_link;

  return new_link;
end;
$$;

create or replace function public.list_share_links(p_file_id uuid)
returns table (
  link_id uuid,
  token text,
  role text,
  has_password boolean,
  allow_download boolean,
  expires_at timestamptz,
  disabled boolean,
  created_at timestamptz,
  view_count integer,
  last_used_at timestamptz
)
language plpgsql stable security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.has_file_access(p_file_id, 'admin') then
    raise exception 'You do not have permission to view links for this file';
  end if;

  return query
  select sl.id, sl.token, sl.role, sl.password_hash is not null,
         sl.allow_download, sl.expires_at, sl.disabled, sl.created_at,
         sl.view_count, sl.last_used_at
  from public.share_links sl
  where sl.file_id = p_file_id
  order by sl.created_at desc;
end;
$$;

create or replace function public.set_share_link_disabled(p_link_id uuid, p_disabled boolean)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not exists (
    select 1 from public.share_links sl
    where sl.id = p_link_id
      and (
        sl.created_by = auth.uid()
        or (sl.file_id is not null and public.has_file_access(sl.file_id, 'admin'))
        or (sl.folder_id is not null and public.has_folder_access(sl.folder_id, 'admin'))
      )
  ) then
    raise exception 'You do not have permission to update this link';
  end if;

  update public.share_links set disabled = p_disabled where id = p_link_id;
end;
$$;

create or replace function public.delete_share_link(p_link_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not exists (
    select 1 from public.share_links sl
    where sl.id = p_link_id
      and (
        sl.created_by = auth.uid()
        or (sl.file_id is not null and public.has_file_access(sl.file_id, 'admin'))
        or (sl.folder_id is not null and public.has_folder_access(sl.folder_id, 'admin'))
      )
  ) then
    raise exception 'You do not have permission to delete this link';
  end if;

  delete from public.share_links where id = p_link_id;
end;
$$;

-- Metadata without granting access (for the password prompt)
create or replace function public.inspect_share_link(p_token text)
returns table (file_name text, requires_password boolean, active boolean)
language plpgsql stable security definer
set search_path = public
as $$
declare
  link public.share_links%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into link from public.share_links where token = trim(coalesce(p_token, ''));
  if not found then
    raise exception 'Share link not found';
  end if;

  return query
  select
    fi.name,
    link.password_hash is not null,
    (not link.disabled)
      and (link.expires_at is null or link.expires_at > now())
      and fi.deleted_at is null
  from public.files fi
  where fi.id = link.file_id;
end;
$$;

-- Validates token/password and grants the caller temporary read access (15 min)
create or replace function public.access_share_link(p_token text, p_password text default null)
returns table (
  file_id uuid,
  name text,
  mime_type text,
  size bigint,
  current_version_id uuid,
  allow_download boolean
)
language plpgsql security definer
set search_path = public
as $$
declare
  link public.share_links%rowtype;
  fi public.files%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into link from public.share_links where token = trim(coalesce(p_token, ''));
  if not found then
    raise exception 'Share link not found';
  end if;
  if link.disabled then
    raise exception 'This share link has been disabled';
  end if;
  if link.expires_at is not null and link.expires_at <= now() then
    raise exception 'This share link has expired';
  end if;
  if link.password_hash is not null then
    if p_password is null
       or crypt(p_password, link.password_hash) <> link.password_hash then
      raise exception 'Incorrect password';
    end if;
  end if;

  select * into fi from public.files where id = link.file_id;
  if not found or fi.deleted_at is not null then
    raise exception 'The shared file is no longer available';
  end if;

  -- owner/admin already have access; skip the temporary grant
  if not public.has_file_access(fi.id, 'viewer') then
    insert into public.share_link_access (user_id, file_id, share_link_id, expires_at)
    values (auth.uid(), fi.id, link.id, now() + interval '15 minutes');
  end if;

  update public.share_links
  set view_count = view_count + 1, last_used_at = now()
  where id = link.id;

  return query
  select fi.id, fi.name, fi.mime_type, fi.size, fi.current_version_id, link.allow_download;
end;
$$;

-- =============================================
-- Grants
-- =============================================
grant execute on function public.share_resource_check(text, text) to authenticated;
grant execute on function public.share_file(uuid, text, text) to authenticated;
grant execute on function public.share_folder(uuid, text, text) to authenticated;
grant execute on function public.update_file_share(uuid, text) to authenticated;
grant execute on function public.update_folder_share(uuid, text) to authenticated;
grant execute on function public.unshare_file(uuid) to authenticated;
grant execute on function public.unshare_folder(uuid) to authenticated;
grant execute on function public.list_file_shares(uuid) to authenticated;
grant execute on function public.list_folder_shares(uuid) to authenticated;
grant execute on function public.list_shared_with_me() to authenticated;
grant execute on function public.create_share_link(uuid, text, text, boolean, timestamptz) to authenticated;
grant execute on function public.list_share_links(uuid) to authenticated;
grant execute on function public.set_share_link_disabled(uuid, boolean) to authenticated;
grant execute on function public.delete_share_link(uuid) to authenticated;
grant execute on function public.inspect_share_link(text) to authenticated;
grant execute on function public.access_share_link(text, text) to authenticated;
