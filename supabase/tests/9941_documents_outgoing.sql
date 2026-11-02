-- Outgoing / internal documents: approval chain, freeze on submit, return as a
-- new revision, sign, issue with numbering, recall, withdraw and follow-ups.
-- Run with scripts/test-db.sh (plain PostgreSQL + supabase/tests stubs).
-- Everything runs in one transaction that is rolled back at the end.

\set ON_ERROR_STOP 1
\o /dev/null
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set H '''aaaaaaaa-0000-0000-0000-0000000000b1'''
\set K '''aaaaaaaa-0000-0000-0000-0000000000c1'''
\set L '''aaaaaaaa-0000-0000-0000-0000000000d1'''
\set C '''aaaaaaaa-0000-0000-0000-0000000000e1'''
\set O '''aaaaaaaa-0000-0000-0000-0000000000f1'''
\set ORG '''0a000000-0000-0000-0000-0000000000b1'''
\set ORG2 '''0a000000-0000-0000-0000-0000000000b2'''
\set HC '''0d000000-0000-0000-0000-0000000000e1'''
\set KT '''0d000000-0000-0000-0000-0000000000e2'''
\set OPS '''0d000000-0000-0000-0000-0000000000e3'''
\set POS '''0c000000-0000-0000-0000-0000000000c1'''
\set TQD '''07000000-0000-0000-0000-0000000000a1'''
\set TCV '''07000000-0000-0000-0000-0000000000a2'''
\set ROUT '''08000000-0000-0000-0000-0000000000a1'''
\set RTYPE '''08000000-0000-0000-0000-0000000000a2'''
\set ROLD '''08000000-0000-0000-0000-0000000000a3'''
\set RINT '''08000000-0000-0000-0000-0000000000a4'''
\set F1 '''f1000000-0000-0000-0000-0000000000b1'''
\set F2 '''f1000000-0000-0000-0000-0000000000b2'''
\set F1PATH '''aaaaaaaa-0000-0000-0000-0000000000d1/f1000000-0000-0000-0000-0000000000b1/v1/to-trinh.pdf'''
\set F1V2 '''aaaaaaaa-0000-0000-0000-0000000000d1/f1000000-0000-0000-0000-0000000000b1/v2/to-trinh.pdf'''
\set F1V3 '''aaaaaaaa-0000-0000-0000-0000000000d1/f1000000-0000-0000-0000-0000000000b1/v3/to-trinh.pdf'''
\set F2PATH '''aaaaaaaa-0000-0000-0000-0000000000d1/f1000000-0000-0000-0000-0000000000b2/v1/thong-bao.pdf'''

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
  (:H, 'hana@example.com'),
  (:K, 'khoa@example.com'),
  (:L, 'lan@example.com'),
  (:C, 'cuong@example.com'),
  (:O, 'out@example.com');
insert into public.user_profiles (id, email) values
  (:A, 'alice@example.com'),
  (:H, 'hana@example.com'),
  (:K, 'khoa@example.com'),
  (:L, 'lan@example.com'),
  (:C, 'cuong@example.com'),
  (:O, 'out@example.com')
on conflict (id) do nothing;
update public.user_profiles set display_name = initcap(split_part(email, '@', 1))
where id in (:A, :H, :K, :L, :C, :O);

-- ABC: Alice leader (signer), Hana head of HCNS, Khoa and Lan staff in HCNS,
-- Cuong clerk. XYZ: Out.
insert into public.organizations (id, name, code, created_by) values
  (:ORG, 'ABC Corporation', 'ABC', :A),
  (:ORG2, 'XYZ Company', 'XYZ', :O);
insert into public.departments (id, org_id, name, code, head_user_id) values
  (:HC, :ORG, 'Hành chính nhân sự', 'HCNS', :H),
  (:KT, :ORG, 'Kế toán', 'KT', null),
  (:OPS, :ORG2, 'Operations', 'OPS', :O);
insert into public.positions (id, org_id, name, can_sign) values
  (:POS, :ORG, 'Trưởng phòng (test)', false);
insert into public.org_members (org_id, user_id, department_id, position_id, roles) values
  (:ORG, :A, null, null, '{org_admin,leader}'),
  (:ORG, :H, :HC, :POS, '{dept_head}'),
  (:ORG, :K, :HC, null, '{staff}'),
  (:ORG, :L, :HC, null, '{staff}'),
  (:ORG, :C, null, null, '{clerk}'),
  (:ORG2, :O, :OPS, null, '{org_admin,clerk,leader}');

-- direct inserts with test names: T12's seed may add its own defaults
insert into public.doc_types (id, org_id, name, abbreviation, is_cong_van, sort_order) values
  (:TQD, :ORG, 'Quyết định (test)', 'QĐ', false, -2),
  (:TCV, :ORG, 'Công văn (test)', '', true, -1);
insert into public.doc_registers (id, org_id, direction, name, year)
values (:ROUT, :ORG, 'outgoing', 'Sổ văn bản đi (test)', public.doc_year_for(:ORG, now()));
insert into public.doc_registers (id, org_id, direction, name, year, scope)
values (:RTYPE, :ORG, 'outgoing', 'Sổ đi theo loại (test)', public.doc_year_for(:ORG, now()), 'register_type');
insert into public.doc_registers (id, org_id, direction, name, year)
values (:ROLD, :ORG, 'outgoing', 'Sổ đi năm cũ (test)', public.doc_year_for(:ORG, now()) - 1);
insert into public.doc_registers (id, org_id, direction, name, year)
values (:RINT, :ORG, 'internal', 'Sổ nội bộ (test)', public.doc_year_for(:ORG, now()));

