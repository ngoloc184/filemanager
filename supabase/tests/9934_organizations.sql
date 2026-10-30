-- Companies, departments, positions, members, invitations and the directory.
-- Run with scripts/test-db.sh (plain PostgreSQL + supabase/tests stubs).
-- Everything runs in one transaction that is rolled back at the end.

\set ON_ERROR_STOP 1
\o /dev/null
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B '''bbbbbbbb-0000-0000-0000-00000000000b'''
\set C '''cccccccc-0000-0000-0000-00000000000c'''
\set D '''dddddddd-0000-0000-0000-00000000000d'''
\set E '''eeeeeeee-0000-0000-0000-00000000000e'''

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

-- Runs a count query given as text (for tables a later migration may add).
create function pg_temp.count_of(stmt text) returns bigint
language plpgsql as $$
declare
  v bigint;
begin
  execute stmt into v;
  return v;
end;
$$;

-- ---------------------------------------------------------------- fixtures
insert into auth.users (id, email) values
  (:A, 'alice@example.com'),
  (:B, 'Bob@Example.com'),
  (:C, 'carol@example.com'),
  (:D, 'dave@example.com'),
  (:E, 'erin@example.com');
insert into public.user_profiles (id, email) values
  (:A, 'alice@example.com'),
  (:B, 'bob@example.com'),
  (:C, 'carol@example.com'),
  (:D, 'dave@example.com'),
  (:E, 'erin@example.com')
on conflict (id) do nothing;
update public.user_profiles set display_name = 'Bob Trần' where id = :B;

grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
grant execute on function pg_temp.login(uuid) to authenticated, anon;
grant execute on function pg_temp.error_of(text) to authenticated, anon;
grant execute on function pg_temp.count_of(text) to authenticated, anon;

create temp table ids (k text primary key, v text);
grant all on ids to authenticated, anon;

-- ---------------------------------------------------------------- anon
set local role anon;
set local request.jwt.claim.sub = '';

select pg_temp.check(
  pg_temp.error_of($$select public.create_organization('Anon Co', 'ANON')$$) ~* 'permission denied',
  'anon cannot call create_organization');
select pg_temp.check(
  pg_temp.error_of($$select public.is_org_member(gen_random_uuid())$$) ~* 'permission denied',
  'anon cannot call the client helpers');
select pg_temp.check(
  pg_temp.error_of($$select count(*) from public.organizations$$) ~* 'permission denied',
  'anon cannot read companies');

reset role;
set local role authenticated;

-- ---------------------------------------------------------------- Alice creates ABC
select pg_temp.login(:A);

select pg_temp.check(public.get_my_org() is null, 'no company yet: get_my_org is null');

select pg_temp.check(
  pg_temp.error_of($$select public.create_organization('X', 'ABC')$$) is not null,
  'company name needs 2+ characters');
select pg_temp.check(
  pg_temp.error_of($$select public.create_organization('Bad code', 'a b')$$) is not null,
  'company code is validated');

insert into ids select 'abc', (public.create_organization('  ABC Corporation ', ' abc ', 'ABC')).id::text;

select pg_temp.check(
  (select code = 'ABC' and name = 'ABC Corporation' from public.organizations),
  'code is upper-cased and the name trimmed');
select pg_temp.check(
  (select roles @> array['org_admin', 'leader', 'clerk'] and status = 'active'
   from public.org_members where user_id = :A),
  'creator becomes org_admin, leader and clerk');
select pg_temp.check(
  (public.get_my_org() -> 'org' ->> 'code') = 'ABC'
  and (public.get_my_org() -> 'me' -> 'roles') ? 'org_admin',
  'get_my_org returns the company and my roles');
select pg_temp.check(public.my_org_id() = (select v::uuid from ids where k = 'abc'), 'my_org_id is ABC');
select pg_temp.check(
  pg_temp.error_of($$select public.create_organization('Second Co', 'SEC')$$) = 'You already belong to a company',
  'creating a second company fails');

select public.update_organization('ABC Corporation', 'ABC', 'ABC', '0101234567', 'Hà Nội', 'Asia/Bangkok');
select pg_temp.check(
  (select timezone = 'Asia/Bangkok' and tax_code = '0101234567' from public.organizations),
  'admin updates the company');
select pg_temp.check(
  pg_temp.error_of($$select public.update_organization('ABC Corporation', null, 'ABC', null, null, 'Mars/Base')$$) is not null,
  'unknown time zones are rejected');

