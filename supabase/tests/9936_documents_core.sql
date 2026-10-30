-- Documents core: access rules, file freeze, numbering helpers and core RPCs.
-- Run with scripts/test-db.sh (plain PostgreSQL + supabase/tests stubs).
-- Everything runs in one transaction that is rolled back at the end.

\set ON_ERROR_STOP 1
\o /dev/null
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B '''bbbbbbbb-0000-0000-0000-00000000000b'''
\set C '''cccccccc-0000-0000-0000-00000000000c'''
\set D '''dddddddd-0000-0000-0000-00000000000d'''
\set ORG '''0a000000-0000-0000-0000-0000000000a1'''
\set ORG2 '''0a000000-0000-0000-0000-0000000000a2'''
\set HC '''0d000000-0000-0000-0000-0000000000d1'''
\set KT '''0d000000-0000-0000-0000-0000000000d2'''
\set OPS '''0d000000-0000-0000-0000-0000000000d3'''
\set TQD '''07000000-0000-0000-0000-000000000071'''
\set TTB '''07000000-0000-0000-0000-000000000072'''
\set TX '''07000000-0000-0000-0000-000000000079'''
\set RIN '''08000000-0000-0000-0000-000000000081'''
\set ROUT '''08000000-0000-0000-0000-000000000082'''
\set RTYPE '''08000000-0000-0000-0000-000000000083'''
\set RFIVE '''08000000-0000-0000-0000-000000000084'''
\set F1 '''f1000000-0000-0000-0000-0000000000f1'''
\set F2 '''f1000000-0000-0000-0000-0000000000f2'''
\set F1PATH '''bbbbbbbb-0000-0000-0000-00000000000b/f1000000-0000-0000-0000-0000000000f1/v1/plan.pdf'''
\set F1V2 '''bbbbbbbb-0000-0000-0000-00000000000b/f1000000-0000-0000-0000-0000000000f1/v2/plan.pdf'''
\set F2PATH '''bbbbbbbb-0000-0000-0000-00000000000b/f1000000-0000-0000-0000-0000000000f2/v1/draft.docx'''

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
  (:C, 'carol@example.com'),
  (:D, 'dave@example.com');
insert into public.user_profiles (id, email) values
  (:A, 'alice@example.com'),
  (:B, 'bob@example.com'),
  (:C, 'carol@example.com'),
  (:D, 'dave@example.com')
on conflict (id) do nothing;
update public.user_profiles set display_name = 'Bob Trần' where id = :B;

-- ABC: Alice admin/leader/clerk and Bob staff in HCNS, Carol staff in KT.
-- XYZ: Dave.
insert into public.organizations (id, name, code, created_by) values
  (:ORG, 'ABC Corporation', 'ABC', :A),
  (:ORG2, 'XYZ Company', 'XYZ', :D);
insert into public.departments (id, org_id, name, code) values
  (:HC, :ORG, 'Hành chính nhân sự', 'HCNS'),
  (:KT, :ORG, 'Kế toán', 'KT'),
  (:OPS, :ORG2, 'Operations', 'OPS');
insert into public.org_members (org_id, user_id, department_id, roles) values
  (:ORG, :A, :HC, '{org_admin,clerk,leader}'),
  (:ORG, :B, :HC, '{staff}'),
  (:ORG, :C, :KT, '{staff}'),
  (:ORG2, :D, :OPS, '{org_admin,clerk,leader}');

insert into public.doc_types (id, org_id, name, abbreviation) values
  (:TQD, :ORG, 'Quyết định', 'QĐ'),
  (:TTB, :ORG, 'Thông báo', 'TB'),
  (:TX, :ORG2, 'Other', 'OT');
insert into public.doc_registers (id, org_id, direction, name, year) values
  (:RIN, :ORG, 'incoming', 'Sổ văn bản đến', 2026),
  (:ROUT, :ORG, 'outgoing', 'Sổ văn bản đi', 2026);
insert into public.doc_registers (id, org_id, direction, name, year, scope) values
  (:RTYPE, :ORG, 'outgoing', 'Sổ theo loại', 2026, 'register_type');
