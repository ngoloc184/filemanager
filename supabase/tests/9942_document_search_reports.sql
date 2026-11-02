-- Documents: inbox views, search, dashboard counts, reports and reminders.
-- Run with scripts/test-db.sh (plain PostgreSQL + supabase/tests stubs).
-- Everything runs in one transaction that is rolled back at the end.
-- Dates are relative to the company's today (org_now_date), as the RPCs use.

\set ON_ERROR_STOP 1
\o /dev/null
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B '''bbbbbbbb-0000-0000-0000-00000000000b'''
\set C '''cccccccc-0000-0000-0000-00000000000c'''
\set D '''dddddddd-0000-0000-0000-00000000000d'''
\set H '''eeeeeeee-0000-0000-0000-00000000000e'''
\set ORG '''0a000000-0000-0000-0000-0000000000a1'''
\set ORG2 '''0a000000-0000-0000-0000-0000000000a2'''
\set HC '''0d000000-0000-0000-0000-0000000000d1'''
\set KT '''0d000000-0000-0000-0000-0000000000d2'''
\set OPS '''0d000000-0000-0000-0000-0000000000d3'''
\set TCV '''07000000-0000-0000-0000-000000000071'''
\set DLEAD '''d0000000-0000-0000-0000-000000000001'''
\set DSOON '''d0000000-0000-0000-0000-000000000002'''
\set DINFO '''d0000000-0000-0000-0000-000000000003'''
\set DAPPR '''d0000000-0000-0000-0000-000000000004'''
\set DSIGN '''d0000000-0000-0000-0000-000000000005'''
\set DREG '''d0000000-0000-0000-0000-000000000006'''
\set DDONE '''d0000000-0000-0000-0000-000000000007'''
\set DDEPT '''d0000000-0000-0000-0000-000000000008'''
\set DISS '''d0000000-0000-0000-0000-000000000009'''
\set DLATE '''d0000000-0000-0000-0000-00000000000a'''
\set DOTHER '''d0000000-0000-0000-0000-0000000000f2'''
\set DORPHAN '''d0000000-0000-0000-0000-0000000000f3'''
\set F1 '''f1000000-0000-0000-0000-0000000000f1'''

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

-- ids of a view for the signed-in user
create function pg_temp.view_ids(p_view text) returns uuid[]
language sql as $$
  select coalesce(array_agg(s.id), '{}')
  from public.search_documents(jsonb_build_object('view', p_view), 200, 0) s;
$$;

-- ---------------------------------------------------------------- fixtures
insert into auth.users (id, email) values
  (:A, 'alice@example.com'),
  (:B, 'bob@example.com'),
  (:C, 'carol@example.com'),
  (:D, 'dave@example.com'),
  (:H, 'hana@example.com');
insert into public.user_profiles (id, email) values
  (:A, 'alice@example.com'),
  (:B, 'bob@example.com'),
  (:C, 'carol@example.com'),
  (:D, 'dave@example.com'),
  (:H, 'hana@example.com')
on conflict (id) do nothing;
update public.user_profiles set display_name = 'Bob Trần' where id = :B;

-- ABC: Alice admin/leader/clerk and Bob staff in HCNS; Carol staff and Hana
-- head of KT. XYZ: Dave.
insert into public.organizations (id, name, code, created_by) values
  (:ORG, 'ABC Corporation', 'ABC', :A),
  (:ORG2, 'XYZ Company', 'XYZ', :D);
insert into public.departments (id, org_id, name, code, head_user_id) values
  (:HC, :ORG, 'Hành chính nhân sự', 'HCNS', null),
  (:KT, :ORG, 'Kế toán', 'KT', :H),
  (:OPS, :ORG2, 'Operations', 'OPS', null);
insert into public.org_members (org_id, user_id, department_id, roles) values
  (:ORG, :A, :HC, '{org_admin,clerk,leader}'),
  (:ORG, :B, :HC, '{staff}'),
  (:ORG, :C, :KT, '{staff}'),
  (:ORG, :H, :KT, '{dept_head}'),
  (:ORG2, :D, :OPS, '{org_admin,clerk,leader}');
