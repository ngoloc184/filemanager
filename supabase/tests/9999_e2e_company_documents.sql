-- End to end: one company runs its documents (Văn bản) at the database level,
-- through the same RPCs and arguments the UI calls (src/lib/services/org.ts,
-- documents.ts, documents-incoming.ts, documents-outgoing.ts,
-- document-search.ts, dossiers.ts, uploads.ts, files.ts, notifications.ts and
-- POST /api/org/offboard → offboard_member).
--   1. company, departments, invitations, roles
--   2. seeded registers and types (the seed runs when create_organization commits)
--   3. incoming: register (duplicate warning), present, assign, sub-assign,
--      report, complete; freeze, timeline, notifications, outsider
--   4. outgoing: private draft, approval chain, return, new version, approve,
--      sign, issue (numbering), distribution to a department, recall
--   5. dossier: file the documents, close, legal hold
--   6. offboarding: open work moves to the successor
--   7. security: anon, another company
-- Run with scripts/test-db.sh (plain PostgreSQL + supabase/tests stubs).
-- Everything runs in one transaction that is rolled back at the end.

\set ON_ERROR_STOP 1
\o /dev/null
\set ALICE '''a9000000-0000-0000-0000-0000000000a1'''
\set BOB '''b9000000-0000-0000-0000-0000000000b1'''
\set CAROL '''c9000000-0000-0000-0000-0000000000c1'''
\set DAN '''d9000000-0000-0000-0000-0000000000d1'''
\set HOA '''99000000-0000-0000-0000-000000000091'''
\set EVE '''e9000000-0000-0000-0000-0000000000e1'''
\set FRANK '''f8000000-0000-0000-0000-0000000000f8'''
\set FIN1 '''f9000000-0000-0000-0000-000000000001'''
\set FIN2 '''f9000000-0000-0000-0000-000000000002'''
\set FIN3 '''f9000000-0000-0000-0000-000000000003'''
\set FIN4 '''f9000000-0000-0000-0000-000000000004'''
\set FOUT1 '''f9000000-0000-0000-0000-000000000011'''
\set FOUT2 '''f9000000-0000-0000-0000-000000000012'''
\set FIN1PATH '''a9000000-0000-0000-0000-0000000000a1/f9000000-0000-0000-0000-000000000001/v1/cv-88-stc.pdf'''
\set FIN1V2 '''a9000000-0000-0000-0000-0000000000a1/f9000000-0000-0000-0000-000000000001/v2/cv-88-stc.pdf'''
\set FIN2PATH '''a9000000-0000-0000-0000-0000000000a1/f9000000-0000-0000-0000-000000000002/v1/cv-88-stc-fax.pdf'''
\set FIN3PATH '''a9000000-0000-0000-0000-0000000000a1/f9000000-0000-0000-0000-000000000003/v1/phieu-chuyen.pdf'''
\set FIN4PATH '''a9000000-0000-0000-0000-0000000000a1/f9000000-0000-0000-0000-000000000004/v1/bien-ban-nhap.pdf'''
\set FOUT1PATH '''c9000000-0000-0000-0000-0000000000c1/f9000000-0000-0000-0000-000000000011/v1/qd-khen-thuong.pdf'''
\set FOUT1V2 '''c9000000-0000-0000-0000-0000000000c1/f9000000-0000-0000-0000-000000000011/v2/qd-khen-thuong.pdf'''
\set FOUT2PATH '''c9000000-0000-0000-0000-0000000000c1/f9000000-0000-0000-0000-000000000012/v1/qd-nang-luong.pdf'''

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
-- Accounts exist (sign-up); everything else is created through the RPCs.
insert into auth.users (id, email) values
  (:ALICE, 'alice@acme.example'),
  (:BOB, 'bob@acme.example'),
  (:CAROL, 'carol@acme.example'),
  (:DAN, 'dan@acme.example'),
  (:HOA, 'hoa@acme.example'),
  (:EVE, 'eve@outside.example'),
  (:FRANK, 'frank@xyz.example');
insert into public.user_profiles (id, email) values
  (:ALICE, 'alice@acme.example'),
  (:BOB, 'bob@acme.example'),
  (:CAROL, 'carol@acme.example'),
  (:DAN, 'dan@acme.example'),
  (:HOA, 'hoa@acme.example'),
  (:EVE, 'eve@outside.example'),
  (:FRANK, 'frank@xyz.example')
on conflict (id) do nothing;
update public.user_profiles set display_name = initcap(split_part(email, '@', 1))
where id in (:ALICE, :BOB, :CAROL, :DAN, :HOA, :EVE, :FRANK);

-- Objects the browser uploaded to storage before register_file / add_file_version
insert into storage.buckets (id, name) values ('uploads', 'uploads') on conflict (id) do nothing;
insert into storage.objects (bucket_id, name, owner, metadata) values
  ('uploads', :FIN1PATH, :ALICE, '{"size": 10}'),
  ('uploads', :FIN1V2, :ALICE, '{"size": 11}'),
  ('uploads', :FIN2PATH, :ALICE, '{"size": 12}'),
  ('uploads', :FIN3PATH, :ALICE, '{"size": 13}'),
  ('uploads', :FIN4PATH, :ALICE, '{"size": 14}'),
  ('uploads', :FOUT1PATH, :CAROL, '{"size": 20}'),
  ('uploads', :FOUT1V2, :CAROL, '{"size": 21}'),
  ('uploads', :FOUT2PATH, :CAROL, '{"size": 22}');

grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
grant execute on function pg_temp.login(uuid) to authenticated, anon;
grant execute on function pg_temp.error_of(text) to authenticated, anon;

create temp table ids (k text primary key, v uuid);
grant all on ids to authenticated, anon;
create temp table vals (k text primary key, v jsonb);
grant all on vals to authenticated, anon;
create temp table tokens (k text primary key, v text);
grant all on tokens to authenticated, anon;

