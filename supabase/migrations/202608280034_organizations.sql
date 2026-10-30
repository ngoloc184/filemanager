-- Organization foundation: companies, departments, positions, members, roles,
-- email-link invitations, holidays and the people directory.
-- Run this migration in Supabase Dashboard > SQL Editor before deploying the UI.
--
-- One company per account in this MVP (unique partial index on
-- org_members(user_id)); org_id is kept everywhere so multi-company can come later.
-- Roles live in org_members.roles, never in user_metadata.
-- Clients only read (RLS); every write goes through the security definer RPCs below.
--
-- Rollback (manual):
--   drop table if exists public.org_holidays, public.org_invitations, public.org_members,
--     public.positions, public.departments, public.organizations cascade;
--   then drop the functions listed in the grants section at the end.

-- =============================================
-- Tables
-- =============================================
create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 200),
  short_name text check (short_name is null or char_length(short_name) <= 50),
  code text not null unique check (code ~ '^[A-ZĐ0-9]{2,15}$'),
  tax_code text check (tax_code is null or char_length(tax_code) <= 30),
  address text check (address is null or char_length(address) <= 500),
  timezone text not null default 'Asia/Ho_Chi_Minh',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists organizations_set_updated_at on public.organizations;
create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function public.handle_updated_at();

create table if not exists public.departments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  parent_id uuid references public.departments(id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  code text not null check (code ~ '^[A-ZĐ0-9-]{1,20}$'),
  head_user_id uuid references auth.users(id) on delete set null,
  sort_order int not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (org_id, code),
  check (parent_id is null or parent_id <> id)
);

create index if not exists idx_departments_org on public.departments (org_id, sort_order);
create index if not exists idx_departments_parent on public.departments (parent_id) where parent_id is not null;
create index if not exists idx_departments_head on public.departments (head_user_id) where head_user_id is not null;

create table if not exists public.positions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 100),
  rank int not null default 0,
  can_sign boolean not null default false,
  unique (org_id, name)
);

create table if not exists public.org_members (
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  department_id uuid references public.departments(id) on delete set null,
  position_id uuid references public.positions(id) on delete set null,
  roles text[] not null default '{staff}' check (
    roles <@ array['org_admin', 'clerk', 'leader', 'dept_head', 'staff']::text[]
    and cardinality(roles) > 0
  ),
  title text check (title is null or char_length(title) <= 100),
  status text not null default 'active' check (status in ('active', 'suspended', 'left')),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  primary key (org_id, user_id)
);

-- one company per account (left rows are history and do not count)
create unique index if not exists uq_org_members_one_company
  on public.org_members (user_id) where status in ('active', 'suspended');
create index if not exists idx_org_members_department
  on public.org_members (org_id, department_id) where status = 'active';

create table if not exists public.org_invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and char_length(email) between 3 and 320),
  department_id uuid references public.departments(id) on delete set null,
  position_id uuid references public.positions(id) on delete set null,
  roles text[] not null default '{staff}' check (
    roles <@ array['org_admin', 'clerk', 'leader', 'dept_head', 'staff']::text[]
    and cardinality(roles) > 0
  ),
  token text not null unique
    default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz
);

create index if not exists idx_org_invitations_org_email on public.org_invitations (org_id, email);

create table if not exists public.org_holidays (
  org_id uuid not null references public.organizations(id) on delete cascade,
  day date not null,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  primary key (org_id, day)
);

-- =============================================
-- Internal helpers (take a user id; definer RPCs only, service_role grant)
-- =============================================
create or replace function public.is_org_member_user(p_org_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.org_members m
    where m.org_id = p_org_id and m.user_id = p_user_id and m.status = 'active'
  );
$$;

create or replace function public.has_org_role_user(p_org_id uuid, p_role text, p_user_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.org_members m
    where m.org_id = p_org_id and m.user_id = p_user_id and m.status = 'active'
      and p_role = any (m.roles)
  );
$$;

create or replace function public.member_department(p_org_id uuid, p_user_id uuid)
returns uuid
language sql stable security definer
set search_path = public
as $$
  select m.department_id from public.org_members m
  where m.org_id = p_org_id and m.user_id = p_user_id and m.status = 'active';
$$;

-- true when both users are active members of one company
create or replace function public.same_org(p_a uuid, p_b uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.org_members a
    join public.org_members b on b.org_id = a.org_id
    where a.user_id = p_a and a.status = 'active'
      and b.user_id = p_b and b.status = 'active'
  );
