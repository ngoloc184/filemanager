-- Documents access fixes (202608280045):
--   (a) recall takes access back from MEMBER recipients (document, page, file);
--       the recipient row stays as history with revoked_at set
--   (b) department recipients still lose access on recall
--   (c) a file attached to a registered incoming document is frozen at once
--   (d) a file attached to an incoming DRAFT stays editable
-- Same RPCs as the UI (see 9999_e2e_company_documents.sql), minimal setup.
-- Run with scripts/test-db.sh (plain PostgreSQL + supabase/tests stubs).
-- Everything runs in one transaction that is rolled back at the end.

\set ON_ERROR_STOP 1
\o /dev/null
\set ALICE '''a4500000-0000-0000-0000-0000000000a1'''
\set HOA '''a4500000-0000-0000-0000-0000000000b1'''
\set KHOA '''a4500000-0000-0000-0000-0000000000c1'''
\set FO1 '''f4500000-0000-0000-0000-000000000001'''
\set FO2 '''f4500000-0000-0000-0000-000000000002'''
\set FIN1 '''f4500000-0000-0000-0000-000000000011'''
\set FLATE '''f4500000-0000-0000-0000-000000000012'''
\set FDRAFT '''f4500000-0000-0000-0000-000000000013'''
\set FO1PATH '''a4500000-0000-0000-0000-0000000000a1/f4500000-0000-0000-0000-000000000001/v1/qd-1.pdf'''
\set FO2PATH '''a4500000-0000-0000-0000-0000000000a1/f4500000-0000-0000-0000-000000000002/v1/qd-2.pdf'''
\set FIN1PATH '''a4500000-0000-0000-0000-0000000000a1/f4500000-0000-0000-0000-000000000011/v1/cv-den.pdf'''
\set FLATEPATH '''a4500000-0000-0000-0000-0000000000a1/f4500000-0000-0000-0000-000000000012/v1/phieu-chuyen.pdf'''
\set FLATEV2 '''a4500000-0000-0000-0000-0000000000a1/f4500000-0000-0000-0000-000000000012/v2/phieu-chuyen.pdf'''
\set FDRAFTPATH '''a4500000-0000-0000-0000-0000000000a1/f4500000-0000-0000-0000-000000000013/v1/phu-luc.pdf'''
\set FDRAFTV2 '''a4500000-0000-0000-0000-0000000000a1/f4500000-0000-0000-0000-000000000013/v2/phu-luc.pdf'''

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
  (:ALICE, 'alice@fix.example'),
  (:HOA, 'hoa@fix.example'),
  (:KHOA, 'khoa@fix.example');
insert into public.user_profiles (id, email) values
  (:ALICE, 'alice@fix.example'),
  (:HOA, 'hoa@fix.example'),
  (:KHOA, 'khoa@fix.example')
on conflict (id) do nothing;

insert into storage.buckets (id, name) values ('uploads', 'uploads') on conflict (id) do nothing;
insert into storage.objects (bucket_id, name, owner, metadata) values
  ('uploads', :FO1PATH, :ALICE, '{"size": 10}'),
  ('uploads', :FO2PATH, :ALICE, '{"size": 11}'),
  ('uploads', :FIN1PATH, :ALICE, '{"size": 12}'),
  ('uploads', :FLATEPATH, :ALICE, '{"size": 13}'),
  ('uploads', :FLATEV2, :ALICE, '{"size": 14}'),
  ('uploads', :FDRAFTPATH, :ALICE, '{"size": 15}'),
  ('uploads', :FDRAFTV2, :ALICE, '{"size": 16}');

grant execute on function pg_temp.check(boolean, text) to authenticated;
grant execute on function pg_temp.login(uuid) to authenticated;
grant execute on function pg_temp.error_of(text) to authenticated;

create temp table ids (k text primary key, v uuid);
grant all on ids to authenticated;
create temp table tokens (k text primary key, v text);
grant all on tokens to authenticated;

create function pg_temp.id(p_key text) returns uuid
language sql stable as $$ select v from ids where k = p_key $$;
grant execute on function pg_temp.id(text) to authenticated;

set local role authenticated;

-- ---------------------------------------------------------------- company
-- Alice: org_admin + clerk + leader. Hoa: staff in HCNS. Khoa: staff in KT.
select pg_temp.login(:ALICE);
insert into ids select 'org', o.id from public.create_organization('Fix Company', 'FIX') o;
set constraints organizations_seed_documents immediate;
insert into ids select 'hcns', d.id from public.upsert_department(null, 'Hành chính', 'HCNS', null, null, null) d;
insert into ids select 'kt', d.id from public.upsert_department(null, 'Kế toán', 'KT', null, null, null) d;
insert into tokens select 'hoa', i.token from public.invite_member('hoa@fix.example', pg_temp.id('hcns'), null, array['staff']) i;
insert into tokens select 'khoa', i.token from public.invite_member('khoa@fix.example', pg_temp.id('kt'), null, array['staff']) i;
insert into ids select 'reg_in', r.id from public.doc_registers r
  where r.org_id = pg_temp.id('org') and r.direction = 'incoming' and r.year = public.doc_year_for(pg_temp.id('org'), now());