create function pg_temp.id(p_key text) returns uuid
language sql stable as $$ select v from ids where k = p_key $$;
grant execute on function pg_temp.id(text) to authenticated, anon;

create function pg_temp.token(p_key text) returns text
language sql stable as $$ select v from tokens where k = p_key $$;
grant execute on function pg_temp.token(text) to authenticated, anon;

-- The inbox list (DocumentsInbox → search_documents) shows the document in this view.
create function pg_temp.in_view(p_view text, p_doc uuid) returns boolean
language sql as $$
  select exists (
    select 1 from public.search_documents(jsonb_build_object('view', p_view), 200, 0) s
    where s.id = p_doc
  )
$$;
grant execute on function pg_temp.in_view(text, uuid) to authenticated, anon;

-- The bell (list_notifications) of the signed-in user: how many match.
create function pg_temp.bell(p_kind text, p_title text) returns int
language sql as $$
  select count(*)::int from public.list_notifications(null, 100) n
  where n.kind = p_kind and n.title like p_title
$$;
grant execute on function pg_temp.bell(text, text) to authenticated, anon;

set local role authenticated;

-- ================================================================ 1. company
select pg_temp.login(:ALICE);
insert into ids select 'org', o.id from public.create_organization('ACME Corporation', 'abc', 'ACME') o;
-- the UI's create_organization commits on its own; the deferred seed trigger
-- runs then. Inside this test transaction it is made to run now.
set constraints organizations_seed_documents immediate;

select pg_temp.check(
  (select (r -> 'org' ->> 'code') = 'ABC'
     and (r -> 'org' ->> 'id')::uuid = pg_temp.id('org')
     and (r -> 'me' -> 'roles') = '["org_admin", "clerk", "leader"]'::jsonb
     and (r -> 'me' ->> 'status') = 'active'
   from (select public.get_my_org() as r) x),
  'Alice creates ACME (code ABC) and is org_admin, clerk and leader');

insert into ids select 'hcns', d.id
  from public.upsert_department(null, 'Hành chính nhân sự', 'HCNS', null, null, null) d;
insert into ids select 'kt', d.id
  from public.upsert_department(null, 'Kế toán', 'KT', null, null, null) d;
insert into ids select 'pos_gd', p.id from public.upsert_position(null, 'Giám đốc', 100, true) p;
select pg_temp.check(
  (select count(*) from public.departments where org_id = pg_temp.id('org')) = 2,
  'departments HCNS and KT exist');

insert into tokens select 'bob', i.token
  from public.invite_member(' Bob@ACME.example ', pg_temp.id('kt'), null, array['dept_head']) i;
insert into tokens select 'carol', i.token
  from public.invite_member('carol@acme.example', pg_temp.id('kt'), null, array['staff']) i;
insert into tokens select 'dan', i.token
  from public.invite_member('dan@acme.example', null, pg_temp.id('pos_gd'), array['leader']) i;
insert into tokens select 'hoa', i.token
  from public.invite_member('hoa@acme.example', pg_temp.id('hcns'), null, array['staff']) i;
select pg_temp.check(
  (select count(*) from public.list_org_invitations()
   where accepted_at is null and revoked_at is null) = 4
  and (select email from public.list_org_invitations() where token = pg_temp.token('bob')) = 'bob@acme.example',
  'four pending invitations; the e-mail is normalised');

-- Eve has the link but is not the invited address
select pg_temp.login(:EVE);
select pg_temp.check(
  pg_temp.error_of(format('select public.get_invitation(%L)', pg_temp.token('bob'))) ~* 'not found'
  and pg_temp.error_of(format('select public.accept_invitation(%L)', pg_temp.token('bob'))) ~* 'not found',
  'an invitation link does not work for another account');

select pg_temp.login(:BOB);
select pg_temp.check(
  pg_temp.bell('org.invite', 'You are invited to join ACME Corporation') = 1,
  'Bob already has an account and sees the invitation in his bell');
select pg_temp.check(
  (select r ->> 'status' = 'pending' and r ->> 'department_name' = 'Kế toán'
   from (select public.get_invitation(pg_temp.token('bob')) as r) x),
  'Bob opens his invitation');
select pg_temp.check(public.accept_invitation(pg_temp.token('bob')) = pg_temp.id('org'), 'Bob joins ACME');
select pg_temp.check(
  pg_temp.error_of(format('select public.accept_invitation(%L)', pg_temp.token('bob'))) ~* 'already accepted',
  'an invitation is accepted once');
select pg_temp.login(:CAROL);
select pg_temp.check(public.accept_invitation(pg_temp.token('carol')) = pg_temp.id('org'), 'Carol joins ACME');
select pg_temp.login(:DAN);
select pg_temp.check(public.accept_invitation(pg_temp.token('dan')) = pg_temp.id('org'), 'Dan joins ACME');
select pg_temp.login(:HOA);
select pg_temp.check(public.accept_invitation(pg_temp.token('hoa')) = pg_temp.id('org'), 'Hoa joins ACME');

-- Alice makes Bob head of KT and gives Dan his title (org UI: department / member dialogs)
select pg_temp.login(:ALICE);
select pg_temp.check(
  (select d.head_user_id = :BOB
   from public.upsert_department(pg_temp.id('kt'), 'Kế toán', 'KT', null, :BOB, null) d),
  'Bob heads KT');
select public.update_member(:DAN, null, pg_temp.id('pos_gd'), array['leader'], 'Giám đốc');
select pg_temp.check(
  (select string_agg(m.email || ':' || array_to_string(m.roles, '+') || ':' || coalesce(m.department_name, '-')
                     || ':' || coalesce(m.position_name, '-'), ' ' order by m.email)
   from public.list_org_members(null, false) m)
  = 'alice@acme.example:org_admin+clerk+leader:-:- bob@acme.example:dept_head:Kế toán:- '
    'carol@acme.example:staff:Kế toán:- dan@acme.example:leader:-:Giám đốc hoa@acme.example:staff:Hành chính nhân sự:-',
  'the directory lists the five members with their roles, departments and positions');

