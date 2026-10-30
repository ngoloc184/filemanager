-- Documents (Văn bản) core: lookups, registers (sổ), documents and their child
-- tables, access rules, file freeze, numbering helpers and the core RPCs.
-- Run after 202608280035_notifications.sql. Idempotent.
--
-- Clients only read (RLS); every write goes through the security definer RPCs
-- below. Attachments reuse public.files / file_versions / storage: files are
-- uploaded into the uploader's system folder 'Documents' (folders.purpose =
-- 'documents', see ensure_document_folder) and linked through document_files.
-- has_file_access gains two rules (checked last): viewer when the caller can
-- read a linked document, editor when the caller can edit it and the link is
-- not frozen. Storage RLS therefore works unchanged.
--
-- Freeze (Phụ lục VI III.5.d): files linked with document_files.frozen = true
-- cannot get new versions, switch back to an older version, be renamed,
-- moved, trashed or deleted (documents_freeze_* triggers).
--
-- Canonical document_events.action values (later tasks use only these):
--   created, profile_updated, file_attached, file_detached, opinion_added,
--   access_granted, access_revoked, registered, submitted, returned_to_clerk,
--   assigned, seen, assignment_updated, assignment_revoked, completed,
--   reopened, cancelled, chain_set, submitted_for_approval, approved,
--   returned, rejected, signed, issued, manual_number_override, recalled,
--   withdrawn, follow_up_created, reassigned, filed, unfiled, archived
--
-- get_document(p_id) 'related' relations: reply_to, replaces, corrects and
-- the reverse links replied_by, replaced_by, corrected_by.
--
-- Confidentiality 'confidential' is an internal company level visible only to
-- explicit participants; it is not a state secret (MẬT).
--
-- Rollback (manual; drops every document and its history):
--   drop trigger if exists documents_freeze_file_versions on public.file_versions;
--   drop trigger if exists documents_freeze_files_update on public.files;
--   drop trigger if exists documents_freeze_files_delete on public.files;
--   re-run has_file_access from 202608280022_folder_owner_access.sql;
--   drop table if exists public.document_grants, public.document_access_log,
--     public.document_events, public.document_opinions, public.document_approval_steps,
--     public.document_assignments, public.document_recipients, public.document_files,
--     public.documents, public.doc_register_roles, public.doc_register_counters,
--     public.doc_registers, public.external_orgs, public.doc_fields, public.doc_types cascade;
--   drop index if exists public.uq_folders_documents_purpose;
--   alter table public.folders drop column if exists purpose;
--   then drop the functions listed in the privileges section at the end.

-- =============================================
-- Lookups
-- =============================================
create table if not exists public.doc_types (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 100),
  abbreviation text not null default '' check (char_length(abbreviation) <= 10),
  is_cong_van boolean not null default false,
  default_retention_code text,
  active boolean not null default true,
  sort_order int not null default 0,
  unique (org_id, name)
);

create table if not exists public.doc_fields (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  active boolean not null default true,
  unique (org_id, name)
);

create table if not exists public.external_orgs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  code text check (code is null or char_length(code) <= 50),
  email text check (email is null or char_length(email) <= 320),
  address text check (address is null or char_length(address) <= 500),
  active boolean not null default true
);

create index if not exists idx_external_orgs_org on public.external_orgs (org_id);

-- =============================================
-- Registers (sổ) and their counters
-- =============================================
create table if not exists public.doc_registers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  direction text not null check (direction in ('incoming', 'outgoing', 'internal')),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  year int not null,
  start_number int not null default 1 check (start_number >= 1),
  scope text not null default 'register' check (scope in ('register', 'register_type')),
  notation_template text not null default '{n}/{type}-{org}',
  cong_van_template text not null default '{n}/{org}-{dept}',
  is_confidential boolean not null default false,
  allowed_type_ids uuid[] not null default '{}',
  closed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, direction, name, year)
);

-- type_key is the doc type for scope 'register_type', else the zero uuid.
create table if not exists public.doc_register_counters (
  register_id uuid not null references public.doc_registers(id) on delete cascade,
  type_key uuid not null default '00000000-0000-0000-0000-000000000000',
  last_number int not null,
  primary key (register_id, type_key)
);

create table if not exists public.doc_register_roles (
  register_id uuid not null references public.doc_registers(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('manager', 'follower')),
  primary key (register_id, user_id)
);

create index if not exists idx_doc_register_roles_user on public.doc_register_roles (user_id);

-- =============================================
-- Documents
-- =============================================
create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  direction text not null check (direction in ('incoming', 'outgoing', 'internal')),
  status text not null default 'draft',

  -- registration and numbering
  register_id uuid references public.doc_registers(id),
  number int,
  notation text check (notation is null or char_length(notation) <= 100),
  arrival_number int,
  arrival_date date,

  -- profile
  doc_type_id uuid references public.doc_types(id) on delete set null,
  field_id uuid references public.doc_fields(id) on delete set null,
  subject text not null check (char_length(btrim(subject)) between 1 and 500),
  issuing_org_name text check (issuing_org_name is null or char_length(issuing_org_name) <= 500),
  external_org_id uuid references public.external_orgs(id) on delete set null,
  issued_date date,
  signer_name text check (signer_name is null or char_length(signer_name) <= 200),
  signer_position text check (signer_position is null or char_length(signer_position) <= 200),
  signer_user_id uuid references auth.users(id) on delete set null,
  signer_authority text not null default '' check (signer_authority in ('', 'KT', 'TL', 'TUQ', 'TM', 'Q')),
  page_count int check (page_count is null or page_count >= 0),
  copies int check (copies is null or copies >= 0),
  urgency text not null default 'normal' check (urgency in ('normal', 'khan', 'thuong_khan', 'hoa_toc')),
  confidentiality text not null default 'normal'
    check (confidentiality in ('normal', 'internal', 'restricted', 'confidential')),
  due_date date,
  drafting_department_id uuid references public.departments(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  presented_to uuid references auth.users(id) on delete set null,
  reply_to_id uuid references public.documents(id) on delete set null,
  replaces_id uuid references public.documents(id) on delete set null,
  corrects_id uuid references public.documents(id) on delete set null,
  keywords text[] not null default '{}',
  description text check (description is null or char_length(description) <= 2000),

  -- workflow tracking
  revision int not null default 1,
  current_step_no int,
  registered_at timestamptz,
  submitted_at timestamptz,
  signed_at timestamptz,
  signed_checksum text,
  issued_at timestamptz,
  completed_at timestamptz,
  result_note text,
  recalled_at timestamptz,
  recall_reason text,
  cancelled_at timestamptz,
  archived_at timestamptz,

  -- search
  search_norm text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint documents_status_by_direction check (
    (direction = 'incoming'
      and status in ('draft', 'registered', 'submitted', 'in_progress', 'completed', 'cancelled', 'archived'))
    or (direction in ('outgoing', 'internal')
      and status in ('draft', 'in_review', 'awaiting_signature', 'signed', 'issued',
                     'rejected', 'withdrawn', 'recalled', 'archived'))
  )
);

-- Incoming notations belong to the sender: not unique, and the clerk may
-- register the same one twice on purpose (duplicate override).
create unique index if not exists uq_documents_register_notation
  on public.documents (register_id, notation)
  where notation is not null and direction in ('outgoing', 'internal') and status <> 'cancelled';
create unique index if not exists uq_documents_register_arrival
  on public.documents (register_id, arrival_number)
  where arrival_number is not null;
create index if not exists idx_documents_org_status on public.documents (org_id, status);
create index if not exists idx_documents_org_due on public.documents (org_id, due_date);
create index if not exists idx_documents_org_notation on public.documents (org_id, direction, lower(notation));
create index if not exists idx_documents_search_norm on public.documents using gin (search_norm gin_trgm_ops);
create index if not exists idx_documents_created_by on public.documents (created_by);

create or replace function public.documents_set_search_norm()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.search_norm := public.fm_normalize(concat_ws(' ',
    new.subject, new.notation, new.issuing_org_name,
    array_to_string(new.keywords, ' '), new.description));
  return new;
end;
$$;

drop trigger if exists documents_search_norm on public.documents;
create trigger documents_search_norm
  before insert or update on public.documents
  for each row execute function public.documents_set_search_norm();

drop trigger if exists documents_set_updated_at on public.documents;
create trigger documents_set_updated_at
  before update on public.documents
  for each row execute function public.handle_updated_at();

