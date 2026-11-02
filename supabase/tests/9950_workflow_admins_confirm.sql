-- Workflow admins and timeline confirmation (202608280050_workflow_admins_confirm.sql): only the
-- owner and admins edit the plan; anyone with the link changes an unconfirmed length or confirms
-- it, after which the length can only be extended; per-role confirmation reminders.
-- Run with scripts/test-db.sh (plain PostgreSQL + supabase/tests stubs).
-- Everything runs in one transaction that is rolled back at the end.

\set ON_ERROR_STOP 1
\o /dev/null
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B '''bbbbbbbb-0000-0000-0000-00000000000b'''
\set C '''cccccccc-0000-0000-0000-00000000000c'''
\set W '''3f000000-0000-0000-0000-000000000050'''

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

create function pg_temp.state_of(stmt text) returns text
language plpgsql as $$
begin
  execute stmt;
  return null;
exception when others then
  return sqlstate;
end;
$$;

create function pg_temp.row_count(stmt text) returns bigint
language plpgsql as $$
declare
  n bigint;
begin
  execute stmt;
  get diagnostics n = row_count;
  return n;
end;
$$;

insert into auth.users (id, email) values (:A, 'alice@example.com'), (:B, 'bob@example.com'), (:C, 'carol@example.com');
insert into public.user_profiles (id, email) values (:A, 'alice@example.com'), (:B, 'bob@example.com'), (:C, 'carol@example.com') on conflict (id) do nothing;
update public.user_profiles set display_name = 'Carol QC' where id = :C;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
grant execute on function pg_temp.login(uuid) to authenticated, anon;
grant execute on function pg_temp.state_of(text) to authenticated, anon;
grant execute on function pg_temp.row_count(text) to authenticated, anon;

set local role authenticated;

-- ---------------------------------------------------------------- admins
select pg_temp.login(:A);
insert into public.workflows (id, owner_id, name, doc) values (:W, :A, 'Plan', '{"version": 2, "steps": [
  {"id": "s_1", "duration": {"amount": 2, "unit": "d"}},
  {"id": "s_2", "duration": {"amount": 4, "unit": "h"}}]}');
select pg_temp.check(public.is_workflow_admin(:W), 'the owner is an admin');

select pg_temp.login(:B);
select pg_temp.check(public.join_workflow(:W) = 'member', 'opening the link makes Bob a member');
select pg_temp.check(not public.is_workflow_admin(:W), 'a member is not an admin');
select pg_temp.check(
  pg_temp.row_count(format('update public.workflows set name = %L where id = %L', 'Renamed', '3f000000-0000-0000-0000-000000000050')) = 0,
  'a member cannot edit the plan');
select pg_temp.check(
  pg_temp.state_of(format('select public.set_workflow_admin(%L, %L, true)', '3f000000-0000-0000-0000-000000000050', 'bbbbbbbb-0000-0000-0000-00000000000b')) = '42501',
  'a member cannot make himself an admin');
select pg_temp.check((select count(*) from public.list_workflow_members(:W)) = 0, 'a member does not see who else opened the plan');

select pg_temp.login(:C);
select public.join_workflow(:W);
select pg_temp.login(:A);
select pg_temp.check((select count(*) from public.list_workflow_members(:W)) = 3, 'the owner sees everyone who opened the plan');
select pg_temp.check(
  (select name = 'Carol QC' and email = 'carol@example.com' and role = 'member' from public.list_workflow_members(:W) where user_id = :C),
  'with their name, e-mail and role');
select public.set_workflow_admin(:W, :B, true);
select pg_temp.check(
  pg_temp.state_of(format('select public.set_workflow_admin(%L, %L, false)', '3f000000-0000-0000-0000-000000000050', 'aaaaaaaa-0000-0000-0000-00000000000a')) = 'PT404',
  'the owner stays the owner');

select pg_temp.login(:B);
select pg_temp.check(public.is_workflow_admin(:W), 'Bob is now an admin');
select pg_temp.check(
  pg_temp.row_count(format('update public.workflows set name = %L where id = %L', 'Renamed', '3f000000-0000-0000-0000-000000000050')) = 1,
  'and edits the plan');
select pg_temp.check(
  pg_temp.state_of(format('select public.set_workflow_admin(%L, %L, true)', '3f000000-0000-0000-0000-000000000050', 'cccccccc-0000-0000-0000-00000000000c')) = '42501',
  'only the owner names admins');

