-- Workflow builder (202608280047_workflows.sql): owners and editors who join by link, saving with
-- a revision, the step log (extensions and length changes from the public page, length changes
-- by editors), cancelling an extension, and what anon may do.
-- Run with scripts/test-db.sh (plain PostgreSQL + supabase/tests stubs).
-- Everything runs in one transaction that is rolled back at the end.

\set ON_ERROR_STOP 1
\o /dev/null
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B '''bbbbbbbb-0000-0000-0000-00000000000b'''
\set C '''cccccccc-0000-0000-0000-00000000000c'''
\set W '''3f000000-0000-0000-0000-000000000001'''

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

-- ---------------------------------------------------------------- fixtures
insert into auth.users (id, email) values
  (:A, 'alice@example.com'),
  (:B, 'bob@example.com'),
  (:C, 'carol@example.com');

grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
grant execute on function pg_temp.login(uuid) to authenticated, anon;
grant execute on function pg_temp.error_of(text) to authenticated, anon;
grant execute on function pg_temp.state_of(text) to authenticated, anon;
grant execute on function pg_temp.row_count(text) to authenticated, anon;

set local role authenticated;

-- ---------------------------------------------------------------- creating
select pg_temp.login(:A);
insert into public.workflows (id, owner_id, name, doc)
values (:W, :A, 'UAT plan', '{"version": 2, "steps": [{"id": "s_1", "duration": {"amount": 2, "unit": "d"}}, {"id": "s_2", "duration": {"amount": 4, "unit": "h"}}]}');
select pg_temp.check(
  (select revision from public.workflows where id = :W) = 1,
  'a new plan starts at revision 1');
select pg_temp.check(
  (select role from public.workflow_members where workflow_id = :W) = 'owner',
  'the creator becomes the owner');
insert into public.workflows (owner_id, name, doc) values (:B, 'In Bob''s name', '{"steps": []}');
select pg_temp.check(
  (select owner_id from public.workflows where name = 'In Bob''s name') = :A,
  'a plan sent in someone else''s name still belongs to its creator');
select pg_temp.check(
  pg_temp.error_of(format('insert into public.workflows (owner_id, name, doc) values (%L, %L, %L)', 'aaaaaaaa-0000-0000-0000-00000000000a', '  ', '{"steps": []}')) like '%check%'
  and pg_temp.error_of(format('insert into public.workflows (owner_id, name, doc) values (%L, %L, %L)', 'aaaaaaaa-0000-0000-0000-00000000000a', 'x', '[]')) is not null,
  'a plan needs a name and an object document');

-- ---------------------------------------------------------------- joining by link
select pg_temp.login(:B);
select pg_temp.check((select count(*) from public.workflows) = 0, 'Bob does not see a plan he has not opened');
select pg_temp.check(
  pg_temp.row_count(format('update public.workflows set name = %L where id = %L', 'hacked', '3f000000-0000-0000-0000-000000000001')) = 0,
  'nor change it');
select pg_temp.check(public.join_workflow(:W) = 'editor', 'opening the link makes Bob an editor');
select pg_temp.check(public.join_workflow('3f000000-0000-0000-0000-0000000000ff') is null, 'an unknown plan returns null');
select pg_temp.check((select count(*) from public.workflows) = 1, 'Bob now sees the plan');
select pg_temp.check((select count(*) from public.workflow_members) = 1, 'Bob only sees his own membership');

-- ---------------------------------------------------------------- saving with a revision
select pg_temp.check(
  pg_temp.row_count(format('update public.workflows set name = %L, doc = doc || %L where id = %L and revision = 1', 'UAT plan v2', '{"note": 1}', '3f000000-0000-0000-0000-000000000001')) = 1,
  'Bob saves on the current revision');
select pg_temp.check(
  pg_temp.row_count(format('update public.workflows set name = %L where id = %L and revision = 1', 'stale', '3f000000-0000-0000-0000-000000000001')) = 0,
  'a save on an old revision changes nothing');
select pg_temp.check(
  pg_temp.error_of(format('update public.workflows set owner_id = %L where id = %L', 'bbbbbbbb-0000-0000-0000-00000000000b', '3f000000-0000-0000-0000-000000000001')) like 'permission denied%'
  and pg_temp.error_of(format('update public.workflows set revision = 99 where id = %L', '3f000000-0000-0000-0000-000000000001')) like 'permission denied%',
  'the owner and revision are not writable');
select pg_temp.check(
  pg_temp.row_count(format('delete from public.workflows where id = %L', '3f000000-0000-0000-0000-000000000001')) = 0,
  'an editor cannot delete the plan');
reset role;
select pg_temp.check(
  (select revision = 2 and updated_by = :B and owner_id = :A and name = 'UAT plan v2' from public.workflows where id = :W)
  and not exists (select 1 from public.workflow_step_logs),
  'the save bumped the revision and recorded the editor');
set local role authenticated;

