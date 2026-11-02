-- Documents: lookups and registers (sổ văn bản) administration, the default
-- seed of a new company, number previews and the register print data.
-- Run after 202608280036_documents_core.sql. Idempotent: create or replace,
-- drop ... if exists and on conflict do nothing only.
--
-- 1. seed_document_defaults(org) (internal): the document types of Decree
--    30/2020 Phụ lục III plus 'Công văn', and the three registers of the
--    company's current year (incoming, outgoing, internal). On conflict do
--    nothing, so it only fills gaps and can run any number of times.
-- 2. organizations_seed_documents: AFTER INSERT on organizations (distinct
--    from organizations_seed_retention of the dossiers migration). It is a
--    constraint trigger, DEFERRABLE INITIALLY DEFERRED: the seed runs when the
--    transaction that created the company commits (create_organization is
--    one transaction), so a transaction that creates a company and its own
--    lookups (an import, a test fixture) is not blocked by the defaults; the
--    defaults then fill only what is missing. 'set constraints
--    organizations_seed_documents immediate' runs it at once.
--    Every existing company is backfilled below.
-- 3. Admin RPCs (company admin of the row's company; external organizations
--    also the clerk): upsert_doc_type, upsert_doc_field, upsert_external_org,
--    upsert_doc_register, close/reopen/delete_doc_register, set_register_role,
--    open_next_year_registers. A new row goes into the caller's company; an
--    existing row keeps its company. Client org ids are never accepted.
-- 4. peek_next_number (clerk, admin, register manager): the next number of a
--    register without taking it (previews only; doc_next_number hands out).
-- 5. list_register_entries (admin, clerk, leader, register manager or
--    follower): the rows of the printed register, columns as Decree 30
--    Phụ lục IV. A row the caller cannot read (can_read_document false, e.g.
--    confidential) keeps only its id, numbers and dates; subject becomes
--    'Restricted document' and every other text is null.
--
-- Rollback (manual):
--   drop trigger if exists organizations_seed_documents on public.organizations;
--   then drop the functions listed in the privileges section at the end.
--   Seeded types and registers stay (they are ordinary company data).

