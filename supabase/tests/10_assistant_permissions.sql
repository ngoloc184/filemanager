-- Permission isolation tests for the AI assistant search functions.
-- Run with scripts/test-db.sh (plain PostgreSQL + supabase/tests stubs).
-- Everything runs in one transaction that is rolled back at the end.

\set ON_ERROR_STOP 1
\o /dev/null
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B '''bbbbbbbb-0000-0000-0000-00000000000b'''
\set C '''cccccccc-0000-0000-0000-00000000000c'''
\set D '''dddddddd-0000-0000-0000-00000000000d'''

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

-- Acts as a signed-in user for the following statements in this transaction.
create function pg_temp.login(uid uuid) returns void
language sql as $$
  select set_config('request.jwt.claim.sub', uid::text, true),
         set_config('request.jwt.claim.role', 'authenticated', true);
$$;

-- ---------------------------------------------------------------- fixtures
insert into auth.users (id, email) values
  (:A, 'alice@example.com'),
  (:B, 'nguyenvana@example.com'),
  (:C, 'carol@example.com'),
  (:D, 'dave@example.com');

insert into public.user_profiles (id, email) values
  (:A, 'alice@example.com'),
  (:B, 'nguyenvana@example.com'),
  (:C, 'carol@example.com'),
  (:D, 'dave@example.com')
on conflict (id) do nothing;

select pg_temp.login(:A);

insert into public.folders (id, owner_id, name, parent_id) values
  ('f0000000-0000-0000-0000-0000000000a1', :A, 'Hợp đồng', null),
  ('f0000000-0000-0000-0000-0000000000a2', :A, '2026', 'f0000000-0000-0000-0000-0000000000a1');