insert into public.doc_registers (id, org_id, direction, name, year, start_number) values
  (:RFIVE, :ORG, 'internal', 'Sổ nội bộ', 2026, 5);

-- Bob's uploads (register_file requires the object to exist in storage)
insert into storage.buckets (id, name) values ('uploads', 'uploads') on conflict (id) do nothing;
insert into storage.objects (bucket_id, name, owner, metadata) values
  ('uploads', :F1PATH, :B, '{"size": 10}'),
  ('uploads', :F1V2, :B, '{"size": 11}'),
  ('uploads', :F2PATH, :B, '{"size": 12}');

-- Carol already has a root folder called Documents
insert into public.folders (owner_id, name) values (:C, 'Documents');

grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
grant execute on function pg_temp.login(uuid) to authenticated, anon;
grant execute on function pg_temp.error_of(text) to authenticated, anon;

create temp table ids (k text primary key, v uuid);
grant all on ids to authenticated, anon;

-- ---------------------------------------------------------------- anon
set local role anon;
set local request.jwt.claim.sub = '';

select pg_temp.check(
  pg_temp.error_of($$select public.create_document('outgoing', '{"subject": "x"}')$$) ~* 'permission denied',
  'anon cannot call create_document');
select pg_temp.check(
  pg_temp.error_of($$select public.can_read_document(gen_random_uuid())$$) ~* 'permission denied',
  'anon cannot call can_read_document');
select pg_temp.check(
  pg_temp.error_of($$select public.doc_render_notation('{n}', 1, '', '', '', 2026)$$) ~* 'permission denied',
  'anon cannot call the notation helper');
select pg_temp.check(
  pg_temp.error_of($$select count(*) from public.documents$$) ~* 'permission denied',
  'anon cannot read documents');

reset role;
set local role authenticated;

-- ---------------------------------------------------------------- Bob drafts an outgoing document
select pg_temp.login(:B);

insert into ids select 'd1', public.create_document('outgoing', jsonb_build_object(
  'subject', '  Kế hoạch năm 2027 ',
  'doc_type_id', :TQD,
  'keywords', jsonb_build_array('kế hoạch', ' ngân sách ', 'kế hoạch', ''),
  'notation', '99/XX',
  'unknown_key', 1
));

select pg_temp.check(
  (select status = 'draft' and subject = 'Kế hoạch năm 2027' and created_by = :B
     and drafting_department_id = :HC and notation is null and org_id = :ORG
     and keywords = array['kế hoạch', 'ngân sách']
   from public.documents where id = (select v from ids where k = 'd1')),
  'create_document: draft in my company and department; keywords cleaned; notation ignored for outgoing');
select pg_temp.check(
  (select search_norm like '%ke hoach nam 2027%' and search_norm like '%ngan sach%'
   from public.documents where id = (select v from ids where k = 'd1')),
  'search_norm is accent-free and covers keywords');
select pg_temp.check(
  (select count(*) from public.document_events
   where document_id = (select v from ids where k = 'd1') and action = 'created' and actor_id = :B) = 1,
  'create_document logs created');
select pg_temp.check(
  public.can_read_document((select v from ids where k = 'd1')),
  'the author reads the draft');
select pg_temp.check(
  pg_temp.error_of(format(
    'insert into public.documents (org_id, direction, subject) values (%L, %L, %L)',
    '0a000000-0000-0000-0000-0000000000a1', 'outgoing', 'direct')) ~* 'permission denied',
  'no direct insert into documents');
select pg_temp.check(
  pg_temp.error_of($$select public.create_document('incoming', '{"subject": "x"}')$$) ~* 'clerk',
  'only clerks create incoming documents');
select pg_temp.check(
  pg_temp.error_of($$select public.create_document('outgoing', '{}')$$) ~* 'subject',
  'subject is required');
