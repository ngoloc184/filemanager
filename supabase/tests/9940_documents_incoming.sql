-- Incoming documents workflow: register (arrival numbers, duplicate warning),
-- present, assign lead/support/info, sub-assign, report, complete, return,
-- cancel, reopen, outsider isolation and the event timeline.
-- Run with scripts/test-db.sh (plain PostgreSQL + supabase/tests stubs).
-- Everything runs in one transaction that is rolled back at the end.

\set ON_ERROR_STOP 1
\o /dev/null
\set ALICE '''a1000000-0000-0000-0000-0000000000a1'''
\set CUONG '''c1000000-0000-0000-0000-0000000000c1'''
\set HANA '''a2000000-0000-0000-0000-0000000000a2'''
\set KHOA '''b1000000-0000-0000-0000-0000000000b1'''
\set SON '''d1000000-0000-0000-0000-0000000000d1'''
\set OUT '''e1000000-0000-0000-0000-0000000000e1'''
\set ORG '''0a000000-0000-0000-0000-0000000004a1'''
\set ORG2 '''0a000000-0000-0000-0000-0000000004a2'''
\set HCNS '''0d000000-0000-0000-0000-0000000004d1'''
\set KT '''0d000000-0000-0000-0000-0000000004d2'''
\set NOHEAD '''0d000000-0000-0000-0000-0000000004d3'''
\set OPS '''0d000000-0000-0000-0000-0000000004d4'''
\set TCV '''07000000-0000-0000-0000-000000000471'''
\set RIN '''08000000-0000-0000-0000-000000000481'''
\set ROLD '''08000000-0000-0000-0000-000000000482'''
\set RSHUT '''08000000-0000-0000-0000-000000000483'''
\set ROUT '''08000000-0000-0000-0000-000000000484'''
\set F1 '''f4000000-0000-0000-0000-0000000000f1'''
\set F2 '''f4000000-0000-0000-0000-0000000000f2'''
\set F3 '''f4000000-0000-0000-0000-0000000000f3'''
\set F1PATH '''c1000000-0000-0000-0000-0000000000c1/f4000000-0000-0000-0000-0000000000f1/v1/cv-123.pdf'''
\set F1V2 '''c1000000-0000-0000-0000-0000000000c1/f4000000-0000-0000-0000-0000000000f1/v2/cv-123.pdf'''
\set F2PATH '''c1000000-0000-0000-0000-0000000000c1/f4000000-0000-0000-0000-0000000000f2/v1/cv-45.pdf'''
\set F3PATH '''c1000000-0000-0000-0000-0000000000c1/f4000000-0000-0000-0000-0000000000f3/v1/cv-123b.pdf'''

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
  (:ALICE, 'alice@abc.example'),
  (:CUONG, 'cuong@abc.example'),
  (:HANA, 'hana@abc.example'),
  (:KHOA, 'khoa@abc.example'),
  (:SON, 'son@abc.example'),
  (:OUT, 'out@xyz.example');
insert into public.user_profiles (id, email) values
  (:ALICE, 'alice@abc.example'),
  (:CUONG, 'cuong@abc.example'),
  (:HANA, 'hana@abc.example'),
  (:KHOA, 'khoa@abc.example'),
  (:SON, 'son@abc.example'),
  (:OUT, 'out@xyz.example')
on conflict (id) do nothing;
update public.user_profiles set display_name = 'Hana' where id = :HANA;
update public.user_profiles set display_name = 'Son' where id = :SON;

-- ABC: Alice leader, Cuong clerk, Hana heads HCNS, Khoa heads KT, Son staff in
-- HCNS. XYZ: Out.
insert into public.organizations (id, name, code, created_by) values
  (:ORG, 'ABC Corporation', 'ABC', :ALICE),
  (:ORG2, 'XYZ Company', 'XYZ', :OUT);
insert into public.departments (id, org_id, name, code) values
  (:HCNS, :ORG, 'Hành chính nhân sự', 'HCNS'),
  (:KT, :ORG, 'Kế toán', 'KT'),
  (:NOHEAD, :ORG, 'Kho', 'KHO'),
  (:OPS, :ORG2, 'Operations', 'OPS');
insert into public.org_members (org_id, user_id, department_id, roles) values
  (:ORG, :ALICE, null, '{leader}'),
  (:ORG, :CUONG, :HCNS, '{clerk}'),
  (:ORG, :HANA, :HCNS, '{dept_head}'),
  (:ORG, :KHOA, :KT, '{dept_head}'),
  (:ORG, :SON, :HCNS, '{staff}'),
  (:ORG2, :OUT, :OPS, '{org_admin,clerk,leader}');
update public.departments set head_user_id = :HANA where id = :HCNS;
update public.departments set head_user_id = :KHOA where id = :KT;

insert into public.doc_types (id, org_id, name, abbreviation, is_cong_van) values
  (:TCV, :ORG, 'Công văn', 'CV', true);
