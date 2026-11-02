-- Offboarding: a leaving member's files, chat groups and document work go to
-- a successor; the member is marked 'left' and the account can be deleted.
-- Run with scripts/test-db.sh (plain PostgreSQL + supabase/tests stubs).
-- Everything runs in one transaction that is rolled back at the end.

\set ON_ERROR_STOP 1
\o /dev/null
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B '''bbbbbbbb-0000-0000-0000-00000000000b'''
\set C '''cccccccc-0000-0000-0000-00000000000c'''
\set D '''dddddddd-0000-0000-0000-00000000000d'''
\set E '''eeeeeeee-0000-0000-0000-00000000000e'''
\set ORG '''0a000000-0000-0000-0000-0000000000a1'''
\set ORG2 '''0a000000-0000-0000-0000-0000000000a2'''
\set HC '''0d000000-0000-0000-0000-0000000000d1'''
\set OPS '''0d000000-0000-0000-0000-0000000000d3'''
\set RIN '''08000000-0000-0000-0000-000000000081'''
\set ROUT '''08000000-0000-0000-0000-000000000082'''
\set BREP '''f0000000-0000-0000-0000-0000000000b1'''
\set BSUB '''f0000000-0000-0000-0000-0000000000b2'''
\set BDOC '''f0000000-0000-0000-0000-0000000000b3'''
\set CREP '''f0000000-0000-0000-0000-0000000000c1'''
\set CDOC '''f0000000-0000-0000-0000-0000000000c3'''
\set AFOL '''f0000000-0000-0000-0000-0000000000a1'''
\set X1 '''f1000000-0000-0000-0000-0000000000b1'''
\set X2 '''f1000000-0000-0000-0000-0000000000b2'''
\set XA '''f1000000-0000-0000-0000-0000000000a1'''
\set DIN '''0c000000-0000-0000-0000-0000000000c1'''
\set DOUT '''0c000000-0000-0000-0000-0000000000c2'''
\set DDRAFT '''0c000000-0000-0000-0000-0000000000c3'''
\set DDONE '''0c000000-0000-0000-0000-0000000000c4'''
\set ASG '''0e000000-0000-0000-0000-0000000000e1'''
\set ASGDONE '''0e000000-0000-0000-0000-0000000000e2'''
\set ST1 '''05000000-0000-0000-0000-000000000051'''
\set ST2 '''05000000-0000-0000-0000-000000000052'''
\set ST2C '''05000000-0000-0000-0000-000000000053'''
\set GRP '''06000000-0000-0000-0000-000000000061'''
\set GRP2 '''06000000-0000-0000-0000-000000000062'''
\set GRP3 '''06000000-0000-0000-0000-000000000063'''
\set CDOC2 '''f0000000-0000-0000-0000-0000000000c4'''

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
  (:D, 'dave@example.com'),
  (:E, 'erin@example.com');
insert into public.user_profiles (id, email) values
  (:A, 'alice@example.com'),
  (:B, 'bob@example.com'),
  (:C, 'carol@example.com'),
  (:D, 'dave@example.com'),
  (:E, 'erin@example.com')
on conflict (id) do nothing;
update public.user_profiles set display_name = 'Bob Trần' where id = :B;

-- ABC: Alice admin, Bob (heads HCNS), Carol and Erin staff.
-- XYZ: Dave admin; Erin left XYZ before joining ABC.
insert into public.organizations (id, name, code, created_by) values
  (:ORG, 'ABC Corporation', 'ABC', :A),
  (:ORG2, 'XYZ Company', 'XYZ', :D);
insert into public.departments (id, org_id, name, code, head_user_id) values
  (:HC, :ORG, 'Hành chính nhân sự', 'HCNS', :B),
  (:OPS, :ORG2, 'Operations', 'OPS', null);
insert into public.org_members (org_id, user_id, department_id, roles, status, left_at) values
  (:ORG, :A, :HC, '{org_admin,clerk,leader}', 'active', null),
  (:ORG, :B, :HC, '{staff,dept_head}', 'active', null),
  (:ORG, :C, :HC, '{staff}', 'active', null),
  (:ORG, :E, :HC, '{staff}', 'active', null),
  (:ORG2, :D, :OPS, '{org_admin}', 'active', null),
  (:ORG2, :E, :OPS, '{staff}', 'left', now() - interval '30 days');