-- ================================================================ 2. registers and types
insert into ids select 'reg_in', r.id from public.doc_registers r
  where r.org_id = pg_temp.id('org') and r.direction = 'incoming'
    and r.year = public.doc_year_for(pg_temp.id('org'), now());
insert into ids select 'reg_out', r.id from public.doc_registers r
  where r.org_id = pg_temp.id('org') and r.direction = 'outgoing'
    and r.year = public.doc_year_for(pg_temp.id('org'), now());
insert into ids select 'cv', t.id from public.doc_types t
  where t.org_id = pg_temp.id('org') and t.name = 'Công văn';
insert into ids select 'qd', t.id from public.doc_types t
  where t.org_id = pg_temp.id('org') and t.abbreviation = 'QĐ';
insert into ids select 'ret_vv', r.id from public.retention_codes r
  where r.org_id = pg_temp.id('org') and r.code = 'VV';
select pg_temp.check(
  (select count(*) from public.doc_registers where org_id = pg_temp.id('org')) = 3
  and pg_temp.id('reg_in') is not null and pg_temp.id('reg_out') is not null
  and pg_temp.id('cv') is not null and pg_temp.id('qd') is not null and pg_temp.id('ret_vv') is not null,
  'the new company has the seeded registers (incoming, outgoing, internal), types and retention codes');
select pg_temp.check(
  public.peek_next_number(pg_temp.id('reg_in')) = 1
  and public.peek_next_number(pg_temp.id('reg_out'), pg_temp.id('qd')) = 1,
  'both registers start at number 1');
insert into ids select 'stc', e.id
  from public.upsert_external_org(null, 'Sở Tài chính', 'STC', 'stc@gov.example', null, true) e;

-- ================================================================ 3. incoming
select pg_temp.login(:ALICE);
insert into ids select 'folder_a', public.ensure_document_folder();
select public.register_file(:FIN1, pg_temp.id('folder_a'), 'cv-88-stc.pdf', 'cv-88-stc.pdf', 'pdf',
  'application/pdf', 10, :FIN1PATH, 'sum-in1');
insert into ids select 'd1', public.create_document('incoming', jsonb_build_object(
  'subject', 'Hướng dẫn quyết toán thuế năm 2026',
  'doc_type_id', pg_temp.id('cv'),
  'issuing_org_name', 'Sở Tài chính',
  'external_org_id', pg_temp.id('stc'),
  'notation', '88/STC-QLNS',
  'issued_date', (public.org_now_date(pg_temp.id('org')) - 3)::text,
  'urgency', 'khan'));
select public.attach_document_file(pg_temp.id('d1'), :FIN1, 'main');

select pg_temp.check(
  public.register_incoming(pg_temp.id('d1'), pg_temp.id('reg_in')) = '{"ok": true, "arrival_number": 1}'::jsonb,
  'Alice (clerk) registers the khẩn document: arrival number 1');
select pg_temp.check(
  (select status = 'registered' and arrival_number = 1 and register_id = pg_temp.id('reg_in')
     and arrival_date = public.org_now_date(pg_temp.id('org'))
     and due_date = public.doc_add_working_days(pg_temp.id('org'), public.org_now_date(pg_temp.id('org')), 2)
   from public.documents where id = pg_temp.id('d1')),
  'registered today with the khẩn default deadline (2 working days)');
select pg_temp.check(
  (select bool_and(frozen) from public.document_files where document_id = pg_temp.id('d1')),
  'registering freezes the main file');
select pg_temp.check(
  pg_temp.error_of(format('select public.add_file_version(%L, %L, 11, %L, %L)',
    :FIN1, :FIN1V2, 'application/pdf', 'sum-in1-v2')) ~* 'locked'
  and pg_temp.error_of(format('select public.rename_file(%L, %L)', :FIN1, 'renamed.pdf')) ~* 'locked'
  and pg_temp.error_of(format('select public.soft_delete_file(%L)', :FIN1)) ~* 'locked',
  'the owner can no longer add a version to, rename or trash the frozen file');

-- the clerk adds a routing slip (phiếu chuyển) while the document is still registered
select public.register_file(:FIN3, pg_temp.id('folder_a'), 'phieu-chuyen.pdf', 'phieu-chuyen.pdf', 'pdf',
  'application/pdf', 13, :FIN3PATH, 'sum-in3');
select public.attach_document_file(pg_temp.id('d1'), :FIN3, 'attachment');

-- duplicate warning: the fax of the same letter
select public.register_file(:FIN2, pg_temp.id('folder_a'), 'cv-88-stc-fax.pdf', 'cv-88-stc-fax.pdf', 'pdf',
  'application/pdf', 12, :FIN2PATH, 'sum-in2');
insert into ids select 'd2', public.create_document('incoming', jsonb_build_object(
  'subject', 'Hướng dẫn quyết toán thuế (bản fax)',
  'doc_type_id', pg_temp.id('cv'),
  'issuing_org_name', 'sở tài chính',
  'notation', '88/stc-qlns',
  'urgency', 'khan'));
select public.attach_document_file(pg_temp.id('d2'), :FIN2, 'main');
insert into vals select 'dup', public.register_incoming(pg_temp.id('d2'), pg_temp.id('reg_in'));
select pg_temp.check(
  (select v -> 'ok' = 'false'::jsonb and jsonb_array_length(v -> 'duplicates') = 1
     and (v -> 'duplicates' -> 0 ->> 'id')::uuid = pg_temp.id('d1')
     and (v -> 'duplicates' -> 0 ->> 'arrival_number')::int = 1
   from vals where k = 'dup')
  and (select status = 'draft' and arrival_number is null from public.documents where id = pg_temp.id('d2'))
  and public.peek_next_number(pg_temp.id('reg_in')) = 2,
  'the same sender notation is reported as a possible duplicate; nothing is registered');