insert into ids select 'reg_out', r.id from public.doc_registers r
  where r.org_id = pg_temp.id('org') and r.direction = 'outgoing' and r.year = public.doc_year_for(pg_temp.id('org'), now());
insert into ids select 'qd', t.id from public.doc_types t where t.org_id = pg_temp.id('org') and t.abbreviation = 'QĐ';
insert into ids select 'cv', t.id from public.doc_types t where t.org_id = pg_temp.id('org') and t.name = 'Công văn';

select pg_temp.login(:HOA);
select public.accept_invitation((select v from tokens where k = 'hoa'));
select pg_temp.login(:KHOA);
select public.accept_invitation((select v from tokens where k = 'khoa'));

-- ---------------------------------------------------------------- two issued decisions
-- Alice drafts, signs (leader) and issues (clerk): o1 to the member Hoa,
-- o2 to the department KT (Khoa).
select pg_temp.login(:ALICE);
insert into ids select 'folder', public.ensure_document_folder();
select public.register_file(:FO1, pg_temp.id('folder'), 'qd-1.pdf', 'qd-1.pdf', 'pdf', 'application/pdf', 10, :FO1PATH, 'sum-o1');
select public.register_file(:FO2, pg_temp.id('folder'), 'qd-2.pdf', 'qd-2.pdf', 'pdf', 'application/pdf', 11, :FO2PATH, 'sum-o2');
insert into ids select 'o1', public.create_document('outgoing', jsonb_build_object(
  'subject', 'Quyết định cử cán bộ', 'doc_type_id', pg_temp.id('qd')));
insert into ids select 'o2', public.create_document('outgoing', jsonb_build_object(
  'subject', 'Quyết định giao chỉ tiêu', 'doc_type_id', pg_temp.id('qd')));
select public.attach_document_file(pg_temp.id('o1'), :FO1, 'main');
select public.attach_document_file(pg_temp.id('o2'), :FO2, 'main');
select public.set_approval_chain(pg_temp.id('o1'), jsonb_build_array(jsonb_build_object('approver_user_id', :ALICE, 'kind', 'sign')));
select public.set_approval_chain(pg_temp.id('o2'), jsonb_build_array(jsonb_build_object('approver_user_id', :ALICE, 'kind', 'sign')));
select public.submit_for_approval(pg_temp.id('o1'));
select public.submit_for_approval(pg_temp.id('o2'));
select public.sign_document(pg_temp.id('o1'));
select public.sign_document(pg_temp.id('o2'));
select pg_temp.check(
  (public.issue_document(pg_temp.id('o1'), pg_temp.id('reg_out'),
     jsonb_build_array(jsonb_build_object('kind', 'member', 'user_id', :HOA))) ->> 'number')::int = 1
  and (public.issue_document(pg_temp.id('o2'), pg_temp.id('reg_out'),
     jsonb_build_array(jsonb_build_object('kind', 'department', 'department_id', pg_temp.id('kt')))) ->> 'number')::int = 2,
  'o1 is issued to the member Hoa, o2 to the department KT');

-- ---------------------------------------------------------------- (a) member recipient
select pg_temp.login(:HOA);
select pg_temp.check(
  public.can_read_document(pg_temp.id('o1'))
  and pg_temp.error_of(format('select public.get_document(%L)', pg_temp.id('o1'))) is null
  and public.has_file_access(:FO1),
  'before the recall Hoa reads o1, its page and its main file');

-- Hoa presses "Mark as read" on her info copy (status 'done'): the recall
-- must still take her access back
select public.update_assignment(a.id, 'done', null)
from public.document_assignments a
where a.document_id = pg_temp.id('o1') and a.role = 'info' and a.assignee_user_id = :HOA;
reset role;
select pg_temp.check(
  (select count(*) from public.document_assignments
   where document_id = pg_temp.id('o1') and role = 'info' and assignee_user_id = :HOA and status = 'done') = 1,
  'Hoa marked her info copy of o1 as read');
set local role authenticated;

select pg_temp.login(:KHOA);
select pg_temp.check(
  public.can_read_document(pg_temp.id('o2')) and public.has_file_access(:FO2),
  'before the recall Khoa (KT) reads o2 and its main file');

select pg_temp.login(:ALICE);
select public.recall_document(pg_temp.id('o1'), 'Sai người nhận');
select public.recall_document(pg_temp.id('o2'), 'Sai chỉ tiêu');

select pg_temp.login(:HOA);
select pg_temp.check(
  not public.can_read_document(pg_temp.id('o1'))
  and pg_temp.error_of(format('select public.get_document(%L)', pg_temp.id('o1'))) ~* 'not found'
  and not public.has_file_access(:FO1)
  and (select count(*) from public.documents where id = pg_temp.id('o1')) = 0,
  'after the recall Hoa reads neither o1, its page nor its main file');