insert into public.doc_registers (id, org_id, direction, name, year) values
  (:RIN, :ORG, 'incoming', 'Sổ văn bản đến', public.doc_year_for(:ORG, now())),
  (:ROLD, :ORG, 'incoming', 'Sổ văn bản đến cũ', public.doc_year_for(:ORG, now()) - 1),
  (:ROUT, :ORG, 'outgoing', 'Sổ văn bản đi', public.doc_year_for(:ORG, now()));
insert into public.doc_registers (id, org_id, direction, name, year, closed_at) values
  (:RSHUT, :ORG, 'incoming', 'Sổ đã đóng', public.doc_year_for(:ORG, now()), now());

-- Cuong's scans (register_file requires the object to exist in storage)
insert into storage.buckets (id, name) values ('uploads', 'uploads') on conflict (id) do nothing;
insert into storage.objects (bucket_id, name, owner, metadata) values
  ('uploads', :F1PATH, :CUONG, '{"size": 10}'),
  ('uploads', :F1V2, :CUONG, '{"size": 11}'),
  ('uploads', :F2PATH, :CUONG, '{"size": 12}'),
  ('uploads', :F3PATH, :CUONG, '{"size": 13}');

grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
grant execute on function pg_temp.login(uuid) to authenticated, anon;
grant execute on function pg_temp.error_of(text) to authenticated, anon;

create temp table ids (k text primary key, v uuid);
grant all on ids to authenticated, anon;

create function pg_temp.id(p_key text) returns uuid
language sql stable as $$ select v from ids where k = p_key $$;
grant execute on function pg_temp.id(text) to authenticated, anon;

-- ---------------------------------------------------------------- anon
set local role anon;
set local request.jwt.claim.sub = '';

select pg_temp.check(
  pg_temp.error_of($$select public.register_incoming(gen_random_uuid(), gen_random_uuid())$$) ~* 'permission denied'
  and pg_temp.error_of($$select public.submit_incoming(gen_random_uuid(), gen_random_uuid())$$) ~* 'permission denied'
  and pg_temp.error_of($$select public.assign_document(gen_random_uuid(), '[]')$$) ~* 'permission denied'
  and pg_temp.error_of($$select public.mark_my_assignments_seen(gen_random_uuid())$$) ~* 'permission denied'
  and pg_temp.error_of($$select public.update_assignment(gen_random_uuid(), 'done')$$) ~* 'permission denied'
  and pg_temp.error_of($$select public.revoke_assignment(gen_random_uuid())$$) ~* 'permission denied'
  and pg_temp.error_of($$select public.complete_document(gen_random_uuid(), 'x')$$) ~* 'permission denied'
  and pg_temp.error_of($$select public.return_to_clerk(gen_random_uuid(), 'x')$$) ~* 'permission denied'
  and pg_temp.error_of($$select public.cancel_incoming(gen_random_uuid(), 'x')$$) ~* 'permission denied'
  and pg_temp.error_of($$select public.reopen_document(gen_random_uuid(), 'x')$$) ~* 'permission denied',
  'anon cannot call any incoming workflow RPC');

reset role;
set local role authenticated;

select pg_temp.login(:SON);
select pg_temp.check(
  pg_temp.error_of($$select public.doc_title('khan', 'x')$$) ~* 'permission denied'
  and pg_temp.error_of($$select public.doc_is_my_assignment(null, null, null)$$) ~* 'permission denied'
  and pg_temp.error_of($$select public.doc_assignment_recipient(null, null)$$) ~* 'permission denied'
  and pg_temp.error_of($$select public.doc_clean_reason('x', 'y')$$) ~* 'permission denied',
  'signed-in users cannot call the internal helpers');

-- ---------------------------------------------------------------- Cuong registers document 1
select pg_temp.login(:CUONG);
insert into ids select 'folder', public.ensure_document_folder();
select public.register_file(:F1, pg_temp.id('folder'), 'cv-123.pdf', 'cv-123.pdf', 'pdf', 'application/pdf', 10, :F1PATH);
select public.register_file(:F2, pg_temp.id('folder'), 'cv-45.pdf', 'cv-45.pdf', 'pdf', 'application/pdf', 12, :F2PATH);
select public.register_file(:F3, pg_temp.id('folder'), 'cv-123b.pdf', 'cv-123b.pdf', 'pdf', 'application/pdf', 13, :F3PATH);

insert into ids select 'd1', public.create_document('incoming', jsonb_build_object(
  'subject', 'Hướng dẫn quyết toán ngân sách',
  'doc_type_id', :TCV,
  'issuing_org_name', 'Bo Tai chinh',
  'notation', '123/BTC-VP',
  'issued_date', '2026-01-05',
  'urgency', 'khan'
));