insert into storage.buckets (id, name) values ('uploads', 'uploads') on conflict (id) do nothing;
insert into storage.objects (bucket_id, name, owner, metadata) values
  ('uploads', :F1PATH, :L, '{"size": 10}'),
  ('uploads', :F1V2, :L, '{"size": 11}'),
  ('uploads', :F1V3, :L, '{"size": 12}'),
  ('uploads', :F2PATH, :L, '{"size": 13}');

grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
grant execute on function pg_temp.login(uuid) to authenticated, anon;
grant execute on function pg_temp.error_of(text) to authenticated, anon;

create temp table ids (k text primary key, v uuid);
grant all on ids to authenticated, anon;
create temp table issued (k text primary key, v jsonb);
grant all on issued to authenticated, anon;

-- ---------------------------------------------------------------- anon and internal helpers
set local role anon;
set local request.jwt.claim.sub = '';

select pg_temp.check(
  pg_temp.error_of($$select public.set_approval_chain(gen_random_uuid(), '[]')$$) ~* 'permission denied',
  'anon cannot call set_approval_chain');
select pg_temp.check(
  pg_temp.error_of($$select public.issue_document(gen_random_uuid(), gen_random_uuid(), '[]')$$) ~* 'permission denied',
  'anon cannot call issue_document');
select pg_temp.check(
  pg_temp.error_of($$select public.sign_document(gen_random_uuid())$$) ~* 'permission denied',
  'anon cannot call sign_document');
select pg_temp.check(
  pg_temp.error_of($$select public.create_follow_up(gen_random_uuid(), 'reply')$$) ~* 'permission denied',
  'anon cannot call create_follow_up');

reset role;
select pg_temp.check(
  (select bool_and(not has_function_privilege('anon', f, 'execute')
                   and has_function_privilege('authenticated', f, 'execute'))
   from unnest(array[
     'public.set_approval_chain(uuid, jsonb)', 'public.submit_for_approval(uuid)',
     'public.approve_step(uuid, text)', 'public.return_document(uuid, text)',
     'public.reject_document(uuid, text)', 'public.sign_document(uuid, text, text)',
     'public.issue_document(uuid, uuid, jsonb, int)', 'public.recall_document(uuid, text)',
     'public.withdraw_document(uuid)', 'public.create_follow_up(uuid, text)'
   ]) as f),
  'every workflow RPC is denied to anon and granted to authenticated');
select pg_temp.check(
  (select bool_and(not has_function_privilege('anon', f, 'execute')
                   and not has_function_privilege('authenticated', f, 'execute'))
   from unnest(array[
     'public.doc_can_sign_user(uuid, uuid)', 'public.doc_out_lock(uuid)',
     'public.doc_out_opinion(uuid, text, text)', 'public.doc_out_activate(uuid, int)'
   ]) as f),
  'the internal helpers are not granted to clients');

set local role authenticated;
select pg_temp.login(:L);

select pg_temp.check(
  pg_temp.error_of($$select public.doc_can_sign_user(gen_random_uuid(), gen_random_uuid())$$) ~* 'permission denied',
  'doc_can_sign_user is internal');
select pg_temp.check(
  pg_temp.error_of($$select public.doc_out_activate(gen_random_uuid(), 1)$$) ~* 'permission denied',
  'doc_out_activate is internal');
select pg_temp.check(
  pg_temp.error_of($$select public.doc_out_lock(gen_random_uuid())$$) ~* 'permission denied',
  'doc_out_lock is internal');

-- ---------------------------------------------------------------- Lan drafts a decision
insert into ids select 'd1', public.create_document('outgoing', jsonb_build_object(
  'subject', 'Quyết định khen thưởng', 'doc_type_id', :TQD));
insert into ids select 'folder_l', public.ensure_document_folder();
select public.register_file(:F1, (select v from ids where k = 'folder_l'),
  'to-trinh.pdf', 'to-trinh.pdf', 'pdf', 'application/pdf', 10, :F1PATH, 'sum-v1');
select public.register_file(:F2, (select v from ids where k = 'folder_l'),
  'thong-bao.pdf', 'thong-bao.pdf', 'pdf', 'application/pdf', 13, :F2PATH, 'sum-f2');

select pg_temp.check(
  pg_temp.error_of(format('select public.submit_for_approval(%L)', (select v from ids where k = 'd1'))) ~* 'main file',
  'submit needs a main file');
select public.attach_document_file((select v from ids where k = 'd1'), :F1, 'main');
select pg_temp.check(
  pg_temp.error_of(format('select public.submit_for_approval(%L)', (select v from ids where k = 'd1')))
    ~* 'at least one approver',
  'submit needs an approval chain');

-- chain validation
select pg_temp.check(
  pg_temp.error_of(format('select public.set_approval_chain(%L, %L)', (select v from ids where k = 'd1'),
    '[]')) ~* 'at least one approver',
  'an empty chain is rejected');