$$;

create or replace function public.headed_departments_of(p_user_id uuid)
returns setof uuid
language sql stable security definer
set search_path = public
as $$
  select d.id
  from public.departments d
  join public.org_members m
    on m.org_id = d.org_id and m.user_id = p_user_id and m.status = 'active'
  where d.head_user_id = p_user_id and d.archived_at is null;
$$;

-- Distinct roles in canonical order; empty/null becomes {staff}.
create or replace function public.org_normalize_roles(p_roles text[])
returns text[]
language plpgsql immutable
set search_path = public
as $$
declare
  v_all constant text[] := array['org_admin', 'clerk', 'leader', 'dept_head', 'staff'];
  v_bad text[];
begin
  if p_roles is null or cardinality(p_roles) = 0 then
    return array['staff'];
  end if;
  select coalesce(array_agg(r), '{}') into v_bad
  from unnest(p_roles) r where r is null or not (r = any (v_all));
  if cardinality(v_bad) > 0 then
    raise exception 'Unknown role: %', array_to_string(v_bad, ', ', '(empty)') using errcode = '22023';
  end if;
  return array(select r from unnest(v_all) with ordinality as a(r, i) where r = any (p_roles) order by i);
end;
$$;

-- Raises unless the caller is an active admin of the company.
create or replace function public.org_require_admin(p_org_id uuid)
returns void
language plpgsql stable security definer
set search_path = public
as $$
begin
  if p_org_id is null or not public.has_org_role_user(p_org_id, 'org_admin', auth.uid()) then
    raise exception 'Only company admins can do this' using errcode = '42501';
  end if;
end;
$$;

-- Raises when no active member holds org_admin any more.
create or replace function public.org_require_an_admin(p_org_id uuid)
returns void
language plpgsql stable security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.org_members m
    where m.org_id = p_org_id and m.status = 'active' and 'org_admin' = any (m.roles)
  ) then
    raise exception 'A company needs at least one admin' using errcode = '23514';
  end if;
end;
$$;

-- =============================================
-- Client helpers (auth.uid() only; used by RLS here and in later migrations)
-- =============================================
create or replace function public.my_org_id()
returns uuid
language sql stable security definer
set search_path = public
as $$
  select m.org_id from public.org_members m
  where m.user_id = auth.uid() and m.status = 'active'
  limit 1;
$$;