-- ---------------------------------------------------------------- confirming a timeline
reset role;
select set_config('request.jwt.claim.sub', '', true);
select public.workflow_public_change(:W, 's_1', 'duration', 3, 'd', null, 'Lan', 'QC HDBank', null);
select pg_temp.check(
  (select doc #>> '{steps,0,duration,amount}' = '3' from public.workflows where id = :W),
  'anyone with the link changes an unconfirmed length');
select public.workflow_public_change(:W, 's_1', 'confirm', 3, 'd', 'Đã thống nhất với HDBank', 'Lan', 'QC HDBank', null);
select pg_temp.check(
  (select doc #>> '{steps,0,confirmed,by}' = 'Lan' and doc #>> '{steps,0,confirmed,role}' = 'QC HDBank' and doc #> '{steps,0,confirmed,at}' is not null
   from public.workflows where id = :W),
  'confirming records who and when in the step');
select pg_temp.check(
  (select count(*) from public.workflow_step_logs where step_id = 's_1' and kind = 'confirm' and amount = 3 and reason = 'Đã thống nhất với HDBank') = 1
  and (select count(*) from public.workflow_step_logs where step_id = 's_1' and kind = 'duration') = 1,
  'confirming the same length logs the confirmation only');
select pg_temp.check(
  pg_temp.state_of(format('select public.workflow_public_change(%L, %L, %L, 5, %L, null, %L, %L, null)', '3f000000-0000-0000-0000-000000000050', 's_1', 'duration', 'd', 'X', 'QC')) = 'PT409'
  and pg_temp.state_of(format('select public.workflow_public_change(%L, %L, %L, 5, %L, null, %L, %L, null)', '3f000000-0000-0000-0000-000000000050', 's_1', 'confirm', 'd', 'X', 'QC')) = 'PT409',
  'a confirmed length cannot be changed or confirmed again');
select public.workflow_public_change(:W, 's_1', 'extend', 1, 'd', 'Chờ data test', 'Lan', 'QC HDBank', null);
select pg_temp.check(
  (select count(*) from public.workflow_step_logs where step_id = 's_1' and kind = 'extend') = 1,
  'it can still be extended');

select public.workflow_public_change(:W, 's_2', 'confirm', 6, 'h', null, 'ignored', 'DEV FPT', :C);
select pg_temp.check(
  (select doc #>> '{steps,1,duration,amount}' = '6' and doc #>> '{steps,1,confirmed,by}' = 'Carol QC' from public.workflows where id = :W)
  and (select count(*) from public.workflow_step_logs where step_id = 's_2' and kind in ('duration', 'confirm') and requester_name = 'Carol QC') = 2,
  'confirming with a new length changes it, logs both, under the signed-in person''s profile name');

-- an admin may still change a confirmed length in the editor; it is logged
set local role authenticated;
select pg_temp.login(:B);
update public.workflows set doc = jsonb_set(doc, '{steps,0,duration,amount}', '4') where id = :W;
select pg_temp.check(
  (select count(*) from public.workflow_step_logs where step_id = 's_1' and kind = 'duration' and amount = 4 and old_amount = 3) = 1,
  'an admin changes a confirmed length, and it is logged');

-- ---------------------------------------------------------------- cancelling is for admins
reset role;
create temp table ext as select id from public.workflow_step_logs where kind = 'extend';
grant select on ext to authenticated;
set local role authenticated;
select pg_temp.login(:C);
select pg_temp.check(
  pg_temp.state_of('select public.cancel_workflow_extension((select id from ext))') = 'PT404',
  'a member cannot cancel an extension');
select pg_temp.login(:B);
select public.cancel_workflow_extension((select id from ext));
select pg_temp.check((select cancelled_by = :B from public.workflow_step_logs where kind = 'extend'), 'an admin can');

-- ---------------------------------------------------------------- confirmation reminders
reset role;
insert into public.workflow_reminders (workflow_id, step_id, kind, day, role_name, recipients) values
  (:W, '_confirm', 'confirm', '2026-11-02', 'QC HDBank', '{lan@hd.vn}'),
  (:W, '_confirm', 'confirm', '2026-11-02', 'DEV FPT', '{an@fpt.vn}');
select pg_temp.check(
  pg_temp.state_of(format('insert into public.workflow_reminders (workflow_id, step_id, kind, day, role_name) values (%L, %L, %L, %L, %L)', '3f000000-0000-0000-0000-000000000050', '_confirm', 'confirm', '2026-11-02', 'qc hdbank')) = '23505',
  'one automatic confirmation reminder per role and day');

rollback;