select pg_temp.check(
  pg_temp.error_of(format('select public.set_approval_chain(%L, %L)', (select v from ids where k = 'd1'),
    jsonb_build_array(jsonb_build_object('approver_user_id', :H, 'kind', 'review')))) ~* 'exactly one signer',
  'a chain without a signer is rejected');
select pg_temp.check(
  pg_temp.error_of(format('select public.set_approval_chain(%L, %L)', (select v from ids where k = 'd1'),
    jsonb_build_array(
      jsonb_build_object('approver_user_id', :A, 'kind', 'sign'),
      jsonb_build_object('approver_user_id', :H, 'kind', 'review')))) ~* 'signer must be last',
  'the signer must be last');
select pg_temp.check(
  pg_temp.error_of(format('select public.set_approval_chain(%L, %L)', (select v from ids where k = 'd1'),
    jsonb_build_array(
      jsonb_build_object('approver_user_id', :H, 'kind', 'review'),
      jsonb_build_object('approver_user_id', :A, 'kind', 'sign', 'parallel_with_previous', true))))
    ~* 'signer must be last',
  'the signer cannot share a step');
select pg_temp.check(
  pg_temp.error_of(format('select public.set_approval_chain(%L, %L)', (select v from ids where k = 'd1'),
    jsonb_build_array(
      jsonb_build_object('approver_user_id', :H, 'kind', 'review'),
      jsonb_build_object('approver_user_id', :H, 'kind', 'consult', 'parallel_with_previous', true),
      jsonb_build_object('approver_user_id', :A, 'kind', 'sign')))) ~* 'twice in the same step',
  'one person appears once per step');
select pg_temp.check(
  pg_temp.error_of(format('select public.set_approval_chain(%L, %L)', (select v from ids where k = 'd1'),
    jsonb_build_array(
      jsonb_build_object('approver_user_id', :O, 'kind', 'review'),
      jsonb_build_object('approver_user_id', :A, 'kind', 'sign')))) ~* 'active members',
  'approvers come from the document''s company');
select pg_temp.check(
  pg_temp.error_of(format('select public.set_approval_chain(%L, %L)', (select v from ids where k = 'd1'),
    jsonb_build_array(jsonb_build_object('approver_user_id', :K, 'kind', 'sign')))) ~* 'Khoa cannot sign documents',
  'a signer without the leader role or a can_sign position is rejected');
select pg_temp.check(
  pg_temp.error_of(format('select public.set_approval_chain(%L, %L)', (select v from ids where k = 'd1'),
    jsonb_build_array(jsonb_build_object('approver_user_id', :H, 'kind', 'sign')))) ~* 'Hana cannot sign documents',
  'a department head without a signing position cannot sign');
select pg_temp.check(
  pg_temp.error_of(format('select public.set_approval_chain(%L, %L)', (select v from ids where k = 'd1'),
    (select jsonb_agg(jsonb_build_object('approver_user_id', 'aaaaaaaa-0000-0000-0000-0000000000b1', 'kind', 'review'))
       || jsonb_build_array(jsonb_build_object('approver_user_id', 'aaaaaaaa-0000-0000-0000-00000000000a', 'kind', 'sign'))
     from generate_series(1, 10)))) ~* 'at most 10',
  'at most 10 steps');

select pg_temp.login(:H);
select pg_temp.check(
  pg_temp.error_of(format('select public.set_approval_chain(%L, %L)', (select v from ids where k = 'd1'),
    jsonb_build_array(jsonb_build_object('approver_user_id', :A, 'kind', 'sign')))) is not null,
  'only the author sets the chain');

select pg_temp.login(:L);
select pg_temp.check(
  public.set_approval_chain((select v from ids where k = 'd1'), jsonb_build_array(
    jsonb_build_object('approver_user_id', :H, 'kind', 'review'),
    jsonb_build_object('approver_user_id', :K, 'kind', 'consult', 'parallel_with_previous', true),
    jsonb_build_object('approver_user_id', :A, 'kind', 'sign'))) = 3,
  'set_approval_chain stores 3 steps');
select pg_temp.check(
  (select string_agg(format('%s:%s:%s:%s', step_no, kind, required, status), ' ' order by step_no, kind)
   from public.document_approval_steps where document_id = (select v from ids where k = 'd1'))
    = '1:consult:f:waiting 1:review:t:waiting 2:sign:t:waiting',
  'parallel consult shares step 1 and is optional; sign is step 2');
-- setting it again replaces the waiting steps
select public.set_approval_chain((select v from ids where k = 'd1'), jsonb_build_array(
  jsonb_build_object('approver_user_id', :H, 'kind', 'review'),
  jsonb_build_object('approver_user_id', :K, 'kind', 'consult', 'parallel_with_previous', true),
  jsonb_build_object('approver_user_id', :A, 'kind', 'sign')));
select pg_temp.check(
  (select count(*) from public.document_approval_steps where document_id = (select v from ids where k = 'd1')) = 3
  and (select count(*) from public.document_events
       where document_id = (select v from ids where k = 'd1') and action = 'chain_set') = 2,
  'a new chain replaces the old one; each save logs chain_set');

-- ---------------------------------------------------------------- submit freezes the files
select pg_temp.login(:H);
select pg_temp.check(
  pg_temp.error_of(format('select public.submit_for_approval(%L)', (select v from ids where k = 'd1'))) is not null,
  'only the author submits');
