-- Push subscriptions (202608280028_web_push.sql).
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
select public.save_push_subscription('https://push.example.com/a1', 'key-a', 'auth-a', 'Chrome');
select public.save_push_subscription('https://push.example.com/a1', 'key-a2', 'auth-a2', 'Chrome');
select pg_temp.check(
  (select count(*) = 1 and min(p256dh) = 'key-a2' and min(user_id::text) = 'aaaaaaaa-0000-0000-0000-00000000000a' from public.push_subscriptions),
  'saving the same browser again updates its keys');
select pg_temp.check(
  pg_temp.error_of($$select public.save_push_subscription('http://insecure.example.com/x', 'k', 'a')$$) is not null,
  'only https push endpoints are accepted');
select pg_temp.check(
  pg_temp.error_of($$insert into public.push_subscriptions (endpoint, p256dh, auth) values ('https://push.example.com/x', 'k', 'a')$$) is not null,
  'subscriptions cannot be written directly');
select pg_temp.check(
  pg_temp.error_of('select count(*) from public.chat_push_log') is not null,
  'the push log is server-only');

-- ---------------------------------------------------------------- Bob
select pg_temp.login(:B);
select pg_temp.check((select count(*) from public.push_subscriptions) = 0,
  'other users cannot see a device''s keys');
select public.delete_push_subscription('https://push.example.com/a1');
-- Bob signs in on Alice's browser: the subscription moves to him
select public.save_push_subscription('https://push.example.com/a1', 'key-b', 'auth-b', 'Chrome');
select pg_temp.check(
  (select count(*) = 1 and min(p256dh) = 'key-b' from public.push_subscriptions),
  'a browser used by another account moves to the new account');

select pg_temp.login(:A);
select pg_temp.check((select count(*) from public.push_subscriptions) = 0,
  'the previous account no longer receives pushes on that browser');
select public.delete_push_subscription('https://push.example.com/a1');
select pg_temp.login(:B);
select pg_temp.check((select count(*) from public.push_subscriptions) = 1,
  'nobody removes another account''s subscription');
select public.delete_push_subscription('https://push.example.com/a1');
select pg_temp.check((select count(*) from public.push_subscriptions) = 0,
  'the owner removes it (sign-out)');

rollback;