select pg_temp.check(
  public.register_incoming(pg_temp.id('d2'), pg_temp.id('reg_in'), 'Bản fax, bản gốc gửi sau')
    = '{"ok": true, "arrival_number": 2}'::jsonb,
  'with the override reason it is registered as number 2');
select public.cancel_incoming(pg_temp.id('d2'), 'Trùng bản fax');
select pg_temp.check(
  (select status = 'cancelled' and arrival_number = 2 from public.documents where id = pg_temp.id('d2')),
  'the clerk cancels the fax copy; it keeps its number');

-- present to Dan (leader)
select public.submit_incoming(pg_temp.id('d1'), :DAN, 'Kính trình Giám đốc xem xét');
select pg_temp.check(
  (select status = 'submitted' and presented_to = :DAN from public.documents where id = pg_temp.id('d1')),
  'presented to Dan');

select pg_temp.login(:DAN);
select pg_temp.check(pg_temp.in_view('needs_me', pg_temp.id('d1')), 'the document is in Dan''s needs_me view');
select pg_temp.check(
  pg_temp.bell('document.submitted', '[URGENT] New incoming document: Hướng dẫn quyết toán thuế năm 2026') = 1,
  'Dan is notified, marked [URGENT]');
select pg_temp.check(
  public.assign_document(pg_temp.id('d1'), jsonb_build_array(
    jsonb_build_object('department_id', pg_temp.id('kt'), 'role', 'lead',
      'due_date', public.doc_add_working_days(pg_temp.id('org'), public.org_now_date(pg_temp.id('org')), 3)),
    jsonb_build_object('user_id', :CAROL, 'role', 'info')
  ), null, 'Phòng KT chủ trì tham mưu') = 2,
  'Dan assigns KT as lead with a deadline and Carol for information');
insert into ids select 'a_kt', id from public.document_assignments
  where document_id = pg_temp.id('d1') and assignee_department_id = pg_temp.id('kt');
insert into ids select 'a_carol_info', id from public.document_assignments
  where document_id = pg_temp.id('d1') and assignee_user_id = :CAROL and role = 'info';
select pg_temp.check(
  (select status = 'in_progress'
     and due_date = public.doc_add_working_days(pg_temp.id('org'), public.org_now_date(pg_temp.id('org')), 3)
   from public.documents where id = pg_temp.id('d1')),
  'in progress; the lead''s deadline becomes the document''s');

-- Bob (head of KT) passes it on to Carol
select pg_temp.login(:BOB);
select pg_temp.check(
  public.can_read_document(pg_temp.id('d1')) and pg_temp.in_view('needs_me', pg_temp.id('d1')),
  'Bob reads it through his department''s assignment and it needs him');
select pg_temp.check(
  pg_temp.bell('document.assigned', '[URGENT] You are the lead for: %') = 1,
  'Bob is told KT leads');
select pg_temp.check(
  public.assign_document(pg_temp.id('d1'),
    jsonb_build_array(jsonb_build_object('user_id', :CAROL, 'role', 'lead', 'instruction', 'Carol soạn báo cáo')),
    pg_temp.id('a_kt')) = 1,
  'Bob sub-assigns Carol under the KT assignment');
insert into ids select 'a_carol', id from public.document_assignments
  where document_id = pg_temp.id('d1') and assignee_user_id = :CAROL and parent_id = pg_temp.id('a_kt');
select pg_temp.check(
  (select role = 'lead' and assigned_by = :BOB
     and due_date = (select due_date from public.document_assignments where id = pg_temp.id('a_kt'))
   from public.document_assignments where id = pg_temp.id('a_carol')),
  'Carol''s sub-assignment inherits the department deadline');

-- Carol works
select pg_temp.login(:CAROL);
select pg_temp.check(
  pg_temp.in_view('needs_me', pg_temp.id('d1')) and pg_temp.in_view('for_info', pg_temp.id('d1'))
  and (public.document_dashboard() ->> 'needs_me')::int >= 1
  and (public.document_dashboard() ->> 'urgent')::int >= 1,
  'Carol sees it in needs_me and for_info; the dashboard counts it (urgent)');
select pg_temp.check(
  pg_temp.bell('document.assigned', '[URGENT] %') = 2,
  'Carol was notified twice (info from Dan, lead from Bob)');
select pg_temp.check(
  (select r -> 'document' ->> 'status' = 'in_progress'
     and jsonb_array_length(r -> 'files') = 2
   from (select public.get_document(pg_temp.id('d1')) as r) x),
  'Carol opens the document page');
select pg_temp.check(public.mark_my_assignments_seen(pg_temp.id('d1')) = 2, 'Carol''s two assignments are seen');
select public.update_assignment(pg_temp.id('a_carol'), 'in_progress');
select public.update_assignment(pg_temp.id('a_carol'), 'done', 'Đã soạn báo cáo quyết toán thuế');
select pg_temp.check(
  (select status = 'done' and result = 'Đã soạn báo cáo quyết toán thuế'
   from public.document_assignments where id = pg_temp.id('a_carol')),
  'Carol reports her result');
select pg_temp.check(
  public.has_file_access(:FIN1) and public.has_file_access(:FIN1, 'viewer')
  and not public.has_file_access(:FIN1, 'editor'),
  'Carol can read the frozen file through the document, not edit it');

select pg_temp.login(:BOB);
select pg_temp.check(
  pg_temp.bell('document.assignment_updated', '[URGENT] Carol finished: %') = 1,
  'Bob hears that Carol finished');
select public.update_assignment(pg_temp.id('a_kt'), 'done', 'Phòng KT đã hoàn thành báo cáo');

select pg_temp.login(:DAN);
select pg_temp.check(
  pg_temp.bell('document.assignment_updated', '[URGENT] Bob finished: %') = 1,
  'Dan hears that KT (Bob) finished');
select public.complete_document(pg_temp.id('d1'), 'Đã báo cáo Sở Tài chính');
select pg_temp.check(
  (select status = 'completed' and completed_at is not null and result_note = 'Đã báo cáo Sở Tài chính'
   from public.documents where id = pg_temp.id('d1')),
  'Dan completes the document');