reset role;
select pg_temp.check(
  (select count(*) from public.document_recipients
   where document_id = pg_temp.id('o1') and kind = 'member' and user_id = :HOA
     and revoked_at is not null and sent_at is not null) = 1,
  'the member recipient row stays as history with revoked_at set');
set local role authenticated;

-- ---------------------------------------------------------------- (b) department recipient
select pg_temp.login(:KHOA);
select pg_temp.check(
  not public.can_read_document(pg_temp.id('o2')) and not public.has_file_access(:FO2),
  'after the recall the department KT (Khoa) no longer reads o2 or its file');
reset role;
select pg_temp.check(
  (select count(*) from public.document_recipients
   where document_id = pg_temp.id('o2') and kind = 'department' and revoked_at is not null) = 1
  and (select count(*) from public.document_assignments
       where document_id = pg_temp.id('o2') and status <> 'revoked') = 0,
  'the department recipient row is revoked too and its info assignment is revoked');
set local role authenticated;

-- the author and the clerk keep reading the recalled document
select pg_temp.login(:ALICE);
select pg_temp.check(
  public.can_read_document(pg_temp.id('o1')) and public.can_read_document(pg_temp.id('o2')),
  'Alice (author, clerk) still reads the recalled documents');

-- ---------------------------------------------------------------- (c) late attachment is frozen
select public.register_file(:FIN1, pg_temp.id('folder'), 'cv-den.pdf', 'cv-den.pdf', 'pdf', 'application/pdf', 12, :FIN1PATH, 'sum-in1');
select public.register_file(:FLATE, pg_temp.id('folder'), 'phieu-chuyen.pdf', 'phieu-chuyen.pdf', 'pdf', 'application/pdf', 13, :FLATEPATH, 'sum-late');
insert into ids select 'd1', public.create_document('incoming', jsonb_build_object(
  'subject', 'Công văn đề nghị', 'doc_type_id', pg_temp.id('cv'),
  'issuing_org_name', 'Sở Kế hoạch', 'notation', '12/SKH-VP'));
select public.attach_document_file(pg_temp.id('d1'), :FIN1, 'main');
select pg_temp.check(
  (public.register_incoming(pg_temp.id('d1'), pg_temp.id('reg_in')) ->> 'ok')::boolean,
  'the incoming letter is registered');
select public.attach_document_file(pg_temp.id('d1'), :FLATE, 'attachment');
select pg_temp.check(
  (select frozen and kind = 'attachment' from public.document_files
   where document_id = pg_temp.id('d1') and file_id = :FLATE),
  'an attachment added to a registered incoming document is frozen at once');
select pg_temp.check(
  pg_temp.error_of(format('select public.rename_file(%L, %L)', :FLATE, 'doi-ten.pdf')) ~* 'locked'
  and pg_temp.error_of(format('select public.add_file_version(%L, %L, 14, %L, %L)',
    :FLATE, :FLATEV2, 'application/pdf', 'sum-late-v2')) ~* 'locked'
  and pg_temp.error_of(format('select public.soft_delete_file(%L)', :FLATE)) ~* 'locked'
  and (select name = 'phieu-chuyen.pdf' and deleted_at is null from public.files where id = :FLATE),
  'the late attachment cannot be renamed, get a new version or be trashed');

-- ---------------------------------------------------------------- (d) draft attachment stays editable
select public.register_file(:FDRAFT, pg_temp.id('folder'), 'phu-luc.pdf', 'phu-luc.pdf', 'pdf', 'application/pdf', 15, :FDRAFTPATH, 'sum-draft');
insert into ids select 'd2', public.create_document('incoming', jsonb_build_object(
  'subject', 'Công văn đang nhập', 'doc_type_id', pg_temp.id('cv')));
select public.attach_document_file(pg_temp.id('d2'), :FDRAFT, 'attachment');
select pg_temp.check(
  (select not frozen from public.document_files where document_id = pg_temp.id('d2') and file_id = :FDRAFT),
  'an attachment on an incoming draft is not frozen');
select pg_temp.check(
  pg_temp.error_of(format('select public.rename_file(%L, %L)', :FDRAFT, 'phu-luc-1.pdf')) is null
  and pg_temp.error_of(format('select public.add_file_version(%L, %L, 16, %L, %L)',
    :FDRAFT, :FDRAFTV2, 'application/pdf', 'sum-draft-v2')) is null,
  'the draft''s attachment can still be renamed and get a new version');
-- a separate statement: the changes above are not in the previous statement's snapshot
select pg_temp.check(
  (select name = 'phu-luc-1.pdf' and checksum = 'sum-draft-v2' from public.files where id = :FDRAFT)
  and (select count(*) from public.file_versions where file_id = :FDRAFT) = 2,
  'the rename and the new version are stored');

rollback;
