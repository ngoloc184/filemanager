-- Workflow e-mail reminders (202608280049_workflow_reminders.sql): the shared role directory and
-- the reminder log (written by the server only, read by members, automatic ones once a day).
-- Run with scripts/test-db.sh (plain PostgreSQL + supabase/tests stubs).
-- Everything runs in one transaction that is rolled back at the end.

\set ON_ERROR_STOP 1
\o /dev/null
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B '''bbbbbbbb-0000-0000-0000-00000000000b'''
\set W '''3f000000-0000-0000-0000-000000000009'''

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

create function pg_temp.error_of(stmt text) returns text
language plpgsql as $$
begin
  execute stmt;
  return null;
exception when others then
  return sqlerrm;
end;
$$;

insert into auth.users (id, email) values (:A, 'alice@example.com'), (:B, 'bob@example.com');
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
grant execute on function pg_temp.login(uuid) to authenticated, anon;
grant execute on function pg_temp.error_of(text) to authenticated, anon;

set local role authenticated;

-- ---------------------------------------------------------------- the directory
select pg_temp.login(:A);
insert into public.workflow_role_contacts (role_name, emails)
values ('  QC HDBank ', array[' Lan@HDBank.com.vn', 'lan@hdbank.com.vn', 'minh@hdbank.com.vn', '']);
select pg_temp.check(
  (select role_name = 'QC HDBank' and role_key = 'qc hdbank' and emails = array['lan@hdbank.com.vn', 'minh@hdbank.com.vn'] and updated_by = :A
   from public.workflow_role_contacts),
  'a role''s addresses are stored trimmed, lower-case and once each');
select pg_temp.check(
  pg_temp.error_of(format('insert into public.workflow_role_contacts (role_name) values (%L)', 'qc hdbank')) like '%duplicate%',
  'one entry per role name, whatever the case');
select pg_temp.check(
  pg_temp.error_of(format('insert into public.workflow_role_contacts (role_name, emails) values (%L, %L)', 'DEV FPT', '{not-an-email}')) like '%check%'
  and pg_temp.error_of(format('insert into public.workflow_role_contacts (role_name, emails) values (%L, %L)', 'DEV FPT', '{"a@b.c, d@e.f"}')) like '%check%',
  'only plain addresses are accepted');

select pg_temp.login(:B);
update public.workflow_role_contacts set emails = emails || 'tuan@hdbank.com.vn'::text where role_key = 'qc hdbank';
select pg_temp.check(
  (select cardinality(emails) = 3 and updated_by = :B from public.workflow_role_contacts),
  'the directory is shared: Bob edits Alice''s entry');
select pg_temp.check(
  pg_temp.error_of(format('update public.workflow_role_contacts set updated_by = %L', 'aaaaaaaa-0000-0000-0000-00000000000a')) like 'permission denied%',
  'nobody writes who changed it');

-- ---------------------------------------------------------------- the reminder log
select pg_temp.login(:A);
insert into public.workflows (id, owner_id, name, doc) values (:W, :A, 'Plan', '{"version": 2, "steps": []}');
select pg_temp.check(
  pg_temp.error_of(format('insert into public.workflow_reminders (workflow_id, step_id, kind, day) values (%L, %L, %L, current_date)', '3f000000-0000-0000-0000-000000000009', 's_1', 'due')) like 'permission denied%',
  'the app cannot write the reminder log');
reset role;
insert into public.workflow_reminders (workflow_id, step_id, kind, day, recipients) values (:W, 's_1', 'due', '2026-11-02', array['lan@hdbank.com.vn']);
select pg_temp.check(
  pg_temp.error_of(format('insert into public.workflow_reminders (workflow_id, step_id, kind, day) values (%L, %L, %L, %L)', '3f000000-0000-0000-0000-000000000009', 's_1', 'due', '2026-11-02')) like '%duplicate%',
  'an automatic reminder is sent once per step, kind and day');
insert into public.workflow_reminders (workflow_id, step_id, kind, day, manual, sent_by) values (:W, 's_1', 'due', '2026-11-02', true, :A), (:W, 's_1', 'due', '2026-11-02', true, :A);
select pg_temp.check((select count(*) from public.workflow_reminders) = 3, '"Nhắc ngay" may be pressed again the same day');
set local role authenticated;
select pg_temp.login(:A);
select pg_temp.check((select count(*) from public.workflow_reminders) = 3, 'a member reads the reminder log');
select pg_temp.login(:B);
select pg_temp.check((select count(*) from public.workflow_reminders) = 0, 'someone who has not opened the plan does not');

-- ---------------------------------------------------------------- anon
reset role;
set local role anon;
select pg_temp.check(
  pg_temp.error_of('select * from public.workflow_role_contacts') like 'permission denied%'
  and pg_temp.error_of('select * from public.workflow_reminders') like 'permission denied%',
  'people without an account see no addresses and no reminders');

rollback;