select pg_temp.login(:L);
select public.submit_for_approval((select v from ids where k = 'd1'));
select pg_temp.check(
  (select status = 'in_review' and current_step_no = 1 and submitted_at is not null
   from public.documents where id = (select v from ids where k = 'd1')),
  'submit: in_review at step 1');
select pg_temp.check(
  (select string_agg(kind || ':' || status, ' ' order by step_no, kind)
   from public.document_approval_steps where document_id = (select v from ids where k = 'd1'))
    = 'consult:pending review:pending sign:waiting',
  'the first step''s approvers are pending');
select pg_temp.check(
  (select bool_and(frozen) from public.document_files where document_id = (select v from ids where k = 'd1')),
  'submit freezes the document files');
select pg_temp.check(
  pg_temp.error_of(format('select public.add_file_version(%L, %L, 11, %L, %L)',
    'f1000000-0000-0000-0000-0000000000b1',
    'aaaaaaaa-0000-0000-0000-0000000000d1/f1000000-0000-0000-0000-0000000000b1/v2/to-trinh.pdf',
    'application/pdf', 'sum-v2')) ~* 'locked',
  'while in review the author cannot upload a new version of the main file');

reset role;
select pg_temp.check(
  (select count(*) from public.notifications
   where user_id = :H and kind = 'document.approval_requested'
     and title = 'Please review: Quyết định khen thưởng') = 1
  and (select count(*) from public.notifications
       where user_id = :K and kind = 'document.approval_requested') = 1
  and (select count(*) from public.notifications
       where user_id = :A and kind = 'document.approval_requested') = 0,
  'the pending approvers are asked to review, the signer not yet');
select pg_temp.check(
  (select count(*) from public.document_events
   where document_id = (select v from ids where k = 'd1') and action = 'submitted_for_approval'
     and from_status = 'draft' and to_status = 'in_review') = 1,
  'submit logs submitted_for_approval');
set local role authenticated;

select pg_temp.login(:A);
select pg_temp.check(
  pg_temp.error_of(format('select public.approve_step(%L)', (select v from ids where k = 'd1'))) ~* 'no pending step',
  'the signer cannot approve before their turn');
select pg_temp.check(
  pg_temp.error_of(format('select public.sign_document(%L)', (select v from ids where k = 'd1'))) ~* 'no signature pending',
  'the signer cannot sign before their turn');

-- ---------------------------------------------------------------- return → revision 2
select pg_temp.login(:H);
select pg_temp.check(
  pg_temp.error_of(format('select public.return_document(%L, %L)', (select v from ids where k = 'd1'), '  ')) ~* 'needs to change',
  'returning needs a comment');
select public.return_document((select v from ids where k = 'd1'), 'Sửa lại điều 2');
select pg_temp.check(
  (select status = 'draft' and revision = 2 and current_step_no is null
   from public.documents where id = (select v from ids where k = 'd1')),
  'return: back to draft as revision 2');
select pg_temp.check(
  (select string_agg(kind || ':' || status, ' ' order by step_no, kind)
   from public.document_approval_steps where document_id = (select v from ids where k = 'd1') and revision = 1)
    = 'consult:skipped review:returned sign:skipped'
  and (select string_agg(kind || ':' || status || ':' || required, ' ' order by step_no, kind)
       from public.document_approval_steps where document_id = (select v from ids where k = 'd1') and revision = 2)
    = 'consult:waiting:false review:waiting:true sign:waiting:true',
  'revision 1 is closed and its chain is copied into revision 2 as waiting');
select pg_temp.check(
  (select count(*) from public.document_opinions
   where document_id = (select v from ids where k = 'd1') and author_id = :H
     and kind = 'comment' and body = 'Sửa lại điều 2') = 1,
  'the return comment becomes an opinion');

reset role;
select pg_temp.check(
  not (select bool_or(frozen) from public.document_files where document_id = (select v from ids where k = 'd1')),
  'return unfreezes the files');
select pg_temp.check(
  (select count(*) from public.notifications
   where user_id = :L and kind = 'document.returned_for_revision') = 1,
  'the author hears about the return');
set local role authenticated;

select pg_temp.login(:L);
select pg_temp.check(
  pg_temp.error_of(format('select public.add_file_version(%L, %L, 11, %L, %L)',
    'f1000000-0000-0000-0000-0000000000b1',
    'aaaaaaaa-0000-0000-0000-0000000000d1/f1000000-0000-0000-0000-0000000000b1/v2/to-trinh.pdf',
    'application/pdf', 'sum-v2')) is null,
  'the returned draft takes a new version');
select public.submit_for_approval((select v from ids where k = 'd1'));

-- ---------------------------------------------------------------- approve → awaiting signature
select pg_temp.login(:H);
select public.approve_step((select v from ids where k = 'd1'), 'Đồng ý');
select pg_temp.check(
  (select status = 'awaiting_signature' and current_step_no = 2
   from public.documents where id = (select v from ids where k = 'd1')),
  'once the required reviewer approves the document waits for the signer');
select pg_temp.check(
  (select string_agg(kind || ':' || status, ' ' order by step_no, kind)
   from public.document_approval_steps where document_id = (select v from ids where k = 'd1') and revision = 2)
    = 'consult:skipped review:approved sign:pending',
  'the optional consult is skipped');
select pg_temp.check(
  pg_temp.error_of(format('select public.approve_step(%L)', (select v from ids where k = 'd1'))) ~* 'no pending step',
  'an approved step cannot be approved again');