-- Bob's files: root 'Reports' (Carol has one too), a subfolder, his
-- 'Documents' system folder (Carol has one too, and already a
-- 'Documents (from Bob Trần)', so his needs ' 2') and two files.
insert into public.folders (id, owner_id, parent_id, name, purpose) values
  (:BREP, :B, null, 'Reports', null),
  (:BSUB, :B, :BREP, 'Q1', null),
  (:BDOC, :B, null, 'Documents', 'documents'),
  (:CREP, :C, null, 'reports', null),
  (:CDOC, :C, null, 'Documents', 'documents'),
  (:CDOC2, :C, null, 'Documents (from Bob Trần)', null),
  (:AFOL, :A, null, 'Alice shared', null);
insert into public.files (id, folder_id, owner_id, name, original_name, size) values
  (:X1, :BSUB, :B, 'plan.pdf', 'plan.pdf', 100),
  (:X2, :BDOC, :B, 'letter.pdf', 'letter.pdf', 50),
  (:XA, :AFOL, :A, 'alice.txt', 'alice.txt', 5);
insert into public.file_versions (file_id, version_no, storage_path, size, uploaded_by) values
  (:X1, 1, 'bbbbbbbb-0000-0000-0000-00000000000b/f1000000-0000-0000-0000-0000000000b1/v1/plan.pdf', 100, :B),
  (:X2, 1, 'bbbbbbbb-0000-0000-0000-00000000000b/f1000000-0000-0000-0000-0000000000b2/v1/letter.pdf', 50, :B);
-- Carol already had a share of Bob's plan; Bob had a share of Alice's file.
insert into public.file_shares (file_id, grantee_id, role, granted_by) values
  (:X1, :C, 'viewer', :B),
  (:XA, :B, 'editor', :A);
insert into public.folder_shares (folder_id, grantee_id, role, granted_by) values
  (:AFOL, :B, 'viewer', :A);

-- Documents: an incoming document Bob leads (seen), a finished task, an
-- outgoing document waiting on Bob's approval (and a step Carol already has),
-- and Bob's own draft.
insert into public.doc_registers (id, org_id, direction, name, year) values
  (:RIN, :ORG, 'incoming', 'Sổ văn bản đến', 2026);
insert into public.doc_registers (id, org_id, direction, name, year) values
  (:ROUT, :ORG, 'outgoing', 'Sổ văn bản đi', 2026);
-- Bob manages both registers; Carol already follows the outgoing one.
insert into public.doc_register_roles (register_id, user_id, role) values
  (:RIN, :B, 'manager'),
  (:ROUT, :B, 'manager'),
  (:ROUT, :C, 'follower');
insert into public.documents (id, org_id, direction, status, subject, created_by, presented_to) values
  (:DIN, :ORG, 'incoming', 'in_progress', 'Công văn đến', :A, :B),
  (:DOUT, :ORG, 'outgoing', 'in_review', 'Tờ trình', :A, null),
  (:DDRAFT, :ORG, 'outgoing', 'draft', 'Bob draft', :B, null),
  (:DDONE, :ORG, 'incoming', 'completed', 'Đã xong', :A, :B);
insert into public.document_assignments (id, document_id, assignee_user_id, role, status, seen_at, assigned_by) values
  (:ASG, :DIN, :B, 'lead', 'seen', now(), :A),
  (:ASGDONE, :DDONE, :B, 'lead', 'done', now(), :A);
insert into public.document_approval_steps (id, document_id, revision, step_no, kind, approver_user_id, status) values
  (:ST1, :DOUT, 1, 1, 'review', :B, 'pending'),
  (:ST2, :DOUT, 1, 2, 'consult', :B, 'waiting'),
  (:ST2C, :DOUT, 1, 2, 'consult', :C, 'waiting');

