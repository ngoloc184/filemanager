-- Documents: default seed, lookup and register administration, number
-- preview and the register print data.
-- Run with scripts/test-db.sh (plain PostgreSQL + supabase/tests stubs).
-- Everything runs in one transaction that is rolled back at the end.

\set ON_ERROR_STOP 1
\o /dev/null
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B '''bbbbbbbb-0000-0000-0000-00000000000b'''
\set L '''11111111-0000-0000-0000-0000000000a1'''
\set S '''55555555-0000-0000-0000-0000000000a5'''
\set M '''66666666-0000-0000-0000-0000000000a6'''
\set K '''77777777-0000-0000-0000-0000000000a7'''
\set D '''dddddddd-0000-0000-0000-00000000000d'''
\set E '''eeeeeeee-0000-0000-0000-00000000000e'''
\set ORG '''0a000000-0000-0000-0000-0000000000a1'''
\set ORG2 '''0a000000-0000-0000-0000-0000000000a2'''
\set HC '''0d000000-0000-0000-0000-0000000000d1'''
\set TX '''07000000-0000-0000-0000-000000000079'''

begin;

create function pg_temp.check(ok boolean, msg text) returns void
language plpgsql as $$
begin
  if not coalesce(ok, false) then
    raise exception 'FAILED: %', msg;
  end if;
  raise warning 'ok - %', msg;
end;
$$;

create function pg_temp.login(uid uuid) returns void
language sql as $$
  select set_config('request.jwt.claim.sub', uid::text, true),
         set_config('request.jwt.claim.role', 'authenticated', true);
$$;

-- Returns the error message of a statement, or null when it succeeds.
create function pg_temp.error_of(stmt text) returns text
language plpgsql as $$
begin
  execute stmt;
  return null;
exception when others then
  return sqlerrm;
end;
$$;

-- ---------------------------------------------------------------- fixtures
insert into auth.users (id, email) values
  (:A, 'alice@example.com'),
  (:B, 'bob@example.com'),
  (:L, 'lan@example.com'),
  (:S, 'son@example.com'),
  (:M, 'minh@example.com'),
  (:K, 'khoa@example.com'),
  (:D, 'dave@example.com'),
  (:E, 'eve@example.com');
insert into public.user_profiles (id, email) values
  (:A, 'alice@example.com'),
  (:B, 'bob@example.com'),
  (:L, 'lan@example.com'),
  (:S, 'son@example.com'),
  (:M, 'minh@example.com'),
  (:K, 'khoa@example.com'),
  (:D, 'dave@example.com'),
  (:E, 'eve@example.com')
on conflict (id) do nothing;
update public.user_profiles set display_name = 'Lan Phạm' where id = :L;

-- ABC: Alice admin/clerk/leader, Lan leader, Khoa clerk, Bob, Son and Minh staff.
-- XYZ: Dave.
insert into public.organizations (id, name, code, created_by) values
  (:ORG, 'ABC Corporation', 'ABC', :A),
  (:ORG2, 'XYZ Company', 'XYZ', :D);
insert into public.departments (id, org_id, name, code) values
  (:HC, :ORG, 'Hành chính nhân sự', 'HCNS');
insert into public.org_members (org_id, user_id, department_id, roles) values
  (:ORG, :A, :HC, '{org_admin,clerk,leader}'),
  (:ORG, :L, :HC, '{leader}'),
  (:ORG, :K, :HC, '{clerk}'),
  (:ORG, :B, :HC, '{staff}'),
  (:ORG, :S, :HC, '{staff}'),
  (:ORG, :M, :HC, '{staff}'),
  (:ORG2, :D, null, '{org_admin,clerk,leader}');
insert into public.doc_types (id, org_id, name, abbreviation) values
  (:TX, :ORG2, 'Other', 'OT');

grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
grant execute on function pg_temp.login(uuid) to authenticated, anon;
grant execute on function pg_temp.error_of(text) to authenticated, anon;