insert into public.doc_types (id, org_id, name, abbreviation, is_cong_van) values
  (:TCV, :ORG, 'Công văn', '', true);

create temp table t as select public.org_now_date(:ORG) as today;
grant select on t to authenticated, anon, service_role;

-- Incoming, in progress: Bob leads, due yesterday (Alice assigned it).
insert into public.documents (id, org_id, direction, status, subject, arrival_number, arrival_date,
                              doc_type_id, created_by, presented_to)
select :DLEAD, :ORG, 'incoming', 'in_progress', 'Hợp đồng thuê văn phòng', 1, today, :TCV, :A, :A from t;
insert into public.document_assignments (document_id, assignee_user_id, role, due_date, assigned_by, status)
select :DLEAD, :B, 'lead', today - 1, :A, 'pending' from t;

-- Incoming, urgent: Bob leads, due tomorrow (the document's own deadline too:
-- it must not put the document in due_soon for readers it does not need).
insert into public.documents (id, org_id, direction, status, subject, arrival_number, arrival_date,
                              urgency, due_date, created_by)
select :DSOON, :ORG, 'incoming', 'in_progress', 'Báo cáo quý', 2, today, 'khan', today + 1, :A from t;
insert into public.document_assignments (document_id, assignee_user_id, role, due_date, assigned_by, status)
select :DSOON, :B, 'lead', today + 1, :A, 'seen' from t;

-- Incoming: Bob for information only.
insert into public.documents (id, org_id, direction, status, subject, arrival_number, arrival_date, created_by)
select :DINFO, :ORG, 'incoming', 'in_progress', 'Thông báo nghỉ lễ', 3, today, :A from t;
insert into public.document_assignments (document_id, assignee_user_id, role, assigned_by, status)
values (:DINFO, :B, 'info', :A, 'pending');

-- Outgoing in review: Bob's approval step is pending.
insert into public.documents (id, org_id, direction, status, subject, created_by, submitted_at, revision, current_step_no)
values (:DAPPR, :ORG, 'outgoing', 'in_review', 'Kế hoạch đào tạo', :C, now(), 1, 1);
insert into public.document_approval_steps (document_id, revision, step_no, kind, approver_user_id, status)
values (:DAPPR, 1, 1, 'review', :B, 'pending');

-- Outgoing signed, waiting for the clerk; Bob can read it but is no clerk.
insert into public.documents (id, org_id, direction, status, subject, created_by, submitted_at, signed_at)
values (:DSIGN, :ORG, 'outgoing', 'signed', 'Quyết định khen thưởng', :C, now() - interval '5 hours', now());
insert into public.document_grants (document_id, user_id, access, granted_by) values (:DSIGN, :B, 'read', :C);

-- Incoming draft waiting to be registered.
insert into public.documents (id, org_id, direction, status, subject, created_by)
values (:DREG, :ORG, 'incoming', 'draft', 'Giấy mời họp', :A);

-- Incoming completed: Carol finished her lead on time; it has an indexed file.
insert into public.documents (id, org_id, direction, status, subject, arrival_number, arrival_date, created_by)
select :DDONE, :ORG, 'incoming', 'completed', 'Đề nghị thanh toán', 4, today, :A from t;
insert into public.document_assignments (document_id, assignee_user_id, role, due_date, assigned_by,
                                         assigned_at, status, done_at)
select :DDONE, :C, 'lead', today + 1, :A, now() - interval '2 days', 'done', now() from t;
insert into public.files (id, owner_id, name, original_name, extension)
values (:F1, :C, 'bien-ban.txt', 'bien-ban.txt', 'txt');
insert into public.document_files (document_id, file_id, kind) values (:DDONE, :F1, 'main');
insert into public.file_contents (file_id, version_id, status, content, char_count)
values (:F1, null, 'indexed', 'Biên bản nghiệm thu công trình', 30);