insert into public.files (id, owner_id, folder_id, name, original_name, extension, mime_type, size, is_public) values
  ('10000000-0000-0000-0000-0000000000a1', :A, 'f0000000-0000-0000-0000-0000000000a2', 'bao-cao-tai-chinh-thang-9.pdf', 'x', 'pdf', 'application/pdf', 1000, false),
  ('10000000-0000-0000-0000-0000000000a2', :A, null, 'secret-plan.docx', 'x', 'docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 2000, false),
  ('10000000-0000-0000-0000-0000000000a3', :A, null, 'public-brochure.pdf', 'x', 'pdf', 'application/pdf', 3000, true),
  ('10000000-0000-0000-0000-0000000000a4', :A, 'f0000000-0000-0000-0000-0000000000a1', 'contract-acme.docx', 'x', 'docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 4000, false);

insert into public.file_versions (id, file_id, version_no, storage_path, size, mime_type, uploaded_by) values
  ('20000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-0000000000a1', 1, 'a/a1/v1/x.pdf', 1000, 'application/pdf', :A),
  ('20000000-0000-0000-0000-0000000000a2', '10000000-0000-0000-0000-0000000000a2', 1, 'a/a2/v1/x.docx', 2000, 'application/pdf', :A),
  ('20000000-0000-0000-0000-0000000000a3', '10000000-0000-0000-0000-0000000000a3', 1, 'a/a3/v1/x.pdf', 3000, 'application/pdf', :A),
  ('20000000-0000-0000-0000-0000000000a4', '10000000-0000-0000-0000-0000000000a4', 1, 'a/a4/v1/x.docx', 4000, 'application/pdf', :A);

update public.files set current_version_id = ('20000000' || substr(id::text, 9))::uuid
where owner_id = :A;

select pg_temp.login(:B);
insert into public.files (id, owner_id, name, original_name, extension, mime_type, size) values
  ('10000000-0000-0000-0000-0000000000b1', :B, 'bob-notes.txt', 'x', 'txt', 'text/plain', 500);
insert into public.file_versions (id, file_id, version_no, storage_path, size, mime_type, uploaded_by) values
  ('20000000-0000-0000-0000-0000000000b1', '10000000-0000-0000-0000-0000000000b1', 1, 'b/b1/v1/x.txt', 500, 'text/plain', :B);
update public.files set current_version_id = '20000000-0000-0000-0000-0000000000b1'
where id = '10000000-0000-0000-0000-0000000000b1';

-- Search index written by the server indexer (service role).
insert into public.file_contents (file_id, version_id, status, content, char_count)
select f.id, f.current_version_id, 'indexed', c.body, length(c.body)
from public.files f
join (values
  ('10000000-0000-0000-0000-0000000000a1'::uuid, 'Báo cáo tài chính tháng 9. Doanh thu tăng 12%. Hệ thống dùng API authentication với JWT.'),
  ('10000000-0000-0000-0000-0000000000a2'::uuid, 'Kế hoạch bí mật: chuyển đổi database sang cụm mới vào quý 4.'),
  ('10000000-0000-0000-0000-0000000000a3'::uuid, 'Brochure giới thiệu sản phẩm công khai.'),
  ('10000000-0000-0000-0000-0000000000a4'::uuid, 'Hợp đồng dịch vụ với ACME, điều khoản thanh toán.'),
  ('10000000-0000-0000-0000-0000000000b1'::uuid, 'Bob database notes: indexes, vacuum, replication.')
) as c(id, body) on c.id = f.id;

-- A shares the "Hợp đồng" folder (and therefore its sub-folder) with C.
select pg_temp.login(:A);
insert into public.folder_shares (folder_id, grantee_id, role, granted_by)
values ('f0000000-0000-0000-0000-0000000000a1', :C, 'viewer', :A);

-- ------------------------------------------- parity with has_file_access()
-- For every user, the assistant's accessible set must equal exactly the
-- non-trashed files has_file_access() allows.
do $$
declare
  u uuid;
  missing integer;
  extra integer;
begin
  foreach u in array array[
    'aaaaaaaa-0000-0000-0000-00000000000a',
    'bbbbbbbb-0000-0000-0000-00000000000b',
    'cccccccc-0000-0000-0000-00000000000c',
    'dddddddd-0000-0000-0000-00000000000d'
  ]::uuid[] loop
    perform pg_temp.login(u);
    select count(*) into missing from public.files f
    where f.deleted_at is null and public.has_file_access(f.id, 'viewer')
      and f.id not in (select file_id from public.assistant_accessible_files());
    select count(*) into extra from public.assistant_accessible_files() a
    where not public.has_file_access(a.file_id, 'viewer');
    perform pg_temp.check(missing = 0 and extra = 0, format('accessible set matches has_file_access for %s', u));
  end loop;
end $$;

-- ------------------------------------------------------------- name search
set local role authenticated;

select pg_temp.login(:A);
select pg_temp.check(
  (select count(*) from public.assistant_find_files(array['bao', 'cao', 'tai', 'chinh', 'thang', '9'])
   where file_id = '10000000-0000-0000-0000-0000000000a1') = 1,
  'owner finds own file by accent-free name terms');
select pg_temp.check(
  (select count(*) from public.assistant_find_files(array['báo', 'cáo', 'tháng'])
   where file_id = '10000000-0000-0000-0000-0000000000a1') = 1,
  'accented terms match too');
select pg_temp.check(
  (select count(*) from public.assistant_find_files(array['hop', 'dong'])
   where file_id = '10000000-0000-0000-0000-0000000000a4') = 1,
  'folder name "Hợp đồng" matches "hop dong"');
select pg_temp.check(
  (select count(*) from public.assistant_find_files(array['%', '_'])) = 0,
  'LIKE wildcards in terms are literal');

select pg_temp.login(:B);
select pg_temp.check(
  (select count(*) from public.assistant_find_files(array['secret'])) = 0,
  'B cannot find A''s private file by name');
select pg_temp.check(
  (select count(*) from public.assistant_find_files(array['bao', 'cao'])) = 0,
  'B cannot find A''s file inside an unshared folder');
select pg_temp.check(
  (select access from public.assistant_find_files(array['brochure'])) = 'public',
  'B sees A''s public file, labelled public');

select pg_temp.login(:C);
select pg_temp.check(
  (select count(*) from public.assistant_find_files(array['bao', 'cao'])
   where file_id = '10000000-0000-0000-0000-0000000000a1') = 1,
  'C finds a file inherited from a shared parent folder');
select pg_temp.check(
  (select count(*) from public.assistant_find_files(array['secret'])) = 0,
  'C cannot find A''s file outside the shared folder');
select pg_temp.check(
  (select count(*) from public.assistant_find_files(null, null, 'mine')) = 0,
  'scope "mine" excludes files shared with C');

select pg_temp.login(:D);
select pg_temp.check(
  (select count(*) from public.assistant_find_files(null)) = 1,
  'D (no grants) only sees the public file');

-- ---------------------------------------------------------- content search
select pg_temp.login(:C);
select pg_temp.check(
  (select count(*) from public.assistant_search_content('authentication')
   where file_id = '10000000-0000-0000-0000-0000000000a1') = 1,
  'C finds content inside an inherited shared file');
select pg_temp.check(
  (select snippet from public.assistant_search_content('authentication')) like '%API authentication%',
  'snippet keeps the original text');

select pg_temp.login(:B);
select pg_temp.check(
  (select count(*) from public.assistant_search_content('authentication')) = 0,
  'B cannot search content of A''s private files');
select pg_temp.check(
  (select array_agg(file_id::text) from public.assistant_search_content('database'))
    = array['10000000-0000-0000-0000-0000000000b1'],
  'B''s content search only returns B''s own document');
select pg_temp.check(
  (select count(*) from public.assistant_search_content('ke hoach bi mat')) = 0,
  'accent-free content search does not leak A''s secret');
select pg_temp.check(
  (select count(*) from public.file_contents where file_id = '10000000-0000-0000-0000-0000000000a2') = 0,
  'RLS hides another user''s index rows from direct reads');
select pg_temp.check(
  (select count(*) from public.assistant_get_content('10000000-0000-0000-0000-0000000000a2')) = 0,
  'get_content reveals nothing (not even the name) without access');

select pg_temp.login(:A);
select pg_temp.check(
  (select status from public.assistant_get_content('10000000-0000-0000-0000-0000000000a2')) = 'indexed',
  'owner can read the indexed content');

select pg_temp.check(
  (select content from public.assistant_get_document('10000000-0000-0000-0000-0000000000a2')) like 'Kế hoạch bí mật%',
  'owner reads the full document for summaries');
select pg_temp.login(:B);
select pg_temp.check(
  (select count(*) from public.assistant_get_document('10000000-0000-0000-0000-0000000000a2')) = 0,
  'get_document reveals nothing without access');
select pg_temp.login(:C);
select pg_temp.check(
  (select name from public.assistant_get_document('10000000-0000-0000-0000-0000000000a1')) = 'bao-cao-tai-chinh-thang-9.pdf',
  'get_document works through an inherited folder share');

-- users can never write the index (only the server indexer can)
select pg_temp.login(:B);
do $$
begin
  begin
    insert into public.file_contents (file_id, version_id, status, content)
    values ('10000000-0000-0000-0000-0000000000b1', null, 'indexed', 'poisoned');
    raise exception 'insert should have been rejected';
  exception when insufficient_privilege then
    perform pg_temp.check(true, 'users cannot write the search index');
  end;
end $$;

-- ---------------------------------------------------- share, then revoke
reset role;
select pg_temp.login(:A);
insert into public.file_shares (file_id, grantee_id, role, granted_by)
values ('10000000-0000-0000-0000-0000000000a2', :B, 'viewer', :A);
set local role authenticated;

select pg_temp.login(:B);
select pg_temp.check(
  (select count(*) from public.assistant_find_files(array['secret'], null, 'shared')) = 1,
  'after sharing, B finds the file in "shared with me"');
select pg_temp.check(
  (select count(*) from public.assistant_search_content('ke hoach bi mat')) = 1,
  'after sharing, B can search its content');

select pg_temp.login(:A);
select pg_temp.check(
  (select grantee_email from public.assistant_my_shares('Nguyễn Văn A')) = 'nguyenvana@example.com',
  'A lists what was shared with "Nguyễn Văn A" (accent/space-insensitive)');
select pg_temp.login(:B);
select pg_temp.check(
  (select count(*) from public.assistant_my_shares(null)) = 0,
  'B has shared nothing');

reset role;
delete from public.file_shares where file_id = '10000000-0000-0000-0000-0000000000a2' and grantee_id = :B;
set local role authenticated;

select pg_temp.login(:B);
select pg_temp.check(
  (select count(*) from public.assistant_find_files(array['secret'])) = 0
  and (select count(*) from public.assistant_search_content('ke hoach bi mat')) = 0
  and (select count(*) from public.assistant_get_content('10000000-0000-0000-0000-0000000000a2')) = 0
  and (select count(*) from public.assistant_get_document('10000000-0000-0000-0000-0000000000a2')) = 0,
  'revoking the share removes access immediately');

-- ----------------------------------------------- trash and stale versions
reset role;
update public.files set deleted_at = now() where id = '10000000-0000-0000-0000-0000000000a4';
insert into public.file_versions (id, file_id, version_no, storage_path, size, mime_type, uploaded_by)
values ('20000000-0000-0000-0000-0000000000f1', '10000000-0000-0000-0000-0000000000a1', 2, 'a/a1/v2/x.pdf', 10, 'application/pdf', :A);
update public.files set current_version_id = '20000000-0000-0000-0000-0000000000f1'
where id = '10000000-0000-0000-0000-0000000000a1';
set local role authenticated;

select pg_temp.login(:C);
select pg_temp.check(
  (select count(*) from public.assistant_find_files(array['contract'])) = 0,
  'trashed files disappear for grantees');
select pg_temp.check(
  (select count(*) from public.assistant_search_content('authentication')) = 0,
  'index of an outdated version is not searchable');
select pg_temp.check(
  (select content = '' and indexed_version_id <> current_version_id
   from public.assistant_get_document('10000000-0000-0000-0000-0000000000a1')),
  'an outdated summary source is detected (old text not returned)');
select pg_temp.login(:A);
select pg_temp.check(
  (select count(*) from public.assistant_index_candidates(array['pdf'])
   where file_id = '10000000-0000-0000-0000-0000000000a1'
     and version_id = '20000000-0000-0000-0000-0000000000f1') = 1,
  'the new version is queued for re-indexing');
select pg_temp.login(:B);
select pg_temp.check(
  (select count(*) from public.assistant_index_candidates(array['pdf', 'docx', 'txt'])
   where file_id::text like '10000000-%-0000000000a%' and file_id <> '10000000-0000-0000-0000-0000000000a3') = 0,
  'B cannot queue A''s private files for indexing');

-- ------------------------------------------------------ unauthenticated
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  begin
    perform * from public.assistant_find_files(null);
    raise exception 'anonymous call should fail';
  exception when raise_exception then
    perform pg_temp.check(sqlerrm = 'Authentication required', 'calls without a user are rejected');
  end;
end $$;

reset role;
set local role anon;
do $$
begin
  begin
    perform * from public.assistant_find_files(null);
    raise exception 'anon role should not execute';
  exception when insufficient_privilege then
    perform pg_temp.check(true, 'anon role cannot execute assistant functions');
  end;
end $$;

reset role;
\o
\echo 'assistant permission tests: all passed'
rollback;
