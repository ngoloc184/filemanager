-- Fix search_path for pgcrypto functions (crypt, gen_salt)
-- Run this in Supabase SQL Editor

create extension if not exists pgcrypto schema extensions;

create or replace function public.create_share_link(
  p_file_id uuid,
  p_role text default 'viewer',
  p_password text default null,
  p_allow_download boolean default true,
  p_expires_at timestamptz default null
)
returns public.share_links
language plpgsql security definer
set search_path = public, extensions
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
    case when pw is not null then extensions.crypt(pw, extensions.gen_salt('bf')) end,
    coalesce(p_allow_download, true), p_expires_at, auth.uid()
  )
  returning * into new_link;

  return new_link;
end;
$$;

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
set search_path = public, extensions
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
    if p_password is null or extensions.crypt(p_password, link.password_hash) <> link.password_hash then
      raise exception 'Invalid password';
    end if;
  end if;

  select * into fi from public.files where id = link.file_id;
  if not found or fi.deleted_at is not null or fi.current_version_id is null then
    raise exception 'The shared file is no longer available';
  end if;

  update public.share_links
  set view_count = view_count + 1, last_used_at = now()
  where id = link.id;

  return query
  select fi.id, fi.name, fi.mime_type, fi.size, fi.current_version_id, link.allow_download;
end;
$$;

grant execute on function public.create_share_link(uuid, text, text, boolean, timestamptz) to authenticated;
grant execute on function public.access_share_link(text, text) to authenticated;