-- departments
insert into ids select 'hr', (public.upsert_department(null, 'Human resources', 'hr', null, null, 2)).id::text;
insert into ids select 'it', (public.upsert_department(null, 'IT', 'IT', null, :A, 1)).id::text;
insert into ids select 'dev', (public.upsert_department(null, 'Development', 'IT-DEV',
  (select v::uuid from ids where k = 'it'), null, 0)).id::text;

select pg_temp.check(
  (select code from public.departments where id = (select v::uuid from ids where k = 'hr')) = 'HR',
  'department code is upper-cased');
select pg_temp.check(
  pg_temp.error_of(format('select public.upsert_department(%L, %L, %L, %L, null, 0)',
    (select v from ids where k = 'it'), 'IT', 'IT', (select v from ids where k = 'dev'))) is not null,
  'a department cannot move under its own child (cycle)');
select pg_temp.check(
  pg_temp.error_of($$select public.upsert_department(null, 'Dup', 'HR', null, null, 0)$$) = 'That department code is already used',
  'department codes are unique per company');
select pg_temp.check(
  pg_temp.error_of(format('select public.upsert_department(null, %L, %L, null, %L, 0)',
    'Sales', 'SALES', 'cccccccc-0000-0000-0000-00000000000c')) is not null,
  'the head must be an active member');
select pg_temp.check(
  (select array_agg(x) from public.headed_departments() x) = array[(select v::uuid from ids where k = 'it')],
  'headed_departments lists the department Alice heads');

-- positions
insert into ids select 'director', (public.upsert_position(null, 'Director', 10, true)).id::text;
insert into ids select 'officer', (public.upsert_position(null, 'Officer', 1, false)).id::text;
select pg_temp.check(
  (select can_sign from public.positions where id = (select v::uuid from ids where k = 'director'))
  and not (select can_sign from public.positions where id = (select v::uuid from ids where k = 'officer')),
  'the positions can_sign flag persists');
select pg_temp.check(
  pg_temp.error_of($$select public.upsert_position(null, 'Director', 0, false)$$) = 'That position already exists',
  'position names are unique per company');

-- holidays
select public.set_org_holiday('2026-09-02', 'National Day');
select pg_temp.check((select count(*) from public.org_holidays) = 1, 'admin adds a holiday');

-- direct writes are blocked
select pg_temp.check(
  pg_temp.error_of(format('update public.org_members set roles = %L where user_id = %L',
    '{staff}', 'aaaaaaaa-0000-0000-0000-00000000000a')) ~* 'permission denied',
  'members cannot be written directly');
select pg_temp.check(
  pg_temp.error_of($$insert into public.organizations (name, code) values ('Direct', 'DIRECT')$$) ~* 'permission denied',
  'companies cannot be inserted directly');

-- ---------------------------------------------------------------- invitations
select pg_temp.check(
  pg_temp.error_of($$select public.invite_member('not-an-email', null, null, '{staff}')$$) = 'Enter a valid e-mail address',
  'invite e-mails are validated');
select pg_temp.check(
  pg_temp.error_of($$select public.invite_member('carol@example.com', null, null, '{boss}')$$) ~ 'Unknown role',
  'invite roles are validated');
select pg_temp.check(
  pg_temp.error_of($$select public.invite_member('alice@example.com', null, null, '{staff}')$$) is not null,
  'existing members cannot be invited again');

insert into ids select 'inv_old', (public.invite_member('bob@example.com', null, null, '{staff}')).token;
insert into ids select 'inv', (public.invite_member(' BOB@example.com ', (select v::uuid from ids where k = 'hr'),
  (select v::uuid from ids where k = 'officer'), '{clerk}')).token;

select pg_temp.check(
  (select revoked_at is not null from public.org_invitations where token = (select v from ids where k = 'inv_old')),
  'a new invite revokes the older pending one for the same e-mail');
select pg_temp.check(
  (select email from public.org_invitations where token = (select v from ids where k = 'inv')) = 'bob@example.com',
  'invite e-mail is stored lower-cased and trimmed');
select pg_temp.check(
  (select length(v) from ids where k = 'inv') = 64,
  'invite tokens are 64 hex characters');
select pg_temp.check(
  (select count(*) from public.list_org_invitations()) = 2
  and (select token from public.list_org_invitations() limit 1) = (select v from ids where k = 'inv'),
  'invitations list pending ones first');

-- ---------------------------------------------------------------- Carol cannot read Bob's invite
select pg_temp.login(:C);
select pg_temp.check(
  pg_temp.error_of(format('select public.get_invitation(%L)', (select v from ids where k = 'inv'))) = 'Invitation not found',
  'another user cannot read the invitation');