create or replace function public.is_org_member(p_org_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select public.is_org_member_user(p_org_id, auth.uid());
$$;

create or replace function public.has_org_role(p_org_id uuid, p_role text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select public.has_org_role_user(p_org_id, p_role, auth.uid());
$$;

create or replace function public.is_org_admin(p_org_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select public.has_org_role_user(p_org_id, 'org_admin', auth.uid());
$$;

create or replace function public.my_department(p_org_id uuid)
returns uuid
language sql stable security definer
set search_path = public
as $$
  select public.member_department(p_org_id, auth.uid());
$$;

create or replace function public.headed_departments()
returns setof uuid
language sql stable security definer
set search_path = public
as $$
  select public.headed_departments_of(auth.uid());
$$;

-- =============================================
-- RLS: members read their own company; nobody writes directly
-- =============================================
alter table public.organizations enable row level security;
alter table public.departments enable row level security;
alter table public.positions enable row level security;
alter table public.org_members enable row level security;
alter table public.org_invitations enable row level security;
alter table public.org_holidays enable row level security;

drop policy if exists "Members can view their company" on public.organizations;
create policy "Members can view their company"
  on public.organizations for select to authenticated
  using (public.is_org_member(id));

drop policy if exists "Members can view departments" on public.departments;
create policy "Members can view departments"
  on public.departments for select to authenticated
  using (public.is_org_member(org_id));

drop policy if exists "Members can view positions" on public.positions;
create policy "Members can view positions"
  on public.positions for select to authenticated
  using (public.is_org_member(org_id));

drop policy if exists "Members can view holidays" on public.org_holidays;
create policy "Members can view holidays"
  on public.org_holidays for select to authenticated
  using (public.is_org_member(org_id));

drop policy if exists "Members can view members" on public.org_members;
create policy "Members can view members"
  on public.org_members for select to authenticated
  using (public.is_org_member(org_id));

drop policy if exists "Admins can view invitations" on public.org_invitations;
create policy "Admins can view invitations"
  on public.org_invitations for select to authenticated
  using (public.is_org_admin(org_id));

revoke all on table public.organizations, public.departments, public.positions,
  public.org_members, public.org_invitations, public.org_holidays from public, anon, authenticated;
grant select on table public.organizations, public.departments, public.positions,
  public.org_members, public.org_invitations, public.org_holidays to authenticated;
grant all on table public.organizations, public.departments, public.positions,
  public.org_members, public.org_invitations, public.org_holidays to service_role;

-- =============================================
-- Company
-- =============================================
create or replace function public.create_organization(p_name text, p_code text, p_short_name text default null)
returns public.organizations
language plpgsql security definer
set search_path = public
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_org public.organizations;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.org_members
    where user_id = auth.uid() and status in ('active', 'suspended')
  ) then
    raise exception 'You already belong to a company' using errcode = '23505';
  end if;
  if char_length(v_name) not between 2 and 200 then
    raise exception 'Company name must be 2 to 200 characters' using errcode = '22023';
  end if;
  if v_code !~ '^[A-ZĐ0-9]{2,15}$' then
    raise exception 'Company code must be 2 to 15 letters or digits' using errcode = '22023';
  end if;
  if exists (select 1 from public.organizations where code = v_code) then
    raise exception 'That company code is already taken' using errcode = '23505';
  end if;

  begin
    insert into public.organizations (name, short_name, code, created_by)
    values (v_name, nullif(btrim(coalesce(p_short_name, '')), ''), v_code, auth.uid())
    returning * into v_org;

    insert into public.org_members (org_id, user_id, roles)
    values (v_org.id, auth.uid(), array['org_admin', 'clerk', 'leader']);
  exception when unique_violation then
    -- a concurrent create with the same code, or a second company for this account
    if exists (select 1 from public.organizations where code = v_code) then
      raise exception 'That company code is already taken' using errcode = '23505';
    end if;
    raise exception 'You already belong to a company' using errcode = '23505';
  end;
  return v_org;
end;
$$;

-- The caller's company and their place in it (active or suspended), or null.
create or replace function public.get_my_org()
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'org', to_jsonb(o),
    'me', jsonb_build_object(
      'roles', to_jsonb(m.roles),
      'department_id', m.department_id,
      'department_name', d.name,
      'position_id', m.position_id,
      'position_name', p.name,
      'status', m.status
    )
  ) into v_result
  from public.org_members m
  join public.organizations o on o.id = m.org_id
  left join public.departments d on d.id = m.department_id
  left join public.positions p on p.id = m.position_id
  where m.user_id = auth.uid() and m.status in ('active', 'suspended')
  limit 1;
  return v_result;
end;
$$;

-- Name, code and timezone keep their value when null; the optional fields are
-- set as given (blank clears them).
create or replace function public.update_organization(
  p_name text, p_short_name text, p_code text, p_tax_code text, p_address text, p_timezone text
)
returns public.organizations
language plpgsql security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_name text := btrim(p_name);
  v_code text := upper(btrim(p_code));
  v_tz text := btrim(p_timezone);
  v_org public.organizations;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_org_id := public.my_org_id();
  perform public.org_require_admin(v_org_id);

  if v_name is not null and char_length(v_name) not between 2 and 200 then
    raise exception 'Company name must be 2 to 200 characters' using errcode = '22023';
  end if;
  if v_code is not null and v_code !~ '^[A-ZĐ0-9]{2,15}$' then
    raise exception 'Company code must be 2 to 15 letters or digits' using errcode = '22023';
  end if;
  if v_code is not null and exists (
    select 1 from public.organizations where code = v_code and id <> v_org_id
  ) then
    raise exception 'That company code is already taken' using errcode = '23505';
  end if;
  if v_tz is not null and not exists (select 1 from pg_timezone_names where name = v_tz) then
    raise exception 'Unknown time zone: %', v_tz using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_short_name, ''))) > 50 then
    raise exception 'Short name is too long (max 50 characters)' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_tax_code, ''))) > 30 then
    raise exception 'Tax code is too long (max 30 characters)' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_address, ''))) > 500 then
    raise exception 'Address is too long (max 500 characters)' using errcode = '22023';
  end if;

  begin
    update public.organizations
    set name = coalesce(v_name, name),
        code = coalesce(v_code, code),
        timezone = coalesce(v_tz, timezone),
        short_name = nullif(btrim(coalesce(p_short_name, '')), ''),
        tax_code = nullif(btrim(coalesce(p_tax_code, '')), ''),
        address = nullif(btrim(coalesce(p_address, '')), '')
    where id = v_org_id
    returning * into v_org;
  exception when unique_violation then
    raise exception 'That company code is already taken' using errcode = '23505';
  end;
  return v_org;
