-- Fix: share_file / share_folder raised "column reference 'email' is ambiguous".
-- The PL/pgSQL variable "email" collided with user_profiles.email.
-- Also fix list_shared_with_me ordering (output-column variable in ORDER BY).
-- Idempotent.

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

grant execute on function public.share_file(uuid, text, text) to authenticated;
grant execute on function public.share_folder(uuid, text, text) to authenticated;
grant execute on function public.list_shared_with_me() to authenticated;