-- timeline (the document page reads it through RLS)
select pg_temp.check(
  (select string_agg(action, ',' order by id) from public.document_events where document_id = pg_temp.id('d1'))
  = 'created,file_attached,registered,file_attached,submitted,assigned,assigned,seen,'
    'assignment_updated,assignment_updated,assignment_updated,completed',
  'the incoming timeline has the canonical actions in order');
select pg_temp.check(
  (select (data ->> 'arrival_number')::int = 1 and actor_id = :ALICE
   from public.document_events where document_id = pg_temp.id('d1') and action = 'registered')
  and (select not (data ? 'override') and data ? 'result_note' and actor_id = :DAN
       from public.document_events where document_id = pg_temp.id('d1') and action = 'completed')
  and (select data ->> 'duplicate_reason' = 'Bản fax, bản gốc gửi sau'
       from public.document_events where document_id = pg_temp.id('d2') and action = 'registered'),
  'events carry the actor, the arrival number and the duplicate override reason');

-- outsider: no company at all
select pg_temp.login(:EVE);
select pg_temp.check(
  not public.can_read_document(pg_temp.id('d1'))
  and (select count(*) from public.documents) = 0
  and (select count(*) from public.document_files) = 0
  and not public.has_file_access(:FIN1)
  and (select count(*) from public.files where id = :FIN1) = 0
  and pg_temp.error_of(format('select public.get_document(%L)', pg_temp.id('d1'))) ~* 'not found'
  and pg_temp.error_of(format('select public.create_document(%L, %L)', 'outgoing', '{"subject": "x"}')) ~* 'join a company',
  'Eve (not in the company) cannot read the document or its file, nor create documents');

-- ================================================================ 4. outgoing
select pg_temp.login(:CAROL);
insert into ids select 'folder_c', public.ensure_document_folder();
select public.register_file(:FOUT1, pg_temp.id('folder_c'), 'qd-khen-thuong.pdf', 'qd-khen-thuong.pdf', 'pdf',
  'application/pdf', 20, :FOUT1PATH, 'sum-o1-v1');
insert into ids select 'o1', public.create_document('outgoing', jsonb_build_object(
  'subject', 'Quyết định khen thưởng phòng Kế toán', 'doc_type_id', pg_temp.id('qd')));
select public.attach_document_file(pg_temp.id('o1'), :FOUT1, 'main');
select pg_temp.check(
  (select status = 'draft' and drafting_department_id = pg_temp.id('kt') and created_by = :CAROL
   from public.documents where id = pg_temp.id('o1')),
  'Carol drafts a Quyết định for KT');

select pg_temp.login(:HOA);
select pg_temp.check(
  not public.can_read_document(pg_temp.id('o1'))
  and (select count(*) from public.documents where id = pg_temp.id('o1')) = 0
  and not public.has_file_access(:FOUT1),
  'Hoa (another department) cannot read the unsubmitted draft');
select pg_temp.login(:ALICE);
select pg_temp.check(
  not public.can_read_document(pg_temp.id('o1')),
  'not even the admin/clerk/leader reads a draft that was never submitted');
select pg_temp.login(:BOB);
select pg_temp.check(
  not public.can_read_document(pg_temp.id('o1')),
  'nor the head of the drafting department');

select pg_temp.login(:CAROL);
select pg_temp.check(
  public.set_approval_chain(pg_temp.id('o1'), jsonb_build_array(
    jsonb_build_object('approver_user_id', :BOB, 'kind', 'review'),
    jsonb_build_object('approver_user_id', :DAN, 'kind', 'sign'))) = 2,
  'Carol sets the chain: Bob reviews, Dan signs');
select public.submit_for_approval(pg_temp.id('o1'));
select pg_temp.check(
  (select status = 'in_review' and current_step_no = 1 and revision = 1
   from public.documents where id = pg_temp.id('o1'))
  and (select bool_and(frozen) from public.document_files where document_id = pg_temp.id('o1')),
  'submitted: in review and the file is frozen');
select pg_temp.check(
  pg_temp.error_of(format('select public.add_file_version(%L, %L, 21, %L, %L)',
    :FOUT1, :FOUT1V2, 'application/pdf', 'sum-o1-v2')) ~* 'locked',
  'the author cannot change the file while it is reviewed');

select pg_temp.login(:BOB);
select pg_temp.check(
  pg_temp.in_view('awaiting_approval', pg_temp.id('o1'))
  and pg_temp.bell('document.approval_requested', 'Please review: Quyết định khen thưởng phòng Kế toán') = 1,
  'Bob is asked to review');
select public.return_document(pg_temp.id('o1'), 'Bổ sung danh sách cá nhân được khen thưởng');
select pg_temp.check(
  (select status = 'draft' and revision = 2 from public.documents where id = pg_temp.id('o1'))
  and not (select bool_or(frozen) from public.document_files where document_id = pg_temp.id('o1')),
  'Bob returns it: revision 2, the file is editable again');

select pg_temp.login(:CAROL);
select pg_temp.check(
  pg_temp.in_view('needs_me', pg_temp.id('o1'))
  and pg_temp.bell('document.returned_for_revision', 'Bob returned for revision: %') = 1,
  'the returned draft needs Carol and she is told');
select pg_temp.check(
  pg_temp.error_of(format('select public.add_file_version(%L, %L, 21, %L, %L)',
    :FOUT1, :FOUT1V2, 'application/pdf', 'sum-o1-v2')) is null,
  'Carol uploads a new version');
select public.submit_for_approval(pg_temp.id('o1'));

select pg_temp.login(:BOB);
select public.approve_step(pg_temp.id('o1'), 'Đồng ý trình ký');
select pg_temp.check(
  (select status = 'awaiting_signature' and current_step_no = 2 from public.documents where id = pg_temp.id('o1')),
  'Bob approves: it waits for Dan''s signature');