-- Bob owns a chat group with Carol and Alice (admin).
insert into public.chat_conversations (id, kind, title, created_by) values (:GRP, 'group', 'Team', :B);
insert into public.chat_members (conversation_id, user_id, role, joined_at) values
  (:GRP, :B, 'owner', now() - interval '3 days'),
  (:GRP, :A, 'admin', now() - interval '2 days'),
  (:GRP, :C, 'member', now() - interval '1 day');
-- Bob owns a group without Carol: the admin (Alice) wins over an older
-- member (Erin). A group with only Bob in it stays as it is.
insert into public.chat_conversations (id, kind, title, created_by) values
  (:GRP2, 'group', 'Project', :B),
  (:GRP3, 'group', 'Just Bob', :B);
insert into public.chat_members (conversation_id, user_id, role, joined_at) values
  (:GRP2, :B, 'owner', now() - interval '5 days'),
  (:GRP2, :E, 'member', now() - interval '4 days'),
  (:GRP2, :A, 'admin', now() - interval '1 day'),
  (:GRP3, :B, 'owner', now() - interval '5 days');

insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values
  (:B, 'https://fcm.googleapis.com/fcm/send/bob-device', 'key', 'auth');

-- Bob owns a dossier when 202608280043 (dossiers) is applied too.
do $$
begin
  if to_regclass('public.dossiers') is not null then
    execute $q$insert into public.dossiers (org_id, year, code, title, owner_id)
      values ('0a000000-0000-0000-0000-0000000000a1', 2026, '01.HCNS', 'Hồ sơ của Bob',
              'bbbbbbbb-0000-0000-0000-00000000000b')$q$;
  end if;
end;
$$;
create function pg_temp.dossiers_owned_by(uid uuid) returns bigint
language plpgsql as $$
declare
  n bigint := 0;
begin
  if to_regclass('public.dossiers') is not null then
    execute 'select count(*) from public.dossiers where owner_id = $1' into n using uid;
  end if;
  return n;
end;
$$;

create temp table expect as
  select case when to_regclass('public.dossiers') is null then 0 else 1 end as dossiers;
grant select on expect to authenticated, anon;

grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
grant execute on function pg_temp.login(uuid) to authenticated, anon;
grant execute on function pg_temp.error_of(text) to authenticated, anon;

create temp table result (k text primary key, v jsonb);
grant all on result to authenticated, anon;

-- ---------------------------------------------------------------- anon
set local role anon;
set local request.jwt.claim.sub = '';

select pg_temp.check(
  pg_temp.error_of(format('select public.offboarding_preview(%L)', :B)) ~* 'permission denied',
  'anon cannot call offboarding_preview');
select pg_temp.check(
  pg_temp.error_of(format('select public.offboard_member(%L, %L)', :B, :C)) ~* 'permission denied',
  'anon cannot call offboard_member');
select pg_temp.check(
  pg_temp.error_of(format('select public.transfer_user_data(%L, %L, %L)', :ORG, :B, :C)) ~* 'permission denied',
  'anon cannot call transfer_user_data');

reset role;
set local role authenticated;

-- ---------------------------------------------------------------- who may offboard
select pg_temp.login(:C);
select pg_temp.check(
  pg_temp.error_of(format('select public.offboard_member(%L, %L)', :B, :C)) ~* 'only company admins',
  'a non-admin cannot offboard a member');
select pg_temp.check(
  pg_temp.error_of(format('select public.offboarding_preview(%L)', :B)) ~* 'only company admins',
  'a non-admin cannot preview an offboarding');

select pg_temp.login(:A);
select pg_temp.check(
  pg_temp.error_of(format('select public.transfer_user_data(%L, %L, %L)', :ORG, :B, :C)) ~* 'permission denied',
  'an admin cannot call transfer_user_data directly (internal)');
select pg_temp.check(
  pg_temp.error_of(format('select public.revoke_user_sessions(%L)', :B)) ~* 'permission denied',
  'revoke_user_sessions is internal');
select pg_temp.check(
  pg_temp.error_of(format('select public.offboard_member(%L, %L)', :A, :C)) ~* 'cannot offboard yourself',
  'the last admin cannot offboard themselves');
select pg_temp.check(
  pg_temp.error_of(format('select public.offboard_member(%L, %L)', :B, :B)) ~* 'different person',
  'the successor must be someone else');