select pg_temp.check(
  pg_temp.error_of(format('select public.accept_invitation(%L)', (select v from ids where k = 'inv'))) = 'Invitation not found',
  'another user cannot accept the invitation');
select pg_temp.check((select count(*) from public.org_invitations) = 0, 'non-admins see no invitations');
select pg_temp.check((select count(*) from public.organizations) = 0, 'non-members see no company');
select pg_temp.check((select count(*) from public.list_org_members()) = 0, 'non-members list no members');
select pg_temp.check(
  pg_temp.error_of($$select public.invite_member('x@example.com', null, null, '{staff}')$$) = 'Only company admins can do this',
  'non-members cannot invite');

-- ---------------------------------------------------------------- Bob accepts
select pg_temp.login(:B);
select pg_temp.check(
  (public.get_invitation((select v from ids where k = 'inv')) ->> 'status') = 'pending'
  and (public.get_invitation((select v from ids where k = 'inv')) ->> 'department_name') = 'Human resources'
  and (public.get_invitation((select v from ids where k = 'inv')) ->> 'org_name') = 'ABC Corporation',
  'the invitee reads the invitation (e-mail match is case-insensitive)');
select pg_temp.check(
  (public.get_invitation((select v from ids where k = 'inv_old')) ->> 'status') = 'revoked',
  'the replaced invitation shows as revoked');
select pg_temp.check(
  pg_temp.error_of(format('select public.accept_invitation(%L)', (select v from ids where k = 'inv_old'))) = 'This invitation was revoked',
  'a revoked invitation cannot be accepted');

select pg_temp.check(
  public.accept_invitation((select v from ids where k = 'inv')) = (select v::uuid from ids where k = 'abc'),
  'Bob accepts the invitation');
select pg_temp.check(
  public.has_org_role((select v::uuid from ids where k = 'abc'), 'clerk')
  and not public.is_org_admin((select v::uuid from ids where k = 'abc'))
  and public.my_department((select v::uuid from ids where k = 'abc')) = (select v::uuid from ids where k = 'hr'),
  'Bob is an active clerk in Human resources');
select pg_temp.check(
  to_regclass('public.notifications') is null
  or (pg_temp.count_of($$select count(*) from public.notifications
      where kind = 'org.invite' and link like '/invite/%'$$)) = 2,
  'existing accounts get an in-app invite notice when notifications are installed');
select pg_temp.check(
  (public.get_my_org() -> 'me' ->> 'position_name') = 'Officer',
  'get_my_org shows the position');
select pg_temp.check(
  pg_temp.error_of(format('select public.accept_invitation(%L)', (select v from ids where k = 'inv'))) = 'This invitation was already accepted',
  'an invitation is accepted only once');
select pg_temp.check(
  (select count(*) from public.departments) = 3 and (select count(*) from public.org_members) = 2,
  'members see their company''s departments and members');
select pg_temp.check(
  (select count(*) from public.search_directory('tran')) = 1,
  'directory search ignores accents');
select pg_temp.check(
  (select count(*) from public.search_directory(null, 500)) = 2,
  'directory without a query lists everyone active');
select pg_temp.check(
  pg_temp.error_of($$select public.upsert_position(null, 'Clerk', 0, false)$$) = 'Only company admins can do this',
  'non-admin members cannot change positions');

-- ---------------------------------------------------------------- Dave: XYZ is isolated from ABC
select pg_temp.login(:D);
insert into ids select 'xyz', (public.create_organization('XYZ Ltd', 'XYZ')).id::text;
select pg_temp.check(
  pg_temp.error_of($$select public.create_organization('Dup', 'ABC')$$) is not null,
  'Dave cannot create a second company');

select pg_temp.check(
  (select count(*) from public.departments where org_id = (select v::uuid from ids where k = 'abc')) = 0,
  'Dave cannot select ABC departments');
select pg_temp.check(
  (select count(*) from public.org_members where org_id = (select v::uuid from ids where k = 'abc')) = 0,
  'Dave cannot select ABC members');
select pg_temp.check(
  (select count(*) from public.organizations) = 1,
  'Dave sees only his own company');
select pg_temp.check(
  (select count(*) from public.org_holidays) = 0,
  'Dave cannot see ABC holidays');
select pg_temp.check(
  not exists (select 1 from public.search_directory('bob') where user_id = :B)
  and not exists (select 1 from public.search_directory(null, 50) where user_id = :B),
  'search_directory for Dave does not return Bob');
