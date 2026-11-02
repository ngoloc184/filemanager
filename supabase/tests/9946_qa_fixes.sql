-- QA fixes (202608280046):
--   (1) Done (Đã xử lý) has the documents the caller completed, and those the
--       caller assigned work on once that work (or the document) is finished
--   (2) report_incoming_processing counts a document once per department and
--       once in the total, also when the department head sub-assigns the lead
--   (3) issue_document notifies the author once when they are also a
--       recipient (member, or head of a recipient department)
--   (4) accept_invitation marks the invitee's invitation notice read
--   (5) get_document's 'Document not found' is SQLSTATE PT404 (HTTP 404)
-- Run with scripts/test-db.sh (plain PostgreSQL + supabase/tests stubs).
-- Everything runs in one transaction that is rolled back at the end.

\set ON_ERROR_STOP 1
\o /dev/null
\set A '''a4600000-0000-0000-0000-0000000000a1'''
\set L '''a4600000-0000-0000-0000-0000000000b1'''
\set H '''a4600000-0000-0000-0000-0000000000c1'''
\set C '''a4600000-0000-0000-0000-0000000000d1'''
\set B '''a4600000-0000-0000-0000-0000000000e1'''
\set N '''a4600000-0000-0000-0000-0000000000f1'''
\set ORG '''0a460000-0000-0000-0000-0000000000a1'''
\set HC '''0d460000-0000-0000-0000-0000000000d1'''
\set KT '''0d460000-0000-0000-0000-0000000000d2'''
\set TQD '''07460000-0000-0000-0000-000000000071'''
\set ROUT '''08460000-0000-0000-0000-000000000081'''
\set DASSIGNED '''d4600000-0000-0000-0000-000000000001'''
\set DCOMPL '''d4600000-0000-0000-0000-000000000002'''
\set DOPEN '''d4600000-0000-0000-0000-000000000003'''
\set DREVOKED '''d4600000-0000-0000-0000-000000000004'''
\set DOUT1 '''d4600000-0000-0000-0000-000000000011'''
\set DOUT2 '''d4600000-0000-0000-0000-000000000012'''
\set DOUT3 '''d4600000-0000-0000-0000-000000000013'''
\set ASGTOP '''a5460000-0000-0000-0000-000000000001'''

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

-- Returns 'SQLSTATE: message' of a failing statement, or null.
create function pg_temp.state_of(stmt text) returns text
language plpgsql as $$
begin
  execute stmt;
  return null;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end;
$$;

create function pg_temp.view_ids(p_view text) returns uuid[]
language sql as $$
  select coalesce(array_agg(s.id order by s.id), '{}')
  from public.search_documents(jsonb_build_object('view', p_view), 200, 0) s;
$$;

-- ---------------------------------------------------------------- fixtures
insert into auth.users (id, email) values
  (:A, 'alice46@example.com'),
  (:L, 'linh46@example.com'),
  (:H, 'hana46@example.com'),
  (:C, 'carol46@example.com'),
  (:B, 'bob46@example.com'),
  (:N, 'nam46@example.com');
insert into public.user_profiles (id, email) values
  (:A, 'alice46@example.com'),
  (:L, 'linh46@example.com'),
  (:H, 'hana46@example.com'),
  (:C, 'carol46@example.com'),
  (:B, 'bob46@example.com'),
  (:N, 'nam46@example.com')
on conflict (id) do nothing;

-- Alice admin/clerk, Linh leader (HCNS), Bob staff (HCNS); Hana heads KT,
-- Carol staff in KT. Nam has an account but no company yet.
insert into public.organizations (id, name, code, created_by) values
  (:ORG, 'QA Corporation', 'QAC', :A);
insert into public.departments (id, org_id, name, code, head_user_id) values
  (:HC, :ORG, 'Hành chính nhân sự', 'HCNS', null),
  (:KT, :ORG, 'Kế toán', 'KT', :H);
insert into public.org_members (org_id, user_id, department_id, roles) values
  (:ORG, :A, :HC, '{org_admin,clerk}'),
  (:ORG, :L, :HC, '{leader}'),
  (:ORG, :B, :HC, '{staff}'),
  (:ORG, :H, :KT, '{dept_head}'),
  (:ORG, :C, :KT, '{staff}');