end;
$$;

-- =============================================
-- Departments and positions
-- =============================================
create or replace function public.upsert_department(
  p_id uuid, p_name text, p_code text, p_parent_id uuid, p_head_user_id uuid, p_sort_order int
)
returns public.departments
language plpgsql security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_dept public.departments;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if p_id is null then
    v_org_id := public.my_org_id();
  else
    select org_id into v_org_id from public.departments where id = p_id;
    if v_org_id is null then
      raise exception 'Department not found' using errcode = 'P0002';
    end if;
  end if;
  perform public.org_require_admin(v_org_id);

  if char_length(v_name) not between 1 and 200 then
    raise exception 'Department name must be 1 to 200 characters' using errcode = '22023';
  end if;
  if v_code !~ '^[A-ZĐ0-9-]{1,20}$' then
    raise exception 'Department code must be 1 to 20 letters, digits or dashes' using errcode = '22023';
  end if;

  if p_parent_id is not null then
    -- serialize re-parenting per company so two moves cannot build a cycle
    perform 1 from public.organizations where id = v_org_id for update;
    if not exists (
      select 1 from public.departments
      where id = p_parent_id and org_id = v_org_id and archived_at is null
    ) then
      raise exception 'Parent department not found' using errcode = 'P0002';
    end if;
    if p_id is not null and (
      p_parent_id = p_id
      or exists (
        with recursive up(id) as (
          select parent_id from public.departments where id = p_parent_id
          union
          select d.parent_id from public.departments d join up on d.id = up.id
        )
        select 1 from up where id = p_id
      )
    ) then
      raise exception 'A department cannot be placed inside itself' using errcode = '22023';
    end if;
  end if;

  if p_head_user_id is not null and not public.is_org_member_user(v_org_id, p_head_user_id) then
    raise exception 'The department head must be an active member' using errcode = '22023';
  end if;

  begin
    if p_id is null then
      insert into public.departments (org_id, parent_id, name, code, head_user_id, sort_order)
      values (v_org_id, p_parent_id, v_name, v_code, p_head_user_id, coalesce(p_sort_order, 0))
      returning * into v_dept;
    else
      update public.departments
      set parent_id = p_parent_id, name = v_name, code = v_code,
          head_user_id = p_head_user_id, sort_order = coalesce(p_sort_order, sort_order)
      where id = p_id
      returning * into v_dept;
    end if;
  exception when unique_violation then
    raise exception 'That department code is already used' using errcode = '23505';
  end;
  return v_dept;
end;
$$;