-- ---------------------------------------------------------------- editor length changes are logged
reset role;
insert into public.user_profiles (id, email) values (:B, 'bob@example.com') on conflict (id) do nothing;
update public.user_profiles set display_name = 'Bob Tran' where id = :B;
set local role authenticated;
update public.workflows
set doc = jsonb_set(doc, '{steps,1,duration}', '{"amount": 6, "unit": "h"}')
where id = :W;
select pg_temp.check(
  pg_temp.error_of('select * from public.workflow_step_logs') is null
  and (select count(*) from public.workflow_step_logs) = 1,
  'Bob sees the log of a plan he edits');
select pg_temp.check(
  (select kind = 'duration' and step_id = 's_2' and old_amount = 4 and old_unit = 'h' and amount = 6 and unit = 'h'
          and requester_name = 'Bob Tran' and created_by = :B
   from public.workflow_step_logs),
  'changing a length in the editor logs old and new, under the editor''s profile name');
select pg_temp.check(
  pg_temp.state_of(format('update public.workflows set doc = jsonb_set(doc, %L, %L) where id = %L', '{steps,1,duration}', '{"amount": 10.0, "unit": "h"}', '3f000000-0000-0000-0000-000000000001')) = '22023'
  and pg_temp.state_of(format('update public.workflows set doc = jsonb_set(doc, %L, %L) where id = %L', '{steps,1,duration}', '{"amount": 0, "unit": "h"}', '3f000000-0000-0000-0000-000000000001')) = '22023'
  and pg_temp.state_of(format('update public.workflows set doc = jsonb_set(doc, %L, %L) where id = %L', '{steps,1}', '{"id": "s_2"}', '3f000000-0000-0000-0000-000000000001')) = '22023',
  'a save must keep every step''s duration well-formed (so no change escapes the log)');
update public.workflows set name = 'UAT plan v3' where id = :W;
select pg_temp.check((select count(*) from public.workflow_step_logs) = 1, 'other edits add no log');

-- ---------------------------------------------------------------- public changes (server only)
select pg_temp.check(
  pg_temp.error_of(format('insert into public.workflow_step_logs (workflow_id, step_id, kind, amount, unit, reason, requester_name, requester_role) values (%L, %L, %L, 1, %L, %L, %L, %L)', '3f000000-0000-0000-0000-000000000001', 's_1', 'extend', 'd', 'need more time', 'Bob', 'QC')) like 'permission denied%',
  'the app cannot write the log directly');
select pg_temp.check(
  pg_temp.error_of(format('select public.workflow_public_change(%L, %L, %L, 1, %L, %L, %L, %L, null)', '3f000000-0000-0000-0000-000000000001', 's_1', 'extend', 'd', 'reason', 'Bob', 'QC')) like 'permission denied%',
  'nor call the public change function');
reset role;
select set_config('request.jwt.claim.sub', '', true);
select public.workflow_public_change(:W, 's_1', 'extend', 2, 'd', '  Chờ HDBank cấp data test  ', ' Minh ', 'QC HDBank', null);
select pg_temp.check(
  (select reason = 'Chờ HDBank cấp data test' and requester_name = 'Minh' and created_by is null
   from public.workflow_step_logs where kind = 'extend'),
  'an anonymous extension is logged, trimmed');
select pg_temp.check(
  (select revision from public.workflows where id = :W) = 4,
  'an extension does not touch the plan document');
select pg_temp.check(
  pg_temp.error_of(format('select public.workflow_public_change(%L, %L, %L, 1, %L, %L, %L, %L, null)', '3f000000-0000-0000-0000-000000000001', 's_1', 'extend', 'd', 'x', 'Minh', 'QC')) like '%check%',
  'an extension needs a reason');
select pg_temp.check(
  pg_temp.state_of(format('select public.workflow_public_change(%L, %L, %L, 1, %L, %L, %L, %L, null)', '3f000000-0000-0000-0000-000000000001', 's_9', 'extend', 'd', 'need more time', 'X', 'QC')) = 'PT404',
  'a change needs a step of the plan');
select pg_temp.check(
  pg_temp.error_of(format('select public.workflow_public_change(%L, %L, %L, 0, %L, %L, %L, %L, null)', '3f000000-0000-0000-0000-000000000001', 's_1', 'extend', 'd', 'need more time', 'X', 'QC')) like '%check%'
  and pg_temp.error_of(format('select public.workflow_public_change(%L, %L, %L, 1, %L, %L, %L, %L, null)', '3f000000-0000-0000-0000-000000000001', 's_1', 'extend', 'w', 'need more time', 'X', 'QC')) like '%check%'
  and pg_temp.error_of(format('select public.workflow_public_change(%L, %L, %L, 1, %L, %L, %L, %L, null)', '3f000000-0000-0000-0000-000000000001', 's_1', 'extend', 'd', 'need more time', ' ', 'QC')) like '%check%',
  'amount, unit and name are checked');

