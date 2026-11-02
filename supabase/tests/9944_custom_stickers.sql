-- Custom chat stickers managed by site admins (202608280044_custom_stickers.sql):
-- who may write packs, stickers, hidden groups and images, what non-admins
-- see, ordering, the pack cover and sending a custom sticker.
-- Run with scripts/test-db.sh (plain PostgreSQL + supabase/tests stubs).
-- Everything runs in one transaction that is rolled back at the end.

\set ON_ERROR_STOP 1
\o /dev/null
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B '''bbbbbbbb-0000-0000-0000-00000000000b'''
\set P1 '''5c000000-0000-0000-0000-000000000001'''
\set P2 '''5c000000-0000-0000-0000-000000000002'''
\set P3 '''5c000000-0000-0000-0000-000000000003'''

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

-- Returns the SQLSTATE of a statement's error, or null when it succeeds.
create function pg_temp.state_of(stmt text) returns text
language plpgsql as $$
begin
  execute stmt;
  return null;
exception when others then
  return sqlstate;
end;
$$;

-- Number of rows a statement touched.
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
  (:B, 'bob@example.com');
insert into public.user_profiles (id, email) values
  (:A, 'alice@example.com'),
  (:B, 'bob@example.com')
on conflict (id) do nothing;
-- Alice is a site admin (appointed by SQL, as the migration header says)
insert into public.app_admins (user_id) values (:A);

grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
grant execute on function pg_temp.login(uuid) to authenticated, anon;
grant execute on function pg_temp.error_of(text) to authenticated, anon;
grant execute on function pg_temp.state_of(text) to authenticated, anon;
grant execute on function pg_temp.row_count(text) to authenticated, anon;

select pg_temp.check(
  (select public from storage.buckets where id = 'stickers'),
  'the stickers bucket exists and is public');

set local role authenticated;

-- ---------------------------------------------------------------- site admins
select pg_temp.login(:A);
select pg_temp.check(public.is_app_admin(), 'Alice is a site admin');
select pg_temp.check((select count(*) from public.app_admins) = 1, 'Alice sees her own admin row');
select pg_temp.login(:B);
select pg_temp.check(not public.is_app_admin(), 'Bob is not a site admin');
select pg_temp.check((select count(*) from public.app_admins) = 0, 'Bob does not see the admin list');
select pg_temp.check(
  pg_temp.error_of(format('insert into public.app_admins (user_id) values (%L)', 'bbbbbbbb-0000-0000-0000-00000000000b')) like 'permission denied%',
  'nobody appoints a site admin from the app');
select pg_temp.check(
  pg_temp.error_of('delete from public.app_admins') like 'permission denied%',
  'Bob cannot remove site admins');
reset role;
select pg_temp.check((select count(*) from public.app_admins) = 1, 'the admin list is unchanged');
set local role authenticated;

-- ---------------------------------------------------------------- packs: non-admin
select pg_temp.login(:B);
select pg_temp.check(
  pg_temp.error_of(format('insert into public.sticker_packs (id, name) values (%L, %L)', '5c000000-0000-0000-0000-0000000000ff', 'Mine')) is not null,
  'a non-admin cannot create a pack');

-- ---------------------------------------------------------------- packs: admin
select pg_temp.login(:A);
insert into public.sticker_packs (id, name, sort_order) values (:P1, 'Cats', 0);
insert into public.sticker_packs (id, name, sort_order, enabled) values (:P2, 'Secret', 1, false);
insert into public.sticker_packs (id, name, sort_order) values (:P3, 'Dogs', 2);
reset role;
select pg_temp.check(
  (select created_by from public.sticker_packs where id = :P1) = :A,
  'a new pack records its creator');
set local role authenticated;
select pg_temp.check(
  pg_temp.error_of(format('select created_by from public.sticker_packs where id = %L', '5c000000-0000-0000-0000-000000000001')) like 'permission denied%'
  and pg_temp.error_of('select hidden_by from public.sticker_hidden_groups') like 'permission denied%'
  and pg_temp.error_of('select * from public.sticker_packs') like 'permission denied%',
  'nobody reads from the app who created a pack or hid a group (it names the site admins)');