-- Incoming: the KT department leads, due in a week.
insert into public.documents (id, org_id, direction, status, subject, arrival_number, arrival_date, created_by)
select :DDEPT, :ORG, 'incoming', 'in_progress', 'Kiểm kê tài sản', 5, today, :A from t;
insert into public.document_assignments (document_id, assignee_department_id, role, due_date, assigned_by, status)
select :DDEPT, :KT, 'lead', today + 7, :A, 'pending' from t;

-- Outgoing issued (report_outgoing): signed 4 hours after submission.
insert into public.documents (id, org_id, direction, status, subject, doc_type_id, created_by,
                              submitted_at, signed_at, issued_at, issued_date, number, notation)
select :DISS, :ORG, 'outgoing', 'issued', 'Công văn gửi đối tác', :TCV, :C,
       now() - interval '4 hours', now(), now(), today, 1, '01/ABC-KT' from t;

-- Alice registered the first one (the 'done' view).
insert into public.document_events (org_id, document_id, actor_id, action, from_status, to_status)
values (:ORG, :DLEAD, :A, 'registered', 'draft', 'registered');

-- XYZ has a document with the same subject.
insert into public.documents (id, org_id, direction, status, subject, arrival_number, arrival_date, created_by)
select :DOTHER, :ORG2, 'incoming', 'in_progress', 'Hợp đồng thuê văn phòng', 1, today, :D from t;
-- XYZ: submitted to a leader whose account is gone (presented_to null), due
-- tomorrow. It needs nobody, so it is in nobody's due_soon.
insert into public.documents (id, org_id, direction, status, subject, arrival_number, arrival_date,
                              due_date, presented_to, created_by)
select :DORPHAN, :ORG2, 'incoming', 'submitted', 'Tờ trình mua sắm', 2, today, today + 1, null, null from t;

grant execute on function pg_temp.check(boolean, text) to authenticated, anon, service_role;
grant execute on function pg_temp.login(uuid) to authenticated, anon, service_role;
grant execute on function pg_temp.error_of(text) to authenticated, anon, service_role;
grant execute on function pg_temp.view_ids(text) to authenticated, anon, service_role;

-- ---------------------------------------------------------------- privileges
select pg_temp.check(
  not has_function_privilege('authenticated', 'public.run_document_reminders()', 'execute')
  and not has_function_privilege('anon', 'public.run_document_reminders()', 'execute')
  and has_function_privilege('service_role', 'public.run_document_reminders()', 'execute'),
  'run_document_reminders is service_role only');
select pg_temp.check(
  not has_function_privilege('authenticated', 'public.doc_in_view(uuid, text, uuid)', 'execute')
  and not has_function_privilege('anon', 'public.doc_in_view(uuid, text, uuid)', 'execute'),
  'doc_in_view is internal');
select pg_temp.check(
  not has_table_privilege('authenticated', 'public.document_reminder_log', 'select')
  and not has_table_privilege('anon', 'public.document_reminder_log', 'select'),
  'the reminder log is not readable by clients');

-- ---------------------------------------------------------------- anon
set local role anon;
set local request.jwt.claim.sub = '';

select pg_temp.check(
  pg_temp.error_of($$select * from public.search_documents('{}')$$) ~* 'permission denied',
  'anon cannot call search_documents');
select pg_temp.check(
  pg_temp.error_of($$select public.document_dashboard()$$) ~* 'permission denied',
  'anon cannot call document_dashboard');
select pg_temp.check(
  pg_temp.error_of($$select * from public.report_incoming_processing(current_date - 1, current_date)$$) ~* 'permission denied',
  'anon cannot call report_incoming_processing');
select pg_temp.check(
  pg_temp.error_of($$select * from public.report_outgoing(current_date - 1, current_date)$$) ~* 'permission denied',
  'anon cannot call report_outgoing');
select pg_temp.check(
  pg_temp.error_of($$select * from public.run_document_reminders()$$) ~* 'permission denied',
  'anon cannot call run_document_reminders');

reset role;
set local role authenticated;

-- ---------------------------------------------------------------- Bob (staff)
select pg_temp.login(:B);

select pg_temp.check(
  pg_temp.error_of($$select * from public.run_document_reminders()$$) ~* 'permission denied',
  'authenticated cannot call run_document_reminders');