select pg_temp.check(
  pg_temp.error_of(format('select public.create_document(%L, %L)', 'outgoing',
    jsonb_build_object('subject', 'x', 'doc_type_id', '07000000-0000-0000-0000-000000000079'))) ~* 'not found',
  'a doc type of another company is rejected');
select pg_temp.check(
  pg_temp.error_of($$select public.create_document('outgoing', '{"subject": "x", "due_date": "2026-02-30"}')$$) ~* 'date',
  'an invalid due date is rejected');

-- ---------------------------------------------------------------- the draft is private
select pg_temp.login(:C);
select pg_temp.check(
  (select count(*) from public.documents where id = (select v from ids where k = 'd1')) = 0,
  'Carol (other department) cannot read Bob''s draft');
select pg_temp.login(:D);
select pg_temp.check(
  (select count(*) from public.documents where id = (select v from ids where k = 'd1')) = 0
  and not public.can_read_document((select v from ids where k = 'd1')),
  'Dave (other company) cannot read it');
select pg_temp.login(:A);
select pg_temp.check(
  (select count(*) from public.documents where id = (select v from ids where k = 'd1')) = 0,
  'Alice (leader) cannot read an unsubmitted draft');

reset role;
update public.documents set submitted_at = now() where id = (select v from ids where k = 'd1');
set local role authenticated;
select pg_temp.login(:A);
select pg_temp.check(
  (select count(*) from public.documents where id = (select v from ids where k = 'd1')) = 1,
  'Alice reads it once it was submitted');
reset role;
update public.documents set submitted_at = null where id = (select v from ids where k = 'd1');
set local role authenticated;

-- ---------------------------------------------------------------- confidential
select pg_temp.login(:B);
insert into ids select 'd2', public.create_document('outgoing',
  '{"subject": "Lương thưởng", "confidentiality": "confidential"}');
reset role;
update public.documents set submitted_at = now() where id = (select v from ids where k = 'd2');
set local role authenticated;
select pg_temp.login(:A);
select pg_temp.check(
  (select count(*) from public.documents where id = (select v from ids where k = 'd2')) = 0,
  'a confidential document is hidden from Alice (admin, leader, clerk)');

-- the clerk who registered a confidential document reads it
insert into ids select 'i0', public.create_document('incoming',
  '{"subject": "Thanh tra", "confidentiality": "confidential", "notation": "5/TTr"}');
select pg_temp.check(
  (select notation from public.documents where id = (select v from ids where k = 'i0')) = '5/TTr',
  'notation is kept for incoming documents');
reset role;
update public.documents set created_by = null where id = (select v from ids where k = 'i0');
set local role authenticated;
select pg_temp.check(
  not public.can_read_document((select v from ids where k = 'i0')),
  'confidential incoming: not readable without being a participant');
reset role;
insert into public.document_events (org_id, document_id, actor_id, action)
values (:ORG, (select v from ids where k = 'i0'), :A, 'registered');
set local role authenticated;
select pg_temp.check(
  public.can_read_document((select v from ids where k = 'i0')),
  'confidential incoming: the clerk who registered it reads it');

-- ---------------------------------------------------------------- attachments
select pg_temp.login(:B);
insert into ids select 'd3', public.create_document('internal', '{"subject": "Thông báo nội bộ"}');
insert into ids select 'folder_b', public.ensure_document_folder();
select pg_temp.check(
  public.ensure_document_folder() = (select v from ids where k = 'folder_b')
  and (select name = 'Documents' and purpose = 'documents' and parent_id is null and owner_id = :B
       from public.folders where id = (select v from ids where k = 'folder_b')),
  'ensure_document_folder creates one Documents folder at root and reuses it');

select public.register_file(:F1, (select v from ids where k = 'folder_b'),
  'plan.pdf', 'plan.pdf', 'pdf', 'application/pdf', 10, :F1PATH);
select public.register_file(:F2, (select v from ids where k = 'folder_b'),
  'draft.docx', 'draft.docx', 'docx', 'application/octet-stream', 12, :F2PATH);
