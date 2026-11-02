-- Dossiers (hồ sơ) and retention basics: a catalog of retention codes per
-- company, dossiers that collect documents, close / reopen / transfer to the
-- archive (nộp lưu) and legal hold.
-- Run after 202608280036_documents_core.sql. Idempotent.
--
-- [Unverified] Periods are configurable defaults, not legal advice (see
-- Thông tư 10/2022/TT-BNV and its 2025 replacement).
--
-- Clients only read (RLS); every write goes through the security definer RPCs
-- below. A document may be in many dossiers (Phụ lục VI III.4.e). Closing sets
-- transfer_due_date = end_date + 1 year (3 months for capital construction
-- dossiers); transferring archives the completed / issued documents in it.
--
-- Legal hold (dossiers_legal_hold_* triggers, distinct from T09's
-- documents_freeze_*): a document in a dossier on hold cannot be deleted or
-- have its files detached, and the files linked to it cannot get new
-- versions, lose old versions, be trashed or be deleted.
-- purge_old_trash handles each file in its own exception block, so a held
-- file is skipped without stopping the cron.
--
-- Document events written here (canonical names): filed, unfiled, archived.
--
-- Rollback (manual; drops every dossier and the retention catalog):
--   drop trigger if exists organizations_seed_retention on public.organizations;
--   drop trigger if exists dossiers_legal_hold_documents_delete on public.documents;
--   drop trigger if exists dossiers_legal_hold_file_versions on public.file_versions;
--   drop trigger if exists dossiers_legal_hold_file_versions_delete on public.file_versions;
--   drop trigger if exists dossiers_legal_hold_document_files_delete on public.document_files;
--   drop trigger if exists dossiers_legal_hold_files_update on public.files;
--   drop trigger if exists dossiers_legal_hold_files_delete on public.files;
--   drop table if exists public.dossier_documents, public.dossiers, public.retention_codes cascade;
--   then drop the functions listed in the privileges section at the end.

-- =============================================
-- Tables
-- =============================================
-- years null = permanent (Vĩnh viễn)
create table if not exists public.retention_codes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9]{1,10}$'),
  label text not null check (char_length(btrim(label)) between 1 and 200),
  years int check (years is null or years between 1 and 100),
  sort_order int not null default 0,
  unique (org_id, code)
);

create table if not exists public.dossiers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  year int not null check (year between 1900 and 2200),
  code text not null check (char_length(code) between 1 and 30),
  title text not null check (char_length(btrim(title)) between 1 and 500),
  department_id uuid references public.departments(id) on delete set null,
  retention_code_id uuid references public.retention_codes(id) on delete set null,
  owner_id uuid references auth.users(id) on delete set null,
  status text not null default 'open' check (status in ('open', 'closed', 'transferred')),
  legal_hold boolean not null default false,
  is_capital_construction boolean not null default false,
  start_date date,
  end_date date,
  transfer_due_date date,
  closed_at timestamptz,
  transferred_at timestamptz,
  description text check (description is null or char_length(description) <= 2000),
  created_at timestamptz not null default now(),
  unique (org_id, year, code)
);

create index if not exists idx_dossiers_org_status on public.dossiers (org_id, status, transfer_due_date);
create index if not exists idx_dossiers_department on public.dossiers (department_id) where department_id is not null;
create index if not exists idx_dossiers_owner on public.dossiers (owner_id) where owner_id is not null;