create temp table ids (k text primary key, v uuid);
grant all on ids to authenticated, anon;
create temp table vals (k text primary key, v jsonb);
grant all on vals to authenticated, anon;

-- the seed is deferred to commit: nothing yet inside this transaction
select pg_temp.check(
  (select count(*) from public.doc_types where org_id = :ORG) = 0,
  'the seed trigger is deferred to the end of the transaction');

-- ---------------------------------------------------------------- anon
set local role anon;
set local request.jwt.claim.sub = '';

select pg_temp.check(
  pg_temp.error_of($$select public.upsert_doc_register(null, 'outgoing', 'x', 2026, 1, 'register', null, null, null, null)$$)
    ~* 'permission denied',
  'anon cannot call upsert_doc_register');
select pg_temp.check(
  pg_temp.error_of($$select public.list_register_entries(gen_random_uuid())$$) ~* 'permission denied',
  'anon cannot call list_register_entries');
select pg_temp.check(
  pg_temp.error_of($$select public.peek_next_number(gen_random_uuid())$$) ~* 'permission denied',
  'anon cannot call peek_next_number');
select pg_temp.check(
  pg_temp.error_of($$select public.seed_document_defaults(gen_random_uuid())$$) ~* 'permission denied',
  'anon cannot call seed_document_defaults');

reset role;
set local role authenticated;

-- ---------------------------------------------------------------- seed on create
select pg_temp.login(:E);
select pg_temp.check(
  pg_temp.error_of($$select public.seed_document_defaults(public.my_org_id())$$) ~* 'permission denied',
  'seed_document_defaults is internal');
insert into ids select 'eorg', (public.create_organization('Epsilon Ltd', 'EPS')).id;

reset role;
set constraints organizations_seed_documents immediate;

select pg_temp.check(
  (select count(*) from public.doc_types where org_id = (select v from ids where k = 'eorg')) = 28,
  'creating a company seeds 28 document types');
select pg_temp.check(
  (select is_cong_van and abbreviation = '' and sort_order = 0
   from public.doc_types where org_id = (select v from ids where k = 'eorg') and name = 'Công văn')
  and (select abbreviation = 'QĐ' and sort_order = 2 and not is_cong_van
       from public.doc_types where org_id = (select v from ids where k = 'eorg') and name = 'Quyết định')
  and (select abbreviation = 'PB' and sort_order = 27
       from public.doc_types where org_id = (select v from ids where k = 'eorg') and name = 'Phiếu báo'),
  'Công văn first without abbreviation; the Phụ lục III types follow in order');
select pg_temp.check(
  (select count(*) from public.doc_registers r
   where r.org_id = (select v from ids where k = 'eorg')
     and r.year = public.doc_year_for(r.org_id, now())
     and r.start_number = 1 and r.scope = 'register' and r.closed_at is null
     and r.notation_template = '{n}/{type}-{org}' and r.cong_van_template = '{n}/{org}-{dept}') = 3
  and (select array_agg(direction || '/' || name order by direction)
       from public.doc_registers where org_id = (select v from ids where k = 'eorg'))
      = array['incoming/Sổ văn bản đến', 'internal/Sổ văn bản nội bộ', 'outgoing/Sổ văn bản đi'],
  'creating a company seeds 3 registers for the current year');
select pg_temp.check(
  (select count(*) from public.doc_types where org_id = :ORG) = 28
  and (select count(*) from public.doc_registers where org_id = :ORG) = 3,
  'companies inserted directly are seeded too');

select public.seed_document_defaults((select v from ids where k = 'eorg'));
select pg_temp.check(
  (select count(*) from public.doc_types where org_id = (select v from ids where k = 'eorg')) = 28
  and (select count(*) from public.doc_registers where org_id = (select v from ids where k = 'eorg')) = 3,
  'the seed is idempotent');