insert into public.doc_types (id, org_id, name, abbreviation, is_cong_van) values
  (:TQD, :ORG, 'Quyết định (test 46)', 'QĐ', false);
insert into public.doc_registers (id, org_id, direction, name, year)
values (:ROUT, :ORG, 'outgoing', 'Sổ văn bản đi (test 46)', public.doc_year_for(:ORG, now()));

create temp table t as select public.org_now_date(:ORG) as today;
grant select on t to authenticated, anon, service_role;

-- Completed: Linh assigned the lead to KT; Hana sub-assigned it to Carol;
-- both finished on time. Alice completed the document.
insert into public.documents (id, org_id, direction, status, subject, arrival_number, arrival_date, created_by)
select :DASSIGNED, :ORG, 'incoming', 'completed', 'Kiểm kê tài sản', 1, today, :A from t;
insert into public.document_assignments (id, document_id, assignee_department_id, role, due_date, assigned_by,
                                         assigned_at, status, done_at)
select :ASGTOP, :DASSIGNED, :KT, 'lead', today + 1, :L, now() - interval '2 days', 'done', now() from t;
insert into public.document_assignments (document_id, parent_id, assignee_user_id, role, due_date, assigned_by,
                                         assigned_at, status, done_at)
select :DASSIGNED, :ASGTOP, :C, 'lead', today + 1, :H, now() - interval '1 day', 'done', now() from t;
insert into public.document_events (org_id, document_id, actor_id, action, from_status, to_status)
values (:ORG, :DASSIGNED, :A, 'completed', 'in_progress', 'completed');

-- Completed by Linh; Alice assigned the lead to Bob.
insert into public.documents (id, org_id, direction, status, subject, arrival_number, arrival_date, created_by)
select :DCOMPL, :ORG, 'incoming', 'completed', 'Đề nghị thanh toán', 2, today, :A from t;
insert into public.document_assignments (document_id, assignee_user_id, role, due_date, assigned_by,
                                         assigned_at, status, done_at)
select :DCOMPL, :B, 'lead', today + 1, :A, now() - interval '2 days', 'done', now() from t;
insert into public.document_events (org_id, document_id, actor_id, action, from_status, to_status)
values (:ORG, :DCOMPL, :L, 'completed', 'in_progress', 'completed');

-- In progress: Linh assigned the lead to Carol, still open.
insert into public.documents (id, org_id, direction, status, subject, arrival_number, arrival_date, created_by)
select :DOPEN, :ORG, 'incoming', 'in_progress', 'Báo cáo quý', 3, today, :A from t;
insert into public.document_assignments (document_id, assignee_user_id, role, due_date, assigned_by, status)
select :DOPEN, :C, 'lead', today + 3, :L, 'pending' from t;

-- Completed, but Linh's assignment was revoked; Alice's lead (Bob) finished.
insert into public.documents (id, org_id, direction, status, subject, arrival_number, arrival_date, created_by)
select :DREVOKED, :ORG, 'incoming', 'completed', 'Giấy mời họp', 4, today, :A from t;
insert into public.document_assignments (document_id, assignee_department_id, role, due_date, assigned_by, status)
select :DREVOKED, :KT, 'lead', today + 1, :L, 'revoked' from t;
insert into public.document_assignments (document_id, assignee_user_id, role, due_date, assigned_by,
                                         assigned_at, status, done_at)
select :DREVOKED, :B, 'lead', today + 1, :A, now() - interval '2 days', 'done', now() from t;

-- Outgoing, signed, waiting for the clerk: written by Carol, by Hana (head of
-- KT) and by Bob.
insert into public.documents (id, org_id, direction, status, subject, doc_type_id, created_by, submitted_at, signed_at)
values
  (:DOUT1, :ORG, 'outgoing', 'signed', 'Quyết định thành lập tổ kiểm kê', :TQD, :C, now() - interval '5 hours', now()),
  (:DOUT2, :ORG, 'outgoing', 'signed', 'Quyết định khen thưởng', :TQD, :H, now() - interval '5 hours', now()),
  (:DOUT3, :ORG, 'outgoing', 'signed', 'Quyết định điều động', :TQD, :B, now() - interval '5 hours', now());

