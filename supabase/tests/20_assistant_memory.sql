-- Isolation tests for assistant memory, events, feedback and tuning
-- (migration 202608280018). Run with scripts/test-db.sh. Rolled back.

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

-- true when the statement fails (permission / RLS / constraint)
create function pg_temp.fails(sql text) returns boolean
language plpgsql as $$
begin
  execute sql;
  return false;
exception when others then
  return true;
end;
$$;

grant execute on function pg_temp.check(boolean, text) to authenticated, anon, service_role;
grant execute on function pg_temp.login(uuid) to authenticated, anon, service_role;
grant execute on function pg_temp.fails(text) to authenticated, anon, service_role;

insert into auth.users (id, email) values (:A, 'alice@example.com'), (:B, 'bob@example.com');

-- ------------------------------------------------------------------ memory
set local role authenticated;
select pg_temp.login(:A);
insert into public.assistant_memories (kind, key, value) values ('glossary', 'hd', 'hợp đồng'), ('preference', 'style', 'short');
insert into public.assistant_memories (kind, value) values ('note', 'tôi phụ trách mảng hợp đồng');
select pg_temp.check((select count(*) from public.assistant_memories) = 3, 'owner sees own memories');
select pg_temp.check((select user_id from public.assistant_memories limit 1) = :A, 'user_id defaults to auth.uid()');
select pg_temp.check(pg_temp.fails($q$insert into public.assistant_memories (kind, key, value) values ('glossary', 'hd', 'khác')$q$), 'one value per glossary term (update instead)');
select pg_temp.check(pg_temp.fails($q$insert into public.assistant_memories (kind, value) values ('glossary', 'no key')$q$), 'glossary needs a key');
select pg_temp.check(pg_temp.fails($q$insert into public.assistant_memories (kind, value) values ('note', repeat('x', 301))$q$), 'memory text limited to 300 chars');

select pg_temp.login(:B);
select pg_temp.check((select count(*) from public.assistant_memories) = 0, 'other user sees no memories');
update public.assistant_memories set value = 'hacked';
delete from public.assistant_memories;
select pg_temp.check(
  pg_temp.fails(format($q$insert into public.assistant_memories (user_id, kind, value) values (%L, 'note', 'planted')$q$, :A)),
  'cannot write into another user''s memory'
);

select pg_temp.login(:A);
select pg_temp.check((select count(*) from public.assistant_memories where value <> 'hacked') = 3, 'other user could not change or delete memories');
select pg_temp.check(
  pg_temp.fails(format($q$update public.assistant_memories set user_id = %L where kind = 'note'$q$, :B)) or
  (select count(*) from public.assistant_memories where kind = 'note') = 1,
  'owner cannot move a memory to someone else'
);
insert into public.assistant_memories (kind, value) select 'note', 'n' || g from generate_series(1, 47) g;
select pg_temp.check(pg_temp.fails($q$insert into public.assistant_memories (kind, value) values ('note', 'one too many')$q$), 'at most 50 memories per user');

-- ------------------------------------------------------- events/feedback
insert into public.assistant_events (intent, method, result_count, grounded, confidence, latency_ms)
  values ('ask', 'passages', 3, true, 'high', 120);
select pg_temp.check((select count(*) from public.assistant_events) = 1, 'owner logs and sees own events');
insert into public.assistant_feedback (event_id, rating, reason, query_terms)
  select id, -1, 'wrong', array['thoi', 'han'] from public.assistant_events;
select pg_temp.check((select count(*) from public.assistant_feedback) = 1, 'owner gives feedback on own answer');
select pg_temp.check(pg_temp.fails($q$update public.assistant_feedback set status = 'applied'$q$), 'users cannot change the review status');
update public.assistant_feedback set rating = 1, reason = null;
select pg_temp.check((select rating from public.assistant_feedback) = 1, 'owner can change their verdict');

select pg_temp.login(:B);
select pg_temp.check((select count(*) from public.assistant_events) = 0, 'other user sees no events');
select pg_temp.check((select count(*) from public.assistant_feedback) = 0, 'other user sees no feedback');
reset role;
create temp table alice_event as select id from public.assistant_events limit 1;
grant select on alice_event to authenticated;
set local role authenticated;
select pg_temp.login(:B);
select pg_temp.check(
  pg_temp.fails($q$insert into public.assistant_feedback (event_id, rating) select id, -1 from alice_event$q$),
  'cannot give feedback on another user''s answer'
);
select pg_temp.check(
  pg_temp.fails(format($q$insert into public.assistant_events (user_id, intent) values (%L, 'ask')$q$, :A)),
  'cannot log events as another user'
);

-- ------------------------------------------------------------------ tuning
reset role;
insert into public.assistant_tuning (version, config, active) values ('v1', '{"weights":{"name":1}}', true), ('v2', '{"weights":{"name":2}}', false);
set local role authenticated;
select pg_temp.login(:A);
select pg_temp.check((select string_agg(version, ',') from public.assistant_tuning) = 'v1', 'users read only the active tuning');
select pg_temp.check(pg_temp.fails($q$insert into public.assistant_tuning (version, config) values ('evil', '{}')$q$), 'users cannot add tuning versions');
select pg_temp.check(pg_temp.fails($q$select public.assistant_activate_tuning('v2')$q$), 'users cannot activate tuning');
select pg_temp.check(pg_temp.fails($q$select * from public.assistant_quality_report(30)$q$), 'users cannot read the quality report');
select pg_temp.check(pg_temp.fails($q$select * from public.assistant_feedback_terms(30, 10)$q$), 'users cannot read feedback terms');
select pg_temp.check(pg_temp.fails($q$select * from public.assistant_purge(30)$q$), 'users cannot purge');

reset role;
set local role service_role;
select public.assistant_activate_tuning('v2');
select pg_temp.check((select string_agg(version, ',') from public.assistant_tuning where active) = 'v2', 'service role activates a version (single active)');
select public.assistant_activate_tuning('v1');
select pg_temp.check((select string_agg(version, ',') from public.assistant_tuning where active) = 'v1', 'rollback to the previous version');
select pg_temp.check((select questions from public.assistant_quality_report(30) where intent = 'TOTAL') = 1, 'quality report counts questions');
select pg_temp.check((select negative + positive from public.assistant_feedback_terms(30, 10) where term = 'han') = 1, 'feedback terms aggregated');

-- ------------------------------------------------------------------- anon
reset role;
set local role anon;
select pg_temp.check(pg_temp.fails($q$select count(*) from public.assistant_memories$q$), 'anon cannot read memories');
select pg_temp.check(pg_temp.fails($q$select count(*) from public.assistant_events$q$), 'anon cannot read events');

reset role;
-- cascade: deleting a user removes their assistant data
delete from auth.users where id = :A;
select pg_temp.check((select count(*) from public.assistant_memories) = 0, 'memories removed with the account');
select pg_temp.check((select count(*) from public.assistant_events) = 0, 'events removed with the account');

\o
\echo 'assistant memory/feedback tests: all passed'
rollback;