-- =============================================
-- Document child tables
-- =============================================
-- file_id cascades so emptying the trash of a draft attachment works; frozen
-- files are protected by the freeze trigger, which raises before the delete.
create table if not exists public.document_files (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  file_id uuid not null references public.files(id) on delete cascade,
  kind text not null check (kind in ('main', 'attachment', 'signed', 'draft')),
  frozen boolean not null default false,
  added_by uuid references auth.users(id) on delete set null,
  added_at timestamptz not null default now(),
  unique (document_id, file_id)
);

-- has_file_access runs for every row of the files/storage policies
create index if not exists idx_document_files_file on public.document_files (file_id);

create table if not exists public.document_recipients (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  kind text not null check (kind in ('member', 'department', 'external')),
  user_id uuid references auth.users(id) on delete set null,
  department_id uuid references public.departments(id) on delete set null,
  external_org_id uuid references public.external_orgs(id) on delete set null,
  name_snapshot text not null,
  method text not null default 'system' check (method in ('system', 'email', 'post', 'hand')),
  sent_at timestamptz,
  acknowledged_at timestamptz,
  note text
);

create index if not exists idx_document_recipients_document on public.document_recipients (document_id);
create index if not exists idx_document_recipients_user on public.document_recipients (user_id) where user_id is not null;

create table if not exists public.document_assignments (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  parent_id uuid references public.document_assignments(id) on delete cascade,
  assignee_user_id uuid references auth.users(id) on delete set null,
  assignee_department_id uuid references public.departments(id) on delete set null,
  role text not null check (role in ('lead', 'support', 'info')),
  instruction text check (instruction is null or char_length(instruction) <= 2000),
  due_date date,
  assigned_by uuid references auth.users(id) on delete set null,
  assigned_at timestamptz not null default now(),
  status text not null default 'pending'
    check (status in ('pending', 'seen', 'in_progress', 'done', 'returned', 'revoked')),
  seen_at timestamptz,
  done_at timestamptz,
  result text check (result is null or char_length(result) <= 5000),
  check ((assignee_user_id is null) <> (assignee_department_id is null))
);

create index if not exists idx_document_assignments_document on public.document_assignments (document_id);
create index if not exists idx_document_assignments_user on public.document_assignments (assignee_user_id, status);
create index if not exists idx_document_assignments_department on public.document_assignments (assignee_department_id, status);

create table if not exists public.document_approval_steps (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  revision int not null,
  step_no int not null,
  kind text not null check (kind in ('review', 'format_check', 'consult', 'sign')),
  approver_user_id uuid references auth.users(id) on delete set null,
  required boolean not null default true,
  status text not null default 'waiting'
    check (status in ('waiting', 'pending', 'approved', 'returned', 'rejected', 'skipped')),
  comment text,
  acted_at timestamptz,
  acted_by uuid,
  unique (document_id, revision, step_no, approver_user_id)
);

create index if not exists idx_document_approval_steps_approver on public.document_approval_steps (approver_user_id, status);

create table if not exists public.document_opinions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  author_id uuid references auth.users(id) on delete set null,
  kind text not null check (kind in ('instruction', 'proposal', 'comment', 'result', 'consult_reply')),
  body text not null check (char_length(body) between 1 and 5000),
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists idx_document_opinions_document on public.document_opinions (document_id, created_at);