select pg_temp.check(
  pg_temp.error_of(format('select public.offboard_member(%L, %L)', :B, :D)) ~* 'active member',
  'the successor must be an active member of the same company');

select pg_temp.login(:D);
select pg_temp.check(
  pg_temp.error_of(format('select public.offboard_member(%L, %L)', :E, :D)) ~* 'only company admins',
  'an admin of a company the person left cannot offboard them from their new company');
select pg_temp.check(
  pg_temp.error_of(format('select public.offboarding_preview(%L)', :E)) ~* 'only company admins',
  'an admin of a company the person left cannot preview them');

-- ---------------------------------------------------------------- preview
select pg_temp.login(:A);
insert into result select 'preview', public.offboarding_preview(:B);

select pg_temp.check(
  (select v->>'files' = '2' and v->>'folders' = '3' and v->>'bytes' = '150' from result where k = 'preview'),
  'preview counts Bob''s files, folders and bytes');
select pg_temp.check(
  (select v->>'open_assignments' = '1' and v->>'pending_steps' = '2' and v->>'presented_documents' = '1'
     and v->>'draft_documents' = '1' and v->>'headed_departments' = '1'
     and v->>'owned_chat_groups' = '2' and v->>'register_roles' = '2'
     and (v->>'dossiers')::int = (select dossiers from expect)
   from result where k = 'preview'),
  'preview counts open document work, departments, groups and register roles');

-- ---------------------------------------------------------------- offboard Bob -> Carol
insert into result select 'done', public.offboard_member(:B, :C);

select pg_temp.check(
  (select v->>'files' = '2' and v->>'folders' = '3' and v->>'renamed_folders' = '2'
     and v->>'assignments' = '1' and v->>'approval_steps' = '1' and v->>'skipped_steps' = '1'
     and v->>'chat_groups' = '2' and v->>'push_subscriptions' = '1'
     and (v->>'dossiers')::int = (select dossiers from expect)
   from result where k = 'done'),
  'offboard_member returns the counts');

reset role;
select pg_temp.check(
  (select count(*) from public.files where owner_id = :B) = 0
  and (select count(*) from public.folders where owner_id = :B) = 0,
  'Bob owns no files or folders any more');
select pg_temp.check(
  (select name from public.folders where id = :BREP) = 'Reports (from Bob Trần)',
  'Bob''s root Reports folder was renamed instead of colliding with Carol''s');
select pg_temp.check(
  (select name from public.folders where id = :BDOC) = 'Documents (from Bob Trần) 2'
  and (select purpose from public.folders where id = :BDOC) is null
  and (select purpose from public.folders where id = :CDOC) = 'documents',
  'Bob''s Documents system folder became a plain folder with a free name; Carol keeps hers');
select pg_temp.check(
  (select name from public.folders where id = :BSUB) = 'Q1',
  'subfolders keep their names');
select pg_temp.check(
  not exists (select 1 from public.file_shares where grantee_id in (:B, :C) and file_id in (:X1, :XA))
  and not exists (select 1 from public.folder_shares where grantee_id = :B),
  'shares to Bob and Carol''s now-redundant share are gone');
select pg_temp.check(
  (select status from public.org_members where org_id = :ORG and user_id = :B) = 'left'
  and (select left_at from public.org_members where org_id = :ORG and user_id = :B) is not null,
  'Bob is marked left');
select pg_temp.check(
  (select head_user_id from public.departments where id = :HC) = :C,
  'Carol heads Bob''s department');
select pg_temp.check(
  not exists (select 1 from public.push_subscriptions where user_id = :B),
  'Bob''s push subscriptions are deleted');
select pg_temp.check(
  exists (select 1 from public.doc_register_roles where register_id = :RIN and user_id = :C and role = 'manager')
  and exists (select 1 from public.doc_register_roles where register_id = :ROUT and user_id = :C and role = 'manager')
  and not exists (select 1 from public.doc_register_roles where user_id = :B),
  'register roles move to Carol (a follower becomes manager)');