select pg_temp.check(
  pg_temp.error_of(format('select public.archive_department(%L)', (select v from ids where k = 'dev'))) = 'Only company admins can do this',
  'Dave cannot archive ABC departments');
select pg_temp.check(
  pg_temp.error_of(format('select public.upsert_department(%L, %L, %L, null, null, 0)',
    (select v from ids where k = 'hr'), 'Taken', 'HR')) = 'Only company admins can do this',
  'Dave cannot edit ABC departments');
select pg_temp.check(
  pg_temp.error_of(format('select public.update_member(%L, null, null, %L, null)',
    'bbbbbbbb-0000-0000-0000-00000000000b', '{org_admin}')) = 'Member not found',
  'Dave cannot edit ABC members');
select pg_temp.check(
  pg_temp.error_of(format('select public.upsert_department(null, %L, %L, %L, null, 0)',
    'Sub', 'SUB', (select v from ids where k = 'it'))) = 'Parent department not found',
  'a parent department must be in the same company');
select pg_temp.check(
  pg_temp.error_of(format('select public.is_org_member_user(%L, %L)',
    (select v from ids where k = 'abc'), 'bbbbbbbb-0000-0000-0000-00000000000b')) ~* 'permission denied',
  'Dave cannot call is_org_member_user');
select pg_temp.check(
  pg_temp.error_of(format('select public.has_org_role_user(%L, %L, %L)',
    (select v from ids where k = 'abc'), 'clerk', 'bbbbbbbb-0000-0000-0000-00000000000b')) ~* 'permission denied',
  'Dave cannot call has_org_role_user');
select pg_temp.check(
  pg_temp.error_of(format('select public.member_department(%L, %L)',
    (select v from ids where k = 'abc'), 'bbbbbbbb-0000-0000-0000-00000000000b')) ~* 'permission denied'
  and pg_temp.error_of(format('select public.same_org(%L, %L)',
    'aaaaaaaa-0000-0000-0000-00000000000a', 'bbbbbbbb-0000-0000-0000-00000000000b')) ~* 'permission denied'
  and pg_temp.error_of(format('select public.headed_departments_of(%L)',
    'aaaaaaaa-0000-0000-0000-00000000000a')) ~* 'permission denied',
  'Dave cannot call the other *_user style helpers');
select pg_temp.check(
  not public.is_org_member((select v::uuid from ids where k = 'abc')),
  'Dave is not a member of ABC');

-- Dave invites Bob, but Bob already belongs to ABC
insert into ids select 'inv_xyz', (public.invite_member('bob@example.com', null, null, '{staff}')).token;
select pg_temp.login(:B);
select pg_temp.check(
  pg_temp.error_of(format('select public.accept_invitation(%L)', (select v from ids where k = 'inv_xyz'))) = 'You already belong to another company',
  'a member of another company cannot accept');

-- ---------------------------------------------------------------- Alice: admins, status, archive
select pg_temp.login(:A);
select pg_temp.check(
  pg_temp.error_of(format('select public.update_member(%L, null, null, %L, null)',
    'aaaaaaaa-0000-0000-0000-00000000000a', '{staff}')) = 'A company needs at least one admin',
  'demoting the last admin fails');
select pg_temp.check(
  pg_temp.error_of(format('select public.set_member_status(%L, %L)',
    'aaaaaaaa-0000-0000-0000-00000000000a', 'suspended')) is not null,
  'admins cannot suspend themselves');
select pg_temp.check(
  pg_temp.error_of(format('select public.archive_department(%L)', (select v from ids where k = 'hr'))) is not null,
  'archive_department with members fails');
select pg_temp.check(
  pg_temp.error_of(format('select public.archive_department(%L)', (select v from ids where k = 'it'))) = 'Archive its sub-departments first',
  'archive_department with sub-departments fails');
select public.archive_department((select v::uuid from ids where k = 'dev'));
select pg_temp.check(
  (select archived_at is not null from public.departments where id = (select v::uuid from ids where k = 'dev')),
  'an empty department is archived');

-- promote Bob, then Alice may step down
select public.update_member(:B, (select v::uuid from ids where k = 'hr'), null, '{staff,org_admin,staff}', ' Head clerk ');
select pg_temp.check(
  (select roles = array['org_admin', 'staff'] and title = 'Head clerk' from public.org_members where user_id = :B),
  'roles are de-duplicated and ordered; title trimmed');
select public.update_member(:B, (select v::uuid from ids where k = 'hr'), null, '{clerk}', null);