select public.attach_document_file((select v from ids where k = 'd3'), :F1, 'main');
select public.attach_document_file((select v from ids where k = 'd3'), :F2, 'main');
select pg_temp.check(
  (select kind from public.document_files where file_id = :F1) = 'attachment'
  and (select kind from public.document_files where file_id = :F2) = 'main',
  'one main file per document: the old main becomes an attachment');
select pg_temp.check(
  (select count(*) from public.document_events
   where document_id = (select v from ids where k = 'd3') and action = 'file_attached') = 2,
  'attach_document_file logs file_attached');

select pg_temp.login(:C);
select pg_temp.check(
  not public.has_file_access(:F1, 'viewer'),
  'Carol has no access to the attachment yet');
select pg_temp.check(
  pg_temp.error_of(format('select public.attach_document_file(%L, %L)',
    (select v from ids where k = 'd3'), 'f1000000-0000-0000-0000-0000000000f1')) ~* 'not found',
  'Carol cannot attach to a document she cannot read');
insert into ids select 'folder_c', public.ensure_document_folder();
select pg_temp.check(
  (select name from public.folders where id = (select v from ids where k = 'folder_c')) = 'Documents (office)',
  'ensure_document_folder avoids a root name that is already taken');

reset role;
insert into public.document_assignments (document_id, assignee_department_id, role, assigned_by)
values ((select v from ids where k = 'd3'), :KT, 'info', :A);
set local role authenticated;
select pg_temp.login(:C);
select pg_temp.check(
  (select count(*) from public.documents where id = (select v from ids where k = 'd3')) = 1,
  'an info assignment to Carol''s department lets Carol read it');
select pg_temp.check(
  public.has_file_access(:F1, 'viewer') and not public.has_file_access(:F1, 'editor'),
  'Carol views the attachment through the document, without edit rights');
select pg_temp.check(
  (select count(*) from public.files where id = :F1) = 1
  and (select count(*) from public.document_files where document_id = (select v from ids where k = 'd3')) = 2,
  'files and document_files are visible through RLS');
select pg_temp.check(
  not public.can_edit_document((select v from ids where k = 'd3')),
  'reading is not editing');

-- ---------------------------------------------------------------- freeze
reset role;
update public.document_files set frozen = true where file_id = :F1;
set local role authenticated;
select pg_temp.login(:B);
select pg_temp.check(
  pg_temp.error_of(format('select public.add_file_version(%L, %L, 11, %L)',
    'f1000000-0000-0000-0000-0000000000f1',
    'bbbbbbbb-0000-0000-0000-00000000000b/f1000000-0000-0000-0000-0000000000f1/v2/plan.pdf',
    'application/pdf')) ~* 'locked',
  'a frozen file gets no new version');
select pg_temp.check(
  pg_temp.error_of($$select public.soft_delete_file('f1000000-0000-0000-0000-0000000000f1')$$) ~* 'locked',
  'a frozen file cannot be trashed');
select pg_temp.check(
  pg_temp.error_of($$select public.rename_file('f1000000-0000-0000-0000-0000000000f1', 'renamed.pdf')$$) ~* 'locked',
  'a frozen file cannot be renamed');
select pg_temp.check(
  pg_temp.error_of($$select public.hard_delete_file('f1000000-0000-0000-0000-0000000000f1')$$) ~* 'locked',
  'a frozen file cannot be deleted');
select pg_temp.check(
  pg_temp.error_of(format('select public.detach_document_file(%L, %L)',
    (select v from ids where k = 'd3'), 'f1000000-0000-0000-0000-0000000000f1')) ~* 'locked',
  'a frozen file cannot be detached');
reset role;
select pg_temp.check(
  pg_temp.error_of(format(
    'insert into public.file_versions (file_id, version_no, storage_path, uploaded_by) values (%L, 2, %L, %L)',
    'f1000000-0000-0000-0000-0000000000f1',
    'bbbbbbbb-0000-0000-0000-00000000000b/f1000000-0000-0000-0000-0000000000f1/v2/plan.pdf',
    'bbbbbbbb-0000-0000-0000-00000000000b')) ~* 'locked',
  'the freeze also holds for direct inserts into file_versions');