select pg_temp.check(
  pg_temp.error_of(format('select public.register_incoming(%L, %L)', pg_temp.id('d1'),
    '08000000-0000-0000-0000-000000000481')) ~* 'attach the main file first',
  'registering without a main file is refused');

select public.attach_document_file(pg_temp.id('d1'), :F1, 'main');

select pg_temp.check(
  pg_temp.error_of(format('select public.register_incoming(%L, %L)', pg_temp.id('d1'),
    '08000000-0000-0000-0000-000000000482')) ~* 'register is for',
  'a register of another year is refused');
select pg_temp.check(
  pg_temp.error_of(format('select public.register_incoming(%L, %L)', pg_temp.id('d1'),
    '08000000-0000-0000-0000-000000000483')) ~* 'closed',
  'a closed register is refused');
select pg_temp.check(
  pg_temp.error_of(format('select public.register_incoming(%L, %L)', pg_temp.id('d1'),
    '08000000-0000-0000-0000-000000000484')) ~* 'not found',
  'an outgoing register is refused');

select pg_temp.login(:SON);
select pg_temp.check(
  pg_temp.error_of(format('select public.register_incoming(%L, %L)', pg_temp.id('d1'),
    '08000000-0000-0000-0000-000000000481')) is not null,
  'staff cannot register');

select pg_temp.login(:CUONG);
select pg_temp.check(
  public.register_incoming(pg_temp.id('d1'), :RIN) = '{"ok": true, "arrival_number": 1}'::jsonb,
  'document 1 gets arrival number 1');
select pg_temp.check(
  (select status = 'registered' and register_id = :RIN and arrival_number = 1
     and arrival_date = public.org_now_date(:ORG) and registered_at is not null
     and due_date = public.doc_add_working_days(:ORG, public.org_now_date(:ORG), 2)
   from public.documents where id = pg_temp.id('d1')),
  'registered: arrival date today, default deadline 2 working days (khẩn)');
select pg_temp.check(
  (select bool_and(frozen) from public.document_files where document_id = pg_temp.id('d1')),
  'registering freezes the files');
select pg_temp.check(
  (select (data ->> 'arrival_number')::int = 1 and actor_id = :CUONG and to_status = 'registered'
   from public.document_events where document_id = pg_temp.id('d1') and action = 'registered'),
  'registered is logged with the arrival number');
select pg_temp.check(
  pg_temp.error_of(format('select public.register_incoming(%L, %L)', pg_temp.id('d1'),
    '08000000-0000-0000-0000-000000000481')) ~* 'only an incoming draft',
  'a registered document is not registered twice');

-- document 2: another sender
insert into ids select 'd2', public.create_document('incoming', jsonb_build_object(
  'subject', 'Mời họp giao ban', 'doc_type_id', :TCV,
  'issuing_org_name', 'UBND Quan 1', 'notation', '45/UBND'));
select public.attach_document_file(pg_temp.id('d2'), :F2, 'main');
select pg_temp.check(
  (public.register_incoming(pg_temp.id('d2'), :RIN) ->> 'arrival_number')::int = 2,
  'document 2 gets arrival number 2');

-- document 3: the same notation and sender as document 1
insert into ids select 'd3', public.create_document('incoming', jsonb_build_object(
  'subject', 'Hướng dẫn quyết toán (bản fax)', 'doc_type_id', :TCV,
  'issuing_org_name', 'bo tai chinh', 'notation', '123/btc-vp'));
select public.attach_document_file(pg_temp.id('d3'), :F3, 'main');
create temp table dup as select public.register_incoming(pg_temp.id('d3'), :RIN) as r;
select pg_temp.check(
  (select r -> 'ok' = 'false'::jsonb and jsonb_array_length(r -> 'duplicates') = 1
     and r -> 'duplicates' -> 0 ->> 'id' = pg_temp.id('d1')::text
     and (r -> 'duplicates' -> 0 ->> 'arrival_number')::int = 1
     and r -> 'duplicates' -> 0 ->> 'subject' = 'Hướng dẫn quyết toán ngân sách'
   from dup),
  'a possible duplicate is reported without registering');
select pg_temp.check(
  (select status = 'draft' and arrival_number is null from public.documents where id = pg_temp.id('d3'))
  and (select last_number from public.doc_register_counters where register_id = :RIN) = 2,
  'the duplicate warning changes nothing and uses no number');
select pg_temp.check(
  (public.register_incoming(pg_temp.id('d3'), :RIN, '  Fax copy, original follows  ') ->> 'arrival_number')::int = 3,
  'with a reason the duplicate is registered as number 3');
select pg_temp.check(
  (select data ->> 'duplicate_reason' = 'Fax copy, original follows'
   from public.document_events where document_id = pg_temp.id('d3') and action = 'registered'),
  'the duplicate reason is logged');