create table if not exists public.dossier_documents (
  dossier_id uuid not null references public.dossiers(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  ordinal int not null check (ordinal >= 1),
  added_by uuid references auth.users(id) on delete set null,
  added_at timestamptz not null default now(),
  primary key (dossier_id, document_id)
);

-- legal hold lookups go from the document to its dossiers
create index if not exists idx_dossier_documents_document on public.dossier_documents (document_id);

-- =============================================
-- Retention catalog seed (internal)
-- =============================================
create or replace function public.seed_retention_defaults(p_org_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.retention_codes (org_id, code, label, years, sort_order)
  values
    (p_org_id, 'VV', 'Vĩnh viễn (permanent)', null, 10),
    (p_org_id, '70', '70 years', 70, 20),
    (p_org_id, '20', '20 years', 20, 30),
    (p_org_id, '10', '10 years', 10, 40),
    (p_org_id, '5', '5 years', 5, 50)
  on conflict (org_id, code) do nothing;
end;
$$;

create or replace function public.retention_seed_on_org_insert()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  perform public.seed_retention_defaults(new.id);
  return new;
end;
$$;

drop trigger if exists organizations_seed_retention on public.organizations;
create trigger organizations_seed_retention
  after insert on public.organizations
  for each row execute function public.retention_seed_on_org_insert();

-- companies created before this migration
select public.seed_retention_defaults(o.id) from public.organizations o;

-- =============================================
-- Access rule (client helper; RLS uses it)
-- =============================================
-- Active member of the dossier's company and: the owner, a member or head of
-- its department, or an admin / leader / clerk.
create or replace function public.can_read_dossier(p_id uuid)
returns boolean
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_d public.dossiers;
begin
  if v_uid is null or p_id is null then
    return false;
  end if;
  select * into v_d from public.dossiers where id = p_id;
  if v_d.id is null or not public.is_org_member_user(v_d.org_id, v_uid) then
    return false;
  end if;
  if v_d.owner_id = v_uid then
    return true;
  end if;
  if v_d.department_id is not null and (
    v_d.department_id = public.member_department(v_d.org_id, v_uid)
    or v_d.department_id in (select public.headed_departments_of(v_uid))
  ) then
    return true;
  end if;
  return exists (
    select 1 from public.org_members m
    where m.org_id = v_d.org_id and m.user_id = v_uid and m.status = 'active'
      and m.roles && array['org_admin', 'leader', 'clerk']
  );
end;
$$;

-- =============================================
-- Internal helpers (definer RPCs only; service_role grant)
-- =============================================

-- The dossier, locked, when the caller can read it; raises 'not found' otherwise.
create or replace function public.dossier_for_update(p_id uuid)
returns public.dossiers
language plpgsql security definer
set search_path = public
as $$
declare
  v_d public.dossiers;
begin
  select * into v_d from public.dossiers where id = p_id for update;
  if v_d.id is null or not public.can_read_dossier(p_id) then
    raise exception 'Dossier not found' using errcode = 'P0002';
  end if;
  return v_d;
end;
$$;

-- Owner, clerk or company admin of the dossier's company.
create or replace function public.dossier_can_manage(p_d public.dossiers, p_user_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select public.is_org_member_user(p_d.org_id, p_user_id) and (
    p_d.owner_id = p_user_id
    or public.has_org_role_user(p_d.org_id, 'clerk', p_user_id)
    or public.has_org_role_user(p_d.org_id, 'org_admin', p_user_id)
  );
$$;

-- end + 1 year, or + 3 months for capital construction (xây dựng cơ bản).
-- Same rule as transferDueDate in src/lib/documents/dossiers.ts.
create or replace function public.dossier_transfer_due(p_end date, p_capital boolean)
returns date
language sql immutable
set search_path = public
as $$
  select (p_end + case when coalesce(p_capital, false) then interval '3 months' else interval '1 year' end)::date;
$$;

-- True when a dossier on legal hold contains the document.
create or replace function public.document_on_legal_hold(p_document_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.dossier_documents dd
    join public.dossiers d on d.id = dd.dossier_id
    where dd.document_id = p_document_id and d.legal_hold
  );
$$;

-- =============================================
-- Legal hold enforcement
-- =============================================
create or replace function public.dossiers_legal_hold_guard()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_held boolean;
  v_file_id uuid;
begin
  -- separate branches: NEW is null on delete, and only file_versions has file_id
  if tg_table_name = 'documents' then
    v_held := public.document_on_legal_hold(old.id);
  elsif tg_table_name = 'document_files' then
    -- detaching would let the file be trashed or deleted afterwards
    v_held := public.document_on_legal_hold(old.document_id);
  else
    if tg_table_name = 'file_versions' and tg_op = 'DELETE' then
      v_file_id := old.file_id;
    elsif tg_table_name = 'file_versions' then
      v_file_id := new.file_id;
    elsif tg_op = 'DELETE' then
      v_file_id := old.id;
    else
      v_file_id := new.id;
    end if;
    v_held := exists (
      select 1 from public.document_files df
      where df.file_id = v_file_id and public.document_on_legal_hold(df.document_id)
    );
  end if;
  if v_held then
    raise exception 'This document is on legal hold' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists dossiers_legal_hold_documents_delete on public.documents;
create trigger dossiers_legal_hold_documents_delete
  before delete on public.documents
  for each row execute function public.dossiers_legal_hold_guard();

drop trigger if exists dossiers_legal_hold_file_versions on public.file_versions;
create trigger dossiers_legal_hold_file_versions
  before insert on public.file_versions
  for each row execute function public.dossiers_legal_hold_guard();

-- delete_file_version (old versions); a held file's own delete is refused
-- before its versions cascade
drop trigger if exists dossiers_legal_hold_file_versions_delete on public.file_versions;
create trigger dossiers_legal_hold_file_versions_delete
  before delete on public.file_versions
  for each row execute function public.dossiers_legal_hold_guard();

-- detach_document_file / delete_document (the document's own delete is also
-- refused by dossiers_legal_hold_documents_delete)
drop trigger if exists dossiers_legal_hold_document_files_delete on public.document_files;
create trigger dossiers_legal_hold_document_files_delete
  before delete on public.document_files
  for each row execute function public.dossiers_legal_hold_guard();

-- moving to the trash only; restoring from it stays possible
drop trigger if exists dossiers_legal_hold_files_update on public.files;
create trigger dossiers_legal_hold_files_update
  before update of deleted_at on public.files
  for each row
  when (old.deleted_at is null and new.deleted_at is not null)
  execute function public.dossiers_legal_hold_guard();

drop trigger if exists dossiers_legal_hold_files_delete on public.files;
create trigger dossiers_legal_hold_files_delete
  before delete on public.files
  for each row execute function public.dossiers_legal_hold_guard();

-- =============================================
-- RLS: read through the access rules; nobody writes directly
-- =============================================
alter table public.retention_codes enable row level security;
alter table public.dossiers enable row level security;
alter table public.dossier_documents enable row level security;

drop policy if exists "Members can view retention codes" on public.retention_codes;
create policy "Members can view retention codes"
  on public.retention_codes for select to authenticated
  using (public.is_org_member(org_id));

drop policy if exists "Readers can view dossiers" on public.dossiers;
create policy "Readers can view dossiers"
  on public.dossiers for select to authenticated
  using (public.can_read_dossier(id));

drop policy if exists "Readers can view dossier documents" on public.dossier_documents;
create policy "Readers can view dossier documents"
  on public.dossier_documents for select to authenticated
  using (public.can_read_dossier(dossier_id) and public.can_read_document(document_id));

revoke all on table public.retention_codes, public.dossiers, public.dossier_documents
  from public, anon, authenticated;
grant select on table public.retention_codes, public.dossiers, public.dossier_documents
  to authenticated;
grant all on table public.retention_codes, public.dossiers, public.dossier_documents
  to service_role;

-- =============================================
-- Retention catalog
-- =============================================
-- p_id null adds a code to the caller's company; otherwise edits that code.
create or replace function public.upsert_retention_code(
  p_id uuid, p_code text, p_label text, p_years int, p_sort_order int
)
returns public.retention_codes
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_org_id uuid;
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_label text := btrim(coalesce(p_label, ''));
  v_row public.retention_codes;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if p_id is null then
    v_org_id := public.my_org_id();
  else
    select org_id into v_org_id from public.retention_codes where id = p_id;
    if v_org_id is null or not public.is_org_member_user(v_org_id, v_uid) then
      raise exception 'Retention code not found' using errcode = 'P0002';
    end if;
  end if;
  perform public.org_require_admin(v_org_id);

  if v_code !~ '^[A-Z0-9]{1,10}$' then
    raise exception 'Code must be 1 to 10 letters or digits' using errcode = '22023';
  end if;
  if char_length(v_label) not between 1 and 200 then
    raise exception 'Label must be 1 to 200 characters' using errcode = '22023';
  end if;
  if p_years is not null and p_years not between 1 and 100 then
    raise exception 'Years must be between 1 and 100 (empty = permanent)' using errcode = '22023';
  end if;

  begin
    if p_id is null then
      insert into public.retention_codes (org_id, code, label, years, sort_order)
      values (v_org_id, v_code, v_label, p_years, coalesce(p_sort_order, 0))
      returning * into v_row;
    else
      update public.retention_codes
      set code = v_code, label = v_label, years = p_years,
          sort_order = coalesce(p_sort_order, sort_order)
      where id = p_id
      returning * into v_row;
    end if;
  exception when unique_violation then
    raise exception 'That retention code already exists' using errcode = '23505';
  end;
  return v_row;
end;
$$;

-- =============================================
-- Dossiers
-- =============================================
create or replace function public.create_dossier(
  p_year int, p_code text, p_title text, p_department_id uuid, p_retention_code_id uuid,
  p_description text default null
)
returns public.dossiers
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_org_id uuid;
  v_code text := btrim(coalesce(p_code, ''));
  v_title text := btrim(coalesce(p_title, ''));
  v_description text := nullif(btrim(coalesce(p_description, '')), '');
  v_department_id uuid := p_department_id;
  v_row public.dossiers;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_org_id := public.my_org_id();
  if v_org_id is null then
    raise exception 'Join a company first' using errcode = '42501';
  end if;
  if p_year is null or p_year not between 1900 and 2200 then
    raise exception 'Year must be between 1900 and 2200' using errcode = '22023';
  end if;
  if char_length(v_code) not between 1 and 30 then
    raise exception 'Dossier code must be 1 to 30 characters' using errcode = '22023';
  end if;
  if char_length(v_title) not between 1 and 500 then
    raise exception 'Title must be 1 to 500 characters' using errcode = '22023';
  end if;
  if char_length(v_description) > 2000 then
    raise exception 'Description is too long (max 2000 characters)' using errcode = '22023';
  end if;

  if v_department_id is null then
    v_department_id := public.member_department(v_org_id, v_uid);
  elsif not exists (
    select 1 from public.departments d
    where d.id = v_department_id and d.org_id = v_org_id and d.archived_at is null
  ) then
    raise exception 'Department not found' using errcode = 'P0002';
  end if;
  if p_retention_code_id is not null and not exists (
    select 1 from public.retention_codes r where r.id = p_retention_code_id and r.org_id = v_org_id
  ) then
    raise exception 'Retention code not found' using errcode = 'P0002';
  end if;

  begin
    insert into public.dossiers (
      org_id, year, code, title, department_id, retention_code_id, owner_id,
      start_date, description
    )
    values (
      v_org_id, p_year, v_code, v_title, v_department_id, p_retention_code_id, v_uid,
      public.org_now_date(v_org_id), v_description
    )
    returning * into v_row;
  exception when unique_violation then
    raise exception 'A dossier with code % already exists for %', v_code, p_year using errcode = '23505';
  end;
  return v_row;
end;
$$;

-- Saves the editable fields of an open dossier; every argument is the new
-- value (null clears it), except a null p_is_capital_construction keeps it.
create or replace function public.update_dossier(
  p_id uuid, p_title text, p_retention_code_id uuid, p_department_id uuid,
  p_description text, p_is_capital_construction boolean
)
returns public.dossiers
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_d public.dossiers;
  v_title text := btrim(coalesce(p_title, ''));
  v_description text := nullif(btrim(coalesce(p_description, '')), '');
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_d := public.dossier_for_update(p_id);
  if not public.dossier_can_manage(v_d, v_uid) then
    raise exception 'Only the owner, a clerk or an admin can edit this dossier' using errcode = '42501';
  end if;
  if v_d.status <> 'open' then
    raise exception 'Only an open dossier can be edited' using errcode = '22023';
  end if;
  if char_length(v_title) not between 1 and 500 then
    raise exception 'Title must be 1 to 500 characters' using errcode = '22023';
  end if;
  if char_length(v_description) > 2000 then
    raise exception 'Description is too long (max 2000 characters)' using errcode = '22023';
  end if;
  if p_department_id is not null and p_department_id is distinct from v_d.department_id and not exists (
    select 1 from public.departments d
    where d.id = p_department_id and d.org_id = v_d.org_id and d.archived_at is null
  ) then
    raise exception 'Department not found' using errcode = 'P0002';
  end if;
  if p_retention_code_id is not null and not exists (
    select 1 from public.retention_codes r where r.id = p_retention_code_id and r.org_id = v_d.org_id
  ) then
    raise exception 'Retention code not found' using errcode = 'P0002';
  end if;

  update public.dossiers set
    title = v_title,
    retention_code_id = p_retention_code_id,
    department_id = p_department_id,
    description = v_description,
    is_capital_construction = coalesce(p_is_capital_construction, is_capital_construction)
  where id = p_id
  returning * into v_d;
  return v_d;
end;
$$;

create or replace function public.add_document_to_dossier(p_dossier_id uuid, p_document_id uuid)
returns int
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_d public.dossiers;
  v_doc public.documents;
  v_ordinal int;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_d := public.dossier_for_update(p_dossier_id);
  if not public.dossier_can_manage(v_d, v_uid) then
    raise exception 'Only the owner, a clerk or an admin can add documents to this dossier'
      using errcode = '42501';
  end if;
  if v_d.status <> 'open' then
    raise exception 'Documents can only be added to an open dossier' using errcode = '22023';
  end if;
  select * into v_doc from public.documents where id = p_document_id;
  if v_doc.id is null or v_doc.org_id <> v_d.org_id or not public.can_read_document(p_document_id) then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.dossier_documents
    where dossier_id = p_dossier_id and document_id = p_document_id
  ) then
    raise exception 'This document is already in the dossier' using errcode = '23505';
  end if;

  -- the dossier row is locked, so concurrent adds get distinct ordinals
  select coalesce(max(ordinal), 0) + 1 into v_ordinal
  from public.dossier_documents where dossier_id = p_dossier_id;

  insert into public.dossier_documents (dossier_id, document_id, ordinal, added_by)
  values (p_dossier_id, p_document_id, v_ordinal, v_uid);

  perform public.doc_log(p_document_id, 'filed', v_doc.status, v_doc.status,
    jsonb_build_object('dossier_id', p_dossier_id, 'code', v_d.code));
  return v_ordinal;
end;
$$;

create or replace function public.remove_document_from_dossier(p_dossier_id uuid, p_document_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_d public.dossiers;
  v_ordinal int;
  v_status text;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_d := public.dossier_for_update(p_dossier_id);
  if not public.dossier_can_manage(v_d, v_uid) then
    raise exception 'Only the owner, a clerk or an admin can remove documents from this dossier'
      using errcode = '42501';
  end if;
  if v_d.legal_hold then
    raise exception 'This dossier is on legal hold' using errcode = '42501';
  end if;
  if v_d.status <> 'open' then
    raise exception 'Documents can only be removed from an open dossier' using errcode = '22023';
  end if;

  delete from public.dossier_documents
  where dossier_id = p_dossier_id and document_id = p_document_id
  returning ordinal into v_ordinal;
  if v_ordinal is null then
    raise exception 'This document is not in the dossier' using errcode = 'P0002';
  end if;

  update public.dossier_documents
  set ordinal = ordinal - 1
  where dossier_id = p_dossier_id and ordinal > v_ordinal;

  select status into v_status from public.documents where id = p_document_id;
  perform public.doc_log(p_document_id, 'unfiled', v_status, v_status,
    jsonb_build_object('dossier_id', p_dossier_id, 'code', v_d.code));
end;
$$;

create or replace function public.close_dossier(p_id uuid, p_end_date date default null)
returns public.dossiers
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_d public.dossiers;
  v_end date;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_d := public.dossier_for_update(p_id);
  if not public.dossier_can_manage(v_d, v_uid) then
    raise exception 'Only the owner, a clerk or an admin can close this dossier' using errcode = '42501';
  end if;
  if v_d.status <> 'open' then
    raise exception 'Only an open dossier can be closed' using errcode = '22023';
  end if;
  v_end := coalesce(p_end_date, public.org_now_date(v_d.org_id));

  update public.dossiers set
    status = 'closed',
    end_date = v_end,
    -- a dossier entered after the fact may end before the day it was created
    start_date = least(start_date, v_end),
    transfer_due_date = public.dossier_transfer_due(v_end, is_capital_construction),
    closed_at = now()
  where id = p_id
  returning * into v_d;
  return v_d;
end;
$$;

create or replace function public.reopen_dossier(p_id uuid)
returns public.dossiers
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_d public.dossiers;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_d := public.dossier_for_update(p_id);
  perform public.org_require_admin(v_d.org_id);
  if v_d.status <> 'closed' then
    raise exception 'Only a closed dossier can be reopened' using errcode = '22023';
  end if;

  update public.dossiers set
    status = 'open', end_date = null, transfer_due_date = null, closed_at = null
  where id = p_id
  returning * into v_d;
  return v_d;
end;
$$;

-- Hands a closed dossier to the archive (nộp lưu); its completed incoming
-- and issued outgoing/internal documents become 'archived'.
create or replace function public.transfer_dossier(p_id uuid)
returns public.dossiers
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_d public.dossiers;
  v_doc record;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_d := public.dossier_for_update(p_id);
  if not public.has_org_role_user(v_d.org_id, 'clerk', v_uid)
     and not public.has_org_role_user(v_d.org_id, 'org_admin', v_uid) then
    raise exception 'Only a clerk or an admin can transfer a dossier to the archive' using errcode = '42501';
  end if;
  if v_d.status <> 'closed' then
    raise exception 'Close the dossier before transferring it' using errcode = '22023';
  end if;

  update public.dossiers set status = 'transferred', transferred_at = now()
  where id = p_id
  returning * into v_d;

  for v_doc in
    select x.id, x.status
    from public.dossier_documents dd
    join public.documents x on x.id = dd.document_id
    where dd.dossier_id = p_id and x.status in ('completed', 'issued')
    order by dd.ordinal
    for update of x
  loop
    update public.documents set status = 'archived', archived_at = now() where id = v_doc.id;
    perform public.doc_log(v_doc.id, 'archived', v_doc.status, 'archived',
      jsonb_build_object('dossier_id', p_id, 'code', v_d.code));
  end loop;
  return v_d;
end;
$$;

create or replace function public.set_dossier_legal_hold(p_id uuid, p_hold boolean)
returns public.dossiers
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_d public.dossiers;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if p_hold is null then
    raise exception 'Choose whether to hold the dossier' using errcode = '22023';
  end if;
  v_d := public.dossier_for_update(p_id);
  perform public.org_require_admin(v_d.org_id);

  update public.dossiers set legal_hold = p_hold
  where id = p_id
  returning * into v_d;
  return v_d;
end;
$$;

-- =============================================
-- Reading
-- =============================================
-- Dossiers of the caller's company that the caller can read; p_q matches the
-- code or title without accents.
create or replace function public.list_dossiers(
  p_year int default null, p_status text default null, p_q text default null
)
returns table (
  id uuid, year int, code text, title text, department_name text, retention_label text,
  owner_name text, status text, legal_hold boolean, doc_count int, end_date date,
  transfer_due_date date
)
language plpgsql stable security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_org_id uuid;
  v_q text := nullif(public.fm_normalize(btrim(coalesce(p_q, ''))), '');
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if p_status is not null and p_status not in ('open', 'closed', 'transferred') then
    raise exception 'Unknown dossier status: %', p_status using errcode = '22023';
  end if;
  v_org_id := public.my_org_id();
  if v_org_id is null then
    return;
  end if;

  return query
  select d.id, d.year, d.code, d.title, dep.name, rc.label,
    public.doc_user_name(d.owner_id), d.status, d.legal_hold,
    (select count(*)::int from public.dossier_documents dd where dd.dossier_id = d.id),
    d.end_date, d.transfer_due_date
  from public.dossiers d
  left join public.departments dep on dep.id = d.department_id
  left join public.retention_codes rc on rc.id = d.retention_code_id
  where d.org_id = v_org_id
    and (p_year is null or d.year = p_year)
    and (p_status is null or d.status = p_status)
    and (v_q is null or strpos(public.fm_normalize(d.code || ' ' || d.title), v_q) > 0)
    and public.can_read_dossier(d.id)
  order by d.year desc, d.code, d.id;
end;
$$;

-- The dossier page: the dossier with display names and the caller's rights,
-- and its documents in order. Documents the caller cannot read keep only
-- their id and ordinal.
create or replace function public.get_dossier(p_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_d public.dossiers;
  v_detail jsonb;
  v_docs jsonb;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select * into v_d from public.dossiers where id = p_id;
  if v_d.id is null or not public.can_read_dossier(p_id) then
    raise exception 'Dossier not found' using errcode = 'P0002';
  end if;

  select to_jsonb(v_d) || jsonb_build_object(
    'department_name', dep.name,
    'department_code', dep.code,
    'retention_code', rc.code,
    'retention_label', rc.label,
    'retention_years', rc.years,
    'owner_name', public.doc_user_name(v_d.owner_id),
    'can_manage', public.dossier_can_manage(v_d, v_uid),
    'is_admin', public.has_org_role_user(v_d.org_id, 'org_admin', v_uid),
    'is_clerk', public.has_org_role_user(v_d.org_id, 'clerk', v_uid)
  )
  into v_detail
  from (select 1) one
  left join public.departments dep on dep.id = v_d.department_id
  left join public.retention_codes rc on rc.id = v_d.retention_code_id;

  select coalesce(jsonb_agg(
    case when c.ok then jsonb_build_object(
      'document_id', x.id,
      'ordinal', dd.ordinal,
      'subject', x.subject,
      'notation', x.notation,
      'arrival_number', x.arrival_number,
      'direction', x.direction,
      'status', x.status,
      'issued_date', x.issued_date,
      'arrival_date', x.arrival_date,
      'type_name', t.name,
      'readable', true
    ) else jsonb_build_object(
      'document_id', x.id,
      'ordinal', dd.ordinal,
      'readable', false
    ) end
    order by dd.ordinal), '[]')
  into v_docs
  from public.dossier_documents dd
  join public.documents x on x.id = dd.document_id
  left join public.doc_types t on t.id = x.doc_type_id
  cross join lateral (select public.can_read_document(x.id) as ok) c
  where dd.dossier_id = p_id;

  return jsonb_build_object('dossier', v_detail, 'documents', v_docs);
end;
$$;

-- Closed dossiers whose transfer to the archive is due within p_days (or
-- overdue); for clerks, admins and leaders.
create or replace function public.dossiers_due_for_transfer(p_days int default 30)
returns table (
  id uuid, year int, code text, title text, department_name text, retention_label text,
  owner_name text, status text, legal_hold boolean, doc_count int, end_date date,
  transfer_due_date date
)
language plpgsql stable security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_org_id uuid;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_org_id := public.my_org_id();
  if v_org_id is null or not (
    public.has_org_role_user(v_org_id, 'clerk', v_uid)
    or public.has_org_role_user(v_org_id, 'org_admin', v_uid)
    or public.has_org_role_user(v_org_id, 'leader', v_uid)
  ) then
    raise exception 'Only clerks, leaders or admins can see dossiers due for transfer'
      using errcode = '42501';
  end if;
  if p_days is null or p_days not between 0 and 3650 then
    raise exception 'Days must be between 0 and 3650' using errcode = '22023';
  end if;

  return query
  select d.id, d.year, d.code, d.title, dep.name, rc.label,
    public.doc_user_name(d.owner_id), d.status, d.legal_hold,
    (select count(*)::int from public.dossier_documents dd where dd.dossier_id = d.id),
    d.end_date, d.transfer_due_date
  from public.dossiers d
  left join public.departments dep on dep.id = d.department_id
  left join public.retention_codes rc on rc.id = d.retention_code_id
  where d.org_id = v_org_id
    and d.status = 'closed'
    and d.transfer_due_date <= public.org_now_date(v_org_id) + p_days
  order by d.transfer_due_date, d.code, d.id;
end;
$$;

-- The dossiers holding a readable document that the caller can read.
create or replace function public.document_dossiers(p_document_id uuid)
returns table (dossier_id uuid, code text, title text, status text)
language plpgsql stable security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if not public.can_read_document(p_document_id) then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;

  return query
  select d.id, d.code, d.title, d.status
  from public.dossier_documents dd
  join public.dossiers d on d.id = dd.dossier_id
  where dd.document_id = p_document_id and public.can_read_dossier(d.id)
  order by d.year desc, d.code, d.id;
end;
$$;

-- =============================================
-- Privileges
-- =============================================
-- Supabase (and the test stubs) grant new functions to anon/authenticated by
-- default, so each one is revoked explicitly; triggers fire without EXECUTE
-- on their function.
revoke all on function public.seed_retention_defaults(uuid) from public, anon, authenticated;
revoke all on function public.retention_seed_on_org_insert() from public, anon, authenticated;
revoke all on function public.dossier_for_update(uuid) from public, anon, authenticated;
revoke all on function public.dossier_can_manage(public.dossiers, uuid) from public, anon, authenticated;
revoke all on function public.dossier_transfer_due(date, boolean) from public, anon, authenticated;
revoke all on function public.document_on_legal_hold(uuid) from public, anon, authenticated;
revoke all on function public.dossiers_legal_hold_guard() from public, anon, authenticated;
grant execute on function public.seed_retention_defaults(uuid) to service_role;
grant execute on function public.retention_seed_on_org_insert() to service_role;
grant execute on function public.dossier_for_update(uuid) to service_role;
grant execute on function public.dossier_can_manage(public.dossiers, uuid) to service_role;
grant execute on function public.dossier_transfer_due(date, boolean) to service_role;
grant execute on function public.document_on_legal_hold(uuid) to service_role;
grant execute on function public.dossiers_legal_hold_guard() to service_role;

revoke all on function public.can_read_dossier(uuid) from public, anon;
revoke all on function public.upsert_retention_code(uuid, text, text, int, int) from public, anon;
revoke all on function public.create_dossier(int, text, text, uuid, uuid, text) from public, anon;
revoke all on function public.update_dossier(uuid, text, uuid, uuid, text, boolean) from public, anon;
revoke all on function public.add_document_to_dossier(uuid, uuid) from public, anon;
revoke all on function public.remove_document_from_dossier(uuid, uuid) from public, anon;
revoke all on function public.close_dossier(uuid, date) from public, anon;
revoke all on function public.reopen_dossier(uuid) from public, anon;
revoke all on function public.transfer_dossier(uuid) from public, anon;
revoke all on function public.set_dossier_legal_hold(uuid, boolean) from public, anon;
revoke all on function public.list_dossiers(int, text, text) from public, anon;
revoke all on function public.get_dossier(uuid) from public, anon;
revoke all on function public.dossiers_due_for_transfer(int) from public, anon;
revoke all on function public.document_dossiers(uuid) from public, anon;

grant execute on function public.can_read_dossier(uuid) to authenticated, service_role;
grant execute on function public.upsert_retention_code(uuid, text, text, int, int) to authenticated;
grant execute on function public.create_dossier(int, text, text, uuid, uuid, text) to authenticated;
grant execute on function public.update_dossier(uuid, text, uuid, uuid, text, boolean) to authenticated;
grant execute on function public.add_document_to_dossier(uuid, uuid) to authenticated;
grant execute on function public.remove_document_from_dossier(uuid, uuid) to authenticated;
grant execute on function public.close_dossier(uuid, date) to authenticated;
grant execute on function public.reopen_dossier(uuid) to authenticated;
grant execute on function public.transfer_dossier(uuid) to authenticated;
grant execute on function public.set_dossier_legal_hold(uuid, boolean) to authenticated;
grant execute on function public.list_dossiers(int, text, text) to authenticated;
grant execute on function public.get_dossier(uuid) to authenticated;
grant execute on function public.dossiers_due_for_transfer(int) to authenticated;
grant execute on function public.document_dossiers(uuid) to authenticated;