select pg_temp.login(:DAN);
select pg_temp.check(
  pg_temp.in_view('needs_me', pg_temp.id('o1'))
  and pg_temp.bell('document.approval_requested', 'Please sign: Quyết định khen thưởng phòng Kế toán') = 1,
  'Dan is asked to sign');
select public.sign_document(pg_temp.id('o1'), 'KT', 'Ký ban hành');
select pg_temp.check(
  (select status = 'signed' and signer_user_id = :DAN and signer_authority = 'KT'
     and signer_name = 'Dan' and signer_position = 'Giám đốc' and signed_checksum = 'sum-o1-v2'
   from public.documents where id = pg_temp.id('o1')),
  'Dan signs: signer, authority (KT), position and the checksum of version 2 are recorded');

select pg_temp.login(:ALICE);
select pg_temp.check(
  pg_temp.in_view('to_issue', pg_temp.id('o1'))
  and pg_temp.bell('document.ready_to_issue', 'Ready to issue: Quyết định khen thưởng phòng Kế toán') = 1,
  'the clerk sees it ready to issue');
insert into vals select 'o1', public.issue_document(pg_temp.id('o1'), pg_temp.id('reg_out'), jsonb_build_array(
  jsonb_build_object('kind', 'department', 'department_id', pg_temp.id('hcns')),
  jsonb_build_object('kind', 'external', 'external_org_id', pg_temp.id('stc'), 'method', 'email')));
select pg_temp.check(
  (select (v ->> 'number')::int = 1
     and v ->> 'notation' = public.doc_render_notation(
       (select notation_template from public.doc_registers where id = pg_temp.id('reg_out')),
       1, 'QĐ', 'ABC', 'KT', public.doc_year_for(pg_temp.id('org'), now()))
     and v ->> 'notation' = '01/QĐ-ABC'
   from vals where k = 'o1'),
  'Alice issues it as number 1, notation 01/QĐ-ABC (the register template)');
select pg_temp.check(
  (select status = 'issued' and number = 1 and notation = '01/QĐ-ABC' and register_id = pg_temp.id('reg_out')
   from public.documents where id = pg_temp.id('o1'))
  and (select bool_and(frozen) from public.document_files where document_id = pg_temp.id('o1'))
  and (select count(*) from public.document_assignments
       where document_id = pg_temp.id('o1') and role = 'info' and status = 'pending'
         and assignee_department_id = pg_temp.id('hcns')) = 1
  and (select string_agg(kind || ':' || name_snapshot || ':' || method, ' / ' order by kind)
       from public.document_recipients where document_id = pg_temp.id('o1'))
      = 'department:Hành chính nhân sự:system / external:Sở Tài chính:email',
  'issued and frozen; HCNS gets an info assignment; recipients are recorded');

select pg_temp.login(:HOA);
select pg_temp.check(
  public.can_read_document(pg_temp.id('o1'))
  and public.has_file_access(:FOUT1)
  and pg_temp.in_view('for_info', pg_temp.id('o1')),
  'Hoa (HCNS) now reads the issued document and its file, in her for_info view');
select pg_temp.login(:CAROL);
select pg_temp.check(
  pg_temp.bell('document.issued', 'New document: 01/QĐ-ABC – Quyết định khen thưởng phòng Kế toán') = 1,
  'the author hears about the issue');

-- a second decision in the same register
select public.register_file(:FOUT2, pg_temp.id('folder_c'), 'qd-nang-luong.pdf', 'qd-nang-luong.pdf', 'pdf',
  'application/pdf', 22, :FOUT2PATH, 'sum-o2');
insert into ids select 'o2', public.create_document('outgoing', jsonb_build_object(
  'subject', 'Quyết định nâng lương', 'doc_type_id', pg_temp.id('qd')));
select public.attach_document_file(pg_temp.id('o2'), :FOUT2, 'main');
select public.set_approval_chain(pg_temp.id('o2'), jsonb_build_array(
  jsonb_build_object('approver_user_id', :DAN, 'kind', 'sign')));
select public.submit_for_approval(pg_temp.id('o2'));
select pg_temp.login(:DAN);
select public.sign_document(pg_temp.id('o2'));
select pg_temp.login(:ALICE);
select pg_temp.check(public.peek_next_number(pg_temp.id('reg_out'), pg_temp.id('qd')) = 2, 'the preview shows number 2');
insert into vals select 'o2', public.issue_document(pg_temp.id('o2'), pg_temp.id('reg_out'), jsonb_build_array(
  jsonb_build_object('kind', 'department', 'department_id', pg_temp.id('hcns'))));
select pg_temp.check(
  (select v = '{"number": 2, "notation": "02/QĐ-ABC"}'::jsonb from vals where k = 'o2'),
  'the second issue in the register gets number 2 (02/QĐ-ABC)');

select pg_temp.login(:HOA);
select pg_temp.check(public.can_read_document(pg_temp.id('o2')), 'Hoa reads the second decision');
select pg_temp.login(:ALICE);
select public.recall_document(pg_temp.id('o2'), 'Sai đối tượng áp dụng');
select pg_temp.check(
  (select status = 'recalled' and recall_reason = 'Sai đối tượng áp dụng' and recalled_at is not null
   from public.documents where id = pg_temp.id('o2'))
  and (select data ->> 'reason' = 'Sai đối tượng áp dụng' and actor_id = :ALICE and to_status = 'recalled'
       from public.document_events where document_id = pg_temp.id('o2') and action = 'recalled')
  and (select count(*) from public.document_assignments
       where document_id = pg_temp.id('o2') and status <> 'revoked') = 0,
  'Alice recalls it; the recall is logged and the info assignments are revoked');
select pg_temp.login(:HOA);
select pg_temp.check(
  not public.can_read_document(pg_temp.id('o2')) and public.can_read_document(pg_temp.id('o1')),
  'after the recall HCNS no longer reads it (the first decision stays readable)');