insert into ids select 'rin', id from public.doc_registers where org_id = :ORG and direction = 'incoming';
insert into ids select 'rout', id from public.doc_registers where org_id = :ORG and direction = 'outgoing';
insert into ids select 'tqd', id from public.doc_types where org_id = :ORG and name = 'Quyết định';
insert into vals select 'year', to_jsonb(public.doc_year_for(:ORG, now()));

set local role authenticated;

-- ---------------------------------------------------------------- who may administer
select pg_temp.login(:S);
select pg_temp.check(
  pg_temp.error_of($$select public.upsert_doc_register(null, 'outgoing', 'Sổ riêng', 2001, 1, 'register', null, null, null, null)$$)
    ~* 'only company admins',
  'a non-admin cannot create a register');
select pg_temp.check(
  pg_temp.error_of(format('select public.upsert_doc_register(%L, %L, %L, %s, 1, %L, null, null, null, null)',
    (select v from ids where k = 'rout'), 'outgoing', 'Renamed', (select v from vals where k = 'year'), 'register'))
    ~* 'only company admins',
  'a non-admin cannot edit a register');
select pg_temp.check(
  pg_temp.error_of($$select public.upsert_doc_type(null, 'Thông tư', 'TT', false, true, 30)$$) ~* 'only company admins',
  'a non-admin cannot add a document type');
select pg_temp.check(
  pg_temp.error_of($$select public.upsert_external_org(null, 'Bộ Tài chính', null, null, null, true)$$) ~* 'admins and clerks',
  'staff cannot add an external organization');

select pg_temp.login(:D);
select pg_temp.check(
  pg_temp.error_of(format('select public.close_doc_register(%L)', (select v from ids where k = 'rout'))) ~* 'not found',
  'an admin of another company does not see the register');

-- ---------------------------------------------------------------- lookups (admin, clerk)
select pg_temp.login(:A);
insert into ids select 'ttt', (public.upsert_doc_type(null, '  Thông tư ', 'TT', null, null, 30, 'R-05')).id;
select pg_temp.check(
  (select name = 'Thông tư' and abbreviation = 'TT' and not is_cong_van and active and sort_order = 30
     and default_retention_code = 'R-05' and org_id = :ORG
   from public.doc_types where id = (select v from ids where k = 'ttt')),
  'the admin adds a document type to their company');
select public.upsert_doc_type((select v from ids where k = 'ttt'), 'Thông tư', 'TT', null, false, null);
select pg_temp.check(
  (select not active and sort_order = 30 and default_retention_code = 'R-05'
   from public.doc_types where id = (select v from ids where k = 'ttt')),
  'null keeps the stored values; the type can be deactivated');
select public.upsert_doc_type((select v from ids where k = 'ttt'), 'Thông tư', 'TT', null, null, null, ' ');
select pg_temp.check(
  (select default_retention_code is null from public.doc_types where id = (select v from ids where k = 'ttt')),
  'a blank retention code clears it');
select pg_temp.check(
  pg_temp.error_of($$select public.upsert_doc_type(null, 'Quyết định', 'QĐ', false, true, 0)$$) ~* 'already exists',
  'a duplicate type name is refused');
select pg_temp.check(
  pg_temp.error_of($$select public.upsert_doc_type(null, 'Bad', 'Q/Đ', false, true, 0)$$) ~* 'abbreviation',
  'an abbreviation with a slash is refused');

insert into ids select 'fld', (public.upsert_doc_field(null, 'Tài chính', null)).id;
select pg_temp.check(
  (select name = 'Tài chính' and active and org_id = :ORG from public.doc_fields where id = (select v from ids where k = 'fld')),
  'the admin adds a field');
select pg_temp.check(
  pg_temp.error_of($$select public.upsert_doc_field(null, 'Tài chính', true)$$) ~* 'already exists',
  'a duplicate field is refused');

select pg_temp.login(:K);
insert into ids select 'ext', (public.upsert_external_org(null, 'Bộ Tài chính', 'BTC', ' Info@MOF.gov.vn ', '', null)).id;
select pg_temp.check(
  (select name = 'Bộ Tài chính' and code = 'BTC' and email = 'info@mof.gov.vn' and address is null and active
   from public.external_orgs where id = (select v from ids where k = 'ext')),
  'a clerk adds an external organization');