select pg_temp.check(:DLEAD = any (pg_temp.view_ids('needs_me')), 'needs_me has the document Bob leads');
select pg_temp.check(:DAPPR = any (pg_temp.view_ids('needs_me')), 'needs_me has the pending approval');
select pg_temp.check(not (:DINFO = any (pg_temp.view_ids('needs_me'))), 'needs_me leaves out for-info documents');
select pg_temp.check(pg_temp.view_ids('for_info') = array[:DINFO]::uuid[], 'for_info has only the info document');
select pg_temp.check(pg_temp.view_ids('awaiting_approval') = array[:DAPPR]::uuid[],
  'awaiting_approval has the pending step');
select pg_temp.check(pg_temp.view_ids('overdue') = array[:DLEAD]::uuid[], 'overdue has the assignment due yesterday');
select pg_temp.check(pg_temp.view_ids('due_soon') = array[:DSOON]::uuid[], 'due_soon has the assignment due tomorrow');
select pg_temp.check(cardinality(pg_temp.view_ids('to_issue')) = 0, 'to_issue is empty for staff');
select pg_temp.check(cardinality(pg_temp.view_ids('to_register')) = 0, 'to_register is empty for staff');
select pg_temp.check(:DSIGN = any (pg_temp.view_ids('all')) and not (:DSIGN = any (pg_temp.view_ids('needs_me'))),
  'staff can read the signed document but it does not need them');
select pg_temp.check(not (:DDEPT = any (pg_temp.view_ids('all'))), 'Bob cannot see the KT department''s document');

-- urgent first: the khan document comes before the normal one
select pg_temp.check(
  (select array_agg(s.id order by ord) from public.search_documents('{"view": "needs_me"}') with ordinality as s(id, direction, status, subject, notation, number, arrival_number, arrival_date, issued_date, issuing_org_name, type_name, urgency, confidentiality, due_date, my_due_date, updated_at, created_at, recipients_summary, total_count, ord))
    = array[:DSOON, :DLEAD, :DAPPR]::uuid[],
  'needs_me is ordered by urgency, then by my deadline');
select pg_temp.check(
  (select s.my_due_date = t.today - 1 and s.total_count = 3
   from public.search_documents('{"view": "needs_me"}') s, t where s.id = :DLEAD),
  'my_due_date and total_count are returned');
select pg_temp.check(
  (select count(*) from public.search_documents('{"view": "needs_me"}', 1, 1)) = 1
  and (select s.id from public.search_documents('{"view": "needs_me"}', 1, 1) s) = :DLEAD,
  'limit and offset page the results');

-- dashboard counts match the views
select pg_temp.check(
  public.document_dashboard() = jsonb_build_object(
    'needs_me', 3, 'for_info', 1, 'awaiting_approval', 1, 'due_soon', 1,
    'overdue', 1, 'to_register', 0, 'to_issue', 0, 'urgent', 1),
  'Bob''s dashboard counts');
select pg_temp.check(
  (select bool_and((public.document_dashboard() ->> v)::int = cardinality(pg_temp.view_ids(v)))
   from unnest(array['needs_me', 'for_info', 'awaiting_approval', 'due_soon', 'overdue', 'to_register', 'to_issue']) v),
  'dashboard counts equal the search results of each view');

select pg_temp.check(
  pg_temp.error_of($$select * from public.report_incoming_processing(current_date - 30, current_date)$$) ~* 'only leaders',
  'staff cannot view the incoming report');
select pg_temp.check(
  pg_temp.error_of($$select * from public.report_outgoing(current_date - 30, current_date)$$) ~* 'only leaders',
  'staff cannot view the outgoing report');
select pg_temp.check(
  pg_temp.error_of($$select * from public.search_documents('{"view": "nope"}')$$) ~* 'unknown view',
  'an unknown view is refused');

-- ---------------------------------------------------------------- Alice (admin, clerk, leader)
select pg_temp.login(:A);