select pg_temp.check(
  pg_temp.error_of(format('insert into public.sticker_packs (name) values (%L)', '   ')) like '%check%',
  'a pack needs a name');
select pg_temp.check(
  pg_temp.error_of(format('insert into public.sticker_packs (name) values (%L)', repeat('x', 61))) like '%check%',
  'a pack name has at most 60 characters');

insert into public.custom_stickers (id, pack_id, name, keywords, sort_order, mime, size_bytes) values
  ('cs-aaaaaaaaa1', :P1, 'Happy cat', array['vui', 'happy'], 0, 'image/png', 1000),
  ('cs-aaaaaaaaa2', :P1, 'Sad cat', array['buồn'], 1, 'image/webp', 2000),
  ('cs-aaaaaaaaa3', :P1, 'Sleepy cat', '{}', 2, 'image/gif', 3000),
  ('cs-bbbbbbbbb1', :P2, 'Hidden', '{}', 0, 'image/jpeg', 4000),
  ('cs-ccccccccc1', :P3, 'Dog', '{}', 0, 'image/png', 5000);

select pg_temp.check(
  pg_temp.error_of(format('insert into public.custom_stickers (id, pack_id, name, mime, size_bytes) values (%L, %L, %L, %L, 10)',
    'red-heart', '5c000000-0000-0000-0000-000000000001', 'x', 'image/png')) like '%check%',
  'a custom sticker id must look like cs-xxxxxxxxxx');
select pg_temp.check(
  pg_temp.error_of(format('insert into public.custom_stickers (id, pack_id, name, mime, size_bytes) values (%L, %L, %L, %L, 10)',
    'cs-dddddddd01', '5c000000-0000-0000-0000-000000000001', 'x', 'image/svg+xml')) like '%check%',
  'SVG is not a sticker type');
select pg_temp.check(
  pg_temp.error_of(format('insert into public.custom_stickers (id, pack_id, name, mime, size_bytes) values (%L, %L, %L, %L, 2097153)',
    'cs-dddddddd02', '5c000000-0000-0000-0000-000000000001', 'x', 'image/png')) like '%check%',
  'a sticker is at most 2 MiB');
select pg_temp.check(
  pg_temp.error_of(format('insert into public.custom_stickers (id, pack_id, name, keywords, mime, size_bytes) values (%L, %L, %L, %L, %L, 10)',
    'cs-dddddddd03', '5c000000-0000-0000-0000-000000000001', 'x',
    (select array_agg('k' || i) from generate_series(1, 31) i)::text, 'image/png')) like '%check%',
  'a sticker has at most 30 keywords');

update public.custom_stickers set name = 'Very happy cat', keywords = array['vui', 'vui vẻ'] where id = 'cs-aaaaaaaaa1';
select pg_temp.check(
  (select name from public.custom_stickers where id = 'cs-aaaaaaaaa1') = 'Very happy cat',
  'an admin renames a sticker and edits its keywords');
select pg_temp.check(
  pg_temp.error_of('update public.custom_stickers set id = ''cs-zzzzzzzzz9'' where id = ''cs-aaaaaaaaa1''') like 'permission denied%'
  and pg_temp.error_of('update public.custom_stickers set mime = ''image/gif'' where id = ''cs-aaaaaaaaa1''') like 'permission denied%',
  'the id and image facts of a sticker never change');

-- cover: a sticker of the pack itself, cleared when that sticker goes
update public.sticker_packs set cover_sticker_id = 'cs-aaaaaaaaa2' where id = :P1;
select pg_temp.check(
  pg_temp.error_of(format('update public.sticker_packs set cover_sticker_id = %L where id = %L', 'cs-ccccccccc1', '5c000000-0000-0000-0000-000000000001')) like '%foreign key%',
  'a pack cover must be one of its own stickers');