select pg_temp.check(
  (select string_agg(action, ',' order by id) from public.document_events where document_id = pg_temp.id('o1'))
  = 'created,file_attached,chain_set,submitted_for_approval,returned,submitted_for_approval,approved,signed,issued',
  'the outgoing timeline has the canonical actions in order');

-- ================================================================ 5. dossier
select pg_temp.login(:ALICE);
insert into ids select 'dossier', d.id from public.create_dossier(
  public.doc_year_for(pg_temp.id('org'), now()), 'HS-01', 'Hồ sơ quyết toán thuế', null, pg_temp.id('ret_vv')) d;
select pg_temp.check(public.add_document_to_dossier(pg_temp.id('dossier'), pg_temp.id('d1')) = 1, 'the incoming document is filed first');
select pg_temp.check(public.add_document_to_dossier(pg_temp.id('dossier'), pg_temp.id('o1')) = 2, 'the decision is filed second');
-- an incoming letter still being entered (draft): its scan is not frozen
select public.register_file(:FIN4, pg_temp.id('folder_a'), 'bien-ban-nhap.pdf', 'bien-ban-nhap.pdf', 'pdf',
  'application/pdf', 14, :FIN4PATH, 'sum-in4');
insert into ids select 'd3', public.create_document('incoming', jsonb_build_object(
  'subject', 'Biên bản kiểm tra thuế (đang nhập)', 'doc_type_id', pg_temp.id('cv'),
  'issuing_org_name', 'Chi cục Thuế', 'notation', '15/BB-CCT'));
select public.attach_document_file(pg_temp.id('d3'), :FIN4, 'main');
select pg_temp.check(public.add_document_to_dossier(pg_temp.id('dossier'), pg_temp.id('d3')) = 3, 'the draft letter is filed third');
select pg_temp.check(
  (select d.status = 'closed' and d.end_date = public.org_now_date(pg_temp.id('org'))
     and d.transfer_due_date = (public.org_now_date(pg_temp.id('org')) + interval '1 year')::date
   from public.close_dossier(pg_temp.id('dossier')) d),
  'Alice closes the dossier; transfer is due one year later');
select pg_temp.check(
  (select count(*) from public.document_events
   where action = 'filed' and document_id in (pg_temp.id('d1'), pg_temp.id('o1'))) = 2,
  'filing is logged on both documents');

-- 045: the routing slip attached after registration was frozen at once;
-- the draft letter's scan is not frozen, so only the legal hold protects it
select pg_temp.check(
  (select frozen from public.document_files where document_id = pg_temp.id('d1') and file_id = :FIN3)
  and (select not frozen from public.document_files where document_id = pg_temp.id('d3') and file_id = :FIN4),
  'the attachment added after registration is frozen; the draft''s file is not');
select pg_temp.check(
  (select d.legal_hold from public.set_dossier_legal_hold(pg_temp.id('dossier'), true) d),
  'Alice puts the dossier on legal hold');
select pg_temp.check(
  pg_temp.error_of(format('select public.soft_delete_file(%L)', :FIN4)) ~* 'legal hold'
  and pg_temp.error_of(format('select public.hard_delete_file(%L)', :FIN4)) ~* 'legal hold'
  and pg_temp.error_of(format('select public.delete_document(%L)', pg_temp.id('d3'))) ~* 'legal hold'
  and pg_temp.error_of(format('select public.hard_delete_file(%L)', :FIN3)) ~* 'locked'
  and pg_temp.error_of(format('select public.hard_delete_file(%L)', :FIN1)) is not null
  and (select count(*) from public.files where id in (:FIN1, :FIN3, :FIN4) and deleted_at is null) = 3,
  'legal hold blocks trashing or deleting the documents and their unfrozen files (frozen ones stay locked)');
select pg_temp.login(:CAROL);
select pg_temp.check(
  pg_temp.error_of(format('select public.hard_delete_file(%L)', :FOUT1)) is not null
  and (select count(*) from public.files where id = :FOUT1) = 1,
  'Carol cannot delete the decision''s file either');

-- ================================================================ 6. offboarding
select pg_temp.login(:CAROL);
insert into ids select 'o3', public.create_document('outgoing', jsonb_build_object(
  'subject', 'Dự thảo quy chế chi tiêu nội bộ', 'doc_type_id', pg_temp.id('qd')));

select pg_temp.login(:ALICE);
select pg_temp.check(public.offboarding_preview(:CAROL) is not null, 'Alice previews Carol''s handover');
insert into vals select 'offboard', public.offboard_member(:CAROL, :BOB);
select pg_temp.check(
  (select (v ->> 'assignments')::int = 1 and (v ->> 'draft_documents')::int = 1
     and (v ->> 'files')::int = 2 and (v ->> 'folders')::int = 1
   from vals where k = 'offboard'),
  'offboarding moves one open assignment, one draft, two files and one folder');
select pg_temp.check(
  (select assignee_user_id = :BOB and status = 'pending'
   from public.document_assignments where id = pg_temp.id('a_carol_info'))
  and (select assignee_user_id = :CAROL and status = 'done'
       from public.document_assignments where id = pg_temp.id('a_carol')),
  'Carol''s open info assignment moves to Bob; her finished work stays hers');
select pg_temp.check(
  (select status = 'left' and left_at is not null from public.org_members
   where org_id = pg_temp.id('org') and user_id = :CAROL),
  'Carol''s membership is left');
select pg_temp.check(
  (select count(*) from public.document_events
   where document_id = pg_temp.id('d1') and action = 'reassigned'
     and data ->> 'reason' = 'offboarding') = 1,
  'the move is logged on the document');

select pg_temp.login(:BOB);
select pg_temp.check(
  pg_temp.bell('org.handover', 'You received work from Carol') = 1
  and public.can_read_document(pg_temp.id('o3')),
  'Bob is told about the handover and reads the draft');
select pg_temp.check(
  (select created_by = :BOB from public.documents where id = pg_temp.id('o3'))
  and (select count(*) from public.files where id in (:FOUT1, :FOUT2) and owner_id = :BOB) = 2,
  'her draft and her files now belong to Bob');