-- ---------------------------------------------------------------- present to Alice
select pg_temp.check(
  pg_temp.error_of(format('select public.submit_incoming(%L, %L)', pg_temp.id('d1'),
    'd1000000-0000-0000-0000-0000000000d1')) ~* 'leader or department head',
  'it cannot be presented to staff');
select pg_temp.check(
  pg_temp.error_of(format('select public.submit_incoming(%L, %L)', pg_temp.id('d1'),
    'e1000000-0000-0000-0000-0000000000e1')) ~* 'leader or department head',
  'it cannot be presented to someone of another company');

select public.submit_incoming(pg_temp.id('d1'), :ALICE, 'Kính trình chị xem xét');
select pg_temp.check(
  (select status = 'submitted' and presented_to = :ALICE and submitted_at is not null
   from public.documents where id = pg_temp.id('d1')),
  'submitted to Alice');
select pg_temp.check(
  (select count(*) from public.document_opinions
   where document_id = pg_temp.id('d1') and kind = 'proposal' and body = 'Kính trình chị xem xét') = 1,
  'the note is a proposal opinion');
select pg_temp.check(
  (select data ->> 'to_name' = 'alice@abc.example'
   from public.document_events where document_id = pg_temp.id('d1') and action = 'submitted'),
  'submitted is logged with the leader''s name');

reset role;
select pg_temp.check(
  (select count(*) from public.notifications
   where user_id = :ALICE and kind = 'document.submitted'
     and title = '[URGENT] New incoming document: Hướng dẫn quyết toán ngân sách') = 1,
  'Alice is notified, with [URGENT] for a khẩn document');
set local role authenticated;

-- ---------------------------------------------------------------- Alice assigns
select pg_temp.login(:ALICE);

select pg_temp.check(
  pg_temp.error_of(format('select public.assign_document(%L, %L::jsonb)', pg_temp.id('d1'),
    jsonb_build_array(
      jsonb_build_object('user_id', 'b1000000-0000-0000-0000-0000000000b1', 'role', 'lead'),
      jsonb_build_object('department_id', '0d000000-0000-0000-0000-0000000004d1', 'role', 'lead')))) ~* 'exactly one lead',
  'two leads are refused');
select pg_temp.check(
  pg_temp.error_of(format('select public.assign_document(%L, %L::jsonb)', pg_temp.id('d1'),
    jsonb_build_array(
      jsonb_build_object('user_id', 'b1000000-0000-0000-0000-0000000000b1', 'role', 'support')))) ~* 'exactly one lead',
  'no lead is refused');
select pg_temp.check(
  pg_temp.error_of(format('select public.assign_document(%L, %L::jsonb)', pg_temp.id('d1'),
    jsonb_build_array(
      jsonb_build_object('department_id', '0d000000-0000-0000-0000-0000000004d3', 'role', 'lead')))) ~* 'Kho has no head',
  'a department without a head is refused');
select pg_temp.check(
  pg_temp.error_of(format('select public.assign_document(%L, %L::jsonb)', pg_temp.id('d1'),
    jsonb_build_array(
      jsonb_build_object('department_id', '0d000000-0000-0000-0000-0000000004d4', 'role', 'lead')))) ~* 'not found',
  'a department of another company is refused');
select pg_temp.check(
  pg_temp.error_of(format('select public.assign_document(%L, %L::jsonb)', pg_temp.id('d1'),
    jsonb_build_array(
      jsonb_build_object('user_id', 'e1000000-0000-0000-0000-0000000000e1', 'role', 'lead')))) ~* 'active members',
  'someone of another company is refused');
select pg_temp.check(
  pg_temp.error_of(format('select public.assign_document(%L, %L::jsonb)', pg_temp.id('d1'),
    jsonb_build_array(
      jsonb_build_object('user_id', 'b1000000-0000-0000-0000-0000000000b1', 'role', 'lead',
        'due_date', public.org_now_date('0a000000-0000-0000-0000-0000000004a1') - 1)))) ~* 'in the past',
  'a deadline in the past is refused');
select pg_temp.check(
  pg_temp.error_of(format('select public.assign_document(%L, %L::jsonb)', pg_temp.id('d1'),
    jsonb_build_array(
      jsonb_build_object('user_id', 'b1000000-0000-0000-0000-0000000000b1', 'role', 'lead'),
      jsonb_build_object('user_id', 'b1000000-0000-0000-0000-0000000000b1', 'role', 'support')))) ~* 'only appear once',
  'the same person twice is refused');

select pg_temp.check(
  public.assign_document(pg_temp.id('d1'), jsonb_build_array(
    jsonb_build_object('department_id', :HCNS, 'role', 'lead',
      'due_date', public.doc_add_working_days(:ORG, public.org_now_date(:ORG), 3)),
    jsonb_build_object('user_id', :KHOA, 'role', 'support'),
    jsonb_build_object('department_id', :KT, 'role', 'info')
  ), null, 'Phòng HCNS chủ trì, phòng KT phối hợp') = 3,
  'Alice assigns lead HCNS, support Khoa and info KT');
