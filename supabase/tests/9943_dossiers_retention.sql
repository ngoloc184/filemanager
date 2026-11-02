-- Dossiers (hồ sơ) and retention: catalog seed, access, filing, close /
-- transfer, legal hold and the trash purge skipping a held file.
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
\set TCV '''07000000-0000-0000-0000-000000000071'''
\set DOC1 '''0c000000-0000-0000-0000-0000000000c1'''
\set DOC2 '''0c000000-0000-0000-0000-0000000000c2'''
\set DOC3 '''0c000000-0000-0000-0000-0000000000c3'''
\set DOC4 '''0c000000-0000-0000-0000-0000000000c4'''
\set FOLD '''f0000000-0000-0000-0000-0000000000b1'''
\set F1 '''f1000000-0000-0000-0000-0000000000f1'''
\set F2 '''f1000000-0000-0000-0000-0000000000f2'''
\set V1 '''f2000000-0000-0000-0000-0000000000a1'''
\set V2 '''f2000000-0000-0000-0000-0000000000a2'''

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
insert into public.doc_types (id, org_id, name, abbreviation, is_cong_van) values
  (:TCV, :ORG, 'Công văn', 'CV', true);

-- DOC1 incoming completed and DOC4 outgoing issued (both Bob's), DOC2 Bob's
-- outgoing draft with two attachments, DOC3 Carol's private draft.
insert into public.documents (id, org_id, direction, status, subject, created_by, doc_type_id,
                              notation, issued_date, arrival_date, completed_at) values
  (:DOC1, :ORG, 'incoming', 'completed', 'Công văn đề nghị phối hợp', :B, :TCV,
   '15/CV-XYZ', '2026-03-02', '2026-03-04', now());
insert into public.documents (id, org_id, direction, status, subject, created_by, notation,
                              issued_date, issued_at) values
  (:DOC4, :ORG, 'outgoing', 'issued', 'Thông báo nghỉ lễ', :B, '01/TB-ABC', '2026-01-10', now());
insert into public.documents (id, org_id, direction, status, subject, created_by) values
  (:DOC2, :ORG, 'outgoing', 'draft', 'Kế hoạch tuyển dụng', :B),
  (:DOC3, :ORG, 'outgoing', 'draft', 'Carol private draft', :C);

insert into public.folders (id, owner_id, name) values (:FOLD, :B, 'Bob docs');
insert into public.files (id, folder_id, owner_id, name, original_name) values
  (:F1, :FOLD, :B, 'plan.pdf', 'plan.pdf'),
  (:F2, :FOLD, :B, 'old.pdf', 'old.pdf');
insert into public.document_files (document_id, file_id, kind, frozen) values
  (:DOC2, :F1, 'main', false),
  (:DOC2, :F2, 'attachment', false);
-- F1 has two versions (v2 current)
insert into public.file_versions (id, file_id, version_no, storage_path, uploaded_by) values
  (:V1, :F1, 1, 'bbbbbbbb-0000-0000-0000-00000000000b/f1000000-0000-0000-0000-0000000000f1/v1/plan.pdf', :B),
  (:V2, :F1, 2, 'bbbbbbbb-0000-0000-0000-00000000000b/f1000000-0000-0000-0000-0000000000f1/v2/plan.pdf', :B);
update public.files set current_version_id = :V2 where id = :F1;
-- F2 went to the trash long ago (before any hold)
update public.files set deleted_at = now() - interval '40 days' where id = :F2;

grant execute on function pg_temp.check(boolean, text) to authenticated, anon, service_role;
grant execute on function pg_temp.login(uuid) to authenticated, anon, service_role;
grant execute on function pg_temp.error_of(text) to authenticated, anon, service_role;

create temp table ids (k text primary key, v uuid);
grant all on ids to authenticated, anon, service_role;
insert into ids select 'xret', id from public.retention_codes where org_id = :ORG2 and code = 'VV';

-- ---------------------------------------------------------------- seed and privileges
select pg_temp.check(
  (select count(*) from public.retention_codes where org_id = :ORG) = 5
  and (select count(*) from public.retention_codes where org_id = :ORG2) = 5
  and (select years is null and label = 'Vĩnh viễn (permanent)'
       from public.retention_codes where org_id = :ORG and code = 'VV')
  and (select array_agg(code order by sort_order) from public.retention_codes where org_id = :ORG)
      = array['VV', '70', '20', '10', '5'],
  'a new company gets the 5 default retention codes');
select pg_temp.check(
  exists (
    select 1 from pg_trigger
    where tgname = 'organizations_seed_retention' and tgrelid = 'public.organizations'::regclass
  ),
  'the seed trigger is organizations_seed_retention');
select pg_temp.check(
  not has_function_privilege('authenticated', 'public.seed_retention_defaults(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.document_on_legal_hold(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.dossier_for_update(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.dossiers_legal_hold_guard()', 'execute')
  and has_function_privilege('service_role', 'public.seed_retention_defaults(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.can_read_dossier(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.create_dossier(int, text, text, uuid, uuid, text)', 'execute'),
  'internal helpers are service_role only; RPCs and can_read_dossier are for signed-in users');
select pg_temp.check(
  not has_function_privilege('anon', 'public.create_dossier(int, text, text, uuid, uuid, text)', 'execute')
  and not has_function_privilege('anon', 'public.can_read_dossier(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.list_dossiers(int, text, text)', 'execute')
  and not has_function_privilege('anon', 'public.get_dossier(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.set_dossier_legal_hold(uuid, boolean)', 'execute')
  and not has_function_privilege('anon', 'public.upsert_retention_code(uuid, text, text, int, int)', 'execute'),
  'anon cannot execute any dossier function');

-- ---------------------------------------------------------------- anon
set local role anon;
set local request.jwt.claim.sub = '';

select pg_temp.check(
  pg_temp.error_of($$select public.create_dossier(2026, '01.X', 'x', null, null)$$) ~* 'permission denied',
  'anon cannot call create_dossier');
select pg_temp.check(
  pg_temp.error_of($$select count(*) from public.dossiers$$) ~* 'permission denied'
  and pg_temp.error_of($$select count(*) from public.retention_codes$$) ~* 'permission denied',
  'anon cannot read dossiers or retention codes');

reset role;
set local role authenticated;

-- ---------------------------------------------------------------- Bob (staff) files documents
select pg_temp.login(:B);

insert into ids select 'ten', id from public.retention_codes where code = '10';
select pg_temp.check(
  (select count(*) from public.retention_codes) = 5,
  'members see their own company''s retention codes only');

insert into ids select 'd1', (public.create_dossier(2026, ' 01.HCNS ', ' Hồ sơ tuyển dụng 2026 ', null,
  (select v from ids where k = 'ten'))).id;
select pg_temp.check(
  (select code = '01.HCNS' and title = 'Hồ sơ tuyển dụng 2026' and department_id = :HC
     and owner_id = :B and status = 'open' and not legal_hold and org_id = :ORG
     and start_date = public.org_now_date(:ORG)
   from public.dossiers where id = (select v from ids where k = 'd1')),
  'create_dossier: my company and department, I own it, it starts today');
select pg_temp.check(
  pg_temp.error_of($$select public.create_dossier(2026, '01.HCNS', 'Again', null, null)$$) ~* 'already exists',
  'a dossier code is unique per company and year');
select pg_temp.check(
  pg_temp.error_of(format('select public.create_dossier(2026, %L, %L, null, %L)', '09.HCNS', 'x',
    (select v from ids where k = 'xret'))) ~* 'retention code not found',
  'a retention code of another company is rejected');
select pg_temp.check(
  pg_temp.error_of(format('select public.create_dossier(2026, %L, %L, %L, null)', '09.HCNS', 'x',
    '0d000000-0000-0000-0000-0000000000d3')) ~* 'department not found',
  'a department of another company is rejected');
select pg_temp.check(
  pg_temp.error_of($$select public.create_dossier(2026, '', 'x', null, null)$$) ~* 'code'
  and pg_temp.error_of($$select public.create_dossier(2026, '09', '   ', null, null)$$) ~* 'title',
  'code and title are required');
select pg_temp.check(
  pg_temp.error_of($$insert into public.dossiers (org_id, year, code, title) values
    ('0a000000-0000-0000-0000-0000000000a1', 2026, 'x', 'x')$$) ~* 'permission denied',
  'no direct insert into dossiers');

select pg_temp.check(
  public.add_document_to_dossier((select v from ids where k = 'd1'), :DOC1) = 1
  and public.add_document_to_dossier((select v from ids where k = 'd1'), :DOC4) = 2
  and public.add_document_to_dossier((select v from ids where k = 'd1'), :DOC2) = 3,
  'adding readable documents gives ordinals 1, 2, 3');
select pg_temp.check(
  pg_temp.error_of(format('select public.add_document_to_dossier(%L, %L)',
    (select v from ids where k = 'd1'), '0c000000-0000-0000-0000-0000000000c3')) ~* 'not found',
  'adding a document I cannot read fails');
select pg_temp.check(
  pg_temp.error_of(format('select public.add_document_to_dossier(%L, %L)',
    (select v from ids where k = 'd1'), '0c000000-0000-0000-0000-0000000000c1')) ~* 'already',
  'a document is added to the same dossier once');
select pg_temp.check(
  (select count(*) from public.document_events
   where document_id = :DOC1 and action = 'filed' and actor_id = :B
     and data ->> 'dossier_id' = (select v from ids where k = 'd1')::text
     and data ->> 'code' = '01.HCNS') = 1,
  'filing logs a filed event with the dossier id and code');

select public.remove_document_from_dossier((select v from ids where k = 'd1'), :DOC4);
select pg_temp.check(
  (select array_agg(document_id order by ordinal) from public.dossier_documents
   where dossier_id = (select v from ids where k = 'd1')) = array[:DOC1, :DOC2]::uuid[]
  and (select array_agg(ordinal order by ordinal) from public.dossier_documents
   where dossier_id = (select v from ids where k = 'd1')) = array[1, 2]
  and exists (select 1 from public.document_events where document_id = :DOC4 and action = 'unfiled'),
  'removing renumbers the ordinals and logs unfiled');
select pg_temp.check(
  public.add_document_to_dossier((select v from ids where k = 'd1'), :DOC4) = 3,
  'a re-added document goes last');

select pg_temp.check(
  (select count(*) from public.list_dossiers(null, null, 'tuyen dung')) = 1
  and (select owner_name = 'Bob Trần' and doc_count = 3 and department_name = 'Hành chính nhân sự'
         and retention_label = '10 years'
       from public.list_dossiers(2026, 'open', null)
       where id = (select v from ids where k = 'd1'))
  and (select count(*) from public.list_dossiers(2025, null, null)) = 0,
  'list_dossiers filters by year, status and accent-free text');

select pg_temp.check(
  (select (j -> 'dossier' ->> 'code') = '01.HCNS'
     and (j -> 'dossier' ->> 'can_manage')::boolean
     and jsonb_array_length(j -> 'documents') = 3
     and (j -> 'documents' -> 0 ->> 'subject') = 'Công văn đề nghị phối hợp'
     and (j -> 'documents' -> 0 ->> 'type_name') = 'Công văn'
     and (j -> 'documents' -> 0 ->> 'readable')::boolean
   from (select public.get_dossier((select v from ids where k = 'd1')) as j) s),
  'get_dossier returns the dossier and its documents in order');

-- ---------------------------------------------------------------- the same document in two dossiers
select pg_temp.login(:A);
insert into ids select 'd2', (public.create_dossier(2026, '02.HCNS', 'Hồ sơ phối hợp', null, null)).id;
select pg_temp.check(
  public.add_document_to_dossier((select v from ids where k = 'd2'), :DOC1) = 1,
  'a document already in a dossier can be added to another one');
select pg_temp.check(
  (select count(*) from public.document_dossiers(:DOC1)) = 2,
  'the same document is now in two dossiers');

select pg_temp.login(:B);
select pg_temp.check(
  pg_temp.error_of(format('select public.add_document_to_dossier(%L, %L)',
    (select v from ids where k = 'd2'), '0c000000-0000-0000-0000-0000000000c4')) ~* 'only the owner',
  'a reader who does not own the dossier cannot add to it');

-- ---------------------------------------------------------------- who can see what
select pg_temp.login(:C);
select pg_temp.check(
  (select count(*) from public.dossiers) = 0
  and not public.can_read_dossier((select v from ids where k = 'd1'))
  and pg_temp.error_of(format('select public.get_dossier(%L)', (select v from ids where k = 'd1'))) ~* 'not found',
  'Carol (another department, staff) cannot see HCNS dossiers');
insert into ids select 'dk', (public.create_dossier(2026, '01.KT', 'Hồ sơ kế toán', null, null)).id;
select public.add_document_to_dossier((select v from ids where k = 'dk'), :DOC3);

select pg_temp.login(:A);
select pg_temp.check(
  (select count(*) from public.dossiers) = 3
  and (select (j -> 'documents' -> 0) = jsonb_build_object(
                'document_id', '0c000000-0000-0000-0000-0000000000c3', 'ordinal', 1, 'readable', false)
       from (select public.get_dossier((select v from ids where k = 'dk')) as j) s)
  and (select count(*) from public.dossier_documents where dossier_id = (select v from ids where k = 'dk')) = 0,
  'the admin sees every dossier; a document she cannot read shows only its id and ordinal');

select pg_temp.login(:D);
select pg_temp.check(
  (select count(*) from public.dossiers) = 0
  and (select count(*) from public.list_dossiers()) = 0
  and (select count(*) from public.retention_codes where org_id = :ORG) = 0
  and pg_temp.error_of(format('select public.get_dossier(%L)', (select v from ids where k = 'd1'))) ~* 'not found'
  and pg_temp.error_of(format('select public.close_dossier(%L)', (select v from ids where k = 'd1'))) ~* 'not found',
  'another company cannot see or touch the dossier');

-- ---------------------------------------------------------------- retention catalog
select pg_temp.login(:B);
select pg_temp.check(
  pg_temp.error_of($$select public.upsert_retention_code(null, 'X15', '15 years', 15, 60)$$) ~* 'admin',
  'only admins edit the retention catalog');
select pg_temp.login(:A);
select pg_temp.check(
  (select code = 'X15' and years = 15 and org_id = :ORG
   from public.upsert_retention_code(null, 'x15', ' 15 years ', 15, 60)),
  'an admin adds a retention code (code upper-cased)');
select pg_temp.check(
  pg_temp.error_of($$select public.upsert_retention_code(null, 'A-B', 'x', 5, 0)$$) ~* 'code'
  and pg_temp.error_of($$select public.upsert_retention_code(null, 'Y', 'x', 101, 0)$$) ~* 'years'
  and pg_temp.error_of($$select public.upsert_retention_code(null, 'VV', 'x', null, 0)$$) ~* 'already exists',
  'invalid codes, periods and duplicates are rejected');
select pg_temp.login(:D);
select pg_temp.check(
  pg_temp.error_of(format('select public.upsert_retention_code(%L, %L, %L, null, 0)',
    (select v from ids where k = 'ten'), 'Z', 'z')) ~* 'not found',
  'another company cannot edit our retention codes');

-- ---------------------------------------------------------------- update and close
select pg_temp.login(:B);
insert into ids select 'dcap', (public.create_dossier(2026, '03.HCNS', 'Công trình nhà kho', null, null)).id;
select pg_temp.check(
  (select is_capital_construction and title = 'Công trình nhà kho (XDCB)' and description = 'Kho A'
   from public.update_dossier((select v from ids where k = 'dcap'), 'Công trình nhà kho (XDCB)',
     null, :HC, ' Kho A ', true)),
  'the owner updates an open dossier');
select pg_temp.check(
  (select transfer_due_date = (public.org_now_date(:ORG) + interval '3 months')::date
     and end_date = public.org_now_date(:ORG) and status = 'closed' and closed_at is not null
   from public.close_dossier((select v from ids where k = 'dcap'))),
  'closing a capital construction dossier: transfer due = end + 3 months');

insert into ids select 'dleap', (public.create_dossier(2024, '04.HCNS', 'Hồ sơ năm nhuận', null, null)).id;
select pg_temp.check(
  (select end_date = '2024-02-29' and transfer_due_date = '2025-02-28' and start_date = '2024-02-29'
   from public.close_dossier((select v from ids where k = 'dleap'), '2024-02-29')),
  'closing on 29 Feb: transfer due = end + 1 year (28 Feb); the start moves back to the end');

select pg_temp.check(
  (select transfer_due_date = (public.org_now_date(:ORG) + interval '1 year')::date
   from public.close_dossier((select v from ids where k = 'd1'))),
  'closing with no end date ends today; transfer due = end + 1 year');
select pg_temp.check(
  pg_temp.error_of(format('select public.add_document_to_dossier(%L, %L)',
    (select v from ids where k = 'd1'), '0c000000-0000-0000-0000-0000000000c2')) ~* 'open'
  and pg_temp.error_of(format('select public.update_dossier(%L, %L, null, null, null, null)',
    (select v from ids where k = 'd1'), 'x')) ~* 'open'
  and pg_temp.error_of(format('select public.close_dossier(%L)', (select v from ids where k = 'd1'))) ~* 'open',
  'a closed dossier cannot be changed or closed again');
select pg_temp.check(
  pg_temp.error_of(format('select public.transfer_dossier(%L)', (select v from ids where k = 'd1'))) ~* 'clerk'
  and pg_temp.error_of(format('select public.reopen_dossier(%L)', (select v from ids where k = 'd1'))) ~* 'admin',
  'staff cannot transfer or reopen');

-- ---------------------------------------------------------------- due for transfer
select pg_temp.login(:A);
insert into ids select 'ddue', (public.create_dossier(2025, '05.HCNS', 'Hồ sơ sắp nộp lưu', null, null)).id;
select public.close_dossier((select v from ids where k = 'ddue'),
  ((public.org_now_date(:ORG) + 20) - interval '1 year')::date);
select pg_temp.check(
  (select transfer_due_date between public.org_now_date(:ORG) + 19 and public.org_now_date(:ORG) + 20
   from public.dossiers where id = (select v from ids where k = 'ddue'))
  and exists (select 1 from public.dossiers_due_for_transfer(30) where id = (select v from ids where k = 'ddue'))
  and not exists (select 1 from public.dossiers_due_for_transfer(10) where id = (select v from ids where k = 'ddue'))
  and not exists (select 1 from public.dossiers_due_for_transfer(30) where id = (select v from ids where k = 'd1'))
  and not exists (select 1 from public.dossiers_due_for_transfer(30) where id = (select v from ids where k = 'dcap'))
  and not exists (select 1 from public.dossiers_due_for_transfer(30) where status <> 'closed'),
  'dossiers_due_for_transfer finds the one due in 20 days, not the later ones');
select pg_temp.login(:B);
select pg_temp.check(
  pg_temp.error_of('select * from public.dossiers_due_for_transfer()') ~* 'only clerks',
  'staff cannot list dossiers due for transfer');

-- ---------------------------------------------------------------- reopen and transfer
select pg_temp.login(:A);
select pg_temp.check(
  (select status = 'open' and end_date is null and transfer_due_date is null and closed_at is null
   from public.reopen_dossier((select v from ids where k = 'dleap'))),
  'an admin reopens a closed dossier');
select pg_temp.check(
  pg_temp.error_of(format('select public.transfer_dossier(%L)', (select v from ids where k = 'dleap'))) ~* 'close',
  'an open dossier cannot be transferred');
select pg_temp.check(
  (select status = 'transferred' and transferred_at is not null
   from public.transfer_dossier((select v from ids where k = 'd1'))),
  'the clerk transfers a closed dossier to the archive');
select pg_temp.check(
  (select status = 'archived' and archived_at is not null from public.documents where id = :DOC1)
  and (select status = 'archived' from public.documents where id = :DOC4)
  and exists (
    select 1 from public.document_events
    where document_id = :DOC1 and action = 'archived'
      and from_status = 'completed' and to_status = 'archived' and actor_id = :A
  ),
  'transfer archives the completed and issued documents and logs archived');
select pg_temp.login(:B);
select pg_temp.check(
  (select status = 'draft' and archived_at is null from public.documents where id = :DOC2),
  'a draft in the transferred dossier keeps its status');
select pg_temp.login(:A);
select pg_temp.check(
  pg_temp.error_of(format('select public.reopen_dossier(%L)', (select v from ids where k = 'd1'))) ~* 'closed',
  'a transferred dossier cannot be reopened');

-- ---------------------------------------------------------------- legal hold
select pg_temp.login(:B);
insert into ids select 'dhold', (public.create_dossier(2026, '06.HCNS', 'Hồ sơ tranh chấp', null, null)).id;
select public.add_document_to_dossier((select v from ids where k = 'dhold'), :DOC2);
select pg_temp.check(
  pg_temp.error_of(format('select public.set_dossier_legal_hold(%L, true)', (select v from ids where k = 'dhold'))) ~* 'admin',
  'only admins set a legal hold');

select pg_temp.login(:A);
select pg_temp.check(
  (select legal_hold from public.set_dossier_legal_hold((select v from ids where k = 'dhold'), true)),
  'an admin puts the dossier on legal hold');

select pg_temp.login(:B);
select pg_temp.check(
  pg_temp.error_of(format('select public.remove_document_from_dossier(%L, %L)',
    (select v from ids where k = 'dhold'), '0c000000-0000-0000-0000-0000000000c2')) ~* 'legal hold',
  'a legal hold blocks remove_document_from_dossier');
select pg_temp.check(
  pg_temp.error_of($$select public.delete_document('0c000000-0000-0000-0000-0000000000c2')$$) ~* 'legal hold'
  and exists (select 1 from public.documents where id = :DOC2),
  'a legal hold blocks deleting the document');
select pg_temp.check(
  pg_temp.error_of($$select public.soft_delete_file('f1000000-0000-0000-0000-0000000000f1')$$) ~* 'legal hold'
  and (select deleted_at is null from public.files where id = :F1),
  'a legal hold blocks moving its file to the trash');
select pg_temp.check(
  pg_temp.error_of($$select public.detach_document_file('0c000000-0000-0000-0000-0000000000c2',
    'f1000000-0000-0000-0000-0000000000f1')$$) ~* 'legal hold'
  and exists (select 1 from public.document_files where document_id = :DOC2 and file_id = :F1),
  'a legal hold blocks detaching its file (which could then be trashed)');
select pg_temp.check(
  pg_temp.error_of($$select public.delete_file_version('f2000000-0000-0000-0000-0000000000a1')$$) ~* 'legal hold'
  and exists (select 1 from public.file_versions where id = :V1),
  'a legal hold blocks deleting an old version of its file');
reset role;
select pg_temp.check(
  pg_temp.error_of(format(
    'insert into public.file_versions (file_id, version_no, storage_path, uploaded_by) values (%L, 3, %L, %L)',
    'f1000000-0000-0000-0000-0000000000f1',
    'bbbbbbbb-0000-0000-0000-00000000000b/f1000000-0000-0000-0000-0000000000f1/v3/plan.pdf',
    'bbbbbbbb-0000-0000-0000-00000000000b')) ~* 'legal hold'
  and pg_temp.error_of($$delete from public.files where id = 'f1000000-0000-0000-0000-0000000000f1'$$) ~* 'legal hold'
  and pg_temp.error_of($$delete from public.documents where id = '0c000000-0000-0000-0000-0000000000c2'$$) ~* 'legal hold',
  'the hold also holds for direct new versions and deletes');

-- the trash purge skips the held file without failing
set local role service_role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
create temporary table purged as select * from public.purge_old_trash(30, 500);
select pg_temp.check(
  exists (select 1 from public.files where id = :F2)
  and not exists (select 1 from purged where file_id = :F2),
  'purge_old_trash skips a trashed file on legal hold');
reset role;

-- lifting the hold makes the document removable again
set local role authenticated;
select pg_temp.login(:A);
select public.set_dossier_legal_hold((select v from ids where k = 'dhold'), false);
select pg_temp.login(:B);
select public.remove_document_from_dossier((select v from ids where k = 'dhold'), :DOC2);
select pg_temp.check(
  pg_temp.error_of($$select public.delete_file_version('f2000000-0000-0000-0000-0000000000a1')$$) is null
  and pg_temp.error_of($$select public.soft_delete_file('f1000000-0000-0000-0000-0000000000f1')$$) is null,
  'after the hold is lifted old versions can be deleted and the file trashed again');
reset role;

set local role service_role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select count(*) from public.purge_old_trash(30, 500);
select pg_temp.check(
  not exists (select 1 from public.files where id = :F2),
  'without the hold the purge removes that file');
reset role;

rollback;