select pg_temp.check(pg_temp.view_ids('to_issue') = array[:DSIGN]::uuid[], 'to_issue shows the signed document to the clerk');
select pg_temp.check(pg_temp.view_ids('to_register') = array[:DREG]::uuid[], 'to_register shows the incoming draft');
select pg_temp.check(:DSIGN = any (pg_temp.view_ids('needs_me')), 'a signed document needs the clerk');
select pg_temp.check(pg_temp.view_ids('overdue') = array[:DLEAD]::uuid[], 'overdue has the late assignment Alice made');
select pg_temp.check((select array_agg(x order by x) from unnest(pg_temp.view_ids('done')) x) = array[:DLEAD, :DDONE]::uuid[], 'done has the document Alice registered and the one whose lead she assigned is done');
select pg_temp.check(cardinality(pg_temp.view_ids('due_soon')) = 0,
  'due_soon leaves out documents due soon that do not need Alice');
select pg_temp.check(
  (select bool_and((public.document_dashboard() ->> v)::int = cardinality(pg_temp.view_ids(v)))
   from unnest(array['needs_me', 'for_info', 'awaiting_approval', 'due_soon', 'overdue', 'to_register', 'to_issue']) v),
  'Alice''s dashboard counts equal the search results of each view');

select pg_temp.check(
  (select array_agg(s.id order by s.id) from public.search_documents('{"q": "hop dong", "view": "all"}') s)
    = array[:DLEAD]::uuid[],
  'q "hop dong" matches "Hợp đồng thuê văn phòng" and never the other company''s document');
select pg_temp.check(
  (select array_agg(s.id) from public.search_documents('{"q": "nghiem thu"}') s) = array[:DDONE]::uuid[],
  'q matches the indexed text of an attached file');
select pg_temp.check(
  (select count(*) from public.search_documents('{"q": "%"}')) = 0,
  'a % in q is a literal, not a wildcard');
select pg_temp.check(
  (select array_agg(s.id order by s.id) from public.search_documents(
     '{"direction": "outgoing", "status": ["signed", "issued"]}') s) = array[:DSIGN, :DISS]::uuid[],
  'direction and status filters');
select pg_temp.check(
  (select array_agg(s.id) from public.search_documents(jsonb_build_object('department_id', :KT)) s) = array[:DDEPT]::uuid[],
  'department filter matches an assignment department');
select pg_temp.check(
  (select array_agg(s.type_name) from public.search_documents('{"q": "doi tac"}') s) = array['Công văn'],
  'type_name is returned');
select pg_temp.check(
  (select count(*) from public.search_documents(jsonb_build_object('year', extract(year from (select today from t))::int,
     'direction', 'incoming', 'view', 'all'))) = 6,
  'year filter on the arrival date or creation date');
select pg_temp.check(
  pg_temp.error_of($$select * from public.search_documents('{"date_from": "yesterday"}')$$) ~* 'must be a date',
  'a bad date is refused');

-- reports
create temp table rep as
select * from public.report_incoming_processing((select today from t) - 30, (select today from t));
select pg_temp.check(
  (select received = 4 and done_on_time = 1 and done_late = 0 and open_on_time = 2 and open_overdue = 1
   from rep where department_name = 'Total' and department_id is null),
  'incoming report total row');
select pg_temp.check(
  (select sum(received) = 4 and sum(done_on_time) = 1 and sum(open_on_time) = 2 and sum(open_overdue) = 1
   from rep where department_name <> 'Total'),
  'incoming report rows add up to the total');
select pg_temp.check(
  (select bool_and(received = done_on_time + done_late + open_on_time + open_overdue) from rep),
  'every row adds up');
select pg_temp.check(
  (select received = 2 and assignee_name = 'Bob Trần' from rep where assignee_user_id = :B and department_id = :HC)
  and (select received = 1 and assignee_user_id is null from rep where department_id = :KT and assignee_user_id is null)
  and (select avg_days = 2.0 from rep where assignee_user_id = :C),
  'rows per department and assignee, with the average processing days');
select pg_temp.check(
  (select issued = 1 and month = to_char((select today from t), 'YYYY-MM') and type_name = 'Công văn'
     and avg_approval_hours = 4.0
   from public.report_outgoing((select today from t) - 30, (select today from t))),
  'outgoing report counts the issued document and the approval time');

