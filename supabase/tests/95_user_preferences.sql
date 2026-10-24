-- Owner isolation and defaults for user preferences
-- (202608280026_user_preferences.sql).
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

insert into auth.users (id, email) values
  (:A, 'alice@example.com'),
  (:B, 'bob@example.com');

grant execute on function pg_temp.check(boolean, text) to authenticated;
grant execute on function pg_temp.login(uuid) to authenticated;
grant execute on function pg_temp.error_of(text) to authenticated;

set local role authenticated;

-- ---------------------------------------------------------------- Alice
select pg_temp.login(:A);

insert into public.user_preferences default values;
select pg_temp.check(
  (select user_id = :A and chat_notifications = false from public.user_preferences),
  'a new row belongs to the caller and starts with notifications off');

insert into public.user_preferences (chat_notifications) values (true)
on conflict (user_id) do update set chat_notifications = excluded.chat_notifications;
select pg_temp.check(
  (select chat_notifications from public.user_preferences where user_id = :A),
  'the owner can turn notifications on (upsert)');

select pg_temp.check(
  pg_temp.error_of(format(
    'insert into public.user_preferences (user_id, chat_notifications) values (%L, true)',
    'bbbbbbbb-0000-0000-0000-00000000000b')) is not null,
  'cannot create preferences for someone else');

-- ---------------------------------------------------------------- Bob
select pg_temp.login(:B);

select pg_temp.check(
  (select count(*) from public.user_preferences) = 0,
  'other users cannot see the preferences');

update public.user_preferences set chat_notifications = false;
delete from public.user_preferences;

-- ---------------------------------------------------------------- Alice again
select pg_temp.login(:A);

select pg_temp.check(
  (select chat_notifications from public.user_preferences where user_id = :A),
  'other users cannot change or delete the preferences');

rollback;