select pg_temp.check(
  pg_temp.error_of($$select public.upsert_external_org(null, 'X', null, 'not-an-email', null, true)$$) ~* 'email',
  'an invalid email is refused');
select pg_temp.check(
  pg_temp.error_of($$select public.upsert_doc_field(null, 'Nhân sự', true)$$) ~* 'only company admins',
  'a clerk cannot add a field');

-- ---------------------------------------------------------------- registers
select pg_temp.login(:A);
select pg_temp.check(
  pg_temp.error_of($$select public.upsert_doc_register(null, 'outgoing', 'Sổ thử', 2001, 1, 'register', 'QĐ-ABC', null, null, null)$$)
    ~* '\{n\}',
  'a template without {n} is refused');
select pg_temp.check(
  pg_temp.error_of($$select public.upsert_doc_register(null, 'outgoing', 'Sổ thử', 2001, 1, 'register', '{n}/{xx}', null, null, null)$$)
    ~* 'unknown token',
  'a template with an unknown token is refused');
select pg_temp.check(
  pg_temp.error_of(format('select public.upsert_doc_register(null, %L, %L, 2001, 1, %L, null, null, null, %L::uuid[])',
    'outgoing', 'Sổ thử', 'register', array['07000000-0000-0000-0000-000000000079']::text[])) ~* 'belong to this company',
  'allowed types of another company are refused');

insert into ids select 'r1', (public.upsert_doc_register(
  null, 'outgoing', 'Sổ thử', 2001, 1, 'register', '{n}/{type}-{org}', null, null,
  array[(select v from ids where k = 'tqd'), (select v from ids where k = 'tqd')])).id;
select pg_temp.check(
  (select org_id = :ORG and year = 2001 and created_by = :A and cong_van_template = '{n}/{org}-{dept}'
     and allowed_type_ids = array[(select v from ids where k = 'tqd')] and not is_confidential
   from public.doc_registers where id = (select v from ids where k = 'r1')),
  'the admin creates a register; default Công văn template; allowed types deduplicated');
select pg_temp.check(
  pg_temp.error_of($$select public.upsert_doc_register(null, 'outgoing', 'Sổ thử', 2001, 1, 'register', null, null, null, null)$$)
    ~* 'already exists',
  'a register name is unique per direction and year');

-- number preview
select pg_temp.check(
  public.peek_next_number((select v from ids where k = 'r1')) = 1,
  'peek_next_number returns 1 for a new register');
reset role;
select pg_temp.check(public.doc_next_number((select v from ids where k = 'r1'), null) = 1, 'doc_next_number hands out 1');
set local role authenticated;
select pg_temp.login(:A);
select pg_temp.check(
  public.peek_next_number((select v from ids where k = 'r1')) = 2
  and public.peek_next_number((select v from ids where k = 'r1')) = 2,
  'peek_next_number returns 2 after doc_next_number, without taking it');
select pg_temp.check(
  pg_temp.error_of(format('select public.upsert_doc_register(%L, %L, %L, 2001, 5, %L, null, null, null, null)',
    (select v from ids where k = 'r1'), 'outgoing', 'Sổ thử', 'register')) ~* 'cannot change',
  'the start number is fixed once a number was handed out');
select pg_temp.check(
  pg_temp.error_of(format('select public.upsert_doc_register(%L, %L, %L, 2001, 1, %L, null, null, null, null)',
    (select v from ids where k = 'r1'), 'outgoing', 'Sổ thử', 'register_type')) ~* 'cannot change',
  'the numbering scope is fixed once a number was handed out');
select public.upsert_doc_register((select v from ids where k = 'r1'), 'outgoing', 'Sổ quyết định', 2001, 1,
  'register', null, '{n}/{org}', true, null);