select pg_temp.check(
  (select updated_at from public.sticker_packs where id = :P1) is not null,
  'packs keep an updated_at');

-- ---------------------------------------------------------------- visibility
select pg_temp.login(:B);
select pg_temp.check(
  (select array_agg(id order by sort_order) from public.sticker_packs) = array[:P1, :P3]::uuid[],
  'a non-admin sees the enabled packs only');
select pg_temp.check(
  (select count(*) from public.custom_stickers where pack_id = :P1) = 3
  and not exists (select 1 from public.custom_stickers where id = 'cs-bbbbbbbbb1'),
  'a non-admin sees the stickers of enabled packs only');
select pg_temp.check(
  pg_temp.row_count('update public.sticker_packs set name = ''Mine'' where id = ''5c000000-0000-0000-0000-000000000001''') = 0
  and pg_temp.row_count('update public.custom_stickers set name = ''Mine'' where id = ''cs-aaaaaaaaa1''') = 0
  and pg_temp.row_count('delete from public.custom_stickers where id = ''cs-aaaaaaaaa1''') = 0
  and pg_temp.row_count('delete from public.sticker_packs where id = ''5c000000-0000-0000-0000-000000000001''') = 0,
  'a non-admin cannot edit or delete packs and stickers');
select pg_temp.check(
  pg_temp.error_of(format('insert into public.custom_stickers (id, pack_id, name, mime, size_bytes) values (%L, %L, %L, %L, 10)',
    'cs-eeeeeeeee1', '5c000000-0000-0000-0000-000000000001', 'x', 'image/png')) is not null,
  'a non-admin cannot add a sticker');
select pg_temp.login(:A);
select pg_temp.check(
  (select count(*) from public.sticker_packs) = 3 and (select count(*) from public.custom_stickers) = 5,
  'an admin sees disabled packs too');
select pg_temp.check(
  (select name from public.sticker_packs where id = :P1) = 'Cats'
  and exists (select 1 from public.custom_stickers where id = 'cs-aaaaaaaaa1'),
  'nothing changed by the non-admin attempts');

-- ---------------------------------------------------------------- ordering
select pg_temp.login(:B);
select pg_temp.check(
  pg_temp.state_of(format('select public.reorder_sticker_packs(array[%L, %L]::uuid[])',
    '5c000000-0000-0000-0000-000000000003', '5c000000-0000-0000-0000-000000000001')) = '42501',
  'a non-admin cannot reorder packs');
select pg_temp.check(
  pg_temp.state_of(format('select public.reorder_custom_stickers(%L, array[%L])',
    '5c000000-0000-0000-0000-000000000001', 'cs-aaaaaaaaa3')) = '42501',
  'a non-admin cannot reorder stickers');
select pg_temp.login(:A);
select public.reorder_sticker_packs(array[:P3, :P2, :P1]::uuid[]);
select pg_temp.check(
  (select array_agg(id order by sort_order) from public.sticker_packs) = array[:P3, :P2, :P1]::uuid[],
  'packs follow the given order');
select public.reorder_custom_stickers(:P1, array['cs-aaaaaaaaa3', 'cs-aaaaaaaaa1', 'cs-aaaaaaaaa2', 'cs-ccccccccc1']);
select pg_temp.check(
  (select array_agg(id order by sort_order) from public.custom_stickers where pack_id = :P1)
    = array['cs-aaaaaaaaa3', 'cs-aaaaaaaaa1', 'cs-aaaaaaaaa2'],
  'stickers follow the given order');
select pg_temp.check(
  (select sort_order from public.custom_stickers where id = 'cs-ccccccccc1') = 0,
  'a sticker of another pack is not moved');
select pg_temp.check(
  pg_temp.state_of(format('select public.reorder_sticker_packs(array[%L, %L]::uuid[])',
    '5c000000-0000-0000-0000-000000000001', '5c000000-0000-0000-0000-000000000001')) = '22023',
  'a pack listed twice is refused');