-- Append-only audit timeline: written only by doc_log (definer RPCs).
create table if not exists public.document_events (
  id bigserial primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  document_id uuid references public.documents(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null constraint document_events_action_check check (action in (
    'created', 'profile_updated', 'file_attached', 'file_detached', 'opinion_added',
    'access_granted', 'access_revoked', 'registered', 'submitted', 'returned_to_clerk',
    'assigned', 'seen', 'assignment_updated', 'assignment_revoked', 'completed',
    'reopened', 'cancelled', 'chain_set', 'submitted_for_approval', 'approved',
    'returned', 'rejected', 'signed', 'issued', 'manual_number_override', 'recalled',
    'withdrawn', 'follow_up_created', 'reassigned', 'filed', 'unfiled', 'archived'
  )),
  from_status text,
  to_status text,
  data jsonb not null default '{}',
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists idx_document_events_document on public.document_events (document_id, created_at);
create index if not exists idx_document_events_registered
  on public.document_events (document_id, actor_id) where action = 'registered';

create table if not exists public.document_access_log (
  id bigserial primary key,
  document_id uuid not null references public.documents(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  action text not null check (action in ('view', 'download', 'print')),
  at timestamptz not null default now()
);

create index if not exists idx_document_access_log_document on public.document_access_log (document_id, user_id, at desc);

create table if not exists public.document_grants (
  document_id uuid not null references public.documents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  access text not null check (access in ('read', 'edit')),
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (document_id, user_id)
);

create index if not exists idx_document_grants_user on public.document_grants (user_id);

-- The uploader's system folder for document attachments (one per owner).
alter table public.folders add column if not exists purpose text check (purpose in ('documents'));
create unique index if not exists uq_folders_documents_purpose
  on public.folders (owner_id) where purpose = 'documents' and deleted_at is null;

-- =============================================
-- Dates, deadlines and notation (client helpers)
-- =============================================
create or replace function public.org_now_date(p_org_id uuid)
returns date
language sql stable security definer
set search_path = public
as $$
  select (now() at time zone coalesce(
    (select o.timezone from public.organizations o where o.id = p_org_id),
    'Asia/Ho_Chi_Minh'
  ))::date;
$$;

create or replace function public.doc_year_for(p_org_id uuid, p_ts timestamptz)
returns int
language sql stable security definer
set search_path = public
as $$
  select extract(year from (p_ts at time zone coalesce(
    (select o.timezone from public.organizations o where o.id = p_org_id),
    'Asia/Ho_Chi_Minh'
  )))::int;
$$;

-- Default processing deadline in working days by urgency (a proposal).
create or replace function public.doc_default_due_days(p_urgency text)
returns int
language sql immutable
set search_path = public
as $$
  select case p_urgency
    when 'hoa_toc' then 0
    when 'thuong_khan' then 1
    when 'khan' then 2
    else 7
  end;
$$;

-- p_days working days after p_from (Mon–Fri minus the company's holidays);
-- 0 returns p_from when it is a working day, else the next working day.
-- Holidays count only for members of the company (and server-side callers).
create or replace function public.doc_add_working_days(p_org_id uuid, p_from date, p_days int)
returns date
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_day date := p_from;
  v_left int := greatest(coalesce(p_days, 0), 0);
  v_holidays date[] := '{}';
  v_guard int := 0;
begin
  if p_from is null then
    return null;
  end if;
  if v_left > 3650 then
    raise exception 'Too many working days' using errcode = '22023';
  end if;
  if auth.uid() is null or public.is_org_member_user(p_org_id, auth.uid()) then
    select coalesce(array_agg(h.day), '{}') into v_holidays
    from public.org_holidays h
    where h.org_id = p_org_id and h.day >= p_from;
  end if;

  if v_left = 0 then
    while extract(isodow from v_day) in (6, 7) or v_day = any (v_holidays) loop
      v_day := v_day + 1;
      v_guard := v_guard + 1;
      if v_guard > 4000 then
        raise exception 'No working day found' using errcode = '22023';
      end if;
    end loop;
    return v_day;
  end if;

  while v_left > 0 loop
    v_day := v_day + 1;
    v_guard := v_guard + 1;
    if v_guard > 20000 then
      raise exception 'No working day found' using errcode = '22023';
    end if;
    if extract(isodow from v_day) not in (6, 7) and not (v_day = any (v_holidays)) then
      v_left := v_left - 1;
    end if;
  end loop;
  return v_day;
end;
$$;

-- Fills a notation template: {n} (zero-padded to 2), {type}, {org}, {dept},
-- {yyyy}; separators left around an empty token are dropped
-- ('{n}/{type}-{org}' with no type gives '02/ABC', not '02/-ABC').
create or replace function public.doc_render_notation(
  p_template text, p_number int, p_type text, p_org text, p_dept text, p_year int
)
returns text
language plpgsql immutable
set search_path = public
as $$
declare
  v text := coalesce(p_template, '');
  v_n text := coalesce(p_number::text, '');
begin
  v := replace(v, '{n}', case when v_n = '' then '' else lpad(v_n, greatest(2, char_length(v_n)), '0') end);
  v := replace(v, '{type}', coalesce(btrim(p_type), ''));
  v := replace(v, '{org}', coalesce(btrim(p_org), ''));
  v := replace(v, '{dept}', coalesce(btrim(p_dept), ''));
  v := replace(v, '{yyyy}', coalesce(p_year::text, ''));
  v := regexp_replace(v, '-{2,}', '-', 'g');
  v := regexp_replace(v, '/{2,}', '/', 'g');
  v := regexp_replace(v, '-+/', '/', 'g');
  v := regexp_replace(v, '/-+', '/', 'g');
  v := regexp_replace(v, '^[-/[:space:]]+|[-/[:space:]]+$', '', 'g');
  return v;
end;
$$;

-- =============================================
-- Internal helpers (definer RPCs only; service_role grant)
-- =============================================

-- Next number of a register (per doc type when scope = 'register_type').
-- Numbers are never handed out twice, also when a document is cancelled.
create or replace function public.doc_next_number(p_register_id uuid, p_doc_type_id uuid)
returns int
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_reg public.doc_registers;
  v_key uuid;
  v_last int;
begin
  select * into v_reg from public.doc_registers where id = p_register_id;
  if v_reg.id is null then
    raise exception 'Register not found' using errcode = 'P0002';
  end if;
  if v_reg.closed_at is not null then
    raise exception 'This register is closed' using errcode = '22023';
  end if;
  v_key := case
    when v_reg.scope = 'register_type' then coalesce(p_doc_type_id, '00000000-0000-0000-0000-000000000000'::uuid)
    else '00000000-0000-0000-0000-000000000000'::uuid
  end;

  insert into public.doc_register_counters (register_id, type_key, last_number)
  values (p_register_id, v_key, v_reg.start_number - 1)
  on conflict (register_id, type_key) do nothing;

  select last_number into v_last
  from public.doc_register_counters
  where register_id = p_register_id and type_key = v_key
  for update;

  update public.doc_register_counters
  set last_number = v_last + 1
  where register_id = p_register_id and type_key = v_key;
  return v_last + 1;
end;
$$;

create or replace function public.doc_log(
  p_document_id uuid, p_action text, p_from text, p_to text, p_data jsonb default '{}'
)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.document_events (org_id, document_id, actor_id, action, from_status, to_status, data)
  select d.org_id, d.id, auth.uid(), p_action, p_from, p_to, coalesce(p_data, '{}')
  from public.documents d
  where d.id = p_document_id;
  if not found then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
end;
$$;

-- A failing notification never breaks the document action itself.
create or replace function public.doc_notify(
  p_user_id uuid, p_document_id uuid, p_kind text, p_title text, p_body text default null
)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_org_id uuid;
begin
  select org_id into v_org_id from public.documents where id = p_document_id;
  if v_org_id is null or p_user_id is null then
    return null;
  end if;
  begin
    return public.create_notification(
      p_user_id, p_kind, p_title, p_body, '/documents/' || p_document_id,
      'document', p_document_id, v_org_id
    );
  exception when others then
    raise warning 'doc_notify: %', sqlerrm;
    return null;
  end;
end;
$$;

create or replace function public.doc_notify_department(
  p_department_id uuid, p_document_id uuid, p_kind text, p_title text
)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_head uuid;
begin
  select d.head_user_id into v_head
  from public.departments d
  where d.id = p_department_id and d.archived_at is null;
  if v_head is not null then
    perform public.doc_notify(v_head, p_document_id, p_kind, p_title);
  end if;
end;
$$;

create or replace function public.doc_user_name(p_user_id uuid)
returns text
language sql stable security definer
set search_path = public
as $$
  select coalesce(nullif(btrim(p.display_name), ''), p.email)
  from public.user_profiles p where p.id = p_user_id;
$$;

-- Typed readers for profile JSON: JSON null or a blank string give null.
create or replace function public.doc_json_text(p jsonb, p_key text, p_max int, p_label text)
returns text
language plpgsql immutable
set search_path = public
as $$
declare
  v text;
begin
  if coalesce(jsonb_typeof(p -> p_key), 'null') = 'null' then
    return null;
  end if;
  if jsonb_typeof(p -> p_key) not in ('string', 'number') then
    raise exception '% must be text', p_label using errcode = '22023';
  end if;
  v := nullif(btrim(p ->> p_key), '');
  if char_length(v) > p_max then
    raise exception '% is too long (max % characters)', p_label, p_max using errcode = '22023';
  end if;
  return v;
end;
$$;

create or replace function public.doc_json_uuid(p jsonb, p_key text, p_label text)
returns uuid
language plpgsql immutable
set search_path = public
as $$
declare
  v text := public.doc_json_text(p, p_key, 100, p_label);
begin
  return v::uuid;
exception when data_exception then
  raise exception '% is not valid', p_label using errcode = '22023';
end;
$$;

create or replace function public.doc_json_date(p jsonb, p_key text, p_label text)
returns date
language plpgsql immutable
set search_path = public
as $$
declare
  v text := public.doc_json_text(p, p_key, 40, p_label);
begin
  if v is not null and v !~ '^\d{4}-\d{2}-\d{2}' then
    raise exception '% must be a date (yyyy-mm-dd)', p_label using errcode = '22023';
  end if;
  return v::date;
exception when data_exception then
  raise exception '% must be a date (yyyy-mm-dd)', p_label using errcode = '22023';
end;
$$;

create or replace function public.doc_json_int(p jsonb, p_key text, p_label text)
returns int
language plpgsql immutable
set search_path = public
as $$
declare
  v text := public.doc_json_text(p, p_key, 20, p_label);
  n int;
begin
  if v is null then
    return null;
  end if;
  if v !~ '^\d+$' then
    raise exception '% must be a whole number', p_label using errcode = '22023';
  end if;
  n := v::int;
  if n > 1000000 then
    raise exception '% is too large', p_label using errcode = '22023';
  end if;
  return n;
exception when numeric_value_out_of_range or invalid_text_representation then
  raise exception '% is too large', p_label using errcode = '22023';
end;
$$;

-- =============================================
-- Access rules (client helpers; RLS and the UI use them)
-- =============================================
create or replace function public.can_read_document(p_document_id uuid)
returns boolean
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.documents;
  v_private_draft boolean;
begin
  if v_uid is null or p_document_id is null then
    return false;
  end if;
  select * into v_doc from public.documents where id = p_document_id;
  if v_doc.id is null or not public.is_org_member_user(v_doc.org_id, v_uid) then
    return false;
  end if;

  -- outgoing/internal drafts that were never submitted belong to their author
  v_private_draft := v_doc.direction in ('outgoing', 'internal')
    and v_doc.status = 'draft' and v_doc.submitted_at is null;

  -- (b) author, the person it is presented to, the signer
  if v_doc.created_by = v_uid or v_doc.presented_to = v_uid or v_doc.signer_user_id = v_uid then
    return true;
  end if;

  if v_doc.confidentiality <> 'confidential' then
    -- (a) admins, leaders and clerks see the company's documents
    if not v_private_draft and exists (
      select 1 from public.org_members m
      where m.org_id = v_doc.org_id and m.user_id = v_uid and m.status = 'active'
        and m.roles && array['org_admin', 'leader', 'clerk']
    ) then
      return true;
    end if;
  else
    -- (k) confidential: only the clerk who registered it
    if exists (
      select 1 from public.document_events e
      where e.document_id = p_document_id and e.action = 'registered' and e.actor_id = v_uid
    ) then
      return true;
    end if;
  end if;

  -- (c) assigned to me, (d) to a department I head, (e) for information to my department
  if exists (
    select 1 from public.document_assignments a
    where a.document_id = p_document_id
      and a.status <> 'revoked'
      and (
        a.assignee_user_id = v_uid
        or a.assignee_department_id in (select public.headed_departments_of(v_uid))
        or (a.role = 'info' and a.assignee_department_id = public.member_department(v_doc.org_id, v_uid))
      )
  ) then
    return true;
  end if;

  -- (f) department heads see what their department drafts
  if v_doc.confidentiality <> 'confidential' and not v_private_draft
     and v_doc.drafting_department_id is not null
     and public.has_org_role_user(v_doc.org_id, 'dept_head', v_uid)
     and v_doc.drafting_department_id in (select public.headed_departments_of(v_uid)) then
    return true;
  end if;

  -- (g) approvers
  if exists (
    select 1 from public.document_approval_steps s
    where s.document_id = p_document_id and s.approver_user_id = v_uid
  ) then
    return true;
  end if;

  -- (h) member recipients
  if exists (
    select 1 from public.document_recipients r
    where r.document_id = p_document_id and r.kind = 'member' and r.user_id = v_uid
  ) then
    return true;
  end if;

  -- (i) managers and followers of the register (never an unsubmitted draft)
  if v_doc.confidentiality <> 'confidential' and not v_private_draft
     and v_doc.register_id is not null and exists (
       select 1 from public.doc_register_roles rr
       where rr.register_id = v_doc.register_id and rr.user_id = v_uid
     ) then
    return true;
  end if;

  -- (j) shared with me
  return exists (
    select 1 from public.document_grants g
    where g.document_id = p_document_id and g.user_id = v_uid
  );
end;
$$;

create or replace function public.can_edit_document(p_document_id uuid)
returns boolean
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.documents;
  v_ok boolean := false;
begin
  if v_uid is null or p_document_id is null then
    return false;
  end if;
  select * into v_doc from public.documents where id = p_document_id;
  if v_doc.id is null or not public.is_org_member_user(v_doc.org_id, v_uid) then
    return false;
  end if;

  if v_doc.direction = 'incoming' then
    v_ok := v_doc.status in ('draft', 'registered')
      and public.has_org_role_user(v_doc.org_id, 'clerk', v_uid);
  else
    v_ok := (v_doc.created_by = v_uid and v_doc.status = 'draft')
      -- profile metadata only (update_document_profile enforces the keys)
      or (v_doc.status = 'signed' and public.has_org_role_user(v_doc.org_id, 'clerk', v_uid));
  end if;

  if not v_ok and v_doc.status = 'draft' then
    v_ok := exists (
      select 1 from public.document_grants g
      where g.document_id = p_document_id and g.user_id = v_uid and g.access = 'edit'
    );
  end if;

  -- editing never reaches further than reading (confidential documents)
  return v_ok and public.can_read_document(p_document_id);
end;
$$;

-- =============================================
-- has_file_access: the 202608280022 body unchanged, plus the document rules
-- at the end (checked last: they are the most expensive).
-- =============================================
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

  -- owners of the containing folder (or any ancestor) manage files that
  -- collaborators uploaded into it, also while they are in the trash
  if fi.folder_id is not null and exists (
    with recursive chain as (
      select p.id, p.parent_id, p.owner_id from public.folders p where p.id = fi.folder_id
      union all
      select p.id, p.parent_id, p.owner_id
      from public.folders p
      join chain c on c.parent_id = p.id
    )
    select 1 from chain where owner_id = auth.uid()
  ) then
    return public.role_rank(required_role) <= public.role_rank('admin');
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

  -- attached to a document the caller can read
  if public.role_rank(required_role) <= public.role_rank('viewer') and exists (
    select 1 from public.document_files df
    where df.file_id = f_id and public.can_read_document(df.document_id)
  ) then
    return true;
  end if;

  -- attached (not frozen) to a document the caller can edit
  if public.role_rank(required_role) <= public.role_rank('editor') and exists (
    select 1 from public.document_files df
    where df.file_id = f_id and not df.frozen and public.can_edit_document(df.document_id)
  ) then
    return true;
  end if;

  return false;
end;
$$;

-- =============================================
-- Freeze: files of a registered or issued document stay as they are
-- =============================================
create or replace function public.documents_freeze_guard()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_file_id uuid;
begin
  -- separate branches: NEW is null on delete, and files has no file_id
  if tg_table_name = 'file_versions' then
    v_file_id := new.file_id;
  elsif tg_op = 'DELETE' then
    v_file_id := old.id;
  else
    v_file_id := new.id;
  end if;
  if exists (
    select 1 from public.document_files df where df.file_id = v_file_id and df.frozen
  ) then
    raise exception 'This file is locked because the document was registered or issued'
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists documents_freeze_file_versions on public.file_versions;
create trigger documents_freeze_file_versions
  before insert on public.file_versions
  for each row execute function public.documents_freeze_guard();

drop trigger if exists documents_freeze_files_update on public.files;
create trigger documents_freeze_files_update
  before update on public.files
  for each row
  when (new.name is distinct from old.name
        or new.deleted_at is distinct from old.deleted_at
        or new.folder_id is distinct from old.folder_id
        -- restore_file_version swaps the content without a new version row
        or new.current_version_id is distinct from old.current_version_id)
  execute function public.documents_freeze_guard();

drop trigger if exists documents_freeze_files_delete on public.files;
create trigger documents_freeze_files_delete
  before delete on public.files
  for each row execute function public.documents_freeze_guard();

-- =============================================
-- RLS: read through the access rules; nobody writes directly
-- =============================================
alter table public.doc_types enable row level security;
alter table public.doc_fields enable row level security;
alter table public.external_orgs enable row level security;
alter table public.doc_registers enable row level security;
alter table public.doc_register_counters enable row level security;
alter table public.doc_register_roles enable row level security;
alter table public.documents enable row level security;
alter table public.document_files enable row level security;
alter table public.document_recipients enable row level security;
alter table public.document_assignments enable row level security;
alter table public.document_approval_steps enable row level security;
alter table public.document_opinions enable row level security;
alter table public.document_events enable row level security;
alter table public.document_access_log enable row level security;
alter table public.document_grants enable row level security;

drop policy if exists "Members can view document types" on public.doc_types;
create policy "Members can view document types"
  on public.doc_types for select to authenticated
  using (public.is_org_member(org_id));

drop policy if exists "Members can view document fields" on public.doc_fields;
create policy "Members can view document fields"
  on public.doc_fields for select to authenticated
  using (public.is_org_member(org_id));

drop policy if exists "Members can view external organizations" on public.external_orgs;
create policy "Members can view external organizations"
  on public.external_orgs for select to authenticated
  using (public.is_org_member(org_id));

drop policy if exists "Members can view registers" on public.doc_registers;
create policy "Members can view registers"
  on public.doc_registers for select to authenticated
  using (public.is_org_member(org_id));

drop policy if exists "Members can view register counters" on public.doc_register_counters;
create policy "Members can view register counters"
  on public.doc_register_counters for select to authenticated
  using (exists (
    select 1 from public.doc_registers r
    where r.id = register_id and public.is_org_member(r.org_id)
  ));

drop policy if exists "Members can view register roles" on public.doc_register_roles;
create policy "Members can view register roles"
  on public.doc_register_roles for select to authenticated
  using (exists (
    select 1 from public.doc_registers r
    where r.id = register_id and public.is_org_member(r.org_id)
  ));

drop policy if exists "Readers can view documents" on public.documents;
create policy "Readers can view documents"
  on public.documents for select to authenticated
  using (public.can_read_document(id));

drop policy if exists "Readers can view document files" on public.document_files;
create policy "Readers can view document files"
  on public.document_files for select to authenticated
  using (public.can_read_document(document_id));

drop policy if exists "Readers can view document recipients" on public.document_recipients;
create policy "Readers can view document recipients"
  on public.document_recipients for select to authenticated
  using (public.can_read_document(document_id));

drop policy if exists "Readers can view document assignments" on public.document_assignments;
create policy "Readers can view document assignments"
  on public.document_assignments for select to authenticated
  using (public.can_read_document(document_id));

drop policy if exists "Readers can view approval steps" on public.document_approval_steps;
create policy "Readers can view approval steps"
  on public.document_approval_steps for select to authenticated
  using (public.can_read_document(document_id));

drop policy if exists "Readers can view document opinions" on public.document_opinions;
create policy "Readers can view document opinions"
  on public.document_opinions for select to authenticated
  using (public.can_read_document(document_id));

drop policy if exists "Readers can view document events" on public.document_events;
create policy "Readers can view document events"
  on public.document_events for select to authenticated
  using (public.can_read_document(document_id));

-- company admins see the whole log of their company; everyone sees their own rows
drop policy if exists "Admins and the viewer can view the access log" on public.document_access_log;
create policy "Admins and the viewer can view the access log"
  on public.document_access_log for select to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.documents d
      where d.id = document_id and public.is_org_admin(d.org_id)
    )
  );

drop policy if exists "Readers can view document grants" on public.document_grants;
create policy "Readers can view document grants"
  on public.document_grants for select to authenticated
  using (public.can_read_document(document_id));

revoke all on table public.doc_types, public.doc_fields, public.external_orgs,
  public.doc_registers, public.doc_register_counters, public.doc_register_roles,
  public.documents, public.document_files, public.document_recipients,
  public.document_assignments, public.document_approval_steps, public.document_opinions,
  public.document_events, public.document_access_log, public.document_grants
  from public, anon, authenticated;
grant select on table public.doc_types, public.doc_fields, public.external_orgs,
  public.doc_registers, public.doc_register_counters, public.doc_register_roles,
  public.documents, public.document_files, public.document_recipients,
  public.document_assignments, public.document_approval_steps, public.document_opinions,
  public.document_events, public.document_access_log, public.document_grants
  to authenticated;
grant all on table public.doc_types, public.doc_fields, public.external_orgs,
  public.doc_registers, public.doc_register_counters, public.doc_register_roles,
  public.documents, public.document_files, public.document_recipients,
  public.document_assignments, public.document_approval_steps, public.document_opinions,
  public.document_events, public.document_access_log, public.document_grants
  to service_role;
revoke all on sequence public.document_events_id_seq, public.document_access_log_id_seq
  from public, anon, authenticated;
grant usage, select on sequence public.document_events_id_seq, public.document_access_log_id_seq
  to service_role;

-- =============================================
-- Profile validation (shared by create_document and update_document_profile)
-- =============================================
-- Returns the allowed keys of p_profile, validated and typed as JSON; keys it
-- does not know are ignored. A key given as JSON null clears that field.
-- notation, issued_date and arrival_date are kept for incoming documents only.
create or replace function public.doc_clean_profile(
  p_org_id uuid, p_direction text, p_profile jsonb, p_self_id uuid default null
)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  p jsonb := coalesce(p_profile, '{}');
  v jsonb := '{}';
  v_text text;
  v_id uuid;
  v_kw text[];
begin
  if jsonb_typeof(p) <> 'object' then
    raise exception 'Invalid document profile' using errcode = '22023';
  end if;

  if p ? 'subject' then
    v_text := btrim(coalesce(p ->> 'subject', ''));
    if char_length(v_text) not between 1 and 500 then
      raise exception 'Subject must be 1 to 500 characters' using errcode = '22023';
    end if;
    v := v || jsonb_build_object('subject', v_text);
  end if;

  if p ? 'doc_type_id' then
    v_id := public.doc_json_uuid(p, 'doc_type_id', 'Document type');
    if v_id is not null and not exists (
      select 1 from public.doc_types t where t.id = v_id and t.org_id = p_org_id
    ) then
      raise exception 'Document type not found' using errcode = 'P0002';
    end if;
    v := v || jsonb_build_object('doc_type_id', v_id);
  end if;

  if p ? 'field_id' then
    v_id := public.doc_json_uuid(p, 'field_id', 'Field');
    if v_id is not null and not exists (
      select 1 from public.doc_fields f where f.id = v_id and f.org_id = p_org_id
    ) then
      raise exception 'Field not found' using errcode = 'P0002';
    end if;
    v := v || jsonb_build_object('field_id', v_id);
  end if;

  if p ? 'urgency' then
    v_text := coalesce(public.doc_json_text(p, 'urgency', 20, 'Urgency'), 'normal');
    if v_text not in ('normal', 'khan', 'thuong_khan', 'hoa_toc') then
      raise exception 'Unknown urgency: %', v_text using errcode = '22023';
    end if;
    v := v || jsonb_build_object('urgency', v_text);
  end if;

  if p ? 'confidentiality' then
    v_text := coalesce(public.doc_json_text(p, 'confidentiality', 20, 'Confidentiality'), 'normal');
    if v_text not in ('normal', 'internal', 'restricted', 'confidential') then
      raise exception 'Unknown confidentiality: %', v_text using errcode = '22023';
    end if;
    v := v || jsonb_build_object('confidentiality', v_text);
  end if;

  if p ? 'due_date' then
    v := v || jsonb_build_object('due_date', public.doc_json_date(p, 'due_date', 'Due date'));
  end if;

  if p ? 'issuing_org_name' then
    v := v || jsonb_build_object('issuing_org_name',
      public.doc_json_text(p, 'issuing_org_name', 500, 'Issuing organization'));
  end if;

  if p ? 'external_org_id' then
    v_id := public.doc_json_uuid(p, 'external_org_id', 'External organization');
    if v_id is not null and not exists (
      select 1 from public.external_orgs e where e.id = v_id and e.org_id = p_org_id
    ) then
      raise exception 'External organization not found' using errcode = 'P0002';
    end if;
    v := v || jsonb_build_object('external_org_id', v_id);
  end if;

  if p_direction = 'incoming' then
    if p ? 'notation' then
      v := v || jsonb_build_object('notation', public.doc_json_text(p, 'notation', 100, 'Notation'));
    end if;
    if p ? 'issued_date' then
      v := v || jsonb_build_object('issued_date', public.doc_json_date(p, 'issued_date', 'Issued date'));
    end if;
    if p ? 'arrival_date' then
      v := v || jsonb_build_object('arrival_date', public.doc_json_date(p, 'arrival_date', 'Arrival date'));
    end if;
  end if;

  if p ? 'signer_name' then
    v := v || jsonb_build_object('signer_name', public.doc_json_text(p, 'signer_name', 200, 'Signer name'));
  end if;
  if p ? 'signer_position' then
    v := v || jsonb_build_object('signer_position',
      public.doc_json_text(p, 'signer_position', 200, 'Signer position'));
  end if;
  if p ? 'page_count' then
    v := v || jsonb_build_object('page_count', public.doc_json_int(p, 'page_count', 'Page count'));
  end if;
  if p ? 'copies' then
    v := v || jsonb_build_object('copies', public.doc_json_int(p, 'copies', 'Copies'));
  end if;

  if p ? 'keywords' then
    if coalesce(jsonb_typeof(p -> 'keywords'), 'null') = 'null' then
      v_kw := '{}';
    elsif jsonb_typeof(p -> 'keywords') <> 'array' or exists (
      select 1 from jsonb_array_elements(p -> 'keywords') e where jsonb_typeof(e) <> 'string'
    ) then
      raise exception 'Keywords must be a list of words' using errcode = '22023';
    else
      -- trimmed, blanks dropped, duplicates removed (first one kept)
      select coalesce(array_agg(s.k order by s.o), '{}') into v_kw
      from (
        select btrim(e.k) as k, min(e.o) as o
        from jsonb_array_elements_text(p -> 'keywords') with ordinality as e(k, o)
        where btrim(e.k) <> ''
        group by btrim(e.k)
      ) s;
    end if;
    if cardinality(v_kw) > 10 then
      raise exception 'At most 10 keywords' using errcode = '22023';
    end if;
    if exists (select 1 from unnest(v_kw) k where char_length(k) > 50) then
      raise exception 'A keyword is too long (max 50 characters)' using errcode = '22023';
    end if;
    v := v || jsonb_build_object('keywords', to_jsonb(v_kw));
  end if;

  if p ? 'description' then
    v := v || jsonb_build_object('description', public.doc_json_text(p, 'description', 2000, 'Description'));
  end if;

  if p ? 'drafting_department_id' then
    v_id := public.doc_json_uuid(p, 'drafting_department_id', 'Drafting department');
    if v_id is not null and not exists (
      select 1 from public.departments d
      where d.id = v_id and d.org_id = p_org_id and d.archived_at is null
    ) then
      raise exception 'Department not found' using errcode = 'P0002';
    end if;
    v := v || jsonb_build_object('drafting_department_id', v_id);
  end if;

  if p ? 'reply_to_id' then
    v_id := public.doc_json_uuid(p, 'reply_to_id', 'Reply to');
    if v_id is not null and (
      v_id = p_self_id
      or not exists (select 1 from public.documents d where d.id = v_id and d.org_id = p_org_id)
      or not public.can_read_document(v_id)
    ) then
      raise exception 'The document this replies to was not found' using errcode = 'P0002';
    end if;
    v := v || jsonb_build_object('reply_to_id', v_id);
  end if;

  return v;
end;
$$;

-- =============================================
-- Core RPCs
-- =============================================
create or replace function public.create_document(p_direction text, p_profile jsonb)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_org_id uuid;
  v jsonb;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_org_id := public.my_org_id();
  if v_org_id is null then
    raise exception 'Join a company first' using errcode = '42501';
  end if;
  if p_direction is null or p_direction not in ('incoming', 'outgoing', 'internal') then
    raise exception 'Unknown document direction: %', coalesce(p_direction, '(empty)') using errcode = '22023';
  end if;
  if p_direction = 'incoming' and not public.has_org_role_user(v_org_id, 'clerk', v_uid) then
    raise exception 'Only clerks (Văn thư) can register incoming documents' using errcode = '42501';
  end if;

  v := public.doc_clean_profile(v_org_id, p_direction, p_profile, null);
  if not (v ? 'subject') then
    raise exception 'Subject is required' using errcode = '22023';
  end if;
  if not (v ? 'drafting_department_id') then
    v := v || jsonb_build_object('drafting_department_id', public.member_department(v_org_id, v_uid));
  end if;

  insert into public.documents (
    org_id, direction, status, subject, doc_type_id, field_id, urgency, confidentiality,
    due_date, issuing_org_name, external_org_id, notation, issued_date, arrival_date,
    signer_name, signer_position, page_count, copies, keywords, description,
    drafting_department_id, reply_to_id, created_by
  )
  values (
    v_org_id, p_direction, 'draft', v ->> 'subject',
    (v ->> 'doc_type_id')::uuid, (v ->> 'field_id')::uuid,
    coalesce(v ->> 'urgency', 'normal'), coalesce(v ->> 'confidentiality', 'normal'),
    (v ->> 'due_date')::date, v ->> 'issuing_org_name', (v ->> 'external_org_id')::uuid,
    v ->> 'notation', (v ->> 'issued_date')::date, (v ->> 'arrival_date')::date,
    v ->> 'signer_name', v ->> 'signer_position',
    (v ->> 'page_count')::int, (v ->> 'copies')::int,
    coalesce(array(
      select k from jsonb_array_elements_text(coalesce(v -> 'keywords', '[]')) with ordinality as e(k, o) order by o
    ), '{}'),
    v ->> 'description', (v ->> 'drafting_department_id')::uuid, (v ->> 'reply_to_id')::uuid, v_uid
  )
  returning id into v_id;

  perform public.doc_log(v_id, 'created', null, 'draft', jsonb_build_object('direction', p_direction));
  return v_id;
end;
$$;

create or replace function public.update_document_profile(p_id uuid, p_profile jsonb)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.documents;
  p jsonb := coalesce(p_profile, '{}');
  v jsonb;
  v_old jsonb;
  v_changed jsonb;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select * into v_doc from public.documents where id = p_id for update;
  if v_doc.id is null or not public.can_read_document(p_id) then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  if not public.can_edit_document(p_id) then
    raise exception 'You cannot edit this document' using errcode = '42501';
  end if;
  if jsonb_typeof(p) <> 'object' then
    raise exception 'Invalid document profile' using errcode = '22023';
  end if;

  -- a signed document: the clerk completes its metadata only
  if v_doc.status = 'signed' then
    select coalesce(jsonb_object_agg(e.key, e.value), '{}') into p
    from jsonb_each(p) e
    where e.key in ('signer_name', 'signer_position', 'page_count', 'copies', 'keywords', 'description');
  end if;

  v := public.doc_clean_profile(v_doc.org_id, v_doc.direction, p, p_id);
  v_old := to_jsonb(v_doc);
  select jsonb_object_agg(e.key, jsonb_build_array(v_old -> e.key, e.value)) into v_changed
  from jsonb_each(v) e
  where (v_old -> e.key) is distinct from e.value;
  if v_changed is null then
    return;
  end if;

  update public.documents set
    subject = case when v ? 'subject' then v ->> 'subject' else subject end,
    doc_type_id = case when v ? 'doc_type_id' then (v ->> 'doc_type_id')::uuid else doc_type_id end,
    field_id = case when v ? 'field_id' then (v ->> 'field_id')::uuid else field_id end,
    urgency = case when v ? 'urgency' then v ->> 'urgency' else urgency end,
    confidentiality = case when v ? 'confidentiality' then v ->> 'confidentiality' else confidentiality end,
    due_date = case when v ? 'due_date' then (v ->> 'due_date')::date else due_date end,
    issuing_org_name = case when v ? 'issuing_org_name' then v ->> 'issuing_org_name' else issuing_org_name end,
    external_org_id = case when v ? 'external_org_id' then (v ->> 'external_org_id')::uuid else external_org_id end,
    notation = case when v ? 'notation' then v ->> 'notation' else notation end,
    issued_date = case when v ? 'issued_date' then (v ->> 'issued_date')::date else issued_date end,
    arrival_date = case when v ? 'arrival_date' then (v ->> 'arrival_date')::date else arrival_date end,
    signer_name = case when v ? 'signer_name' then v ->> 'signer_name' else signer_name end,
    signer_position = case when v ? 'signer_position' then v ->> 'signer_position' else signer_position end,
    page_count = case when v ? 'page_count' then (v ->> 'page_count')::int else page_count end,
    copies = case when v ? 'copies' then (v ->> 'copies')::int else copies end,
    keywords = case when v ? 'keywords' then coalesce(array(
      select k from jsonb_array_elements_text(v -> 'keywords') with ordinality as e(k, o) order by o
    ), '{}') else keywords end,
    description = case when v ? 'description' then v ->> 'description' else description end,
    drafting_department_id = case when v ? 'drafting_department_id'
      then (v ->> 'drafting_department_id')::uuid else drafting_department_id end,
    reply_to_id = case when v ? 'reply_to_id' then (v ->> 'reply_to_id')::uuid else reply_to_id end
  where id = p_id;

  perform public.doc_log(p_id, 'profile_updated', v_doc.status, v_doc.status,
    jsonb_build_object('changed', v_changed));
end;
$$;

-- The caller's 'Documents' system folder, created at root on first use.
create or replace function public.ensure_document_folder()
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_name text := 'Documents';
  v_i int := 1;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select id into v_id from public.folders
  where owner_id = v_uid and purpose = 'documents' and deleted_at is null
  limit 1;
  if v_id is not null then
    return v_id;
  end if;

  while exists (
    select 1 from public.folders
    where owner_id = v_uid and parent_id is null and deleted_at is null and lower(name) = lower(v_name)
  ) loop
    v_name := case when v_i = 1 then 'Documents (office)' else 'Documents (office ' || v_i || ')' end;
    v_i := v_i + 1;
  end loop;

  begin
    insert into public.folders (owner_id, name, purpose)
    values (v_uid, v_name, 'documents')
    returning id into v_id;
  exception when unique_violation then
    -- created meanwhile by another request
    select id into v_id from public.folders
    where owner_id = v_uid and purpose = 'documents' and deleted_at is null
    limit 1;
    if v_id is null then
      raise;
    end if;
  end;
  return v_id;
end;
$$;

create or replace function public.attach_document_file(
  p_document_id uuid, p_file_id uuid, p_kind text default 'attachment'
)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.documents;
  v_kind text := coalesce(p_kind, 'attachment');
  v_file public.files;
  v_link public.document_files;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select * into v_doc from public.documents where id = p_document_id for update;
  if v_doc.id is null or not public.can_read_document(p_document_id) then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  if v_kind not in ('main', 'attachment', 'signed', 'draft') then
    raise exception 'Unknown file kind: %', v_kind using errcode = '22023';
  end if;

  if v_doc.status in ('signed', 'issued') then
    -- after signing only the clerk adds the signed copy
    if v_kind <> 'signed' or not public.has_org_role_user(v_doc.org_id, 'clerk', v_uid) then
      raise exception 'Only a clerk can add the signed copy now' using errcode = '42501';
    end if;
  elsif not public.can_edit_document(p_document_id) then
    raise exception 'You cannot edit this document' using errcode = '42501';
  end if;

  select * into v_file from public.files where id = p_file_id;
  if v_file.id is null or v_file.deleted_at is not null
     or not public.has_file_access(p_file_id, 'admin') then
    raise exception 'You can only attach files you manage' using errcode = '42501';
  end if;

  select * into v_link from public.document_files
  where document_id = p_document_id and file_id = p_file_id;
  if v_link.frozen then
    raise exception 'This file is locked because the document was registered or issued'
      using errcode = '42501';
  end if;

  if v_kind = 'main' then
    if exists (
      select 1 from public.document_files
      where document_id = p_document_id and kind = 'main' and file_id <> p_file_id and frozen
    ) then
      raise exception 'The main file is locked because the document was registered or issued'
        using errcode = '42501';
    end if;
    update public.document_files set kind = 'attachment'
    where document_id = p_document_id and kind = 'main' and file_id <> p_file_id;
  end if;

  insert into public.document_files (document_id, file_id, kind, frozen, added_by)
  values (p_document_id, p_file_id, v_kind, v_kind = 'signed' and v_doc.status = 'issued', v_uid)
  on conflict (document_id, file_id) do update set kind = excluded.kind, frozen = excluded.frozen
  returning * into v_link;

  perform public.doc_log(p_document_id, 'file_attached', v_doc.status, v_doc.status,
    jsonb_build_object('file_id', p_file_id, 'kind', v_kind, 'name', v_file.name));
  return v_link.id;
end;
$$;

create or replace function public.detach_document_file(p_document_id uuid, p_file_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.documents;
  v_link public.document_files;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select * into v_doc from public.documents where id = p_document_id for update;
  if v_doc.id is null or not public.can_read_document(p_document_id) then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  if not public.can_edit_document(p_document_id) then
    raise exception 'You cannot edit this document' using errcode = '42501';
  end if;
  select * into v_link from public.document_files
  where document_id = p_document_id and file_id = p_file_id;
  if v_link.id is null then
    raise exception 'This file is not attached to the document' using errcode = 'P0002';
  end if;
  if v_link.frozen then
    raise exception 'This file is locked because the document was registered or issued'
      using errcode = '42501';
  end if;
  -- a signed document: the clerk edits metadata only (see attach_document_file)
  if v_doc.status = 'signed' and v_link.kind <> 'signed' then
    raise exception 'Only the signed copy can be removed now' using errcode = '42501';
  end if;

  delete from public.document_files where id = v_link.id;
  perform public.doc_log(p_document_id, 'file_detached', v_doc.status, v_doc.status,
    jsonb_build_object('file_id', p_file_id, 'kind', v_link.kind,
      'name', (select f.name from public.files f where f.id = p_file_id)));
end;
$$;

create or replace function public.add_document_opinion(p_document_id uuid, p_kind text, p_body text)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.documents;
  v_body text := btrim(coalesce(p_body, ''));
  v_id uuid;
  v_title text;
  v_user uuid;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select * into v_doc from public.documents where id = p_document_id;
  if v_doc.id is null or not public.can_read_document(p_document_id) then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  if p_kind is null or p_kind not in ('instruction', 'proposal', 'comment', 'result', 'consult_reply') then
    raise exception 'Unknown opinion kind: %', coalesce(p_kind, '(empty)') using errcode = '22023';
  end if;
  if char_length(v_body) not between 1 and 5000 then
    raise exception 'An opinion must be 1 to 5000 characters' using errcode = '22023';
  end if;
  if p_kind = 'instruction'
     and not public.has_org_role_user(v_doc.org_id, 'leader', v_uid)
     and not public.has_org_role_user(v_doc.org_id, 'org_admin', v_uid)
     and not exists (
       select 1 from public.document_assignments a
       where a.document_id = p_document_id and a.assigned_by = v_uid
     ) then
    raise exception 'Only leaders or the person who assigned it can give instructions' using errcode = '42501';
  end if;

  insert into public.document_opinions (document_id, author_id, kind, body)
  values (p_document_id, v_uid, p_kind, v_body)
  returning id into v_id;

  perform public.doc_log(p_document_id, 'opinion_added', v_doc.status, v_doc.status,
    jsonb_build_object('opinion_id', v_id, 'kind', p_kind));

  v_title := public.notification_actor_name(v_uid) || ' added an opinion on “' || left(v_doc.subject, 120) || '”';
  for v_user in
    select distinct s.u from (
      select v_doc.created_by as u
      union all
      select v_doc.presented_to
      union all
      select a.assignee_user_id from public.document_assignments a
      where a.document_id = p_document_id and a.status in ('pending', 'seen', 'in_progress')
      union all
      select dep.head_user_id from public.document_assignments a
      join public.departments dep on dep.id = a.assignee_department_id
      where a.document_id = p_document_id and a.status in ('pending', 'seen', 'in_progress')
    ) s
    where s.u is not null and s.u <> v_uid
  loop
    perform public.doc_notify(v_user, p_document_id, 'document.opinion', v_title, left(v_body, 140));
  end loop;
  return v_id;
end;
$$;

-- Shares one document with a member of its company (the author or an admin).
create or replace function public.grant_document_access(p_document_id uuid, p_user_id uuid, p_access text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.documents;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select * into v_doc from public.documents where id = p_document_id;
  if v_doc.id is null or not public.can_read_document(p_document_id) then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  if v_doc.created_by is distinct from v_uid
     and not public.has_org_role_user(v_doc.org_id, 'org_admin', v_uid) then
    raise exception 'Only the author or a company admin can share this document' using errcode = '42501';
  end if;
  if p_access is null or p_access not in ('read', 'edit') then
    raise exception 'Unknown access: %', coalesce(p_access, '(empty)') using errcode = '22023';
  end if;
  if p_user_id is null or p_user_id = v_uid then
    raise exception 'Pick someone else to share with' using errcode = '22023';
  end if;
  if not public.is_org_member_user(v_doc.org_id, p_user_id) then
    raise exception 'You can only share with active members of the company' using errcode = '22023';
  end if;

  insert into public.document_grants (document_id, user_id, access, granted_by)
  values (p_document_id, p_user_id, p_access, v_uid)
  on conflict (document_id, user_id) do update
    set access = excluded.access, granted_by = excluded.granted_by;

  perform public.doc_log(p_document_id, 'access_granted', v_doc.status, v_doc.status,
    jsonb_build_object('user_id', p_user_id, 'access', p_access));
  perform public.doc_notify(p_user_id, p_document_id, 'document.shared',
    case when p_access = 'edit' then 'You can now edit: ' else 'You can now view: ' end
      || left(v_doc.subject, 150));
end;
$$;

create or replace function public.revoke_document_access(p_document_id uuid, p_user_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.documents;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select * into v_doc from public.documents where id = p_document_id;
  if v_doc.id is null or not public.can_read_document(p_document_id) then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  if v_doc.created_by is distinct from v_uid
     and not public.has_org_role_user(v_doc.org_id, 'org_admin', v_uid) then
    raise exception 'Only the author or a company admin can change sharing' using errcode = '42501';
  end if;

  delete from public.document_grants where document_id = p_document_id and user_id = p_user_id;
  if found then
    perform public.doc_log(p_document_id, 'access_revoked', v_doc.status, v_doc.status,
      jsonb_build_object('user_id', p_user_id));
  end if;
end;
$$;

-- Everything the document page shows, for a reader; records a 'view' at most
-- once an hour per person.
create or replace function public.get_document(p_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.documents;
  v_detail jsonb;
  v_files jsonb;
  v_assignments jsonb;
  v_steps jsonb;
  v_opinions jsonb;
  v_recipients jsonb;
  v_grants jsonb;
  v_events jsonb;
  v_related jsonb;
  v_me jsonb;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select * into v_doc from public.documents where id = p_id;
  if v_doc.id is null or not public.can_read_document(p_id) then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.document_access_log l
    where l.document_id = p_id and l.user_id = v_uid and l.action = 'view'
      and l.at > now() - interval '1 hour'
  ) then
    insert into public.document_access_log (document_id, user_id, action) values (p_id, v_uid, 'view');
  end if;

  v_detail := (to_jsonb(v_doc) - 'search_norm') || jsonb_build_object(
    'type_name', (select t.name from public.doc_types t where t.id = v_doc.doc_type_id),
    'type_abbreviation', (select t.abbreviation from public.doc_types t where t.id = v_doc.doc_type_id),
    'is_cong_van', (select t.is_cong_van from public.doc_types t where t.id = v_doc.doc_type_id),
    'field_name', (select f.name from public.doc_fields f where f.id = v_doc.field_id),
    'register_name', (select r.name from public.doc_registers r where r.id = v_doc.register_id),
    'external_org_name', (select e.name from public.external_orgs e where e.id = v_doc.external_org_id),
    'drafting_department_name',
      (select dep.name from public.departments dep where dep.id = v_doc.drafting_department_id),
    'drafting_department_code',
      (select dep.code from public.departments dep where dep.id = v_doc.drafting_department_id),
    'created_by_name', public.doc_user_name(v_doc.created_by),
    'presented_to_name', public.doc_user_name(v_doc.presented_to),
    'signer_display', nullif(concat_ws(' ',
      case when v_doc.signer_authority <> '' then v_doc.signer_authority || '.' end,
      nullif(btrim(v_doc.signer_position), ''),
      coalesce(nullif(btrim(v_doc.signer_name), ''), public.doc_user_name(v_doc.signer_user_id))
    ), '')
  );

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', df.id, 'file_id', df.file_id, 'kind', df.kind, 'frozen', df.frozen,
      'name', f.name, 'size', f.size, 'mime_type', f.mime_type,
      'current_version_id', f.current_version_id, 'owner_id', f.owner_id, 'added_at', df.added_at
    ) order by case df.kind when 'main' then 0 when 'signed' then 1 when 'attachment' then 2 else 3 end,
      df.added_at), '[]')
  into v_files
  from public.document_files df
  join public.files f on f.id = df.file_id
  where df.document_id = p_id;

  select coalesce(jsonb_agg(to_jsonb(a) || jsonb_build_object(
      'assignee_name', public.doc_user_name(a.assignee_user_id),
      'assignee_department_name', (select dep.name from public.departments dep where dep.id = a.assignee_department_id),
      'assigned_by_name', public.doc_user_name(a.assigned_by)
    ) order by a.assigned_at, a.id), '[]')
  into v_assignments
  from public.document_assignments a
  where a.document_id = p_id;

  select coalesce(jsonb_agg(to_jsonb(s) || jsonb_build_object(
      'approver_name', public.doc_user_name(s.approver_user_id)
    ) order by s.revision, s.step_no, s.id), '[]')
  into v_steps
  from public.document_approval_steps s
  where s.document_id = p_id;

  select coalesce(jsonb_agg(to_jsonb(o) || jsonb_build_object(
      'author_name', public.doc_user_name(o.author_id)
    ) order by o.created_at, o.id), '[]')
  into v_opinions
  from public.document_opinions o
  where o.document_id = p_id;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.sent_at nulls last, r.name_snapshot, r.id), '[]')
  into v_recipients
  from public.document_recipients r
  where r.document_id = p_id;

  select coalesce(jsonb_agg(jsonb_build_object(
      'user_id', g.user_id, 'name', public.doc_user_name(g.user_id), 'access', g.access
    ) order by g.created_at, g.user_id), '[]')
  into v_grants
  from public.document_grants g
  where g.document_id = p_id;

  select coalesce(jsonb_agg(to_jsonb(e) || jsonb_build_object(
      'actor_name', public.doc_user_name(e.actor_id)
    ) order by e.created_at, e.id), '[]')
  into v_events
  from public.document_events e
  where e.document_id = p_id;

  -- linked documents; unreadable ones keep only their id and direction
  with rel(id, relation, ord) as (
    select v_doc.reply_to_id, 'reply_to', 1 where v_doc.reply_to_id is not null
    union all
    select v_doc.replaces_id, 'replaces', 2 where v_doc.replaces_id is not null
    union all
    select v_doc.corrects_id, 'corrects', 3 where v_doc.corrects_id is not null
    union all
    select x.id, 'replied_by', 4 from public.documents x where x.reply_to_id = p_id
    union all
    select x.id, 'replaced_by', 5 from public.documents x where x.replaces_id = p_id
    union all
    select x.id, 'corrected_by', 6 from public.documents x where x.corrects_id = p_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', x.id,
      'subject', case when c.ok then x.subject end,
      'notation', case when c.ok then x.notation end,
      'direction', x.direction,
      'relation', rel.relation,
      'readable', c.ok
    ) order by rel.ord, x.created_at), '[]')
  into v_related
  from rel
  join public.documents x on x.id = rel.id
  cross join lateral (select public.can_read_document(x.id) as ok) c;

  select jsonb_build_object(
    'user_id', v_uid,
    'roles', coalesce((
      select to_jsonb(m.roles) from public.org_members m
      where m.org_id = v_doc.org_id and m.user_id = v_uid and m.status = 'active'
    ), '[]'::jsonb),
    'department_id', public.member_department(v_doc.org_id, v_uid),
    'headed_department_ids', coalesce((
      select jsonb_agg(h.id) from public.headed_departments_of(v_uid) as h(id)
    ), '[]'::jsonb),
    'can_edit', public.can_edit_document(p_id)
  ) into v_me;

  return jsonb_build_object(
    'document', v_detail,
    'files', v_files,
    'assignments', v_assignments,
    'approval_steps', v_steps,
    'opinions', v_opinions,
    'recipients', v_recipients,
    'grants', v_grants,
    'events', v_events,
    'related', v_related,
    'me', v_me
  );