select pg_temp.check(
  (select name = 'Sổ quyết định' and is_confidential and cong_van_template = '{n}/{org}'
     and notation_template = '{n}/{type}-{org}' and allowed_type_ids = array[(select v from ids where k = 'tqd')]
   from public.doc_registers where id = (select v from ids where k = 'r1')),
  'name and templates can still change; null keeps the stored template and types');
insert into ids select 'r4', (public.upsert_doc_register(
  null, 'outgoing', 'Sổ theo loại', 2001, 7, 'register_type', null, null, null, null)).id;
select public.upsert_doc_register((select v from ids where k = 'r4'), 'outgoing', 'Sổ theo loại văn bản', 2001,
  null, null, null, null, null, null);
select pg_temp.check(
  (select name = 'Sổ theo loại văn bản' and scope = 'register_type' and start_number = 7
   from public.doc_registers where id = (select v from ids where k = 'r4')),
  'null scope and start number keep the stored values on edit');

-- register roles
select public.set_register_role((select v from ids where k = 'r1'), :M, 'manager');
select pg_temp.check(
  pg_temp.error_of(format('select public.set_register_role(%L, %L, %L)',
    (select v from ids where k = 'r1'), 'dddddddd-0000-0000-0000-00000000000d', 'follower')) ~* 'active member',
  'register roles go to members of the company only');
select pg_temp.check(
  pg_temp.error_of(format('select public.set_register_role(%L, %L, %L)',
    (select v from ids where k = 'r1'), '66666666-0000-0000-0000-0000000000a6', 'owner')) ~* 'unknown register role',
  'an unknown register role is refused');

select pg_temp.login(:M);
select pg_temp.check(
  public.peek_next_number((select v from ids where k = 'r1')) = 2,
  'a register manager previews the next number');
select pg_temp.login(:S);
select pg_temp.check(
  pg_temp.error_of(format('select public.peek_next_number(%L)', (select v from ids where k = 'r1'))) ~* 'only clerks',
  'staff cannot preview numbers');

-- close / reopen
select pg_temp.login(:A);
select pg_temp.check(
  (public.close_doc_register((select v from ids where k = 'r1'))).closed_at is not null,
  'the admin closes a register');
reset role;
select pg_temp.check(
  pg_temp.error_of(format('select public.doc_next_number(%L, null)', (select v from ids where k = 'r1'))) ~* 'closed',
  'a closed register hands out no numbers');
set local role authenticated;
select pg_temp.login(:A);
select pg_temp.check(
  (public.reopen_doc_register((select v from ids where k = 'r1'))).closed_at is null,
  'the admin reopens it');