create or replace function public.archive_department(p_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_org_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select org_id into v_org_id from public.departments where id = p_id;
  if v_org_id is null then
    raise exception 'Department not found' using errcode = 'P0002';
  end if;
  perform public.org_require_admin(v_org_id);

  if exists (
    select 1 from public.org_members
    where department_id = p_id and status in ('active', 'suspended')
  ) then
    raise exception 'Move this department''s members elsewhere first' using errcode = '23503';
  end if;
  if exists (select 1 from public.departments where parent_id = p_id and archived_at is null) then
    raise exception 'Archive its sub-departments first' using errcode = '23503';
  end if;
  update public.departments set archived_at = coalesce(archived_at, now()) where id = p_id;
end;
$$;

create or replace function public.upsert_position(p_id uuid, p_name text, p_rank int, p_can_sign boolean)
returns public.positions
language plpgsql security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_pos public.positions;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if p_id is null then
    v_org_id := public.my_org_id();
  else
    select org_id into v_org_id from public.positions where id = p_id;
    if v_org_id is null then
      raise exception 'Position not found' using errcode = 'P0002';
    end if;
  end if;
  perform public.org_require_admin(v_org_id);

  if char_length(v_name) not between 1 and 100 then
    raise exception 'Position name must be 1 to 100 characters' using errcode = '22023';
  end if;

  begin
    if p_id is null then
      insert into public.positions (org_id, name, rank, can_sign)
      values (v_org_id, v_name, coalesce(p_rank, 0), coalesce(p_can_sign, false))
      returning * into v_pos;
    else
      update public.positions
      set name = v_name, rank = coalesce(p_rank, rank), can_sign = coalesce(p_can_sign, can_sign)
      where id = p_id
      returning * into v_pos;
    end if;
  exception when unique_violation then
    raise exception 'That position already exists' using errcode = '23505';
  end;
  return v_pos;
end;
$$;

-- Members and invitations holding it fall back to no position (FK set null).
create or replace function public.delete_position(p_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_org_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select org_id into v_org_id from public.positions where id = p_id;
  if v_org_id is null then
    raise exception 'Position not found' using errcode = 'P0002';
  end if;
  perform public.org_require_admin(v_org_id);
  delete from public.positions where id = p_id;
end;
$$;

-- =============================================
-- Invitations (the link is copied by hand; no e-mail delivery yet)
-- =============================================
create or replace function public.invite_member(
  p_email text, p_department_id uuid, p_position_id uuid, p_roles text[]
)
returns public.org_invitations
language plpgsql security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_roles text[] := public.org_normalize_roles(p_roles);
  v_invite public.org_invitations;
  v_org_name text;
  v_user_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_org_id := public.my_org_id();
  perform public.org_require_admin(v_org_id);

  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 320 then
    raise exception 'Enter a valid e-mail address' using errcode = '22023';
  end if;
  if p_department_id is not null and not exists (
    select 1 from public.departments
    where id = p_department_id and org_id = v_org_id and archived_at is null
  ) then
    raise exception 'Department not found' using errcode = 'P0002';
  end if;
  if p_position_id is not null and not exists (
    select 1 from public.positions where id = p_position_id and org_id = v_org_id
  ) then
    raise exception 'Position not found' using errcode = 'P0002';
  end if;
  if exists (
    select 1
    from public.org_members m
    join auth.users u on u.id = m.user_id
    where m.org_id = v_org_id and m.status in ('active', 'suspended') and lower(u.email) = v_email
  ) then
    raise exception 'That person is already a member of this company' using errcode = '23505';
  end if;

  update public.org_invitations
  set revoked_at = now()
  where org_id = v_org_id and email = v_email
    and accepted_at is null and revoked_at is null;

  insert into public.org_invitations (org_id, email, department_id, position_id, roles, invited_by)
  values (v_org_id, v_email, p_department_id, p_position_id, v_roles, auth.uid())
  returning * into v_invite;

  -- In-app notice for people who already have an account (needs 202608280035).
  select id into v_user_id from public.user_profiles where lower(email) = v_email limit 1;
  if v_user_id is not null and exists (
    select 1 from pg_proc
    where proname = 'create_notification' and pronamespace = 'public'::regnamespace
  ) then
    select name into v_org_name from public.organizations where id = v_org_id;
    begin
      execute 'select public.create_notification(p_user_id => $1, p_kind => $2, p_title => $3, '
        'p_link => $4, p_entity_type => $5, p_entity_id => $6, p_org_id => $7)'
      using v_user_id, 'org.invite', 'You are invited to join ' || v_org_name,
        '/invite/' || v_invite.token, 'org', v_org_id, v_org_id;
    exception when undefined_function then
      null; -- a different create_notification signature: skip the notice, keep the invite
    end;
  end if;
  return v_invite;
end;
$$;

create or replace function public.list_org_invitations()
returns setof public.org_invitations
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_org_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_org_id := public.my_org_id();
  perform public.org_require_admin(v_org_id);
  return query
    select i.* from public.org_invitations i
    where i.org_id = v_org_id
    order by (i.accepted_at is null and i.revoked_at is null and i.expires_at > now()) desc,
             i.created_at desc;
end;
$$;

create or replace function public.revoke_invitation(p_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_invite public.org_invitations;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select * into v_invite from public.org_invitations where id = p_id;
  if v_invite.id is null then
    raise exception 'Invitation not found' using errcode = 'P0002';
  end if;
  perform public.org_require_admin(v_invite.org_id);
  if v_invite.accepted_at is not null then
    raise exception 'This invitation was already accepted' using errcode = '22023';
  end if;
  update public.org_invitations set revoked_at = coalesce(revoked_at, now()) where id = p_id;
end;
$$;

-- The invitation behind a link, only for the signed-in person it was sent to.
create or replace function public.get_invitation(p_token text)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_email text;
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select lower(btrim(email)) into v_email from auth.users where id = auth.uid();

  select jsonb_build_object(
    'org_name', o.name,
    'email', i.email,
    'roles', to_jsonb(i.roles),
    'department_name', d.name,
    'position_name', p.name,
    'expires_at', i.expires_at,
    'status', case
      when i.revoked_at is not null then 'revoked'
      when i.accepted_at is not null then 'accepted'
      when i.expires_at <= now() then 'expired'
      else 'pending'
    end
  ) into v_result
  from public.org_invitations i
  join public.organizations o on o.id = i.org_id
  left join public.departments d on d.id = i.department_id
  left join public.positions p on p.id = i.position_id
  where i.token = p_token and v_email is not null and i.email = v_email;

  if v_result is null then
    raise exception 'Invitation not found' using errcode = 'P0002';
  end if;
  return v_result;
end;
$$;

create or replace function public.accept_invitation(p_token text)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_email text;
  v_invite public.org_invitations;
  v_department_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select lower(btrim(email)) into v_email from auth.users where id = auth.uid();

  select * into v_invite from public.org_invitations
  where token = p_token and v_email is not null and email = v_email
  for update;
  if v_invite.id is null then
    raise exception 'Invitation not found' using errcode = 'P0002';
  end if;
  if v_invite.revoked_at is not null then
    raise exception 'This invitation was revoked' using errcode = '22023';
  end if;
  if v_invite.accepted_at is not null then
    raise exception 'This invitation was already accepted' using errcode = '22023';
  end if;
  if v_invite.expires_at <= now() then
    raise exception 'This invitation has expired' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.org_members
    where user_id = auth.uid() and status in ('active', 'suspended') and org_id <> v_invite.org_id
  ) then
    raise exception 'You already belong to another company' using errcode = '23505';
  end if;
  -- a suspended member must not reactivate themselves with a fresh link
  if exists (
    select 1 from public.org_members
    where user_id = auth.uid() and org_id = v_invite.org_id and status in ('active', 'suspended')
  ) then
    raise exception 'You are already a member of this company' using errcode = '23505';
  end if;

  select id into v_department_id from public.departments
  where id = v_invite.department_id and archived_at is null;

  begin
    insert into public.org_members (org_id, user_id, department_id, position_id, roles, status)
    values (v_invite.org_id, auth.uid(), v_department_id, v_invite.position_id, v_invite.roles, 'active')
    on conflict (org_id, user_id) do update
      set department_id = excluded.department_id,
          position_id = excluded.position_id,
          roles = excluded.roles,
          title = null,
          status = 'active',
          joined_at = now(),
          left_at = null
      where public.org_members.status = 'left';
  exception when unique_violation then
    raise exception 'You already belong to another company' using errcode = '23505';
  end;

  update public.org_invitations
  set accepted_at = now(), accepted_by = auth.uid()
  where id = v_invite.id;
  return v_invite.org_id;
end;
$$;

-- =============================================
-- Members
-- =============================================
create or replace function public.update_member(
  p_user_id uuid, p_department_id uuid, p_position_id uuid, p_roles text[], p_title text
)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_roles text[] := public.org_normalize_roles(p_roles);
  v_title text := nullif(btrim(coalesce(p_title, '')), '');
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_org_id := public.my_org_id();
  perform public.org_require_admin(v_org_id);
  -- one admin change at a time per company, so two admins cannot demote each other
  perform 1 from public.organizations where id = v_org_id for update;
  if not exists (select 1 from public.org_members where org_id = v_org_id and user_id = p_user_id) then
    raise exception 'Member not found' using errcode = 'P0002';
  end if;
  if p_department_id is not null and not exists (
    select 1 from public.departments
    where id = p_department_id and org_id = v_org_id and archived_at is null
  ) then
    raise exception 'Department not found' using errcode = 'P0002';
  end if;
  if p_position_id is not null and not exists (
    select 1 from public.positions where id = p_position_id and org_id = v_org_id
  ) then
    raise exception 'Position not found' using errcode = 'P0002';
  end if;
  if char_length(v_title) > 100 then
    raise exception 'Title is too long (max 100 characters)' using errcode = '22023';
  end if;

  update public.org_members
  set department_id = p_department_id, position_id = p_position_id, roles = v_roles, title = v_title
  where org_id = v_org_id and user_id = p_user_id;

  perform public.org_require_an_admin(v_org_id);
end;
$$;

create or replace function public.set_member_status(p_user_id uuid, p_status text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_current text;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_org_id := public.my_org_id();
  perform public.org_require_admin(v_org_id);
  -- one admin change at a time per company, so two admins cannot demote each other
  perform 1 from public.organizations where id = v_org_id for update;
  if p_status is null or p_status not in ('active', 'suspended', 'left') then
    raise exception 'Unknown member status: %', coalesce(p_status, '(empty)') using errcode = '22023';
  end if;
  select status into v_current from public.org_members where org_id = v_org_id and user_id = p_user_id;
  if v_current is null then
    raise exception 'Member not found' using errcode = 'P0002';
  end if;
  if p_user_id = auth.uid() and p_status <> 'active' then
    raise exception 'You cannot suspend or remove yourself' using errcode = '22023';
  end if;
  -- coming back needs the person's consent (accept_invitation), not an admin switch
  if v_current = 'left' and p_status <> 'left' then
    raise exception 'People who left must be invited again' using errcode = '22023';
  end if;

  begin
    update public.org_members
    set status = p_status,
        left_at = case when p_status = 'left' then coalesce(left_at, now()) end
    where org_id = v_org_id and user_id = p_user_id;
  exception when unique_violation then
    raise exception 'That person already belongs to another company' using errcode = '23505';
  end;

  if p_status = 'left' then
    update public.departments set head_user_id = null
    where org_id = v_org_id and head_user_id = p_user_id;
  end if;

  perform public.org_require_an_admin(v_org_id);
end;
$$;

-- People of the caller's company; empty when the caller is not an active member.
create or replace function public.list_org_members(p_query text default null, p_include_inactive boolean default false)
returns table (
  user_id uuid, email text, display_name text, avatar_path text,
  department_id uuid, department_name text, position_id uuid, position_name text,
  can_sign boolean, roles text[], title text, status text, joined_at timestamptz
)
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_q text := nullif(btrim(coalesce(p_query, '')), '');
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_org_id := public.my_org_id();
  if v_org_id is null then
    return;
  end if;
  return query
    select m.user_id, coalesce(up.email, u.email)::text, up.display_name, up.avatar_path,
           m.department_id, d.name, m.position_id, p.name,
           coalesce(p.can_sign, false), m.roles, m.title, m.status, m.joined_at
    from public.org_members m
    left join auth.users u on u.id = m.user_id
    left join public.user_profiles up on up.id = m.user_id
    left join public.departments d on d.id = m.department_id
    left join public.positions p on p.id = m.position_id
    where m.org_id = v_org_id
      and (coalesce(p_include_inactive, false) or m.status = 'active')
      and (v_q is null or public.fm_normalize(
            concat_ws(' ', up.display_name, coalesce(up.email, u.email), d.name)
          ) like '%' || replace(replace(replace(public.fm_normalize(v_q), '\', '\\'), '%', '\%'), '_', '\_') || '%')
    order by up.display_name nulls last, coalesce(up.email, u.email);
end;
$$;

-- Person picker: active members of the caller's company only.
create or replace function public.search_directory(p_q text, p_limit int default 20)
returns table (
  user_id uuid, email text, display_name text, avatar_path text,
  department_id uuid, department_name text, position_id uuid, position_name text,
  can_sign boolean, roles text[], title text, status text, joined_at timestamptz
)
language plpgsql stable security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  return query
    select * from public.list_org_members(p_q, false)
    limit least(greatest(coalesce(p_limit, 20), 1), 50);
end;
$$;

-- =============================================
-- Holidays (working-day deadlines skip these)
-- =============================================
create or replace function public.set_org_holiday(p_day date, p_name text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_name text := btrim(coalesce(p_name, ''));
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_org_id := public.my_org_id();
  perform public.org_require_admin(v_org_id);
  if p_day is null then
    raise exception 'Pick a day' using errcode = '22023';
  end if;
  if char_length(v_name) not between 1 and 200 then
    raise exception 'Holiday name must be 1 to 200 characters' using errcode = '22023';
  end if;
  insert into public.org_holidays (org_id, day, name)
  values (v_org_id, p_day, v_name)
  on conflict (org_id, day) do update set name = excluded.name;
end;
$$;

create or replace function public.delete_org_holiday(p_day date)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_org_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_org_id := public.my_org_id();
  perform public.org_require_admin(v_org_id);
  delete from public.org_holidays where org_id = v_org_id and day = p_day;
end;
$$;

-- =============================================
-- Grants: nothing for public/anon; client RPCs and auth.uid()-only helpers for
-- authenticated; helpers that take a user id for service_role only.
-- =============================================
revoke all on function public.is_org_member_user(uuid, uuid) from public, anon, authenticated;
revoke all on function public.has_org_role_user(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.member_department(uuid, uuid) from public, anon, authenticated;
revoke all on function public.same_org(uuid, uuid) from public, anon, authenticated;
revoke all on function public.headed_departments_of(uuid) from public, anon, authenticated;
revoke all on function public.org_normalize_roles(text[]) from public, anon, authenticated;
revoke all on function public.org_require_admin(uuid) from public, anon, authenticated;
revoke all on function public.org_require_an_admin(uuid) from public, anon, authenticated;
grant execute on function public.is_org_member_user(uuid, uuid) to service_role;
grant execute on function public.has_org_role_user(uuid, text, uuid) to service_role;
grant execute on function public.member_department(uuid, uuid) to service_role;
grant execute on function public.same_org(uuid, uuid) to service_role;
grant execute on function public.headed_departments_of(uuid) to service_role;
grant execute on function public.org_normalize_roles(text[]) to service_role;
grant execute on function public.org_require_admin(uuid) to service_role;
grant execute on function public.org_require_an_admin(uuid) to service_role;

revoke all on function public.my_org_id() from public, anon;
revoke all on function public.is_org_member(uuid) from public, anon;
revoke all on function public.has_org_role(uuid, text) from public, anon;
revoke all on function public.is_org_admin(uuid) from public, anon;
revoke all on function public.my_department(uuid) from public, anon;
revoke all on function public.headed_departments() from public, anon;
revoke all on function public.create_organization(text, text, text) from public, anon;
revoke all on function public.get_my_org() from public, anon;
revoke all on function public.update_organization(text, text, text, text, text, text) from public, anon;
revoke all on function public.upsert_department(uuid, text, text, uuid, uuid, int) from public, anon;
revoke all on function public.archive_department(uuid) from public, anon;
revoke all on function public.upsert_position(uuid, text, int, boolean) from public, anon;
revoke all on function public.delete_position(uuid) from public, anon;
revoke all on function public.invite_member(text, uuid, uuid, text[]) from public, anon;
revoke all on function public.list_org_invitations() from public, anon;
revoke all on function public.revoke_invitation(uuid) from public, anon;
revoke all on function public.get_invitation(text) from public, anon;
revoke all on function public.accept_invitation(text) from public, anon;
revoke all on function public.update_member(uuid, uuid, uuid, text[], text) from public, anon;
revoke all on function public.set_member_status(uuid, text) from public, anon;
revoke all on function public.list_org_members(text, boolean) from public, anon;
revoke all on function public.search_directory(text, int) from public, anon;
revoke all on function public.set_org_holiday(date, text) from public, anon;
revoke all on function public.delete_org_holiday(date) from public, anon;

grant execute on function public.my_org_id() to authenticated, service_role;
grant execute on function public.is_org_member(uuid) to authenticated, service_role;
grant execute on function public.has_org_role(uuid, text) to authenticated, service_role;
grant execute on function public.is_org_admin(uuid) to authenticated, service_role;
grant execute on function public.my_department(uuid) to authenticated, service_role;
grant execute on function public.headed_departments() to authenticated, service_role;
grant execute on function public.create_organization(text, text, text) to authenticated;
grant execute on function public.get_my_org() to authenticated;
grant execute on function public.update_organization(text, text, text, text, text, text) to authenticated;
grant execute on function public.upsert_department(uuid, text, text, uuid, uuid, int) to authenticated;
grant execute on function public.archive_department(uuid) to authenticated;
grant execute on function public.upsert_position(uuid, text, int, boolean) to authenticated;
grant execute on function public.delete_position(uuid) to authenticated;
grant execute on function public.invite_member(text, uuid, uuid, text[]) to authenticated;
grant execute on function public.list_org_invitations() to authenticated;
grant execute on function public.revoke_invitation(uuid) to authenticated;
grant execute on function public.get_invitation(text) to authenticated;
grant execute on function public.accept_invitation(text) to authenticated;
grant execute on function public.update_member(uuid, uuid, uuid, text[], text) to authenticated;
grant execute on function public.set_member_status(uuid, text) to authenticated;
grant execute on function public.list_org_members(text, boolean) to authenticated;
grant execute on function public.search_directory(text, int) to authenticated;
grant execute on function public.set_org_holiday(date, text) to authenticated;
grant execute on function public.delete_org_holiday(date) to authenticated;