end;
$$;

create or replace function public.log_document_access(p_id uuid, p_action text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if p_action is null or p_action not in ('download', 'print') then
    raise exception 'Unknown access action: %', coalesce(p_action, '(empty)') using errcode = '22023';
  end if;
  if not public.can_read_document(p_id) then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  insert into public.document_access_log (document_id, user_id, action) values (p_id, v_uid, p_action);
end;
$$;

-- Deletes a draft (its file links go, the files stay).
create or replace function public.delete_document(p_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.documents;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select * into v_doc from public.documents where id = p_id for update;
  if v_doc.id is null or not public.can_read_document(p_id) then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  if v_doc.status <> 'draft' or not (
    v_doc.created_by = v_uid
    or (v_doc.direction = 'incoming' and public.has_org_role_user(v_doc.org_id, 'clerk', v_uid))
  ) then
    raise exception 'Only the author can delete a draft' using errcode = '42501';
  end if;
  if exists (select 1 from public.document_files where document_id = p_id and frozen) then
    raise exception 'This document has locked files' using errcode = '42501';
  end if;

  delete from public.document_files where document_id = p_id;
  delete from public.documents where id = p_id;
end;
$$;

-- =============================================
-- Privileges
-- =============================================
-- Supabase (and the test stubs) grant new functions to anon/authenticated by
-- default, so each one is revoked explicitly; triggers fire without EXECUTE
-- on their function.
revoke all on function public.documents_set_search_norm() from public, anon, authenticated;
revoke all on function public.documents_freeze_guard() from public, anon, authenticated;
revoke all on function public.doc_next_number(uuid, uuid) from public, anon, authenticated;
revoke all on function public.doc_log(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.doc_notify(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.doc_notify_department(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.doc_user_name(uuid) from public, anon, authenticated;
revoke all on function public.doc_json_text(jsonb, text, int, text) from public, anon, authenticated;
revoke all on function public.doc_json_uuid(jsonb, text, text) from public, anon, authenticated;
revoke all on function public.doc_json_date(jsonb, text, text) from public, anon, authenticated;
revoke all on function public.doc_json_int(jsonb, text, text) from public, anon, authenticated;
revoke all on function public.doc_clean_profile(uuid, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.documents_set_search_norm() to service_role;
grant execute on function public.documents_freeze_guard() to service_role;
grant execute on function public.doc_next_number(uuid, uuid) to service_role;
grant execute on function public.doc_log(uuid, text, text, text, jsonb) to service_role;
grant execute on function public.doc_notify(uuid, uuid, text, text, text) to service_role;
grant execute on function public.doc_notify_department(uuid, uuid, text, text) to service_role;
grant execute on function public.doc_user_name(uuid) to service_role;
grant execute on function public.doc_json_text(jsonb, text, int, text) to service_role;
grant execute on function public.doc_json_uuid(jsonb, text, text) to service_role;
grant execute on function public.doc_json_date(jsonb, text, text) to service_role;
grant execute on function public.doc_json_int(jsonb, text, text) to service_role;
grant execute on function public.doc_clean_profile(uuid, text, jsonb, uuid) to service_role;

revoke all on function public.org_now_date(uuid) from public, anon;
revoke all on function public.doc_year_for(uuid, timestamptz) from public, anon;
revoke all on function public.doc_default_due_days(text) from public, anon;
revoke all on function public.doc_add_working_days(uuid, date, int) from public, anon;
revoke all on function public.doc_render_notation(text, int, text, text, text, int) from public, anon;
revoke all on function public.can_read_document(uuid) from public, anon;
revoke all on function public.can_edit_document(uuid) from public, anon;
revoke all on function public.has_file_access(uuid, text) from public, anon;
revoke all on function public.create_document(text, jsonb) from public, anon;
revoke all on function public.update_document_profile(uuid, jsonb) from public, anon;
revoke all on function public.ensure_document_folder() from public, anon;
revoke all on function public.attach_document_file(uuid, uuid, text) from public, anon;
revoke all on function public.detach_document_file(uuid, uuid) from public, anon;
revoke all on function public.add_document_opinion(uuid, text, text) from public, anon;
revoke all on function public.grant_document_access(uuid, uuid, text) from public, anon;
revoke all on function public.revoke_document_access(uuid, uuid) from public, anon;
revoke all on function public.get_document(uuid) from public, anon;
revoke all on function public.log_document_access(uuid, text) from public, anon;
revoke all on function public.delete_document(uuid) from public, anon;

grant execute on function public.org_now_date(uuid) to authenticated, service_role;
grant execute on function public.doc_year_for(uuid, timestamptz) to authenticated, service_role;
grant execute on function public.doc_default_due_days(text) to authenticated, service_role;
grant execute on function public.doc_add_working_days(uuid, date, int) to authenticated, service_role;
grant execute on function public.doc_render_notation(text, int, text, text, text, int) to authenticated, service_role;
grant execute on function public.can_read_document(uuid) to authenticated, service_role;
grant execute on function public.can_edit_document(uuid) to authenticated, service_role;
grant execute on function public.has_file_access(uuid, text) to authenticated, service_role;
grant execute on function public.create_document(text, jsonb) to authenticated;
grant execute on function public.update_document_profile(uuid, jsonb) to authenticated;
grant execute on function public.ensure_document_folder() to authenticated;
grant execute on function public.attach_document_file(uuid, uuid, text) to authenticated;
grant execute on function public.detach_document_file(uuid, uuid) to authenticated;
grant execute on function public.add_document_opinion(uuid, text, text) to authenticated;
grant execute on function public.grant_document_access(uuid, uuid, text) to authenticated;
grant execute on function public.revoke_document_access(uuid, uuid) to authenticated;
grant execute on function public.get_document(uuid) to authenticated;
grant execute on function public.log_document_access(uuid, text) to authenticated;
grant execute on function public.delete_document(uuid) to authenticated;