select pg_temp.check(
  (select status = 'in_progress' and due_date = public.doc_add_working_days(:ORG, public.org_now_date(:ORG), 3)
   from public.documents where id = pg_temp.id('d1')),
  'the document is in progress with the lead''s deadline');
insert into ids select 'a_lead', id from public.document_assignments
  where document_id = pg_temp.id('d1') and assignee_department_id = :HCNS;
insert into ids select 'a_support', id from public.document_assignments
  where document_id = pg_temp.id('d1') and assignee_user_id = :KHOA;
insert into ids select 'a_info', id from public.document_assignments
  where document_id = pg_temp.id('d1') and assignee_department_id = :KT;
select pg_temp.check(
  (select due_date = public.doc_add_working_days(:ORG, public.org_now_date(:ORG), 3)
   from public.document_assignments where id = pg_temp.id('a_lead'))
  and (select due_date = public.doc_add_working_days(:ORG, public.org_now_date(:ORG), 3)
       from public.document_assignments where id = pg_temp.id('a_support'))
  and (select due_date is null and role = 'info' and status = 'pending' and assigned_by = :ALICE
       from public.document_assignments where id = pg_temp.id('a_info')),
  'support takes the document deadline, info has none');
select pg_temp.check(
  (select count(*) from public.document_opinions
   where document_id = pg_temp.id('d1') and kind = 'instruction' and author_id = :ALICE) = 1,
  'the instruction is an opinion');
select pg_temp.check(
  pg_temp.error_of(format('select public.assign_document(%L, %L::jsonb)', pg_temp.id('d1'),
    jsonb_build_array(
      jsonb_build_object('user_id', 'd1000000-0000-0000-0000-0000000000d1', 'role', 'lead')))) ~* 'already has a lead',
  'a second lead is refused while one is active');
select pg_temp.check(
  pg_temp.error_of(format('select public.assign_document(%L, %L::jsonb)', pg_temp.id('d1'),
    jsonb_build_array(
      jsonb_build_object('user_id', 'b1000000-0000-0000-0000-0000000000b1', 'role', 'info')))) ~* 'only appear once',
  'an active assignee cannot be added again');

reset role;
select pg_temp.check(
  (select count(*) from public.notifications
   where user_id = :HANA and kind = 'document.assigned'
     and title = '[URGENT] You are the lead for: Hướng dẫn quyết toán ngân sách'
     and body = 'Phòng HCNS chủ trì, phòng KT phối hợp') = 1,
  'Hana (head of HCNS) is told she leads');
select pg_temp.check(
  (select count(*) from public.notifications
   where user_id = :KHOA and kind = 'document.assigned'
     and title in ('[URGENT] Please support: Hướng dẫn quyết toán ngân sách',
                   '[URGENT] For your information: Hướng dẫn quyết toán ngân sách')) = 2,
  'Khoa is told as supporter and as head of KT');
set local role authenticated;

-- ---------------------------------------------------------------- Hana sub-assigns to Son
select pg_temp.login(:HANA);
select pg_temp.check(
  public.can_read_document(pg_temp.id('d1')),
  'Hana reads the document through her department''s assignment');
select pg_temp.check(
  pg_temp.error_of(format('select public.assign_document(%L, %L::jsonb, %L)', pg_temp.id('d1'),
    jsonb_build_array(jsonb_build_object('user_id', 'd1000000-0000-0000-0000-0000000000d1', 'role', 'lead',
      'due_date', public.doc_add_working_days('0a000000-0000-0000-0000-0000000004a1',
        public.org_now_date('0a000000-0000-0000-0000-0000000004a1'), 10))),
    pg_temp.id('a_lead'))) ~* 'on or before',
  'a sub-assignment cannot end after its parent');
select pg_temp.check(
  pg_temp.error_of(format('select public.assign_document(%L, %L::jsonb, %L)', pg_temp.id('d1'),
    jsonb_build_array(jsonb_build_object('user_id', 'd1000000-0000-0000-0000-0000000000d1', 'role', 'lead')),
    pg_temp.id('a_support'))) ~* 'only the assignee',
  'Hana cannot pass on Khoa''s assignment');
select pg_temp.check(
  public.assign_document(pg_temp.id('d1'),
    jsonb_build_array(jsonb_build_object('user_id', :SON, 'role', 'lead', 'instruction', 'Em soạn báo cáo')),
    pg_temp.id('a_lead')) = 1,
  'Hana makes Son the lead inside HCNS');
insert into ids select 'a_son', id from public.document_assignments
  where document_id = pg_temp.id('d1') and assignee_user_id = :SON;
select pg_temp.check(
  (select parent_id = pg_temp.id('a_lead') and assigned_by = :HANA and instruction = 'Em soạn báo cáo'
     and due_date = (select due_date from public.document_assignments where id = pg_temp.id('a_lead'))
   from public.document_assignments where id = pg_temp.id('a_son')),
  'Son''s assignment hangs under HCNS and inherits its deadline');