select pg_temp.login(:K);
select pg_temp.check(
  pg_temp.error_of(format('select public.approve_step(%L)', (select v from ids where k = 'd1'))) ~* 'no pending step',
  'a skipped consult can no longer answer');

select pg_temp.login(:A);
select pg_temp.check(
  pg_temp.error_of(format('select public.approve_step(%L)', (select v from ids where k = 'd1'))) ~* 'Use Sign',
  'the sign step is not approved with approve_step');
select pg_temp.check(
  pg_temp.error_of(format('select public.sign_document(%L, %L)', (select v from ids where k = 'd1'), 'XX'))
    ~* 'signing authority',
  'an unknown signing authority is rejected');

reset role;
select pg_temp.check(
  (select count(*) from public.notifications
   where user_id = :L and kind = 'document.approved' and title = 'Hana approved: Quyết định khen thưởng') = 1
  and (select count(*) from public.notifications
       where user_id = :A and kind = 'document.approval_requested' and title = 'Please sign: Quyết định khen thưởng') = 1,
  'the author hears about the approval and the signer is asked to sign');
set local role authenticated;

-- ---------------------------------------------------------------- sign
select pg_temp.login(:A);
select public.sign_document((select v from ids where k = 'd1'), 'KT', 'Ký ban hành');
select pg_temp.check(
  (select status = 'signed' and signer_user_id = :A and signer_authority = 'KT'
     and signer_name = 'Alice' and signed_at is not null and signed_checksum = 'sum-v2'
   from public.documents where id = (select v from ids where k = 'd1')),
  'sign records signer, authority and the checksum of the current main version');

reset role;
select pg_temp.check(
  (select bool_and(frozen) from public.document_files where document_id = (select v from ids where k = 'd1')),
  'sign freezes the files');
select pg_temp.check(
  (select count(*) from public.notifications
   where user_id = :C and kind = 'document.ready_to_issue' and title = 'Ready to issue: Quyết định khen thưởng') = 1
  and (select count(*) from public.notifications where user_id = :L and kind = 'document.signed') = 1,
  'the clerk and the author are told it is signed');
set local role authenticated;

select pg_temp.login(:L);
select pg_temp.check(
  pg_temp.error_of(format('select public.add_file_version(%L, %L, 12, %L)',
    'f1000000-0000-0000-0000-0000000000b1',
    'aaaaaaaa-0000-0000-0000-0000000000d1/f1000000-0000-0000-0000-0000000000b1/v3/to-trinh.pdf',
    'application/pdf')) ~* 'locked',
  'a signed main file gets no new version');

-- ---------------------------------------------------------------- issue
select pg_temp.check(
  pg_temp.error_of(format('select public.issue_document(%L, %L, %L)', (select v from ids where k = 'd1'),
    '08000000-0000-0000-0000-0000000000a1',
    jsonb_build_array(jsonb_build_object('kind', 'member', 'user_id', 'aaaaaaaa-0000-0000-0000-0000000000c1'))))
    ~* 'only clerks',
  'a non-clerk cannot issue');

select pg_temp.login(:O);
select pg_temp.check(
  (select count(*) from public.documents where id = (select v from ids where k = 'd1')) = 0
  and not public.can_read_document((select v from ids where k = 'd1')),
  'Out (another company) cannot read it');
select pg_temp.check(
  pg_temp.error_of(format('select public.issue_document(%L, %L, %L)', (select v from ids where k = 'd1'),
    '08000000-0000-0000-0000-0000000000a1', '[{"kind": "external", "name": "x"}]')) ~* 'not found',
  'Out cannot issue it');

select pg_temp.login(:C);
select pg_temp.check(
  pg_temp.error_of(format('select public.issue_document(%L, %L, %L)', (select v from ids where k = 'd1'),
    '08000000-0000-0000-0000-0000000000a1', '[]')) ~* 'at least one recipient',
  'an outgoing document needs a recipient');
select pg_temp.check(
  pg_temp.error_of(format('select public.issue_document(%L, %L, %L)', (select v from ids where k = 'd1'),
    '08000000-0000-0000-0000-0000000000a3', '[{"kind": "external", "name": "x"}]')) ~* 'register is for',
  'a register of another year is refused');
select pg_temp.check(
  pg_temp.error_of(format('select public.issue_document(%L, %L, %L)', (select v from ids where k = 'd1'),
    '08000000-0000-0000-0000-0000000000a4', '[{"kind": "external", "name": "x"}]')) ~* 'register for outgoing',
  'a register of another direction is refused');
select pg_temp.check(
  pg_temp.error_of(format('select public.issue_document(%L, %L, %L)', (select v from ids where k = 'd1'),
    '08000000-0000-0000-0000-0000000000a1',
    jsonb_build_array(jsonb_build_object('kind', 'member', 'user_id', 'aaaaaaaa-0000-0000-0000-0000000000f1'))))
    ~* 'active members',
  'recipients come from the document''s company');

insert into issued select 'd1', public.issue_document((select v from ids where k = 'd1'), :ROUT, jsonb_build_array(
  jsonb_build_object('kind', 'member', 'user_id', :K),
  jsonb_build_object('kind', 'department', 'department_id', :HC),
  jsonb_build_object('kind', 'external', 'name', 'Sở Tài chính', 'method', 'post'),
  jsonb_build_object('kind', 'external', 'name', 'Ngân hàng X', 'method', 'email')));