-- an older, unrelated invitation notice of Nam's: it must stay unread
insert into public.notifications (user_id, org_id, kind, entity_type, entity_id, title, link)
values (:N, null, 'org.invite', 'org', gen_random_uuid(), 'You are invited to join Other Co', '/invite/other-token');

create temp table ids (k text primary key, v text);
grant all on ids to authenticated, anon, service_role;

grant execute on function pg_temp.check(boolean, text) to authenticated, anon, service_role;
grant execute on function pg_temp.login(uuid) to authenticated, anon, service_role;
grant execute on function pg_temp.error_of(text) to authenticated, anon, service_role;
grant execute on function pg_temp.state_of(text) to authenticated, anon, service_role;
grant execute on function pg_temp.view_ids(text) to authenticated, anon, service_role;

-- ---------------------------------------------------------------- privileges
select pg_temp.check(
  not has_function_privilege('authenticated', 'public.doc_in_view(uuid, text, uuid)', 'execute')
  and not has_function_privilege('anon', 'public.doc_in_view(uuid, text, uuid)', 'execute'),
  'doc_in_view stays internal');
select pg_temp.check(
  (select bool_and(has_function_privilege('authenticated', f, 'execute')
                   and not has_function_privilege('anon', f, 'execute'))
   from unnest(array['public.get_document(uuid)', 'public.issue_document(uuid, uuid, jsonb, int)',
                     'public.accept_invitation(text)',
                     'public.report_incoming_processing(date, date, uuid)']) f),
  'the redefined RPCs keep their grants: authenticated yes, anon no');

set local role anon;
set local request.jwt.claim.sub = '';
select pg_temp.check(
  pg_temp.error_of($$select public.get_document(gen_random_uuid())$$) ~* 'permission denied',
  'anon cannot call get_document');
select pg_temp.check(
  pg_temp.error_of($$select public.issue_document(gen_random_uuid(), gen_random_uuid(), '[]')$$) ~* 'permission denied',
  'anon cannot call issue_document');
select pg_temp.check(
  pg_temp.error_of($$select public.accept_invitation('x')$$) ~* 'permission denied',
  'anon cannot call accept_invitation');
select pg_temp.check(
  pg_temp.error_of($$select * from public.report_incoming_processing(current_date - 1, current_date)$$) ~* 'permission denied',
  'anon cannot call report_incoming_processing');
reset role;

set local role authenticated;

-- ---------------------------------------------------------------- (1) Done
select pg_temp.login(:L);
select pg_temp.check(:DASSIGNED = any (pg_temp.view_ids('done')),
  'done has the document Linh assigned once the work is finished');
select pg_temp.check(:DCOMPL = any (pg_temp.view_ids('done')),
  'done has the document Linh completed');
select pg_temp.check(not (:DOPEN = any (pg_temp.view_ids('done'))),
  'done leaves out work Linh assigned that is still open');
select pg_temp.check(not (:DREVOKED = any (pg_temp.view_ids('done'))),
  'done leaves out a document whose only assignment by Linh was revoked');
select pg_temp.check(pg_temp.view_ids('needs_me') = '{}'::uuid[]
  and pg_temp.view_ids('overdue') = '{}'::uuid[],
  'the other views do not change for Linh');
select pg_temp.check(
  (select bool_and((public.document_dashboard() ->> v)::int = cardinality(pg_temp.view_ids(v)))
   from unnest(array['needs_me', 'for_info', 'awaiting_approval', 'due_soon', 'overdue', 'to_register', 'to_issue']) v),
  'Linh''s dashboard counts equal the search results of each view');

select pg_temp.login(:C);
select pg_temp.check(:DASSIGNED = any (pg_temp.view_ids('done'))
  and not (:DOPEN = any (pg_temp.view_ids('done'))),
  'Carol''s done still has her finished sub-assignment, not her open lead');

select pg_temp.login(:A);
select pg_temp.check(pg_temp.view_ids('done') = array[:DASSIGNED, :DCOMPL, :DREVOKED]::uuid[],
  'Alice''s done: the one she completed and the two whose lead she assigned is done');