-- ---------------------------------------------------------------- register entries
reset role;
-- numbers 2, 1 and a confidential 3 in r1 (Bob's, Lan is not a participant),
-- plus an unnumbered draft that is not listed
with x as (
  insert into public.documents (org_id, direction, status, register_id, number, notation, subject,
    doc_type_id, issued_date, signer_authority, signer_name, drafting_department_id, copies, created_by,
    submitted_at, issued_at)
  values
    (:ORG, 'outgoing', 'issued', (select v from ids where k = 'r1'), 2, '02/QĐ-ABC', 'Quyết định thứ hai',
     (select v from ids where k = 'tqd'), '2001-03-02', '', 'Alice', :HC, 3, :B, now(), now()),
    (:ORG, 'outgoing', 'issued', (select v from ids where k = 'r1'), 1, '01/QĐ-ABC', 'Quyết định thứ nhất',
     (select v from ids where k = 'tqd'), '2001-03-01', 'KT', 'Alice', :HC, 2, :B, now(), '2001-03-01 09:00+07')
  returning id, number
)
insert into ids select 'n' || number, id from x;
with x as (
  insert into public.documents (org_id, direction, status, register_id, number, notation, subject,
    confidentiality, issued_date, created_by, submitted_at)
  values (:ORG, 'outgoing', 'signed', (select v from ids where k = 'r1'), 3, '03/QĐ-ABC', 'Lương lãnh đạo',
    'confidential', '2001-03-05', :B, now())
  returning id
)
insert into ids select 'n3', id from x;
insert into public.documents (org_id, direction, status, register_id, subject, created_by)
values (:ORG, 'outgoing', 'draft', (select v from ids where k = 'r1'), 'Chưa có số', :B);
insert into public.document_recipients (document_id, kind, name_snapshot, sent_at) values
  ((select v from ids where k = 'n1'), 'external', 'Bộ Tài chính', '2001-03-01 10:00+07'),
  ((select v from ids where k = 'n1'), 'external', 'Sở Kế hoạch', '2001-03-01 11:00+07');

-- incoming register: arrival numbers 2 and 1, one presented to Lan
insert into public.documents (org_id, direction, status, register_id, arrival_number, arrival_date, notation,
  issuing_org_name, subject, created_by, presented_to, registered_at)
values
  (:ORG, 'incoming', 'registered', (select v from ids where k = 'rin'), 2, '2001-04-02', '15/BTC-VP',
   'Bộ Tài chính', 'Công văn đến hai', :A, :L, now()),
  (:ORG, 'incoming', 'registered', (select v from ids where k = 'rin'), 1, '2001-04-01', '7/UBND',
   'UBND Thành phố', 'Công văn đến một', :A, null, now());

set local role authenticated;
select pg_temp.login(:L);
insert into vals select 'out', public.list_register_entries((select v from ids where k = 'r1'));
select pg_temp.check(
  jsonb_array_length((select v from vals where k = 'out')) = 3
  and (select array_agg((e ->> 'number')::int order by o) from jsonb_array_elements((select v from vals where k = 'out')) with ordinality as t(e, o))
      = array[1, 2, 3],
  'list_register_entries returns the numbered rows in number order');
select pg_temp.check(
  (select e ->> 'notation' = '01/QĐ-ABC' and e ->> 'type_name' = 'Quyết định' and e ->> 'subject' = 'Quyết định thứ nhất'
     and e ->> 'signer' = 'KT. Alice' and e ->> 'recipients' = 'Bộ Tài chính, Sở Kế hoạch'
     and e ->> 'filed_unit' = 'Hành chính nhân sự' and (e ->> 'copies')::int = 2
     and e ->> 'issued_date' = '2001-03-01' and (e ->> 'sent_at')::timestamptz = '2001-03-01 10:00+07'
     and e ->> 'note' = 'issued' and (e ->> 'readable')::boolean
   from jsonb_array_elements((select v from vals where k = 'out')) e where (e ->> 'number')::int = 1),
  'an outgoing row carries the Phụ lục IV columns');
select pg_temp.check(
  (select e ->> 'signer' = 'Alice' and e ->> 'recipients' is null
     and (e ->> 'sent_at')::timestamptz is not null
   from jsonb_array_elements((select v from vals where k = 'out')) e where (e ->> 'number')::int = 2),
  'no recipients: sent_at falls back to issued_at');
select pg_temp.check(
  (select e ->> 'subject' = 'Restricted document' and not (e ->> 'readable')::boolean
     and e -> 'notation' = 'null'::jsonb and e -> 'type_name' = 'null'::jsonb and e -> 'signer' = 'null'::jsonb
     and e -> 'note' = 'null'::jsonb and e ->> 'issued_date' = '2001-03-05'
     and e ->> 'id' = (select v::text from ids where k = 'n3')
   from jsonb_array_elements((select v from vals where k = 'out')) e where (e ->> 'number')::int = 3),
  'a confidential document shows as Restricted document to a leader who cannot read it');
select pg_temp.check(
  jsonb_array_length(public.list_register_entries((select v from ids where k = 'r1'), null, null, 2, null)) = 2
  and jsonb_array_length(public.list_register_entries((select v from ids where k = 'r1'), '2001-03-02', '2001-03-04')) = 1,
  'number and date filters narrow the rows');

insert into vals select 'in', public.list_register_entries((select v from ids where k = 'rin'));
select pg_temp.check(
  (select array_agg((e ->> 'arrival_number')::int order by o)
   from jsonb_array_elements((select v from vals where k = 'in')) with ordinality as t(e, o)) = array[1, 2],
  'incoming rows are ordered by arrival number');
select pg_temp.check(
  (select e ->> 'receiver' = 'Lan Phạm' and e ->> 'issuing_org_name' = 'Bộ Tài chính'
     and e ->> 'notation' = '15/BTC-VP' and e ->> 'arrival_date' = '2001-04-02' and e ->> 'note' = 'registered'
   from jsonb_array_elements((select v from vals where k = 'in')) e where (e ->> 'arrival_number')::int = 2),
  'an incoming row names the person it was presented to');

select pg_temp.login(:S);
select pg_temp.check(
  pg_temp.error_of(format('select public.list_register_entries(%L)', (select v from ids where k = 'r1'))) ~* 'cannot view',
  'an unrelated staff member gets an error');
select pg_temp.login(:M);
select pg_temp.check(
  jsonb_array_length(public.list_register_entries((select v from ids where k = 'r1'))) = 3,
  'a register manager lists the register');
select pg_temp.login(:D);
select pg_temp.check(
  pg_temp.error_of(format('select public.list_register_entries(%L)', (select v from ids where k = 'r1'))) ~* 'not found',
  'another company does not see the register');

-- ---------------------------------------------------------------- delete
select pg_temp.login(:A);
select pg_temp.check(
  pg_temp.error_of(format('select public.delete_doc_register(%L)', (select v from ids where k = 'r1')))
    ~* 'in use and cannot be deleted',
  'a register in use cannot be deleted');
insert into ids select 'r2', (public.upsert_doc_register(null, 'internal', 'Sổ tạm', 2001, 1, 'register', null, null, null, null)).id;
select public.delete_doc_register((select v from ids where k = 'r2'));
reset role;
select pg_temp.check(
  not exists (select 1 from public.doc_registers where id = (select v from ids where k = 'r2')),
  'an unused register is deleted');
set local role authenticated;

-- ---------------------------------------------------------------- next year
select pg_temp.login(:A);
select public.set_register_role((select v from ids where k = 'rout'), :M, 'follower');
select public.set_register_role((select v from ids where k = 'rout'), :S, 'manager');
select public.set_register_role((select v from ids where k = 'rout'), :S, null);
select pg_temp.check(
  pg_temp.error_of(format('select public.open_next_year_registers(%s)', (select v from vals where k = 'year')::int + 1))
    is null,
  'the admin opens next year');
reset role;
select pg_temp.check(
  (select count(*) from public.doc_registers
   where org_id = :ORG and year = (select v from vals where k = 'year')::int + 1) = 3,
  'open_next_year_registers copies the 3 open registers');
select pg_temp.check(
  (select rr.role = 'follower'
   from public.doc_register_roles rr
   join public.doc_registers r on r.id = rr.register_id
   where r.org_id = :ORG and r.direction = 'outgoing' and r.year = (select v from vals where k = 'year')::int + 1
     and rr.user_id = :M)
  and not exists (
    select 1 from public.doc_register_roles rr
    join public.doc_registers r on r.id = rr.register_id
    where r.org_id = :ORG and r.year = (select v from vals where k = 'year')::int + 1 and rr.user_id = :S),
  'register roles are copied (a removed role is not)');
set local role authenticated;
select pg_temp.login(:A);
select pg_temp.check(
  public.open_next_year_registers((select v from vals where k = 'year')::int + 1) = 0,
  'opening the same year again copies nothing');
select pg_temp.login(:L);
select pg_temp.check(
  pg_temp.error_of(format('select public.open_next_year_registers(%s)', (select v from vals where k = 'year')::int + 2))
    ~* 'only company admins',
  'only admins open next year');

reset role;

rollback;