-- =============================================
-- Default seed (internal)
-- =============================================
create or replace function public.seed_document_defaults(p_org_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_year int;
begin
  if p_org_id is null or not exists (select 1 from public.organizations where id = p_org_id) then
    return;
  end if;

  -- Decree 30/2020 Phụ lục III (name, abbreviation), in this order
  insert into public.doc_types (org_id, name, abbreviation, is_cong_van, sort_order)
  select p_org_id, t.name, t.abbreviation, false, t.ord::int
  from unnest(
    array[
      'Nghị quyết', 'Quyết định', 'Chỉ thị', 'Quy chế', 'Quy định', 'Thông cáo', 'Thông báo',
      'Hướng dẫn', 'Chương trình', 'Kế hoạch', 'Phương án', 'Đề án', 'Dự án',
      'Báo cáo', 'Biên bản', 'Tờ trình', 'Hợp đồng', 'Công điện', 'Bản ghi nhớ',
      'Bản thỏa thuận', 'Giấy ủy quyền', 'Giấy mời', 'Giấy giới thiệu', 'Giấy nghỉ phép',
      'Phiếu gửi', 'Phiếu chuyển', 'Phiếu báo'
    ],
    array[
      'NQ', 'QĐ', 'CT', 'QC', 'QyĐ', 'TC', 'TB',
      'HD', 'CTr', 'KH', 'PA', 'ĐA', 'DA',
      'BC', 'BB', 'TTr', 'HĐ', 'CĐ', 'BGN',
      'BTT', 'GUQ', 'GM', 'GGT', 'GNP',
      'PG', 'PC', 'PB'
    ]
  ) with ordinality as t(name, abbreviation, ord)
  on conflict (org_id, name) do nothing;

  -- Công văn has no abbreviation: its notation is '{n}/{org}-{dept}'
  insert into public.doc_types (org_id, name, abbreviation, is_cong_van, sort_order)
  values (p_org_id, 'Công văn', '', true, 0)
  on conflict (org_id, name) do nothing;

  v_year := public.doc_year_for(p_org_id, now());
  insert into public.doc_registers (org_id, direction, name, year, start_number, scope)
  values
    (p_org_id, 'incoming', 'Sổ văn bản đến', v_year, 1, 'register'),
    (p_org_id, 'outgoing', 'Sổ văn bản đi', v_year, 1, 'register'),
    (p_org_id, 'internal', 'Sổ văn bản nội bộ', v_year, 1, 'register')
  on conflict (org_id, direction, name, year) do nothing;
end;
$$;

create or replace function public.organizations_seed_documents_trigger()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  perform public.seed_document_defaults(new.id);
  return null;
end;
$$;

drop trigger if exists organizations_seed_documents on public.organizations;
create constraint trigger organizations_seed_documents
  after insert on public.organizations
  deferrable initially deferred
  for each row execute function public.organizations_seed_documents_trigger();

-- backfill every existing company
do $$
declare
  v_id uuid;
begin
  for v_id in select id from public.organizations loop
    perform public.seed_document_defaults(v_id);
  end loop;
end;
$$;

-- =============================================
-- Internal helpers
-- =============================================

-- The company of a new row (the caller's) or of an existing one; raises when
-- the caller is not signed in, has no company, or the row is not found.
create or replace function public.doc_admin_org(p_table text, p_id uuid, p_label text)
returns uuid
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_org_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if p_id is null then
    v_org_id := public.my_org_id();
    if v_org_id is null then
      raise exception 'Join a company first' using errcode = '42501';
    end if;
    return v_org_id;
  end if;
  if p_table not in ('doc_types', 'doc_fields', 'external_orgs', 'doc_registers') then
    raise exception 'Unknown lookup table' using errcode = '22023';
  end if;
  execute format('select org_id from public.%I where id = $1', p_table) into v_org_id using p_id;
  if v_org_id is null or not public.is_org_member_user(v_org_id, auth.uid()) then
    raise exception '% not found', p_label using errcode = 'P0002';
  end if;
  return v_org_id;
end;
$$;

-- A notation template: 1 to 100 characters, contains {n}, only known tokens.
create or replace function public.doc_check_template(p_template text, p_label text)
returns text
language plpgsql immutable
set search_path = public
as $$
declare
  v text := btrim(coalesce(p_template, ''));
  v_bad text;
begin
  if char_length(v) not between 1 and 100 then
    raise exception '% must be 1 to 100 characters', p_label using errcode = '22023';
  end if;
  if position('{n}' in v) = 0 then
    raise exception '% must contain {n} (the number)', p_label using errcode = '22023';
  end if;
  select m[1] into v_bad
  from regexp_matches(v, '(\{[^}]*\})', 'g') as m
  where m[1] not in ('{n}', '{type}', '{org}', '{dept}', '{yyyy}')
  limit 1;
  if v_bad is not null then
    raise exception '% has an unknown token %; use {n}, {type}, {org}, {dept} or {yyyy}', p_label, v_bad
      using errcode = '22023';
  end if;
  return v;
end;
$$;

-- True once a register has handed out a number (a numbered document, or a
-- counter: cancelled numbers are never reused).
create or replace function public.doc_register_is_numbered(p_register_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.documents d
    where d.register_id = p_register_id and (d.number is not null or d.arrival_number is not null)
  ) or exists (
    select 1 from public.doc_register_counters c where c.register_id = p_register_id
  );
$$;

-- =============================================
-- Lookups (admin; external organizations also the clerk)
-- =============================================

-- Null p_is_cong_van / p_active / p_sort_order / p_default_retention_code
-- keep the stored value on edit (false / true / 0 / none when new); a blank
-- retention code clears it.
create or replace function public.upsert_doc_type(
  p_id uuid, p_name text, p_abbreviation text, p_is_cong_van boolean, p_active boolean,
  p_sort_order int, p_default_retention_code text default null
)
returns public.doc_types
language plpgsql security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_abbr text := btrim(coalesce(p_abbreviation, ''));
  v_code text := btrim(p_default_retention_code);
  v_type public.doc_types;
begin
  v_org_id := public.doc_admin_org('doc_types', p_id, 'Document type');
  perform public.org_require_admin(v_org_id);

  if char_length(v_name) not between 1 and 100 then
    raise exception 'Type name must be 1 to 100 characters' using errcode = '22023';
  end if;
  if char_length(v_abbr) > 10 then
    raise exception 'Abbreviation must be at most 10 characters' using errcode = '22023';
  end if;
  if v_abbr ~ '[\s/{}]' then
    raise exception 'Abbreviation cannot contain spaces, slashes or braces' using errcode = '22023';
  end if;
  if char_length(v_code) > 50 then
    raise exception 'Retention code must be at most 50 characters' using errcode = '22023';
  end if;
  if p_sort_order is not null and p_sort_order not between -100000 and 100000 then
    raise exception 'Sort order is out of range' using errcode = '22023';
  end if;

  begin
    if p_id is null then
      insert into public.doc_types (org_id, name, abbreviation, is_cong_van, active, sort_order, default_retention_code)
      values (v_org_id, v_name, v_abbr, coalesce(p_is_cong_van, false), coalesce(p_active, true),
              coalesce(p_sort_order, 0), nullif(v_code, ''))
      returning * into v_type;
    else
      update public.doc_types
      set name = v_name,
          abbreviation = v_abbr,
          is_cong_van = coalesce(p_is_cong_van, is_cong_van),
          active = coalesce(p_active, active),
          sort_order = coalesce(p_sort_order, sort_order),
          default_retention_code = case
            when v_code is null then default_retention_code
            else nullif(v_code, '')
          end
      where id = p_id
      returning * into v_type;
    end if;
  exception when unique_violation then
    raise exception 'That document type already exists' using errcode = '23505';
  end;
  return v_type;
end;
$$;

-- Null p_active keeps the stored value on edit (true when new).
create or replace function public.upsert_doc_field(p_id uuid, p_name text, p_active boolean)
returns public.doc_fields
language plpgsql security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_field public.doc_fields;
begin
  v_org_id := public.doc_admin_org('doc_fields', p_id, 'Field');
  perform public.org_require_admin(v_org_id);

  if char_length(v_name) not between 1 and 200 then
    raise exception 'Field name must be 1 to 200 characters' using errcode = '22023';
  end if;

  begin
    if p_id is null then
      insert into public.doc_fields (org_id, name, active)
      values (v_org_id, v_name, coalesce(p_active, true))
      returning * into v_field;
    else
      update public.doc_fields
      set name = v_name, active = coalesce(p_active, active)
      where id = p_id
      returning * into v_field;
    end if;
  exception when unique_violation then
    raise exception 'That field already exists' using errcode = '23505';
  end;
  return v_field;
end;
$$;

-- Blank code, email or address clear them; null p_active keeps the stored
-- value on edit (true when new).
create or replace function public.upsert_external_org(
  p_id uuid, p_name text, p_code text, p_email text, p_address text, p_active boolean
)
returns public.external_orgs
language plpgsql security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_code text := nullif(btrim(coalesce(p_code, '')), '');
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_address text := nullif(btrim(coalesce(p_address, '')), '');
  v_ext public.external_orgs;
begin
  v_org_id := public.doc_admin_org('external_orgs', p_id, 'External organization');
  if not (public.has_org_role_user(v_org_id, 'org_admin', auth.uid())
          or public.has_org_role_user(v_org_id, 'clerk', auth.uid())) then
    raise exception 'Only company admins and clerks (Văn thư) can do this' using errcode = '42501';
  end if;

  if char_length(v_name) not between 1 and 200 then
    raise exception 'Organization name must be 1 to 200 characters' using errcode = '22023';
  end if;
  if char_length(v_code) > 50 then
    raise exception 'Code must be at most 50 characters' using errcode = '22023';
  end if;
  if v_email is not null and (char_length(v_email) > 320 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'Enter a valid email address' using errcode = '22023';
  end if;
  if char_length(v_address) > 500 then
    raise exception 'Address must be at most 500 characters' using errcode = '22023';
  end if;

  if p_id is null then
    insert into public.external_orgs (org_id, name, code, email, address, active)
    values (v_org_id, v_name, v_code, v_email, v_address, coalesce(p_active, true))
    returning * into v_ext;
  else
    update public.external_orgs
    set name = v_name, code = v_code, email = v_email, address = v_address,
        active = coalesce(p_active, active)
    where id = p_id
    returning * into v_ext;
  end if;
  return v_ext;
end;
$$;

-- =============================================
-- Registers (admin)
-- =============================================

-- Direction, year, scope and start number are fixed once the register has
-- handed out a number. Null scope / start number / templates use the
-- defaults when new and keep the stored ones on edit; null is_confidential /
-- allowed types likewise.
create or replace function public.upsert_doc_register(
  p_id uuid, p_direction text, p_name text, p_year int, p_start_number int, p_scope text,
  p_notation_template text, p_cong_van_template text, p_is_confidential boolean,
  p_allowed_type_ids uuid[]
)
returns public.doc_registers
language plpgsql security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_old public.doc_registers;
  v_reg public.doc_registers;
  v_name text := btrim(coalesce(p_name, ''));
  v_direction text := coalesce(p_direction, '');
  v_scope text;
  v_start int;
  v_template text;
  v_cv_template text;
  v_types uuid[];
begin
  v_org_id := public.doc_admin_org('doc_registers', p_id, 'Register');
  perform public.org_require_admin(v_org_id);

  if p_id is not null then
    select * into v_old from public.doc_registers where id = p_id for update;
  end if;
  v_scope := coalesce(p_scope, v_old.scope, 'register');
  v_start := coalesce(p_start_number, v_old.start_number, 1);

  if v_direction not in ('incoming', 'outgoing', 'internal') then
    raise exception 'Unknown register direction: %', coalesce(p_direction, '(empty)') using errcode = '22023';
  end if;
  if char_length(v_name) not between 1 and 200 then
    raise exception 'Register name must be 1 to 200 characters' using errcode = '22023';
  end if;
  if p_year is null or p_year not between 2000 and 2100 then
    raise exception 'Year must be between 2000 and 2100' using errcode = '22023';
  end if;
  if v_start not between 1 and 1000000 then
    raise exception 'Start number must be between 1 and 1000000' using errcode = '22023';
  end if;
  if v_scope not in ('register', 'register_type') then
    raise exception 'Unknown numbering scope: %', v_scope using errcode = '22023';
  end if;

  v_template := public.doc_check_template(
    coalesce(p_notation_template, v_old.notation_template, '{n}/{type}-{org}'), 'Notation template');
  v_cv_template := public.doc_check_template(
    coalesce(p_cong_van_template, v_old.cong_van_template, '{n}/{org}-{dept}'), 'Công văn template');

  if p_allowed_type_ids is null then
    v_types := coalesce(v_old.allowed_type_ids, '{}');
  else
    select coalesce(array_agg(distinct t), '{}') into v_types
    from unnest(p_allowed_type_ids) t where t is not null;
    if exists (
      select 1 from unnest(v_types) t
      where not exists (select 1 from public.doc_types dt where dt.id = t and dt.org_id = v_org_id)
    ) then
      raise exception 'Allowed document types must belong to this company' using errcode = '22023';
    end if;
  end if;

  if p_id is not null
     and (v_old.direction <> v_direction or v_old.year <> p_year
          or v_old.scope <> v_scope or v_old.start_number <> v_start)
     and public.doc_register_is_numbered(p_id) then
    raise exception 'This register already has numbered documents: its direction, year, numbering scope and start number cannot change'
      using errcode = '22023';
  end if;

  begin
    if p_id is null then
      insert into public.doc_registers (
        org_id, direction, name, year, start_number, scope, notation_template,
        cong_van_template, is_confidential, allowed_type_ids, created_by
      )
      values (
        v_org_id, v_direction, v_name, p_year, v_start, v_scope, v_template,
        v_cv_template, coalesce(p_is_confidential, false), v_types, auth.uid()
      )
      returning * into v_reg;
    else
      update public.doc_registers
      set direction = v_direction, name = v_name, year = p_year, start_number = v_start,
          scope = v_scope, notation_template = v_template, cong_van_template = v_cv_template,
          is_confidential = coalesce(p_is_confidential, is_confidential),
          allowed_type_ids = v_types
      where id = p_id
      returning * into v_reg;
    end if;
  exception when unique_violation then
    raise exception 'A register with that name already exists for this year' using errcode = '23505';
  end;
  return v_reg;
end;
$$;

-- A closed register hands out no numbers (doc_next_number refuses).
create or replace function public.close_doc_register(p_id uuid)
returns public.doc_registers
language plpgsql security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_reg public.doc_registers;
begin
  if p_id is null then
    raise exception 'Register not found' using errcode = 'P0002';
  end if;
  v_org_id := public.doc_admin_org('doc_registers', p_id, 'Register');
  perform public.org_require_admin(v_org_id);
  update public.doc_registers set closed_at = coalesce(closed_at, now())
  where id = p_id
  returning * into v_reg;
  return v_reg;
end;
$$;

create or replace function public.reopen_doc_register(p_id uuid)
returns public.doc_registers
language plpgsql security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_reg public.doc_registers;
begin
  if p_id is null then
    raise exception 'Register not found' using errcode = 'P0002';
  end if;
  v_org_id := public.doc_admin_org('doc_registers', p_id, 'Register');
  perform public.org_require_admin(v_org_id);
  update public.doc_registers set closed_at = null
  where id = p_id
  returning * into v_reg;
  return v_reg;
end;
$$;

create or replace function public.delete_doc_register(p_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_org_id uuid;
begin
  if p_id is null then
    raise exception 'Register not found' using errcode = 'P0002';
  end if;
  v_org_id := public.doc_admin_org('doc_registers', p_id, 'Register');
  perform public.org_require_admin(v_org_id);
  perform 1 from public.doc_registers where id = p_id for update;
  if exists (select 1 from public.documents where register_id = p_id) then
    raise exception 'This register is in use and cannot be deleted. Close it instead.' using errcode = '23503';
  end if;
  -- counters and roles cascade
  delete from public.doc_registers where id = p_id;
end;
$$;

-- p_role 'manager' or 'follower'; null removes the user's role.
create or replace function public.set_register_role(p_register_id uuid, p_user_id uuid, p_role text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_org_id uuid;
begin
  if p_register_id is null then
    raise exception 'Register not found' using errcode = 'P0002';
  end if;
  v_org_id := public.doc_admin_org('doc_registers', p_register_id, 'Register');
  perform public.org_require_admin(v_org_id);
  if p_user_id is null then
    raise exception 'Choose a member' using errcode = '22023';
  end if;

  if p_role is null then
    delete from public.doc_register_roles where register_id = p_register_id and user_id = p_user_id;
    return;
  end if;
  if p_role not in ('manager', 'follower') then
    raise exception 'Unknown register role: %', p_role using errcode = '22023';
  end if;
  if not public.is_org_member_user(v_org_id, p_user_id) then
    raise exception 'The person must be an active member of this company' using errcode = '22023';
  end if;
  insert into public.doc_register_roles (register_id, user_id, role)
  values (p_register_id, p_user_id, p_role)
  on conflict (register_id, user_id) do update set role = excluded.role;
end;
$$;

-- Copies last year's open registers into p_year with their settings and the
-- roles of members who are still active. Returns how many were created.
create or replace function public.open_next_year_registers(p_year int)
returns int
language plpgsql security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_count int;
begin
  v_org_id := public.doc_admin_org('doc_registers', null, 'Register');
  perform public.org_require_admin(v_org_id);
  if p_year is null or p_year not between 2001 and 2100 then
    raise exception 'Year must be between 2001 and 2100' using errcode = '22023';
  end if;

  with src as (
    select r.* from public.doc_registers r
    where r.org_id = v_org_id and r.year = p_year - 1 and r.closed_at is null
  ),
  ins as (
    insert into public.doc_registers (
      org_id, direction, name, year, start_number, scope, notation_template,
      cong_van_template, is_confidential, allowed_type_ids, created_by
    )
    select org_id, direction, name, p_year, start_number, scope, notation_template,
           cong_van_template, is_confidential, allowed_type_ids, auth.uid()
    from src
    on conflict (org_id, direction, name, year) do nothing
    returning id, direction, name
  ),
  roles as (
    insert into public.doc_register_roles (register_id, user_id, role)
    select ins.id, rr.user_id, rr.role
    from ins
    join src on src.direction = ins.direction and src.name = ins.name
    join public.doc_register_roles rr on rr.register_id = src.id
    where public.is_org_member_user(v_org_id, rr.user_id)
    on conflict (register_id, user_id) do nothing
    returning 1
  )
  select count(*) into v_count from ins;
  -- the roles CTE runs even though only ins is counted (data-modifying CTEs always run)
  return v_count;
end;
$$;

-- =============================================
-- Number preview (clerk, admin, register manager)
-- =============================================
create or replace function public.peek_next_number(p_register_id uuid, p_doc_type_id uuid default null)
returns int
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_reg public.doc_registers;
  v_last int;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select * into v_reg from public.doc_registers where id = p_register_id;
  if v_reg.id is null or not public.is_org_member_user(v_reg.org_id, v_uid) then
    raise exception 'Register not found' using errcode = 'P0002';
  end if;
  if not (
    public.has_org_role_user(v_reg.org_id, 'clerk', v_uid)
    or public.has_org_role_user(v_reg.org_id, 'org_admin', v_uid)
    or exists (
      select 1 from public.doc_register_roles rr
      where rr.register_id = v_reg.id and rr.user_id = v_uid and rr.role = 'manager'
    )
  ) then
    raise exception 'Only clerks (Văn thư), admins and register managers can see the next number'
      using errcode = '42501';
  end if;

  select c.last_number into v_last
  from public.doc_register_counters c
  where c.register_id = v_reg.id
    and c.type_key = case
      when v_reg.scope = 'register_type'
        then coalesce(p_doc_type_id, '00000000-0000-0000-0000-000000000000'::uuid)
      else '00000000-0000-0000-0000-000000000000'::uuid
    end;
  return coalesce(v_last + 1, v_reg.start_number);
end;
$$;

-- =============================================
-- Register print data (Decree 30 Phụ lục IV)
-- =============================================
-- Incoming rows: id, readable, arrival_date, arrival_number, issuing_org_name,
--   notation, issued_date, type_name, subject, receiver, transferred_at, note.
-- Outgoing / internal rows: id, readable, number, notation, issued_date,
--   type_name, subject, signer, recipients, filed_unit, copies, sent_at, note.
-- note is the status key (the UI shows its label). Dates are yyyy-mm-dd;
-- transferred_at and sent_at are timestamps. Filters: p_from / p_to on the
-- arrival date (incoming) or the issue date, p_from_number / p_to_number on
-- the arrival number (incoming) or the number.
create or replace function public.list_register_entries(
  p_register_id uuid, p_from date default null, p_to date default null,
  p_from_number int default null, p_to_number int default null
)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_reg public.doc_registers;
  v_tz text;
  v_rows jsonb;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select * into v_reg from public.doc_registers where id = p_register_id;
  if v_reg.id is null or not public.is_org_member_user(v_reg.org_id, v_uid) then
    raise exception 'Register not found' using errcode = 'P0002';
  end if;
  if not (
    exists (
      select 1 from public.org_members m
      where m.org_id = v_reg.org_id and m.user_id = v_uid and m.status = 'active'
        and m.roles && array['org_admin', 'clerk', 'leader']
    )
    or exists (
      select 1 from public.doc_register_roles rr
      where rr.register_id = v_reg.id and rr.user_id = v_uid
    )
  ) then
    raise exception 'You cannot view this register' using errcode = '42501';
  end if;

  select coalesce(o.timezone, 'Asia/Ho_Chi_Minh') into v_tz
  from public.organizations o where o.id = v_reg.org_id;
  v_tz := coalesce(v_tz, 'Asia/Ho_Chi_Minh');

  if v_reg.direction = 'incoming' then
    select coalesce(jsonb_agg(x.entry order by x.n nulls last, x.created_at, x.id), '[]')
    into v_rows
    from (
      select d.id, d.created_at, d.arrival_number as n,
        jsonb_build_object(
          'id', d.id,
          'readable', c.ok,
          'arrival_date', coalesce(d.arrival_date, (d.registered_at at time zone v_tz)::date),
          'arrival_number', d.arrival_number,
          'issuing_org_name', case when c.ok then coalesce(
            nullif(btrim(d.issuing_org_name), ''),
            (select e.name from public.external_orgs e where e.id = d.external_org_id)
          ) end,
          'notation', case when c.ok then d.notation end,
          'issued_date', d.issued_date,
          'type_name', case when c.ok then (select t.name from public.doc_types t where t.id = d.doc_type_id) end,
          'subject', case when c.ok then d.subject else 'Restricted document' end,
          'receiver', case when c.ok then coalesce(
            (select coalesce(public.doc_user_name(a.assignee_user_id), dep.name)
             from public.document_assignments a
             left join public.departments dep on dep.id = a.assignee_department_id
             where a.document_id = d.id and a.parent_id is null and a.role = 'lead'
               and a.status <> 'revoked'
             order by a.assigned_at, a.id
             limit 1),
            public.doc_user_name(d.presented_to)
          ) end,
          'transferred_at', coalesce(
            (select min(a.assigned_at) from public.document_assignments a
             where a.document_id = d.id and a.parent_id is null),
            d.submitted_at
          ),
          'note', case when c.ok then d.status end
        ) as entry
      from public.documents d
      cross join lateral (select public.can_read_document(d.id) as ok) c
      where d.register_id = v_reg.id
        and (d.number is not null or d.arrival_number is not null)
        and (p_from is null or coalesce(d.arrival_date, (d.registered_at at time zone v_tz)::date) >= p_from)
        and (p_to is null or coalesce(d.arrival_date, (d.registered_at at time zone v_tz)::date) <= p_to)
        and (p_from_number is null or d.arrival_number >= p_from_number)
        and (p_to_number is null or d.arrival_number <= p_to_number)
    ) x;
  else
    select coalesce(jsonb_agg(x.entry order by x.n nulls last, x.created_at, x.id), '[]')
    into v_rows
    from (
      select d.id, d.created_at, d.number as n,
        jsonb_build_object(
          'id', d.id,
          'readable', c.ok,
          'number', d.number,
          'notation', case when c.ok then d.notation end,
          'issued_date', coalesce(d.issued_date, (d.issued_at at time zone v_tz)::date),
          'type_name', case when c.ok then (select t.name from public.doc_types t where t.id = d.doc_type_id) end,
          'subject', case when c.ok then d.subject else 'Restricted document' end,
          'signer', case when c.ok then nullif(concat_ws(' ',
            case when d.signer_authority <> '' then d.signer_authority || '.' end,
            coalesce(nullif(btrim(d.signer_name), ''), public.doc_user_name(d.signer_user_id))
          ), '') end,
          'recipients', case when c.ok then (
            select string_agg(r.name_snapshot, ', ' order by r.sent_at nulls last, r.name_snapshot, r.id)
            from public.document_recipients r where r.document_id = d.id
          ) end,
          'filed_unit', case when c.ok then
            (select dep.name from public.departments dep where dep.id = d.drafting_department_id) end,
          'copies', case when c.ok then d.copies end,
          'sent_at', coalesce(
            (select min(r.sent_at) from public.document_recipients r where r.document_id = d.id),
            d.issued_at
          ),
          'note', case when c.ok then d.status end
        ) as entry
      from public.documents d
      cross join lateral (select public.can_read_document(d.id) as ok) c
      where d.register_id = v_reg.id
        and (d.number is not null or d.arrival_number is not null)
        and (p_from is null or coalesce(d.issued_date, (d.issued_at at time zone v_tz)::date) >= p_from)
        and (p_to is null or coalesce(d.issued_date, (d.issued_at at time zone v_tz)::date) <= p_to)
        and (p_from_number is null or d.number >= p_from_number)
        and (p_to_number is null or d.number <= p_to_number)
    ) x;
  end if;
  return v_rows;
end;
$$;

-- =============================================
-- Privileges
-- =============================================
-- Supabase (and the test stubs) grant new functions to anon/authenticated by
-- default, so each one is revoked explicitly; triggers fire without EXECUTE
-- on their function.
revoke all on function public.seed_document_defaults(uuid) from public, anon, authenticated;
revoke all on function public.organizations_seed_documents_trigger() from public, anon, authenticated;
revoke all on function public.doc_admin_org(text, uuid, text) from public, anon, authenticated;
revoke all on function public.doc_check_template(text, text) from public, anon, authenticated;
revoke all on function public.doc_register_is_numbered(uuid) from public, anon, authenticated;
grant execute on function public.seed_document_defaults(uuid) to service_role;
grant execute on function public.organizations_seed_documents_trigger() to service_role;
grant execute on function public.doc_admin_org(text, uuid, text) to service_role;
grant execute on function public.doc_check_template(text, text) to service_role;
grant execute on function public.doc_register_is_numbered(uuid) to service_role;

revoke all on function public.upsert_doc_type(uuid, text, text, boolean, boolean, int, text) from public, anon;
revoke all on function public.upsert_doc_field(uuid, text, boolean) from public, anon;
revoke all on function public.upsert_external_org(uuid, text, text, text, text, boolean) from public, anon;
revoke all on function public.upsert_doc_register(uuid, text, text, int, int, text, text, text, boolean, uuid[]) from public, anon;
revoke all on function public.close_doc_register(uuid) from public, anon;
revoke all on function public.reopen_doc_register(uuid) from public, anon;
revoke all on function public.delete_doc_register(uuid) from public, anon;
revoke all on function public.set_register_role(uuid, uuid, text) from public, anon;
revoke all on function public.open_next_year_registers(int) from public, anon;
revoke all on function public.peek_next_number(uuid, uuid) from public, anon;
revoke all on function public.list_register_entries(uuid, date, date, int, int) from public, anon;
grant execute on function public.upsert_doc_type(uuid, text, text, boolean, boolean, int, text) to authenticated;
grant execute on function public.upsert_doc_field(uuid, text, boolean) to authenticated;
grant execute on function public.upsert_external_org(uuid, text, text, text, text, boolean) to authenticated;
grant execute on function public.upsert_doc_register(uuid, text, text, int, int, text, text, text, boolean, uuid[]) to authenticated;
grant execute on function public.close_doc_register(uuid) to authenticated;
grant execute on function public.reopen_doc_register(uuid) to authenticated;
grant execute on function public.delete_doc_register(uuid) to authenticated;
grant execute on function public.set_register_role(uuid, uuid, text) to authenticated;
grant execute on function public.open_next_year_registers(int) to authenticated;
grant execute on function public.peek_next_number(uuid, uuid) to authenticated;
grant execute on function public.list_register_entries(uuid, date, date, int, int) to authenticated;