select public.delete_position((select v::uuid from ids where k = 'officer'));
select pg_temp.check(
  (select position_id is null from public.org_members where user_id = :B),
  'deleting a position clears it from members');

select public.set_member_status(:B, 'suspended');
select pg_temp.check(
  (select count(*) from public.search_directory(null)) = 1,
  'suspended members are left out of the directory');
select pg_temp.check(
  (select count(*) from public.list_org_members(null, true)) = 2,
  'admins can list inactive members');

select pg_temp.login(:B);
select pg_temp.check(
  not public.is_org_member((select v::uuid from ids where k = 'abc')),
  'a suspended member gets is_org_member false');
select pg_temp.check(
  (select count(*) from public.departments) = 0,
  'a suspended member cannot read the company');
select pg_temp.check(
  (public.get_my_org() -> 'me' ->> 'status') = 'suspended',
  'get_my_org tells a suspended member their status');

-- Bob leaves ABC, then gets re-invited and comes back (the left row is reactivated)
select pg_temp.login(:A);
select public.set_member_status(:B, 'left');
select pg_temp.check(
  (select left_at is not null from public.org_members where user_id = :B),
  'leaving sets left_at');
select pg_temp.check(
  pg_temp.error_of(format('select public.set_member_status(%L, %L)',
    'bbbbbbbb-0000-0000-0000-00000000000b', 'active')) = 'People who left must be invited again'
  and pg_temp.error_of(format('select public.set_member_status(%L, %L)',
    'bbbbbbbb-0000-0000-0000-00000000000b', 'suspended')) = 'People who left must be invited again'
  and (select status from public.org_members where user_id = :B) = 'left',
  'an admin cannot pull a former member back without their consent');
insert into ids select 'inv_back', (public.invite_member('bob@example.com', null,
  (select v::uuid from ids where k = 'director'), '{leader}')).token;
select pg_temp.check(
  (select count(*) from public.list_org_invitations()
   where token = (select v from ids where k = 'inv_back') and accepted_at is null) = 1,
  'a former member can be invited again');

select pg_temp.login(:B);
select public.accept_invitation((select v from ids where k = 'inv_back'));
select pg_temp.check(
  (select status = 'active' and roles = array['leader'] and left_at is null and department_id is null
   from public.org_members where user_id = :B),
  'accepting reactivates the left row with the new roles');
select pg_temp.check(
  (select can_sign from public.search_directory('bob') where user_id = :B),
  'the directory shows can_sign from the position');

-- Alice revokes an invite for Erin; Erin cannot use it
select pg_temp.login(:A);
insert into ids select 'inv_erin', (public.invite_member('erin@example.com', null, null, null)).token;
select public.revoke_invitation((select id from public.org_invitations where token = (select v from ids where k = 'inv_erin')));
select pg_temp.login(:E);
select pg_temp.check(
  (public.get_invitation((select v from ids where k = 'inv_erin')) ->> 'status') = 'revoked',
  'Erin sees the invitation was revoked');

-- holidays removed by admin only
select pg_temp.check(
  pg_temp.error_of($$select public.delete_org_holiday('2026-09-02')$$) = 'Only company admins can do this',
  'non-members cannot delete holidays');
select pg_temp.login(:A);
select public.delete_org_holiday('2026-09-02');
select pg_temp.check((select count(*) from public.org_holidays) = 0, 'admin deletes a holiday');

reset role;

-- No function that takes a user id is executable by authenticated or anon.
select pg_temp.check(
  not exists (
    select 1 from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('is_org_member_user', 'has_org_role_user', 'member_department', 'same_org',
                        'headed_departments_of', 'org_require_admin', 'org_require_an_admin', 'org_normalize_roles')
      and (has_function_privilege('authenticated', p.oid, 'execute')
           or has_function_privilege('anon', p.oid, 'execute'))
  ),
  'internal org helpers are not executable by authenticated or anon');
select pg_temp.check(
  not exists (
    select 1 from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('my_org_id', 'is_org_member', 'has_org_role', 'is_org_admin', 'my_department',
        'headed_departments', 'create_organization', 'get_my_org', 'update_organization', 'upsert_department',
        'archive_department', 'upsert_position', 'delete_position', 'invite_member', 'list_org_invitations',
        'revoke_invitation', 'get_invitation', 'accept_invitation', 'update_member', 'set_member_status',
        'list_org_members', 'search_directory', 'set_org_holiday', 'delete_org_holiday')
      and has_function_privilege('anon', p.oid, 'execute')
  ),
  'no organization RPC is executable by anon');

rollback;