select pg_temp.login(:CAROL);
select pg_temp.check(
  public.get_my_org() is null
  and not public.can_read_document(pg_temp.id('d1'))
  and not public.can_read_document(pg_temp.id('o1'))
  and (select count(*) from public.documents) = 0,
  'Carol (left) no longer belongs to ACME nor reads its documents');

-- ================================================================ 7. security
-- another company
select pg_temp.login(:FRANK);
insert into ids select 'org2', o.id from public.create_organization('XYZ Trading', 'XYZ') o;
select pg_temp.check(
  not public.can_read_document(pg_temp.id('d1'))
  and not public.can_read_document(pg_temp.id('o1'))
  and (select count(*) from public.documents) = 0
  and (select count(*) from public.document_events) = 0
  and (select count(*) from public.doc_registers where org_id = pg_temp.id('org')) = 0
  and (select count(*) from public.search_documents('{"view": "all"}', 200, 0)) = 0
  and not public.has_file_access(:FOUT1)
  and pg_temp.error_of(format('select public.get_document(%L)', pg_temp.id('o1'))) ~* 'not found'
  and pg_temp.error_of(format('select public.add_document_to_dossier(%L, %L)',
    pg_temp.id('dossier'), pg_temp.id('o1'))) ~* 'not found'
  and pg_temp.error_of(format('select public.recall_document(%L, %L)', pg_temp.id('o1'), 'x')) ~* 'not found'
  and pg_temp.error_of(format('select public.assign_document(%L, %L::jsonb)', pg_temp.id('d1'),
    jsonb_build_array(jsonb_build_object('user_id', :FRANK, 'role', 'lead')))) ~* 'not found',
  'a member of another company cannot read or act on ACME documents');

-- anon (signed out)
reset role;
set local role anon;
select set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', 'anon', true);
select pg_temp.check(bad is null, 'anon cannot call any of the RPCs used above' || coalesce(' (not denied: ' || bad || ')', ''))
from (select string_agg(stmt, '; ' order by stmt) as bad from (values
    ('select public.create_organization(''x'', ''XX'')'),
    ('select public.get_my_org()'),
    ('select public.upsert_department(null, ''x'', ''X'', null, null, null)'),
    ('select public.upsert_position(null, ''x'', 1, true)'),
    ('select public.invite_member(''a@b.c'', null, null, array[''staff''])'),
    ('select public.list_org_invitations()'),
    ('select public.get_invitation(''x'')'),
    ('select public.accept_invitation(''x'')'),
    ('select public.update_member(gen_random_uuid(), null, null, array[''staff''], null)'),
    ('select public.list_org_members(null, false)'),
    ('select public.upsert_external_org(null, ''x'', null, null, null, true)'),
    ('select public.peek_next_number(gen_random_uuid(), null)'),
    ('select public.ensure_document_folder()'),
    ('select public.register_file(gen_random_uuid(), null, ''x'', ''x'', ''pdf'', ''application/pdf'', 1, ''x'')'),
    ('select public.add_file_version(gen_random_uuid(), ''x'', 1, ''application/pdf'')'),
    ('select public.rename_file(gen_random_uuid(), ''x'')'),
    ('select public.soft_delete_file(gen_random_uuid())'),
    ('select public.hard_delete_file(gen_random_uuid())'),
    ('select public.create_document(''outgoing'', ''{}'')'),
    ('select public.attach_document_file(gen_random_uuid(), gen_random_uuid(), ''main'')'),
    ('select public.get_document(gen_random_uuid())'),
    ('select public.can_read_document(gen_random_uuid())'),
    ('select public.has_file_access(gen_random_uuid(), ''viewer'')'),
    ('select public.register_incoming(gen_random_uuid(), gen_random_uuid(), null)'),
    ('select public.cancel_incoming(gen_random_uuid(), ''x'')'),
    ('select public.submit_incoming(gen_random_uuid(), gen_random_uuid(), null)'),
    ('select public.assign_document(gen_random_uuid(), ''[]'', null, null)'),
    ('select public.mark_my_assignments_seen(gen_random_uuid())'),
    ('select public.update_assignment(gen_random_uuid(), ''done'', null)'),
    ('select public.complete_document(gen_random_uuid(), null)'),
    ('select public.set_approval_chain(gen_random_uuid(), ''[]'')'),
    ('select public.submit_for_approval(gen_random_uuid())'),
    ('select public.approve_step(gen_random_uuid(), null)'),
    ('select public.return_document(gen_random_uuid(), ''x'')'),
    ('select public.sign_document(gen_random_uuid(), '''', null)'),
    ('select public.issue_document(gen_random_uuid(), gen_random_uuid(), ''[]'', null)'),
    ('select public.recall_document(gen_random_uuid(), ''x'')'),
    ('select public.search_documents(''{}'', 50, 0)'),
    ('select public.document_dashboard()'),
    ('select public.list_notifications(null, 30)'),
    ('select public.create_dossier(2026, ''x'', ''x'', null, null, null)'),
    ('select public.add_document_to_dossier(gen_random_uuid(), gen_random_uuid())'),
    ('select public.close_dossier(gen_random_uuid(), null)'),
    ('select public.set_dossier_legal_hold(gen_random_uuid(), true)'),
    ('select public.offboarding_preview(gen_random_uuid())'),
    ('select public.offboard_member(gen_random_uuid(), gen_random_uuid())')
  ) s(stmt)
  -- the refusal must be for the RPC itself, not for something it calls
  where coalesce(pg_temp.error_of(stmt), '')
    !~* ('permission denied for function ' || substring(stmt from 'public\.(\w+)\('))) z;
select pg_temp.check(
  pg_temp.error_of('select count(*) from public.documents') ~* 'permission denied'
  and pg_temp.error_of('select count(*) from public.document_files') ~* 'permission denied'
  and pg_temp.error_of('select count(*) from public.org_members') ~* 'permission denied',
  'anon cannot read the tables');

rollback;