select pg_temp.check(
  (select role from public.chat_members where conversation_id = :GRP and user_id = :C) = 'owner'
  and (select role from public.chat_members where conversation_id = :GRP and user_id = :B) = 'member'
  and (select role from public.chat_members where conversation_id = :GRP and user_id = :A) = 'admin',
  'the chat group goes to Carol (a member), not to the admin');
select pg_temp.check(
  exists (select 1 from public.chat_messages
          where conversation_id = :GRP and kind = 'system' and meta->>'type' = 'owner' and meta->>'user_id' = :C),
  'the group shows who the new owner is');
select pg_temp.check(
  (select role from public.chat_members where conversation_id = :GRP2 and user_id = :A) = 'owner'
  and (select role from public.chat_members where conversation_id = :GRP2 and user_id = :E) = 'member'
  and (select role from public.chat_members where conversation_id = :GRP2 and user_id = :B) = 'member',
  'a group without Carol goes to its admin, not to the older member');
select pg_temp.check(
  (select role from public.chat_members where conversation_id = :GRP3 and user_id = :B) = 'owner',
  'a group with nobody else in it is left alone');

select pg_temp.check(
  pg_temp.dossiers_owned_by(:C) = (select dossiers from expect)
  and pg_temp.dossiers_owned_by(:B) = 0,
  'Bob''s dossier belongs to Carol (when dossiers exist)');

-- documents
select pg_temp.check(
  (select assignee_user_id = :C and status = 'pending' and seen_at is null
   from public.document_assignments where id = :ASG),
  'Bob''s open lead assignment is Carol''s and pending again');
select pg_temp.check(
  (select assignee_user_id from public.document_assignments where id = :ASGDONE) = :B,
  'finished assignments keep their history');
select pg_temp.check(
  exists (select 1 from public.document_events
          where document_id = :DIN and action = 'reassigned' and actor_id = :A
            and data->>'to' = :C),
  'the reassignment is in the document timeline');
select pg_temp.check(
  (select approver_user_id = :C and status = 'pending' from public.document_approval_steps where id = :ST1),
  'Bob''s pending approval step is Carol''s');
select pg_temp.check(
  (select approver_user_id = :B and status = 'skipped' from public.document_approval_steps where id = :ST2)
  and (select status from public.document_approval_steps where id = :ST2C) = 'waiting',
  'a step Carol already has is skipped for Bob');
select pg_temp.check(
  (select presented_to from public.documents where id = :DIN) = :C
  and (select presented_to from public.documents where id = :DDONE) = :B,
  'unfinished documents are presented to Carol; finished ones keep Bob');
select pg_temp.check(
  (select created_by from public.documents where id = :DDRAFT) = :C,
  'Bob''s draft belongs to Carol');

-- ---------------------------------------------------------------- Carol's view
set local role authenticated;
select pg_temp.login(:C);
select pg_temp.check(
  (select count(*) from public.files where id in (:X1, :X2)) = 2,
  'Carol can read the files she received');
select pg_temp.check(
  public.has_file_access(:X1, 'admin'),
  'Carol is the owner of Bob''s plan');
select pg_temp.check(
  exists (select 1 from public.notifications
          where user_id = :C and kind = 'org.handover' and title = 'You received work from Bob Trần'
            and link = '/documents'),
  'Carol is notified about the handover');

select pg_temp.login(:A);
select pg_temp.check(
  pg_temp.error_of(format('select public.offboard_member(%L, %L)', :B, :C)) ~* 'only company admins',
  'someone who already left cannot be offboarded again');
select pg_temp.check(
  pg_temp.error_of(format('select public.offboarding_preview(%L)', :B)) ~* 'only company admins',
  'nor previewed');

-- ---------------------------------------------------------------- the account can go
reset role;
insert into result select 'delete_bob',
  to_jsonb(pg_temp.error_of(format('delete from auth.users where id = %L', :B)));
select pg_temp.check(
  (select v is null from result where k = 'delete_bob'),
  'Bob''s account can be deleted after offboarding'
    || coalesce(' (' || (select v->>0 from result where k = 'delete_bob') || ')', ''));
select pg_temp.check(
  (select count(*) from public.files where id in (:X1, :X2)) = 2
  and (select count(*) from public.file_versions where file_id in (:X1, :X2)) = 2,
  'no team file was lost');

rollback;
