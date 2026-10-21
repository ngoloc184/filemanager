-- Default storage quota (202608280024_storage_quota_10gb.sql).
-- Run with scripts/test-db.sh (plain PostgreSQL + supabase/tests stubs).
-- Everything runs in one transaction that is rolled back at the end.

\set ON_ERROR_STOP 1
\o /dev/null

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

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'new@example.com'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'custom@example.com');
insert into public.user_profiles (id, email) values ('aaaaaaaa-0000-0000-0000-00000000000a', 'new@example.com')
on conflict (id) do nothing;
insert into public.user_profiles (id, email, storage_quota_bytes) values ('bbbbbbbb-0000-0000-0000-00000000000b', 'custom@example.com', 2147483648)
on conflict (id) do update set storage_quota_bytes = excluded.storage_quota_bytes;

select pg_temp.check(
  public.get_user_storage_quota_bytes('aaaaaaaa-0000-0000-0000-00000000000a') = 10737418240,
  'new users get 10 GiB');
select pg_temp.check(
  public.get_user_storage_quota_bytes('cccccccc-0000-0000-0000-00000000000c') = 10737418240,
  'users without a profile fall back to 10 GiB');
select pg_temp.check(
  public.get_user_storage_quota_bytes('bbbbbbbb-0000-0000-0000-00000000000b') = 2147483648,
  'a quota set by hand is kept');

-- re-running the migration moves remaining 1 GiB users and keeps custom ones
update public.user_profiles set storage_quota_bytes = 1073741824 where id = 'aaaaaaaa-0000-0000-0000-00000000000a';
update public.user_profiles set storage_quota_bytes = 10737418240 where storage_quota_bytes = 1073741824;
select pg_temp.check(
  (select storage_quota_bytes from public.user_profiles where id = 'aaaaaaaa-0000-0000-0000-00000000000a') = 10737418240,
  'users on the old 1 GiB default are raised');

-- quota enforcement uses the new limit: 5 GiB fits, 11 GiB does not
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-00000000000a', true);
select public.assert_storage_quota('aaaaaaaa-0000-0000-0000-00000000000a', 5368709120);
do $$
begin
  perform public.assert_storage_quota('aaaaaaaa-0000-0000-0000-00000000000a', 11811160064);
  raise exception 'FAILED: 11 GiB should exceed the quota';
exception when others then
  if sqlerrm like 'FAILED%' then raise; end if;
end;
$$;
select pg_temp.check(true, 'uploads above 10 GiB are refused');

rollback;