select pg_temp.check(
  pg_temp.error_of(format('select public.assign_document(%L, %L::jsonb, %L)', pg_temp.id('d1'),
    jsonb_build_array(jsonb_build_object('user_id', 'c1000000-0000-0000-0000-0000000000c1', 'role', 'lead')),
    pg_temp.id('a_lead'))) ~* 'already has a lead',
  'one lead per parent');
select pg_temp.check(
  (select status = 'seen' and seen_at is not null from public.document_assignments where id = pg_temp.id('a_lead')),
  'passing the department assignment on opens it');

-- ---------------------------------------------------------------- Son works and reports
select pg_temp.login(:SON);
select pg_temp.check(public.mark_my_assignments_seen(pg_temp.id('d1')) = 1, 'Son marks his assignment seen');
select pg_temp.check(public.mark_my_assignments_seen(pg_temp.id('d1')) = 0, 'seen only once');
select pg_temp.check(
  (select status = 'seen' and seen_at is not null from public.document_assignments where id = pg_temp.id('a_son')),
  'the assignment is seen');
select public.update_assignment(pg_temp.id('a_son'), 'in_progress');
select pg_temp.check(
  pg_temp.error_of(format('select public.update_assignment(%L, %L)', pg_temp.id('a_son'), 'done')) ~* 'result',
  'a lead cannot finish without a result');
select pg_temp.check(
  pg_temp.error_of(format('select public.update_assignment(%L, %L)', pg_temp.id('a_son'), 'in_progress')) ~* 'already',
  'in progress cannot start again');
select public.update_assignment(pg_temp.id('a_son'), 'done', 'Đã soạn báo cáo quyết toán');
select pg_temp.check(
  (select status = 'done' and done_at is not null and result = 'Đã soạn báo cáo quyết toán'
   from public.document_assignments where id = pg_temp.id('a_son')),
  'Son is done with a result');
select pg_temp.check(
  (select count(*) from public.document_opinions
   where document_id = pg_temp.id('d1') and kind = 'result' and author_id = :SON) = 1,
  'the result is an opinion');
select pg_temp.check(
  pg_temp.error_of(format('select public.update_assignment(%L, %L, %L)', pg_temp.id('a_lead'), 'done', 'x')) ~* 'only the assignee',
  'Son cannot finish the department''s assignment');
select pg_temp.check(
  not public.can_read_document(pg_temp.id('d2'))
  and (select count(*) from public.documents where id = pg_temp.id('d2')) = 0,
  'Son (staff, not assigned) cannot read document 2');

reset role;
select pg_temp.check(
  (select count(*) from public.notifications
   where user_id = :HANA and kind = 'document.assignment_updated'
     and title = '[URGENT] Son finished: Hướng dẫn quyết toán ngân sách') = 1,
  'Hana is told Son finished');
set local role authenticated;

-- ---------------------------------------------------------------- Khoa opens; revoking is too late
select pg_temp.login(:KHOA);
select pg_temp.check(public.mark_my_assignments_seen(pg_temp.id('d1')) = 2,
  'Khoa marks his support and his department''s info assignment seen');
select pg_temp.login(:ALICE);
select pg_temp.check(
  pg_temp.error_of(format('select public.revoke_assignment(%L)', pg_temp.id('a_support'))) ~* 'already opened',
  'revoking an assignment that was already seen fails');
select pg_temp.check(
  pg_temp.error_of(format('select public.revoke_assignment(%L)', pg_temp.id('a_lead'))) ~* 'already opened',
  'an assignment that was passed on cannot be revoked (it would revoke Son''s work)');

select pg_temp.login(:KHOA);
select public.update_assignment(pg_temp.id('a_info'), 'done');
select pg_temp.check(
  (select status = 'done' and result is null from public.document_assignments where id = pg_temp.id('a_info')),
  'an info assignment is done without a result');
reset role;
select pg_temp.check(
  (select count(*) from public.notifications where user_id = :ALICE and kind = 'document.assignment_updated') = 0,
  'nobody is told about an info assignment being done');
set local role authenticated;

select pg_temp.login(:SON);
select pg_temp.check(
  pg_temp.error_of(format('select public.complete_document(%L, %L)', pg_temp.id('d1'), 'x')) ~* 'only the lead',
  'a sub-assignee cannot complete the document');

-- ---------------------------------------------------------------- Hana finishes and completes
select pg_temp.login(:HANA);
select pg_temp.check(
  pg_temp.error_of(format('select public.complete_document(%L, %L)', pg_temp.id('d1'), 'x')) ~* 'not finished',
  'the document cannot be completed before the lead is done');