-- ---------------------------------------------------------------- (2) report
select pg_temp.login(:L);
select pg_temp.check(
  (select r.received = 4 and r.done_on_time = 3 and r.open_on_time = 1
   from public.report_incoming_processing((select today from t), (select today from t)) r
   where r.department_name = 'Total'),
  'the total counts each incoming document once (4 documents, 3 done, 1 open)');
select pg_temp.check(
  (select sum(r.received) = 2
   from public.report_incoming_processing((select today from t), (select today from t)) r
   where r.department_id = :KT),
  'KT counts its two documents once each (the sub-assigned lead is not counted again)');
select pg_temp.check(
  (select r.received = 1 and r.open_on_time = 1 and r.done_on_time = 0
   from public.report_incoming_processing((select today from t), (select today from t)) r
   where r.department_id = :KT and r.assignee_user_id = :C),
  'Carol''s row has only the lead given to her directly');
select pg_temp.check(
  (select sum(r.received) = 2
   from public.report_incoming_processing((select today from t), (select today from t)) r
   where r.department_id = :HC),
  'HCNS counts Bob''s two leads (the revoked one is not counted)');

-- ---------------------------------------------------------------- (3) issue
select pg_temp.login(:A);
select public.issue_document(:DOUT1, :ROUT, jsonb_build_array(
  jsonb_build_object('kind', 'member', 'user_id', :C),
  jsonb_build_object('kind', 'external', 'name', 'Sở Tài chính', 'method', 'post')));
select public.issue_document(:DOUT2, :ROUT, jsonb_build_array(
  jsonb_build_object('kind', 'department', 'department_id', :KT)));
select public.issue_document(:DOUT3, :ROUT, jsonb_build_array(
  jsonb_build_object('kind', 'member', 'user_id', :C)));

reset role;
select pg_temp.check(
  (select count(*) from public.notifications
   where user_id = :C and kind = 'document.issued' and entity_id = :DOUT1) = 1,
  'the author who is also a member recipient is notified once');
select pg_temp.check(
  (select count(*) from public.notifications
   where user_id = :H and kind = 'document.issued' and entity_id = :DOUT2) = 1,
  'the author who heads a recipient department is notified once');
select pg_temp.check(
  (select count(*) from public.notifications
   where user_id = :B and kind = 'document.issued' and entity_id = :DOUT3) = 1
  and (select count(*) from public.notifications
       where user_id = :C and kind = 'document.issued' and entity_id = :DOUT3) = 1,
  'an author who is not a recipient is still notified, and so is the recipient');

-- ---------------------------------------------------------------- (4) invitation
set local role authenticated;
select pg_temp.login(:A);
insert into ids select 'inv', (public.invite_member('nam46@example.com', :KT, null, '{staff}')).token;

reset role;
select pg_temp.check(
  (select count(*) from public.notifications
   where user_id = :N and kind = 'org.invite' and read_at is null
     and link = '/invite/' || (select v from ids where k = 'inv')) = 1,
  'Nam has an unread invitation notice');

set local role authenticated;
select pg_temp.login(:N);
select pg_temp.check(public.accept_invitation((select v from ids where k = 'inv')) = :ORG,
  'Nam accepts the invitation');

reset role;
select pg_temp.check(
  (select read_at is not null from public.notifications
   where user_id = :N and kind = 'org.invite' and link = '/invite/' || (select v from ids where k = 'inv')),
  'accepting marks the invitation notice read');
select pg_temp.check(
  (select read_at is null from public.notifications
   where user_id = :N and link = '/invite/other-token'),
  'other invitation notices stay unread');

-- ---------------------------------------------------------------- (5) get_document
set local role authenticated;
select pg_temp.login(:C);
select pg_temp.check(
  pg_temp.state_of($$select public.get_document(gen_random_uuid())$$) = 'PT404: Document not found',
  'a missing document is PT404 with the same message');
select pg_temp.check(
  pg_temp.state_of(format('select public.get_document(%L)', :DCOMPL)) = 'PT404: Document not found',
  'a document the caller cannot read is PT404 too');
select pg_temp.check(
  (public.get_document(:DASSIGNED) -> 'document' ->> 'id') = :DASSIGNED,
  'a readable document still loads');

reset role;
rollback;
