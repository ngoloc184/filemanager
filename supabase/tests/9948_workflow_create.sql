-- Creating a workflow from the app (insert … returning id, as supabase-js does) and the owner's
-- access to it (202608280048_workflow_owner_select.sql).
-- Run with scripts/test-db.sh (plain PostgreSQL + supabase/tests stubs).
-- Everything runs in one transaction that is rolled back at the end.

\set ON_ERROR_STOP 1
\o /dev/null
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B '''bbbbbbbb-0000-0000-0000-00000000000b'''

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

insert into auth.users (id, email) values (:A, 'alice@example.com'), (:B, 'bob@example.com');
grant execute on function pg_temp.check(boolean, text) to authenticated;
grant execute on function pg_temp.login(uuid) to authenticated;

set local role authenticated;
select pg_temp.login(:A);

create temp table made (id uuid) on commit drop;
grant all on made to authenticated;
with w as (
  insert into public.workflows (owner_id, name, doc)
  values (:A, 'From the app', '{"version": 2, "steps": []}')
  returning id
)
insert into made select id from w;
select pg_temp.check((select count(*) from made) = 1, 'the creator gets the new id back (insert … returning)');
select pg_temp.check(
  (select count(*) from public.workflows where id = (select id from made)) = 1,
  'and sees the plan');

select pg_temp.login(:B);
select pg_temp.check(
  (select count(*) from public.workflows where id = (select id from made)) = 0,
  'someone else still does not see it before opening the link');

rollback;