select public.update_assignment(pg_temp.id('a_lead'), 'done', 'HCNS đã hoàn thành báo cáo');
select public.complete_document(pg_temp.id('d1'), 'Đã báo cáo Bộ Tài chính');
select pg_temp.check(
  (select status = 'completed' and completed_at is not null and result_note = 'Đã báo cáo Bộ Tài chính'
   from public.documents where id = pg_temp.id('d1')),
  'Hana completes the document');
select pg_temp.check(
  (select status = 'seen' from public.document_assignments where id = pg_temp.id('a_support')),
  'the open support assignment stays open');

reset role;
select pg_temp.check(
  (select count(*) from public.notifications where user_id = :ALICE and kind = 'document.completed') = 1
  and (select count(*) from public.notifications where user_id = :KHOA and kind = 'document.completed') = 1,
  'Alice and the open supporter are told it is completed');
set local role authenticated;

-- ---------------------------------------------------------------- reopen
select pg_temp.login(:HANA);
select pg_temp.check(
  pg_temp.error_of(format('select public.reopen_document(%L, %L)', pg_temp.id('d1'), 'x')) ~* 'only leaders',
  'a department head cannot reopen');
select pg_temp.login(:ALICE);
select pg_temp.check(
  pg_temp.error_of(format('select public.reopen_document(%L, %L)', pg_temp.id('d1'), ' ')) ~* 'reason',
  'reopening needs a reason');
select public.reopen_document(pg_temp.id('d1'), 'Bổ sung số liệu');
select pg_temp.check(
  (select status = 'in_progress' and completed_at is null from public.documents where id = pg_temp.id('d1')),
  'Alice reopens it');
select public.complete_document(pg_temp.id('d1'), 'Đã bổ sung');
select pg_temp.check(
  (select data = jsonb_build_object('result_note', 'Đã bổ sung') from public.document_events
   where document_id = pg_temp.id('d1') and action = 'completed' order by id desc limit 1),
  'completing again needs no override (the lead is done) and logs the result note');

-- ---------------------------------------------------------------- outsider
select pg_temp.login(:OUT);
select pg_temp.check(
  not public.can_read_document(pg_temp.id('d1'))
  and (select count(*) from public.documents where id = pg_temp.id('d1')) = 0
  and (select count(*) from public.document_assignments where document_id = pg_temp.id('d1')) = 0,
  'Out cannot read document 1');
select pg_temp.check(
  pg_temp.error_of(format('select public.assign_document(%L, %L::jsonb)', pg_temp.id('d1'),
    jsonb_build_array(jsonb_build_object('user_id', 'e1000000-0000-0000-0000-0000000000e1', 'role', 'lead')))) ~* 'not found',
  'Out cannot assign document 1');
select pg_temp.check(
  pg_temp.error_of(format('select public.cancel_incoming(%L, %L)', pg_temp.id('d2'), 'x')) ~* 'not found'
  and pg_temp.error_of(format('select public.mark_my_assignments_seen(%L)', pg_temp.id('d2'))) ~* 'not found',
  'Out cannot touch document 2');

-- ---------------------------------------------------------------- direct distribution and revoke
select pg_temp.login(:CUONG);
select pg_temp.check(
  public.assign_document(pg_temp.id('d2'),
    jsonb_build_array(jsonb_build_object('user_id', :KHOA, 'role', 'lead'))) = 1,
  'the clerk distributes a registered document directly');
insert into ids select 'a_d2', id from public.document_assignments where document_id = pg_temp.id('d2');
select pg_temp.login(:HANA);
select pg_temp.check(
  pg_temp.error_of(format('select public.revoke_assignment(%L)', pg_temp.id('a_d2'))) is not null,
  'only the person who assigned it can revoke it');
select pg_temp.login(:CUONG);
select public.revoke_assignment(pg_temp.id('a_d2'));
select pg_temp.check(
  (select status = 'revoked' from public.document_assignments where id = pg_temp.id('a_d2')),
  'a pending assignment is revoked');
select pg_temp.check(
  pg_temp.error_of(format('select public.assign_document(%L, %L::jsonb)', pg_temp.id('d2'),
    jsonb_build_array(jsonb_build_object('user_id', 'b1000000-0000-0000-0000-0000000000b1', 'role', 'lead')))) ~* 'presented to',
  'once in progress the clerk no longer assigns');
select pg_temp.login(:ALICE);
select pg_temp.check(
  public.assign_document(pg_temp.id('d2'),
    jsonb_build_array(jsonb_build_object('user_id', :KHOA, 'role', 'lead'))) = 1,
  'after the revoke a new lead can be named');
reset role;
select pg_temp.check(
  (select count(*) from public.notifications where user_id = :KHOA and kind = 'document.assignment_revoked') = 1,
  'Khoa is told the assignment was withdrawn');
set local role authenticated;
select pg_temp.login(:KHOA);
insert into ids select 'a_d2b', id from public.document_assignments
  where document_id = pg_temp.id('d2') and status = 'pending';