-- ---------------------------------------------------------------- hidden groups
select pg_temp.login(:B);
select pg_temp.check(
  pg_temp.error_of('insert into public.sticker_hidden_groups (group_key) values (''smileys'')') is not null,
  'a non-admin cannot hide a built-in group');
select pg_temp.login(:A);
insert into public.sticker_hidden_groups (group_key) values ('food');
-- what the admin page sends (upsert, ignore duplicates)
insert into public.sticker_hidden_groups (group_key) values ('food') on conflict (group_key) do nothing;
reset role;
select pg_temp.check(
  (select hidden_by from public.sticker_hidden_groups where group_key = 'food') = :A,
  'an admin hides a built-in group');
set local role authenticated;
select pg_temp.check(
  pg_temp.error_of('insert into public.sticker_hidden_groups (group_key) values (''bogus'')') like '%check%',
  'only real built-in groups can be hidden');
select pg_temp.login(:B);
select pg_temp.check(
  (select array_agg(group_key) from public.sticker_hidden_groups) = array['food'],
  'everyone signed in sees which groups are hidden');
select pg_temp.check(
  pg_temp.row_count('delete from public.sticker_hidden_groups') = 0,
  'a non-admin cannot show a hidden group again');
select pg_temp.login(:A);
insert into public.sticker_hidden_groups (group_key) values ('travel');
select pg_temp.check(
  pg_temp.row_count('delete from public.sticker_hidden_groups where group_key = ''travel''') = 1,
  'an admin shows a group again');

-- ---------------------------------------------------------------- storage
select pg_temp.login(:B);
select pg_temp.check(
  pg_temp.error_of('insert into storage.objects (bucket_id, name) values (''stickers'', ''cs-aaaaaaaaa1'')') is not null,
  'a non-admin cannot upload a sticker image');
select pg_temp.login(:A);
insert into storage.objects (bucket_id, name) values ('stickers', 'cs-aaaaaaaaa1'), ('stickers', 'cs-aaaaaaaaa2');
select pg_temp.check(
  pg_temp.error_of('insert into storage.objects (bucket_id, name) values (''stickers'', ''folder/cs-aaaaaaaaa1'')') is not null
  and pg_temp.error_of('insert into storage.objects (bucket_id, name) values (''stickers'', ''cat.png'')') is not null
  and pg_temp.error_of('insert into storage.objects (bucket_id, name) values (''stickers'', ''cs-AAAAAAAAA1'')') is not null,
  'sticker images are named exactly like a sticker id');
select pg_temp.login(:B);
select pg_temp.check(
  (select count(*) from storage.objects where bucket_id = 'stickers') = 2,
  'signed-in users can list sticker images');
select pg_temp.check(
  pg_temp.row_count('delete from storage.objects where bucket_id = ''stickers''') = 0
  and pg_temp.row_count('update storage.objects set name = ''cs-zzzzzzzzz1'' where bucket_id = ''stickers''') = 0,
  'a non-admin cannot delete or rename sticker images');
select pg_temp.login(:A);
select pg_temp.check(
  pg_temp.row_count('delete from storage.objects where bucket_id = ''stickers'' and name = ''cs-aaaaaaaaa2''') = 1,
  'an admin deletes a sticker image');

-- ---------------------------------------------------------------- sending
select pg_temp.login(:A);
select set_config('test.g', public.create_chat_group('Stickers', array['bob@example.com'])::text, true);
select pg_temp.login(:B);
select set_config('test.m', public.send_chat_message(current_setting('test.g')::uuid, null, null, null, null, null, 'cs-aaaaaaaaa1')::text, true);
select pg_temp.check(
  (select meta ->> 'sticker' from public.chat_messages where id = current_setting('test.m')::uuid) = 'cs-aaaaaaaaa1',
  'a sticker of an enabled pack can be sent');
select pg_temp.check(
  public.send_chat_message(current_setting('test.g')::uuid, null, null, null, null, null, 'red-heart') is not null,
  'a built-in sticker can still be sent');