select pg_temp.check(
  (select v from issued where k = 'd1') = '{"number": 1, "notation": "01/QĐ-ABC"}'::jsonb,
  'the first decision is 01/QĐ-ABC');
select pg_temp.check(
  (select status = 'issued' and number = 1 and notation = '01/QĐ-ABC' and register_id = :ROUT
     and issued_date = public.org_now_date(:ORG) and issued_at is not null
   from public.documents where id = (select v from ids where k = 'd1')),
  'issue stores number, notation, register and the issue date in the company time zone');
select pg_temp.check(
  (select string_agg(concat_ws('|', kind, name_snapshot, method, sent_at is not null), ' / '
     order by kind, name_snapshot)
   from public.document_recipients where document_id = (select v from ids where k = 'd1'))
    = 'department|Hành chính nhân sự|system|t / external|Ngân hàng X|email|t / external|Sở Tài chính|post|f / member|Khoa|system|t',
  'recipients are recorded; post is not sent yet');
select pg_temp.check(
  (select count(*) from public.document_assignments
   where document_id = (select v from ids where k = 'd1') and role = 'info' and status = 'pending'
     and assigned_by = :C
     and (assignee_user_id = :K or assignee_department_id = :HC)) = 2,
  'members and departments get an info assignment');

reset role;
select pg_temp.check(
  (select count(*) from public.notifications
   where user_id = :K and kind = 'document.issued'
     and title = 'New document: 01/QĐ-ABC – Quyết định khen thưởng') = 1
  and (select count(*) from public.notifications where user_id = :H and kind = 'document.issued') = 1
  and (select count(*) from public.notifications where user_id = :L and kind = 'document.issued') = 1,
  'the member, the department head and the author hear about the issue');
select pg_temp.check(
  (select data = '{"number": 1, "notation": "01/QĐ-ABC", "register_id": "08000000-0000-0000-0000-0000000000a1", "recipients": 4}'::jsonb
   from public.document_events
   where document_id = (select v from ids where k = 'd1') and action = 'issued'),
  'issue logs the number and notation');
set local role authenticated;

select pg_temp.login(:L);
select pg_temp.check(
  pg_temp.error_of(format('select public.add_file_version(%L, %L, 12, %L)',
    'f1000000-0000-0000-0000-0000000000b1',
    'aaaaaaaa-0000-0000-0000-0000000000d1/f1000000-0000-0000-0000-0000000000b1/v3/to-trinh.pdf',
    'application/pdf')) ~* 'locked',
  'an issued file rejects a new version');

select pg_temp.login(:C);
select pg_temp.check(
  pg_temp.error_of(format('select public.issue_document(%L, %L, %L)', (select v from ids where k = 'd1'),
    '08000000-0000-0000-0000-0000000000a1', '[{"kind": "external", "name": "x"}]')) ~* 'signed document',
  'an issued document is not issued twice');

-- ---------------------------------------------------------------- more documents and numbering
select pg_temp.login(:L);
insert into ids select 'd2', public.create_document('outgoing', jsonb_build_object(
  'subject', 'Công văn đôn đốc', 'doc_type_id', :TCV));
insert into ids select 'd3', public.create_document('outgoing', jsonb_build_object(
  'subject', 'Quyết định số ba', 'doc_type_id', :TQD));
insert into ids select 'd4', public.create_document('outgoing', jsonb_build_object(
  'subject', 'Quyết định theo loại', 'doc_type_id', :TQD));
insert into ids select 'd5', public.create_document('outgoing', jsonb_build_object(
  'subject', 'Công văn theo loại', 'doc_type_id', :TCV));
insert into ids select 'd6', public.create_document('outgoing', jsonb_build_object(
  'subject', 'Quyết định sau số tay', 'doc_type_id', :TQD));
insert into ids select 'd7', public.create_document('internal', jsonb_build_object(
  'subject', 'Thông báo nội bộ', 'doc_type_id', :TQD));
insert into ids select 'd10', public.create_document('outgoing', jsonb_build_object(
  'subject', 'Công văn số tay', 'doc_type_id', :TCV));
reset role;
-- skip the chain for these: they are signed already
update public.documents set status = 'signed', submitted_at = now(), signed_at = now(), signer_user_id = :A
where id in (select v from ids where k in ('d2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd10'));
set local role authenticated;

select pg_temp.login(:C);
insert into issued select 'd2', public.issue_document((select v from ids where k = 'd2'), :ROUT,
  '[{"kind": "external", "name": "UBND tỉnh"}]');
select pg_temp.check(
  (select v from issued where k = 'd2') = '{"number": 2, "notation": "02/ABC-HCNS"}'::jsonb,
  'a công văn takes the next number of the register and the công văn template');

select pg_temp.check(
  pg_temp.error_of(format('select public.issue_document(%L, %L, %L, 1)', (select v from ids where k = 'd3'),
    '08000000-0000-0000-0000-0000000000a1', '[{"kind": "external", "name": "x"}]')) ~* 'already used',
  'a manual number that duplicates a notation fails');
select pg_temp.check(
  pg_temp.error_of(format('select public.issue_document(%L, %L, %L, 0)', (select v from ids where k = 'd3'),
    '08000000-0000-0000-0000-0000000000a1', '[{"kind": "external", "name": "x"}]')) ~* 'positive',
  'a manual number must be positive');