update public.document_files set frozen = false where file_id = :F1;
set local role authenticated;
select pg_temp.login(:B);
select pg_temp.check(
  pg_temp.error_of(format('select public.add_file_version(%L, %L, 11, %L)',
    'f1000000-0000-0000-0000-0000000000f1',
    'bbbbbbbb-0000-0000-0000-00000000000b/f1000000-0000-0000-0000-0000000000f1/v2/plan.pdf',
    'application/pdf')) is null,
  'once unfrozen the file takes a new version');

-- hard delete of a non-frozen attached file removes the link
select public.soft_delete_file(:F2);
select public.hard_delete_file(:F2);
reset role;
select pg_temp.check(
  (select count(*) from public.files where id = :F2) = 0
  and (select count(*) from public.document_files where file_id = :F2) = 0,
  'hard delete of a non-frozen attached file succeeds and removes the link');
set local role authenticated;

-- ---------------------------------------------------------------- notation, dates, deadlines
select pg_temp.login(:B);
select pg_temp.check(public.doc_render_notation('{n}/{type}-{org}', 1, 'QĐ', 'ABC', 'HCNS', 2026) = '01/QĐ-ABC', 'notation: 01/QĐ-ABC');
select pg_temp.check(public.doc_render_notation('{n}/{org}-{dept}', 5, '', 'ABC', 'HCNS', 2026) = '05/ABC-HCNS', 'notation: 05/ABC-HCNS');
select pg_temp.check(public.doc_render_notation('{n}/{org}-{dept}', 5, '', 'ABC', '', 2026) = '05/ABC', 'notation: 05/ABC');
select pg_temp.check(public.doc_render_notation('{n}/{type}-{org}', 123, 'QĐ', 'ABC', '', 2026) = '123/QĐ-ABC', 'notation: 123/QĐ-ABC');
select pg_temp.check(public.doc_render_notation('{n}/{type}-{org}-{dept}', 7, 'TB', 'ABC', '', 2026) = '07/TB-ABC', 'notation: 07/TB-ABC');
select pg_temp.check(public.doc_render_notation('{n}/{yyyy}/{type}', 3, 'HĐ', 'ABC', '', 2026) = '03/2026/HĐ', 'notation: 03/2026/HĐ');
select pg_temp.check(public.doc_render_notation('{n}/{type}-{org}', 2, '', 'ABC', '', 2026) = '02/ABC', 'notation: 02/ABC');

select pg_temp.check(
  public.doc_default_due_days('normal') = 7 and public.doc_default_due_days('khan') = 2
  and public.doc_default_due_days('thuong_khan') = 1 and public.doc_default_due_days('hoa_toc') = 0,
  'default processing days by urgency');
select pg_temp.check(
  public.doc_add_working_days(:ORG, '2026-10-30', 1) = '2026-11-02',
  'Friday + 1 working day is Monday');
reset role;
insert into public.org_holidays (org_id, day, name) values (:ORG, '2026-11-02', 'Company day');
set local role authenticated;
select pg_temp.check(
  public.doc_add_working_days(:ORG, '2026-10-30', 1) = '2026-11-03',
  'working days skip company holidays');
select pg_temp.check(
  public.doc_add_working_days(:ORG, '2026-10-31', 0) = '2026-11-03'
  and public.doc_add_working_days(:ORG, '2026-10-30', 0) = '2026-10-30',
  '0 days: the same day when it is a working day, else the next working day');
select pg_temp.check(
  public.doc_year_for(:ORG, '2026-12-31 17:30+00') = 2027,
  'the year comes from the company time zone, not UTC');
select pg_temp.check(public.org_now_date(:ORG) is not null, 'org_now_date answers');
select pg_temp.login(:D);
select pg_temp.check(
  public.doc_add_working_days(:ORG, '2026-10-30', 1) = '2026-11-02',
  'another company''s holidays are not revealed');