-- ---------------------------------------------------------------- Hana (head of KT)
select pg_temp.login(:H);

select pg_temp.check(:DDEPT = any (pg_temp.view_ids('needs_me')), 'a department head sees the department''s lead');
select pg_temp.check(
  pg_temp.error_of(format($$select * from public.report_incoming_processing(current_date - 30, current_date, %L)$$, :HC))
    ~* 'departments you head',
  'a department head cannot report on another department');
select pg_temp.check(
  (select received = 2 from public.report_incoming_processing((select today from t) - 30, (select today from t))
   where department_name = 'Total'),
  'a department head''s report covers only the departments they head');
select pg_temp.check(
  pg_temp.error_of($$select * from public.report_outgoing(current_date - 30, current_date)$$) ~* 'only leaders',
  'a department head cannot view the outgoing report');

-- ---------------------------------------------------------------- Dave (other company)
select pg_temp.login(:D);

select pg_temp.check(
  (select array_agg(s.id) from public.search_documents('{"q": "hop dong"}') s) = array[:DOTHER]::uuid[],
  'Dave only finds his own company''s document');
select pg_temp.check(
  (public.document_dashboard() ->> 'needs_me')::int = 0,
  'another company''s documents never count');
select pg_temp.check(
  cardinality(pg_temp.view_ids('due_soon')) = 0 and cardinality(pg_temp.view_ids('needs_me')) = 0
  and (public.document_dashboard() ->> 'due_soon')::int = 0,
  'a document presented to nobody is not due soon for a reader');

-- ---------------------------------------------------------------- reminders (service role)
reset role;
set local role service_role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);

create temp table first_run as select * from public.run_document_reminders();
select pg_temp.check(
  (select count(*) from public.notifications n join first_run r on r.notification_id = n.id
   where n.kind = 'document.overdue') = 1
  and (select count(*) from public.notifications n join first_run r on r.notification_id = n.id
       where n.kind = 'document.overdue' and n.user_id = :B and n.entity_id = :DLEAD
         and n.title = 'Overdue since ' || to_char((select today from t) - 1, 'DD/MM') || ': Hợp đồng thuê văn phòng'
         and n.link = '/documents/' || :DLEAD and n.actor_id is null) = 1,
  'the first run sends one overdue reminder to the lead');
select pg_temp.check(
  (select count(*) from public.notifications n join first_run r on r.notification_id = n.id
   where n.entity_id in (:DINFO, :DDONE, :DDEPT, :DOTHER)) = 0,
  'info, finished and far-off assignments get no reminder');
select pg_temp.check(
  (select count(*) from public.run_document_reminders()) = 0,
  'a second run on the same day sends nothing');

-- 2+ working days late: the assigner hears about it too
reset role;
insert into public.documents (id, org_id, direction, status, subject, arrival_number, arrival_date, created_by)
select :DLATE, :ORG, 'incoming', 'in_progress', 'Đơn khiếu nại', 9, today - 10, :A from t;
insert into public.document_assignments (document_id, assignee_user_id, role, due_date, assigned_by, status)
select :DLATE, :B, 'lead', today - 10, :A, 'in_progress' from t;
set local role service_role;

create temp table late_run as select * from public.run_document_reminders();
select pg_temp.check(
  (select count(*) from public.notifications n join late_run r on r.notification_id = n.id) = 2
  and (select count(*) from public.notifications n join late_run r on r.notification_id = n.id
       where n.user_id = :A and n.kind = 'document.overdue'
         and n.title = 'Bob Trần is overdue: Đơn khiếu nại') = 1
  and (select count(*) from public.notifications n join late_run r on r.notification_id = n.id
       where n.user_id = :B and n.entity_id = :DLATE) = 1,
  'an assignment 2+ working days late also notifies the assigner');
select pg_temp.check(
  (select count(*) from public.run_document_reminders()) = 0,
  'the assigner is not notified twice on the same day');

reset role;

rollback;