insert into issued select 'd3', public.issue_document((select v from ids where k = 'd3'), :ROUT,
  '[{"kind": "external", "name": "x"}]', 7);
select pg_temp.check(
  (select v from issued where k = 'd3') = '{"number": 7, "notation": "07/QĐ-ABC"}'::jsonb,
  'a manual number is used as given');
insert into issued select 'd6', public.issue_document((select v from ids where k = 'd6'), :ROUT,
  '[{"kind": "external", "name": "x"}]');
select pg_temp.check(
  (select v from issued where k = 'd6') = '{"number": 8, "notation": "08/QĐ-ABC"}'::jsonb,
  'automatic numbering continues after the manual number');
-- number 1 is taken by the decision 01/QĐ-ABC; as a công văn it would read
-- 01/ABC-HCNS, a different notation but the same number of the register
select pg_temp.check(
  pg_temp.error_of(format('select public.issue_document(%L, %L, %L, 1)', (select v from ids where k = 'd10'),
    '08000000-0000-0000-0000-0000000000a1', '[{"kind": "external", "name": "x"}]')) ~* 'already used',
  'a manual number already used by another type in the register fails');
insert into issued select 'd10', public.issue_document((select v from ids where k = 'd10'), :ROUT,
  '[{"kind": "external", "name": "x"}]');
select pg_temp.check(
  (select v from issued where k = 'd10') = '{"number": 9, "notation": "09/ABC-HCNS"}'::jsonb,
  'the failed manual number took no number from the register');

insert into issued select 'd4', public.issue_document((select v from ids where k = 'd4'), :RTYPE,
  '[{"kind": "external", "name": "x"}]');
insert into issued select 'd5', public.issue_document((select v from ids where k = 'd5'), :RTYPE,
  '[{"kind": "external", "name": "x"}]');
select pg_temp.check(
  (select v from issued where k = 'd4') = '{"number": 1, "notation": "01/QĐ-ABC"}'::jsonb
  and (select v from issued where k = 'd5') = '{"number": 1, "notation": "01/ABC-HCNS"}'::jsonb,
  'a register numbered per type starts each type at 1');

select pg_temp.check(
  pg_temp.error_of(format('select public.issue_document(%L, %L, %L)', (select v from ids where k = 'd7'),
    '08000000-0000-0000-0000-0000000000a4', '[{"kind": "external", "name": "x"}]')) ~* 'person or department',
  'an internal document goes to people or departments');
insert into issued select 'd7', public.issue_document((select v from ids where k = 'd7'), :RINT,
  jsonb_build_array(jsonb_build_object('kind', 'department', 'department_id', :KT)));
select pg_temp.check(
  (select v ->> 'notation' from issued where k = 'd7') = '01/QĐ-ABC',
  'internal documents number in their own register');

reset role;
select pg_temp.check(
  (select count(*) from public.document_events
   where document_id = (select v from ids where k = 'd3') and action = 'manual_number_override') = 1,
  'a manual number is logged');
set local role authenticated;

-- ---------------------------------------------------------------- recall
select pg_temp.login(:L);
select pg_temp.check(
  pg_temp.error_of(format('select public.recall_document(%L, %L)', (select v from ids where k = 'd1'), 'x'))
    ~* 'clerks or leaders',
  'staff cannot recall');
select pg_temp.login(:C);
select pg_temp.check(
  pg_temp.error_of(format('select public.recall_document(%L, %L)', (select v from ids where k = 'd1'), ' '))
    ~* 'reason',
  'a recall needs a reason');
select public.recall_document((select v from ids where k = 'd1'), 'Sai đối tượng');
select pg_temp.check(
  (select status = 'recalled' and recalled_at is not null and recall_reason = 'Sai đối tượng'
   from public.documents where id = (select v from ids where k = 'd1')),
  'recall stores the reason');
select pg_temp.check(
  (select count(*) from public.document_assignments
   where document_id = (select v from ids where k = 'd1') and status <> 'revoked') = 0,
  'recall revokes the info assignments');
reset role;
select pg_temp.check(
  (select count(*) from public.notifications where user_id = :K and kind = 'document.recalled') = 1
  and (select count(*) from public.notifications where user_id = :H and kind = 'document.recalled') = 1
  and (select count(*) from public.notifications where user_id = :L and kind = 'document.recalled') = 1,
  'recipients, the department head and the author hear about the recall');
select pg_temp.check(
  (select bool_and(frozen) from public.document_files where document_id = (select v from ids where k = 'd1')),
  'a recalled document keeps its files frozen');
set local role authenticated;

-- ---------------------------------------------------------------- follow-ups
reset role;
insert into public.documents (org_id, direction, status, subject, notation, created_by, registered_at)
values (:ORG, 'incoming', 'registered', 'Đề nghị báo cáo', '123/UBND-VP', :C, now());
insert into ids select 'inc', id from public.documents where notation = '123/UBND-VP' and org_id = :ORG;
set local role authenticated;

select pg_temp.login(:L);
select pg_temp.check(
  pg_temp.error_of(format('select public.create_follow_up(%L, %L)', (select v from ids where k = 'inc'), 'reply'))
    ~* 'not found',
  'a reply needs read access to the source');