-- ---------------------------------------------------------------- numbering
select pg_temp.login(:B);
select pg_temp.check(
  pg_temp.error_of(format('select public.doc_next_number(%L, null)', '08000000-0000-0000-0000-000000000082')) ~* 'permission denied',
  'Bob cannot call doc_next_number');
select pg_temp.check(
  pg_temp.error_of(format('select public.doc_log(%L, %L, null, null)', (select v from ids where k = 'd1'), 'issued')) ~* 'permission denied',
  'Bob cannot write the audit log');

reset role;
select pg_temp.check(
  public.doc_next_number(:ROUT, :TQD) = 1 and public.doc_next_number(:ROUT, :TTB) = 2
  and public.doc_next_number(:ROUT, null) = 3,
  'doc_next_number returns 1, 2, 3 for one register');
select pg_temp.check(
  public.doc_next_number(:RTYPE, :TQD) = 1 and public.doc_next_number(:RTYPE, :TTB) = 1
  and public.doc_next_number(:RTYPE, :TQD) = 2,
  'scope register_type counts each type separately');
select pg_temp.check(public.doc_next_number(:RFIVE, null) = 5, 'numbering starts at start_number');
update public.doc_registers set closed_at = now() where id = :RFIVE;
select pg_temp.check(
  pg_temp.error_of(format('select public.doc_next_number(%L, null)', '08000000-0000-0000-0000-000000000084')) ~* 'closed',
  'a closed register gives no numbers');

-- notations: incoming ones may repeat, outgoing ones may not
insert into public.documents (org_id, direction, status, subject, register_id, notation) values
  (:ORG, 'incoming', 'registered', 'Công văn 1', :RIN, '12/UBND'),
  (:ORG, 'incoming', 'registered', 'Công văn 1 (bản 2)', :RIN, '12/UBND');
select pg_temp.check(
  (select count(*) from public.documents where register_id = :RIN and notation = '12/UBND') = 2,
  'two incoming documents with the same notation in one register');
insert into public.documents (org_id, direction, status, subject, register_id, notation)
values (:ORG, 'outgoing', 'issued', 'Quyết định 1', :ROUT, '01/QĐ-ABC');
select pg_temp.check(
  pg_temp.error_of(format(
    'insert into public.documents (org_id, direction, status, subject, register_id, notation) values (%L, %L, %L, %L, %L, %L)',
    '0a000000-0000-0000-0000-0000000000a1', 'outgoing', 'issued', 'Quyết định 1 (lặp)',
    '08000000-0000-0000-0000-000000000082', '01/QĐ-ABC')) ~* 'duplicate|unique',
  'two outgoing documents with the same notation in one register are rejected');
select pg_temp.check(
  pg_temp.error_of(format(
    'insert into public.documents (org_id, direction, status, subject) values (%L, %L, %L, %L)',
    '0a000000-0000-0000-0000-0000000000a1', 'outgoing', 'registered', 'x')) is not null,
  'status must fit the direction');
select pg_temp.check(
  pg_temp.error_of(format(
    'insert into public.document_events (org_id, document_id, action) values (%L, %L, %L)',
    '0a000000-0000-0000-0000-0000000000a1', (select v from ids where k = 'd1'), 'hacked')) is not null,
  'document_events.action is limited to the canonical list');

-- Alice's incoming document that Bob cannot read
set local role authenticated;
select pg_temp.login(:A);
insert into ids select 'i1', public.create_document('incoming',
  '{"subject": "Công văn của Sở", "notation": "45/SXD", "issued_date": "2026-10-20", "arrival_date": "2026-10-29"}');

-- ---------------------------------------------------------------- profile updates
select pg_temp.login(:C);
select pg_temp.check(
  pg_temp.error_of(format('select public.update_document_profile(%L, %L)',
    (select v from ids where k = 'd1'), '{"subject": "hijack"}')) ~* 'not found',
  'update_document_profile by Carol fails');

select pg_temp.login(:B);
select public.update_document_profile((select v from ids where k = 'd1'),
  '{"subject": "Kế hoạch 2027 (sửa)", "urgency": "khan", "ignored": true}');
