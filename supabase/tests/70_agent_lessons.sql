-- Sharing rules for agent lessons (202608280023_agent_lessons.sql).
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

create function pg_temp.login(n integer) returns void
language sql as $$
  select set_config('request.jwt.claim.sub', format('00000000-0000-0000-0000-%s', lpad(n::text, 12, '0')), true),
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

-- what user n sees for a phrase: 'mine', 'global' or null
create function pg_temp.sees(n integer, p text) returns text
language plpgsql as $$
declare
  v text;
begin
  perform pg_temp.login(n);
  select l.scope into v from public.agent_lessons_for_me() l where l.phrase = p limit 1;
  return v;
end;
$$;

-- teach as user n
create function pg_temp.teach(n integer, p text, c text, eff text default 'read', gen boolean default true, src text default 'explicit')
returns void language plpgsql as $$
begin
  perform pg_temp.login(n);
  perform public.agent_teach(p, c, eff, gen, src);
end;
$$;

insert into auth.users (id, email)
select format('00000000-0000-0000-0000-%s', lpad(n::text, 12, '0'))::uuid, format('u%s@example.com', n)
from generate_series(1, 9) n;

grant execute on function pg_temp.check(boolean, text) to authenticated;
grant execute on function pg_temp.login(integer) to authenticated;
grant execute on function pg_temp.error_of(text) to authenticated;
grant execute on function pg_temp.sees(integer, text) to authenticated;
grant execute on function pg_temp.teach(integer, text, text, text, boolean, text) to authenticated;

set local role authenticated;

-- ---------------------------------------------------------------- personal, then shared
select pg_temp.teach(1, 'kiem', 'tim');
select pg_temp.check(pg_temp.sees(1, 'kiem') = 'mine', 'the author uses a lesson right away');
select pg_temp.check(pg_temp.sees(4, 'kiem') is null, 'others do not see a lesson taught by one user');

select pg_temp.teach(2, 'kiem', 'tim');
select pg_temp.teach(3, 'kiem', 'tim');
select pg_temp.check(pg_temp.sees(4, 'kiem') = 'global', 'a lesson confirmed by 3 users is shared with everyone');

select pg_temp.login(5);
select public.agent_vote(array[(select id from public.agent_lessons_for_me() where phrase = 'kiem')], -1::smallint);
select pg_temp.check(pg_temp.sees(5, 'kiem') is null, 'a user who rejected a lesson no longer gets it');
select pg_temp.check(pg_temp.sees(4, 'kiem') = 'global', 'one rejection against three confirmations keeps it shared');

select pg_temp.login(6);
select public.agent_vote(array[(select id from public.agent_lessons_for_me() where phrase = 'kiem')], -1::smallint);
select pg_temp.check(pg_temp.sees(4, 'kiem') is null, 'enough rejections stop sharing');
select pg_temp.check(pg_temp.sees(1, 'kiem') = 'mine', 'authors keep their own lesson');

-- ---------------------------------------------------------------- write lessons need approval
select pg_temp.teach(1, 'cat', 'chuyen', 'write');
select pg_temp.teach(2, 'cat', 'chuyen', 'write');
select pg_temp.teach(3, 'cat', 'chuyen', 'write');
select pg_temp.check(pg_temp.sees(4, 'cat') is null, 'write lessons are not shared without approval');

-- one client claiming "read" does not downgrade a write lesson
select pg_temp.teach(7, 'cat', 'chuyen', 'read');
select pg_temp.check(pg_temp.sees(4, 'cat') is null, 'a later "read" claim does not make a write lesson shareable');

reset role;
update public.agent_lessons set approved = true where phrase = 'cat';
set local role authenticated;
select pg_temp.check(pg_temp.sees(4, 'cat') = 'global', 'approved write lessons are shared');

-- ---------------------------------------------------------------- lessons with names stay personal
select pg_temp.teach(1, 'luc hd', 'tim hop dong acme', 'read', false);
select pg_temp.teach(2, 'luc hd', 'tim hop dong acme', 'read', false);
select pg_temp.teach(3, 'luc hd', 'tim hop dong acme', 'read', false);
select pg_temp.check(pg_temp.sees(4, 'luc hd') is null, 'non-generic lessons are never shared');