select public.workflow_public_change(:W, 's_1', 'duration', 3, 'd', '', 'Lan', 'DEV HDBank', null);
select pg_temp.check(
  (select (doc -> 'steps' -> 0 -> 'duration') = '{"amount": 3, "unit": "d"}'::jsonb
          and (doc -> 'steps' -> 1 ->> 'id') = 's_2' and revision = 5
   from public.workflows where id = :W),
  'an anonymous length change updates that step only and bumps the revision');
select pg_temp.check(
  (select count(*) from public.workflow_step_logs where kind = 'duration' and step_id = 's_1') = 1
  and (select old_amount = 2 and old_unit = 'd' and amount = 3 and requester_name = 'Lan' and reason is null
       from public.workflow_step_logs where kind = 'duration' and step_id = 's_1'),
  'it is logged once, with the old and new length');
select public.workflow_public_change(:W, 's_1', 'duration', 3, 'd', null, 'Lan', 'DEV HDBank', null);
select pg_temp.check(
  (select count(*) from public.workflow_step_logs where kind = 'duration' and step_id = 's_1') = 1
  and (select revision from public.workflows where id = :W) = 5,
  'setting the same length again changes and logs nothing');

select public.workflow_public_change(:W, 's_2', 'extend', 1, 'h', 'flood ' || g, 'Bot', 'Bot', null) from generate_series(1, 28) g;
select pg_temp.check(
  pg_temp.state_of(format('select public.workflow_public_change(%L, %L, %L, 1, %L, %L, %L, %L, null)', '3f000000-0000-0000-0000-000000000001', 's_2', 'extend', 'h', 'one too many', 'Bot', 'Bot')) = 'PT429',
  'requests without an account are limited to 30 per plan per 10 minutes');
select public.workflow_public_change(:W, 's_2', 'extend', 3, 'h', 'signed-in request', 'Giám đốc X', 'QC FPT', :B);
select pg_temp.check(
  (select count(*) from public.workflow_step_logs where created_by = :B and kind = 'extend') = 1,
  'a signed-in request is not held by that limit');
select pg_temp.check(
  (select requester_name from public.workflow_step_logs where created_by = :B and kind = 'extend') = 'Bob Tran',
  'a signed-in request is logged under the profile name, not a typed one');

create temp table minh as select id from public.workflow_step_logs where requester_name = 'Minh';
create temp table lan as select id from public.workflow_step_logs where requester_name = 'Lan';
grant select on minh, lan to authenticated, anon;
select pg_temp.check(
  pg_temp.state_of('select public.cancel_workflow_extension((select id from minh))') is not null,
  'cancelling needs a signed-in member');
set local role authenticated;

select pg_temp.login(:C);
select pg_temp.check((select count(*) from public.workflow_step_logs) = 0, 'Carol (not a member) sees no log');
select pg_temp.check(
  pg_temp.state_of('select public.cancel_workflow_extension((select id from minh))') = 'PT404',
  'Carol cannot cancel an extension of a plan she has not opened');

select pg_temp.login(:B);
select pg_temp.check((select count(*) from public.workflow_step_logs) = 32, 'Bob (member) sees the whole history');
select pg_temp.check(
  pg_temp.state_of('select public.cancel_workflow_extension((select id from lan))') = 'PT404',
  'only an extension can be cancelled, not a length change');
select public.cancel_workflow_extension((select id from minh));
select pg_temp.check(
  (select cancelled_at is not null and cancelled_by = :B from public.workflow_step_logs where requester_name = 'Minh'),
  'Bob cancels an extension; it stays in the history');

-- ---------------------------------------------------------------- leaving and deleting
select pg_temp.check(
  pg_temp.row_count(format('delete from public.workflow_members where workflow_id = %L', '3f000000-0000-0000-0000-000000000001')) = 1,
  'Bob can leave the plan');
select pg_temp.check((select count(*) from public.workflows) = 0, 'after leaving Bob no longer sees it');
select pg_temp.login(:A);
select pg_temp.check(
  pg_temp.row_count(format('delete from public.workflow_members where workflow_id = %L', '3f000000-0000-0000-0000-000000000001')) = 0,
  'the owner cannot leave');

-- ---------------------------------------------------------------- anon
reset role;
set local role anon;
select pg_temp.check(
  pg_temp.error_of('select * from public.workflows') like 'permission denied%'
  and pg_temp.error_of('select * from public.workflow_step_logs') like 'permission denied%'
  and pg_temp.error_of(format('select public.join_workflow(%L)', '3f000000-0000-0000-0000-000000000001')) like 'permission denied%',
  'anon reaches nothing directly (the server serves public links)');
reset role;
set local role authenticated;

select pg_temp.login(:A);
select pg_temp.check(
  pg_temp.row_count(format('delete from public.workflows where id = %L', '3f000000-0000-0000-0000-000000000001')) = 1,
  'the owner deletes the plan');
reset role;
select pg_temp.check(
  not exists (select 1 from public.workflow_step_logs where workflow_id = :W)
  and not exists (select 1 from public.workflow_members where workflow_id = :W),
  'its members and log go with it');

rollback;