select pg_temp.check(
  (select data -> 'changed' -> 'subject' = '["Kế hoạch năm 2027", "Kế hoạch 2027 (sửa)"]'::jsonb
     and data -> 'changed' -> 'urgency' = '["normal", "khan"]'::jsonb
     and not (data -> 'changed' ? 'ignored')
   from public.document_events
   where document_id = (select v from ids where k = 'd1') and action = 'profile_updated'),
  'profile_updated logs each changed key with old and new values');
select public.update_document_profile((select v from ids where k = 'd1'), '{"urgency": "khan"}');
select pg_temp.check(
  (select count(*) from public.document_events
   where document_id = (select v from ids where k = 'd1') and action = 'profile_updated') = 1,
  'an update without changes logs nothing');
select pg_temp.check(
  pg_temp.error_of(format('select public.update_document_profile(%L, %L)',
    (select v from ids where k = 'd1'), jsonb_build_object('reply_to_id', (select v from ids where k = 'i1')))) ~* 'not found',
  'reply_to must be a document the caller can read');
select pg_temp.check(
  pg_temp.error_of(format('select public.update_document_profile(%L, %L)',
    (select v from ids where k = 'd1'), '{"keywords": ["1","2","3","4","5","6","7","8","9","10","11"]}')) ~* '10 keywords',
  'at most 10 keywords');

-- ---------------------------------------------------------------- get_document
reset role;
update public.documents set reply_to_id = (select v from ids where k = 'i1')
where id = (select v from ids where k = 'd1');
set local role authenticated;
select pg_temp.login(:B);
select public.get_document((select v from ids where k = 'd1'));
select pg_temp.check(
  (select (j -> 'me' ->> 'can_edit')::boolean
     and j -> 'me' ->> 'user_id' = :B
     and j -> 'me' -> 'roles' = '["staff"]'::jsonb
     and j -> 'me' ->> 'department_id' = :HC
     and j -> 'document' ->> 'type_abbreviation' = 'QĐ'
     and j -> 'document' ->> 'created_by_name' = 'Bob Trần'
     and j -> 'document' ->> 'drafting_department_code' = 'HCNS'
     and not (j -> 'document' ? 'search_norm')
     and jsonb_array_length(j -> 'events') >= 2
   from (select public.get_document((select v from ids where k = 'd1')) as j) s),
  'get_document: me.can_edit is true for Bob on his draft, with display names');
select pg_temp.check(
  (select j -> 'related' -> 0 ->> 'relation' = 'reply_to'
     and (j -> 'related' -> 0 ->> 'readable')::boolean = false
     and j -> 'related' -> 0 -> 'subject' = 'null'::jsonb
     and j -> 'related' -> 0 -> 'notation' = 'null'::jsonb
     and j -> 'related' -> 0 ->> 'id' = (select v::text from ids where k = 'i1')
   from (select public.get_document((select v from ids where k = 'd1')) as j) s),
  'a related document Bob cannot read comes back unreadable without subject');
select pg_temp.check(
  (select count(*) from public.document_access_log
   where document_id = (select v from ids where k = 'd1') and user_id = :B and action = 'view') = 1,
  'get_document logs one view per hour');
select public.log_document_access((select v from ids where k = 'd1'), 'download');
select pg_temp.check(
  (select count(*) from public.document_access_log
   where document_id = (select v from ids where k = 'd1') and action = 'download') = 1,
  'log_document_access records a download');
select pg_temp.check(
  pg_temp.error_of(format('select public.log_document_access(%L, %L)', (select v from ids where k = 'd1'), 'edit')) is not null,
  'log_document_access accepts download and print only');

select pg_temp.login(:A);
select pg_temp.check(
  (select j -> 'related' -> 0 ->> 'relation' = 'replied_by'
     and (j -> 'related' -> 0 ->> 'readable')::boolean = false
     and j -> 'related' -> 0 -> 'subject' = 'null'::jsonb
   from (select public.get_document((select v from ids where k = 'i1')) as j) s),
  'reverse links to a private draft are redacted too');