-- ---------------------------------------------------------------- implicit observations
select pg_temp.teach(n, 'loi ra', 'tim', 'read', true, 'implicit') from generate_series(1, 4) n;
select pg_temp.check(pg_temp.sees(1, 'loi ra') is null, 'an observation alone does not create a personal lesson');
select pg_temp.check(pg_temp.sees(9, 'loi ra') is null, 'four observations are not enough to share');
select pg_temp.teach(5, 'loi ra', 'tim', 'read', true, 'implicit');
select pg_temp.check(pg_temp.sees(9, 'loi ra') = 'global', 'five users rephrasing the same way share the lesson');
select pg_temp.teach(1, 'loi ra', 'tim');
select pg_temp.check(pg_temp.sees(1, 'loi ra') = 'mine', 'confirming an observation makes it personal');
select pg_temp.teach(1, 'loi ra', 'tim', 'read', true, 'implicit');
select pg_temp.check(pg_temp.sees(1, 'loi ra') = 'mine', 'a later observation does not downgrade a confirmation');

-- ---------------------------------------------------------------- blocking and forgetting
reset role;
update public.agent_lessons set status = 'blocked' where phrase = 'loi ra';
set local role authenticated;
select pg_temp.check(pg_temp.sees(1, 'loi ra') is null and pg_temp.sees(9, 'loi ra') is null, 'blocked lessons are used by nobody');

select pg_temp.teach(8, 'tra', 'tim');
select pg_temp.login(8);
select public.agent_forget_lesson((select id from public.agent_lessons_for_me() where phrase = 'tra'));
select pg_temp.check(pg_temp.sees(8, 'tra') is null, 'forgetting removes a personal lesson');

-- ---------------------------------------------------------------- votes cannot be faked
-- user 9 never got "luc hd" (non-generic, not shared): a 👍 on its id is ignored
reset role;
select set_config('test.luc', (select id::text from public.agent_lessons where phrase = 'luc hd' limit 1), true);
set local role authenticated;
select pg_temp.login(9);
select public.agent_vote(array[current_setting('test.luc')::uuid], 1::smallint);
reset role;
select pg_temp.check(
  not exists (select 1 from public.agent_lesson_votes v join public.agent_lessons l on l.id = v.lesson_id
              where l.phrase = 'luc hd' and v.user_id = '00000000-0000-0000-0000-000000000009'),
  'users cannot upvote lessons they do not get');
set local role authenticated;

-- an observation does not turn a rejection into a confirmation
select pg_temp.teach(6, 'kiem', 'tim', 'read', true, 'implicit');
select pg_temp.check(pg_temp.sees(6, 'kiem') is null, 'an observation keeps an earlier rejection');

-- forgetting a shared lesson rejects it for that user
select pg_temp.check(pg_temp.sees(9, 'cat') = 'global', 'precondition: shared lesson visible');
select pg_temp.login(9);
select public.agent_forget_lesson((select id from public.agent_lessons_for_me() where phrase = 'cat'));
select pg_temp.check(pg_temp.sees(9, 'cat') is null, 'forgetting a shared lesson stops it for that user');

-- ---------------------------------------------------------------- safety
select pg_temp.login(1);
select pg_temp.check(pg_temp.error_of($$select public.agent_teach('gui a@b.com', 'tim', 'read', true, 'explicit')$$) is not null,
  'lessons must be folded text without e-mails');
select pg_temp.check(pg_temp.error_of($$select public.agent_teach('so 1234567', 'tim', 'read', true, 'explicit')$$) is not null,
  'lessons with long numbers are rejected');
select pg_temp.check(pg_temp.error_of($$select * from public.agent_lessons$$) is not null
  and pg_temp.error_of($$select * from public.agent_lesson_votes$$) is not null
  and pg_temp.error_of($$select * from public.agent_lesson_stats$$) is not null,
  'users cannot read lesson tables or statistics directly');
select pg_temp.check(pg_temp.error_of($$insert into public.agent_lessons (phrase, canonical, effect, generic, approved) values ('x', 'tim', 'write', true, true)$$) is not null,
  'users cannot insert or approve lessons directly');

rollback;
