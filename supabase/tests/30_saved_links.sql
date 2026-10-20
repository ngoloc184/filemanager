-- Owner isolation and validation tests for saved links.
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

insert into public.saved_links (title, url)
values ('Link cập nhật tiến độ mỗi ngày', 'https://example.com/progress?day=1');

select pg_temp.check(
  (select owner_id from public.saved_links) = :A,
  'owner_id defaults to the signed-in user');

select pg_temp.check(
  pg_temp.error_of($$insert into public.saved_links (title, url) values ('x', 'javascript:alert(1)')$$) is not null,
  'javascript: URLs are rejected');

select pg_temp.check(
  pg_temp.error_of($$insert into public.saved_links (title, url) values ('   ', 'https://example.com')$$) is not null,
  'blank titles are rejected');

select pg_temp.check(
  pg_temp.error_of(format(
    'insert into public.saved_links (owner_id, title, url) values (%L, %L, %L)',
    'bbbbbbbb-0000-0000-0000-00000000000b', 'spoof', 'https://example.com')) is not null,
  'cannot create a link owned by someone else');

-- ---------------------------------------------------------------- Bob
select pg_temp.login(:B);

select pg_temp.check(
  (select count(*) from public.saved_links) = 0,
  'other users cannot see the link');

update public.saved_links set title = 'hacked';
delete from public.saved_links;

-- ---------------------------------------------------------------- Alice again
select pg_temp.login(:A);

select pg_temp.check(
  (select title from public.saved_links) = 'Link cập nhật tiến độ mỗi ngày',
  'other users cannot update or delete the link');

rollback;