select pg_temp.check(
  pg_temp.error_of(format('select public.get_document(%L)', (select v from ids where k = 'd1'))) ~* 'not found',
  'get_document refuses a document the caller cannot read');

-- ---------------------------------------------------------------- sharing and opinions
select pg_temp.login(:B);
select pg_temp.check(
  pg_temp.error_of(format('select public.grant_document_access(%L, %L, %L)',
    (select v from ids where k = 'd1'), 'dddddddd-0000-0000-0000-00000000000d', 'read')) ~* 'active members',
  'documents are shared only inside the company');
select public.grant_document_access((select v from ids where k = 'd1'), :C, 'read');

select pg_temp.login(:C);
select pg_temp.check(
  (select count(*) from public.documents where id = (select v from ids where k = 'd1')) = 1
  and not public.can_edit_document((select v from ids where k = 'd1')),
  'grant_document_access (read) lets Carol read the draft, not edit it');
select pg_temp.check(
  (select count(*) from public.notifications where user_id = :C and kind = 'document.shared'
     and link = '/documents/' || (select v from ids where k = 'd1')) = 1,
  'the grantee is notified');
select pg_temp.check(
  pg_temp.error_of(format('select public.update_document_profile(%L, %L)',
    (select v from ids where k = 'd1'), '{"subject": "hijack"}')) ~* 'cannot edit',
  'a reader cannot update the profile');
select pg_temp.check(
  pg_temp.error_of(format('select public.grant_document_access(%L, %L, %L)',
    (select v from ids where k = 'd1'), 'aaaaaaaa-0000-0000-0000-00000000000a', 'read')) ~* 'only the author',
  'only the author or an admin shares a document');
select public.add_document_opinion((select v from ids where k = 'd1'), 'comment', '  Đồng ý với kế hoạch  ');
select pg_temp.check(
  (select body from public.document_opinions where document_id = (select v from ids where k = 'd1')) = 'Đồng ý với kế hoạch',
  'add_document_opinion stores the trimmed body');
select pg_temp.check(
  pg_temp.error_of(format('select public.add_document_opinion(%L, %L, %L)',
    (select v from ids where k = 'd1'), 'instruction', 'Làm ngay')) ~* 'instructions',
  'only leaders (or the assigner) give instructions');

select pg_temp.login(:B);
select pg_temp.check(
  (select count(*) from public.notifications where user_id = :B and kind = 'document.opinion') = 1,
  'the author is notified of a new opinion');
select public.revoke_document_access((select v from ids where k = 'd1'), :C);
select pg_temp.check(
  (select count(*) from public.document_events
   where document_id = (select v from ids where k = 'd1') and action in ('access_granted', 'access_revoked')) = 2,
  'sharing changes are logged');
select public.grant_document_access((select v from ids where k = 'd1'), :C, 'edit');
select pg_temp.login(:C);
select pg_temp.check(
  public.can_edit_document((select v from ids where k = 'd1')),
  'an edit grant lets Carol edit the draft');
select pg_temp.login(:B);
select public.revoke_document_access((select v from ids where k = 'd1'), :C);
select pg_temp.login(:C);
select pg_temp.check(
  (select count(*) from public.documents where id = (select v from ids where k = 'd1')) = 0,
  'revoke_document_access takes the access back');

-- ---------------------------------------------------------------- delete
select pg_temp.check(
  pg_temp.error_of(format('select public.delete_document(%L)', (select v from ids where k = 'd3'))) ~* 'only the author',
  'a reader cannot delete the draft');
select pg_temp.login(:B);
select public.delete_document((select v from ids where k = 'd3'));
select pg_temp.check(
  (select count(*) from public.documents where id = (select v from ids where k = 'd3')) = 0
  and (select count(*) from public.files where id = :F1 and deleted_at is null) = 1,
  'delete_document removes the draft and keeps its files');

reset role;
select pg_temp.check(
  (select count(*) from public.document_files where file_id = :F1) = 0,
  'its file links are gone');

rollback;