-- presented_to is null on document 2: a reader without a leader role gets no rights from it
select pg_temp.check(
  pg_temp.error_of(format('select public.assign_document(%L, %L::jsonb)', pg_temp.id('d2'),
    jsonb_build_array(jsonb_build_object('user_id', 'd1000000-0000-0000-0000-0000000000d1', 'role', 'support')))) ~* 'presented to'
  and pg_temp.error_of(format('select public.return_to_clerk(%L, %L)', pg_temp.id('d2'), 'x')) ~* 'presented to'
  and pg_temp.error_of(format('select public.reopen_document(%L, %L)', pg_temp.id('d2'), 'x')) ~* 'only leaders'
  and pg_temp.error_of(format('select public.cancel_incoming(%L, %L)', pg_temp.id('d2'), 'x')) ~* 'only clerks',
  'with nobody presented to, an assignee without a role cannot assign, return, reopen or cancel');
select pg_temp.check(
  pg_temp.error_of(format('select public.update_assignment(%L, %L)', pg_temp.id('a_d2b'), 'returned')) ~* 'reason',
  'returning needs a reason');
select public.update_assignment(pg_temp.id('a_d2b'), 'returned', 'Không thuộc chức năng phòng KT');
reset role;
select pg_temp.check(
  (select count(*) from public.notifications
   where user_id = :ALICE and kind = 'document.assignment_updated'
     and title like '% returned: Mời họp giao ban' and body = 'Không thuộc chức năng phòng KT') = 1,
  'the person who assigned it is told it was returned');
set local role authenticated;

-- ---------------------------------------------------------------- return to clerk and cancel
select pg_temp.login(:CUONG);
select public.submit_incoming(pg_temp.id('d3'), :ALICE);
select pg_temp.login(:HANA);
select pg_temp.check(
  pg_temp.error_of(format('select public.return_to_clerk(%L, %L)', pg_temp.id('d3'), 'x')) is not null,
  'only the person it was presented to returns it');
select pg_temp.login(:ALICE);
select public.return_to_clerk(pg_temp.id('d3'), 'Bản fax trùng, đề nghị hủy');
select pg_temp.check(
  (select status = 'registered' and presented_to is null from public.documents where id = pg_temp.id('d3')),
  'returned to the clerk');
reset role;
select pg_temp.check(
  (select count(*) from public.notifications
   where user_id = :CUONG and kind = 'document.returned_to_clerk' and body = 'Bản fax trùng, đề nghị hủy') = 1,
  'the clerk who registered it is told');
set local role authenticated;
select pg_temp.login(:CUONG);
select public.cancel_incoming(pg_temp.id('d3'), 'Bản fax trùng');
select pg_temp.check(
  (select status = 'cancelled' and cancelled_at is not null and arrival_number = 3
   from public.documents where id = pg_temp.id('d3'))
  and (select bool_and(frozen) from public.document_files where document_id = pg_temp.id('d3'))
  and (select last_number from public.doc_register_counters where register_id = :RIN) = 3,
  'a cancelled registered document keeps its number and frozen files');
select pg_temp.check(
  pg_temp.error_of(format('select public.cancel_incoming(%L, %L)', pg_temp.id('d1'), 'x')) ~* 'draft or registered',
  'a document in progress cannot be cancelled');

-- ---------------------------------------------------------------- frozen files
select pg_temp.check(
  pg_temp.error_of(format('select public.add_file_version(%L, %L, 11, %L)',
    'f4000000-0000-0000-0000-0000000000f1',
    'c1000000-0000-0000-0000-0000000000c1/f4000000-0000-0000-0000-0000000000f1/v2/cv-123.pdf',
    'application/pdf')) ~* 'locked',
  'frozen files reject add_file_version');

-- ---------------------------------------------------------------- timeline
reset role;
select pg_temp.check(
  (select string_agg(action, ',' order by id) from public.document_events
   where document_id = pg_temp.id('d1'))
  ~ '^created(,[a-z_]+)*,file_attached(,[a-z_]+)*,registered(,[a-z_]+)*,submitted(,[a-z_]+)*,assigned(,[a-z_]+)*,seen(,[a-z_]+)*,assignment_updated(,[a-z_]+)*,completed(,|$)',
  'document 1 timeline: created, file_attached, registered, submitted, assigned, seen, assignment_updated, completed');
select pg_temp.check(
  not exists (
    select 1 from public.document_events
    where document_id in (pg_temp.id('d1'), pg_temp.id('d2'), pg_temp.id('d3'))
      and action not in ('created', 'file_attached', 'opinion_added', 'registered', 'submitted',
        'returned_to_clerk', 'assigned', 'seen', 'assignment_updated', 'assignment_revoked',
        'completed', 'reopened', 'cancelled')
  ),
  'only canonical workflow actions were written');

rollback;