select pg_temp.login(:A);
insert into ids select 'reply', public.create_follow_up((select v from ids where k = 'inc'), 'reply');
select pg_temp.check(
  (select direction = 'outgoing' and status = 'draft' and created_by = :A
     and reply_to_id = (select v from ids where k = 'inc')
     and subject = 'V/v trả lời 123/UBND-VP' and org_id = :ORG
   from public.documents where id = (select v from ids where k = 'reply')),
  'reply to an incoming document creates an outgoing draft with reply_to_id');
select pg_temp.check(
  (select count(*) from public.document_events
   where action = 'follow_up_created'
     and document_id in ((select v from ids where k = 'inc'), (select v from ids where k = 'reply'))) = 2,
  'follow_up_created is logged on both documents');

select pg_temp.login(:L);
insert into ids select 'corr', public.create_follow_up((select v from ids where k = 'd2'), 'correction');
select pg_temp.check(
  (select direction = 'outgoing' and corrects_id = (select v from ids where k = 'd2')
     and subject = 'Đính chính 02/ABC-HCNS' and drafting_department_id = :HC
     and (select t.is_cong_van from public.doc_types t where t.id = doc_type_id)
   from public.documents where id = (select v from ids where k = 'corr')),
  'a correction is a công văn draft that names the corrected notation');
insert into ids select 'repl', public.create_follow_up((select v from ids where k = 'd7'), 'replacement');
select pg_temp.check(
  (select direction = 'internal' and replaces_id = (select v from ids where k = 'd7')
     and subject = 'Thông báo nội bộ' and doc_type_id = :TQD
   from public.documents where id = (select v from ids where k = 'repl')),
  'a replacement keeps direction, type and subject');
select pg_temp.check(
  pg_temp.error_of(format('select public.create_follow_up(%L, %L)', (select v from ids where k = 'd1'), 'replacement'))
    ~* 'only an issued',
  'a recalled document cannot be replaced');

select pg_temp.login(:O);
select pg_temp.check(
  pg_temp.error_of(format('select public.create_follow_up(%L, %L)', (select v from ids where k = 'd2'), 'reply'))
    ~* 'not found',
  'Out cannot follow up on another company''s document');

-- ---------------------------------------------------------------- withdraw, reject, signing position
reset role;
update public.positions set can_sign = true where id = :POS;
set local role authenticated;

select pg_temp.login(:L);
insert into ids select 'd8', public.create_document('outgoing', jsonb_build_object(
  'subject', 'Tờ trình rút lại', 'doc_type_id', :TQD));
select public.attach_document_file((select v from ids where k = 'd8'), :F2, 'main');
select pg_temp.check(
  public.set_approval_chain((select v from ids where k = 'd8'), jsonb_build_array(
    jsonb_build_object('approver_user_id', :H, 'kind', 'sign'))) = 1,
  'a member whose position can sign may be the signer');
select public.submit_for_approval((select v from ids where k = 'd8'));
select pg_temp.check(
  (select status from public.documents where id = (select v from ids where k = 'd8')) = 'awaiting_signature',
  'a chain that is only a signer goes straight to awaiting signature');
select pg_temp.login(:H);
select pg_temp.check(
  pg_temp.error_of(format('select public.withdraw_document(%L)', (select v from ids where k = 'd8'))) ~* 'author',
  'only the author withdraws');
select pg_temp.login(:L);
select public.withdraw_document((select v from ids where k = 'd8'));
select pg_temp.check(
  (select status from public.documents where id = (select v from ids where k = 'd8')) = 'withdrawn'
  and (select string_agg(status, ',') from public.document_approval_steps
       where document_id = (select v from ids where k = 'd8')) = 'skipped',
  'withdraw ends the document and skips its steps');
reset role;
select pg_temp.check(
  (select count(*) from public.notifications where user_id = :H and kind = 'document.withdrawn') = 1
  and (select bool_and(frozen) from public.document_files where document_id = (select v from ids where k = 'd8')),
  'the pending signer is told; the files stay frozen');
set local role authenticated;

select pg_temp.login(:L);
insert into ids select 'd9', public.create_document('outgoing', jsonb_build_object(
  'subject', 'Tờ trình bị từ chối', 'doc_type_id', :TQD));
select public.attach_document_file((select v from ids where k = 'd9'), :F2, 'main');
select public.set_approval_chain((select v from ids where k = 'd9'), jsonb_build_array(
  jsonb_build_object('approver_user_id', :K, 'kind', 'review'),
  jsonb_build_object('approver_user_id', :A, 'kind', 'sign')));
select public.submit_for_approval((select v from ids where k = 'd9'));
select pg_temp.login(:K);
select public.reject_document((select v from ids where k = 'd9'), 'Không phù hợp');
select pg_temp.check(
  (select status = 'rejected' and current_step_no is null from public.documents where id = (select v from ids where k = 'd9'))
  and (select string_agg(kind || ':' || status, ' ' order by step_no)
       from public.document_approval_steps where document_id = (select v from ids where k = 'd9'))
    = 'review:rejected sign:skipped',
  'reject ends the document and skips the remaining steps');
select pg_temp.login(:L);
select pg_temp.check(
  pg_temp.error_of(format('select public.withdraw_document(%L)', (select v from ids where k = 'd9'))) ~* 'not signed yet',
  'a rejected document cannot be withdrawn');

reset role;

rollback;