select pg_temp.check(
  public.send_chat_message(current_setting('test.g')::uuid, null, null, null, null, null, 'hamburger') is not null,
  'a sticker of a hidden built-in group can still be sent');
select pg_temp.check(
  pg_temp.error_of(format('select public.send_chat_message(%L, null, null, null, null, null, %L)', current_setting('test.g'), 'cs-bbbbbbbbb1')) = 'Unknown sticker',
  'a sticker of a disabled pack cannot be sent');
select pg_temp.check(
  pg_temp.error_of(format('select public.send_chat_message(%L, null, null, null, null, null, %L)', current_setting('test.g'), 'cs-zzzzzzzzz9')) = 'Unknown sticker'
  and pg_temp.error_of(format('select public.send_chat_message(%L, null, null, null, null, null, %L)', current_setting('test.g'), 'cs-abc')) = 'Unknown sticker',
  'an unknown custom sticker cannot be sent');
select pg_temp.check(
  pg_temp.error_of(format('select public.send_chat_message(%L, null, null, null, null, null, %L)', current_setting('test.g'), 'Bad Sticker!')) = 'Unknown sticker',
  'the built-in id check still applies');

-- ---------------------------------------------------------------- deleting
select pg_temp.login(:A);
delete from public.custom_stickers where id = 'cs-aaaaaaaaa2';
select pg_temp.check(
  (select cover_sticker_id from public.sticker_packs where id = :P1) is null
  and exists (select 1 from public.sticker_packs where id = :P1),
  'deleting the cover sticker clears the cover and keeps the pack');
select pg_temp.login(:B);
select pg_temp.check(
  pg_temp.error_of(format('select public.send_chat_message(%L, null, null, null, null, null, %L)', current_setting('test.g'), 'cs-aaaaaaaaa2')) = 'Unknown sticker',
  'a deleted sticker cannot be sent');
select pg_temp.login(:A);
update public.sticker_packs set cover_sticker_id = 'cs-aaaaaaaaa1' where id = :P1;
delete from public.sticker_packs where id = :P1;
select pg_temp.check(
  not exists (select 1 from public.custom_stickers where pack_id = :P1),
  'deleting a pack deletes its stickers');
select pg_temp.check(
  (select meta ->> 'sticker' from public.chat_messages where id = current_setting('test.m')::uuid) = 'cs-aaaaaaaaa1',
  'old messages keep the sticker id (the app shows a placeholder)');
reset role;

-- ---------------------------------------------------------------- anon
set local role anon;
select pg_temp.check(
  pg_temp.error_of('select count(*) from public.sticker_packs') like 'permission denied%'
  and pg_temp.error_of('select count(*) from public.custom_stickers') like 'permission denied%'
  and pg_temp.error_of('select count(*) from public.sticker_hidden_groups') like 'permission denied%'
  and pg_temp.error_of('select count(*) from public.app_admins') like 'permission denied%',
  'anon reads no sticker table');
select pg_temp.check(
  pg_temp.error_of('select public.is_app_admin()') like 'permission denied%'
  and pg_temp.error_of('select public.reorder_sticker_packs(array[]::uuid[])') like 'permission denied%'
  and pg_temp.error_of(format('select public.reorder_custom_stickers(%L, array[]::text[])', '5c000000-0000-0000-0000-000000000003')) like 'permission denied%',
  'anon cannot call the sticker functions');
reset role;

select pg_temp.check(
  not has_function_privilege('anon', 'public.is_app_admin()', 'execute')
  and has_function_privilege('authenticated', 'public.is_app_admin()', 'execute')
  and has_function_privilege('authenticated', 'public.send_chat_message(uuid, text, uuid, uuid, uuid[], uuid, text)', 'execute')
  and not has_function_privilege('anon', 'public.send_chat_message(uuid, text, uuid, uuid, uuid[], uuid, text)', 'execute'),
  'function grants');

rollback;
