-- Security hardening (audit findings legacy.sql, anon-callable definer
-- functions, push endpoint allowlist).
-- Run after 202608280029_chat_stickers.sql. Idempotent: every step uses
-- drop ... if exists / create or replace / a re-runnable loop.
--
-- 1) Legacy storage policies (202608280001) are dropped. They let any user
--    read or delete any object in the 'uploads' bucket by inserting an
--    uploaded_files row that pointed at someone else's path. Storage access
--    now goes only through the 003 policies ('Users can upload to their own
--    namespace', 'Users can read accessible file versions', 'Users can delete
--    accessible file versions') and the public_images_* policies (027).
-- 2) Legacy tables upload_batches / uploaded_files become read-only for
--    clients (history stays readable through their SELECT policies).
-- 3) migrate_batches_to_file_system() is no longer callable by clients.
-- 4) Internal helpers: execute revoked from public, anon and authenticated,
--    granted to service_role:
--      log_activity(text, text, uuid, text, uuid, jsonb)   forged activity
--      get_user_storage_usage_bytes(uuid)                 any user's usage
--      get_user_storage_quota_bytes(uuid)                 any user's quota
--      assert_storage_quota(uuid, bigint)
--      share_resource_check(text, text)
--      migrate_batches_to_file_system()
--      activity_files_trigger_fn(), activity_folders_trigger_fn(),
--      activity_file_versions_trigger_fn(), activity_file_shares_trigger_fn(),
--      activity_folder_shares_trigger_fn(), activity_share_links_trigger_fn(),
--      handle_new_user_profile()                          trigger functions
--      find_user_by_email(text)                           any user's id by e-mail
--                                          (user_profiles has no client SELECT
--                                          policy; unused by the app and by SQL)
--    All of them are called only from SECURITY DEFINER functions or as
--    triggers (trigger firing does not check EXECUTE); no RLS policy and no
--    SECURITY INVOKER function calls them, and src/ + packages/ never call
--    them through supabase.rpc.
--    Kept for authenticated because RLS policies (evaluated as the caller)
--    call them:
--      can_view_upload_batch(uuid, uuid)   policy "Users can view permitted batches"
--      has_file_access(uuid, text)         files/file_versions/file_tags/file_shares/
--                                          share_links/item_comments/file_contents
--                                          and storage.objects policies
--      has_folder_access(uuid, text)       folders/folder_shares/share_links/item_comments
--      is_chat_member(uuid)                chat_* policies
--      is_chat_topic_member(text)          realtime.messages policies
--      can_write_public_image(text), can_upload_public_image(text)
--                                          public_images_* storage policies
--    Also kept: chat_role(uuid), can_edit_chat_group(uuid), can_pin_chat(uuid)
--    and assistant_accessible_files(); they only answer for auth.uid() and were
--    granted on purpose (027 / 016).
-- 4b) Anon sweep: execute is revoked from anon and public on every function in
--    schema public that anon could run (authenticated keeps the grant it had,
--    service_role is granted). At 029 that is: access_share_link,
--    activity_*_trigger_fn (6), add_file_version, add_item_comment,
--    add_related_user, assert_storage_quota, assistant_memories_guard,
--    assistant_snippet, can_view_upload_batch, chat_valid_file_name,
--    clean_comment_body, copy_file, count_item_comments, create_folder,
--    create_share_link, delete_item_comment, delete_share_link, empty_trash,
--    file_versions_storage_path_guard, find_duplicate_files,
--    find_user_by_email, fm_normalize, get_file_tags, get_file_version_paths,
--    get_folder_ancestors, get_folder_storage_paths, get_storage_quota,
--    get_trash_storage_paths, get_user_storage_quota_bytes,
--    get_user_storage_usage_bytes, handle_new_user_profile, handle_updated_at,
--    hard_delete_file, hard_delete_folder, has_file_access, has_folder_access,
--    inspect_share_link, list_activity, list_file_shares, list_folder_shares,
--    list_item_comments, list_my_tags, list_recent_files, list_related_users,
--    list_share_links, list_shared_with_me, list_trash, log_activity,
--    migrate_batches_to_file_system, move_file, move_folder, register_file,
--    remove_related_user, rename_file, rename_folder, restore_file,
--    restore_file_version, restore_folder, role_rank, search_files,
--    set_file_tags, set_share_link_disabled, share_file, share_folder,
--    share_resource_check, soft_delete_file, soft_delete_folder,
--    touch_superapp_versions_updated_at, unshare_file, unshare_folder,
--    update_file_share, update_folder_comment, update_folder_share,
--    update_item_comment (plus anything else a live database still exposes).
--    Extension-owned functions are skipped (on Supabase they live in schema
--    extensions anyway).
--    Anon allow-list: EMPTY. The signed-out pages (/share/[token],
--    /api/public-share, /superapp, /api/superapp) use only the service-role
--    client; their single RPC, record_share_link_view, is service_role only
--    (021). supabase/tests/9930_security_hardening.sql checks this list.
--    The default privileges for role postgres in schema public are also
--    changed so new functions are not granted to anon. [Unverified] whether
--    hosted Supabase allows it; on PostgreSQL a per-schema revoke cannot
--    remove the global PUBLIC default, so later migrations must still
--    'revoke all on function ... from public, anon' explicitly.
-- 5) Push endpoints: only FCM, Mozilla autopush, Windows (WNS) and Apple push
--    services are accepted (same pattern as src/lib/push/endpoints.ts); other
--    rows are deleted; at most 10 subscriptions are kept per user.
--
-- Rollback (restores the old, less safe behaviour; not recommended):
--   recreate the three storage policies and the upload_batches/uploaded_files
--   insert/update/delete policies from 202608280001 and
--   'grant insert, update, delete on public.upload_batches, public.uploaded_files to authenticated';
--   'grant execute on function <each function above> to authenticated' (and anon if wanted);
--   alter table public.push_subscriptions drop constraint push_subscriptions_endpoint_check,
--     add constraint push_subscriptions_endpoint_check check (endpoint ~ '^https://' and length(endpoint) <= 1000);
--   re-run save_push_subscription from 202608280028_web_push.sql.
-- Deleted push subscriptions cannot be restored (browsers re-subscribe on next visit).

-- =============================================
-- 1) Legacy storage policies
-- =============================================
-- 202608280001
drop policy if exists "Users can upload to their own batches" on storage.objects;
drop policy if exists "Users can read permitted stored files" on storage.objects;
drop policy if exists "Users can delete their own stored files" on storage.objects;
-- schema.sql (already dropped by 001; repeated in case a project skipped it)
drop policy if exists "Authenticated users can upload files" on storage.objects;
drop policy if exists "Authenticated users can read files" on storage.objects;
drop policy if exists "Authenticated users can delete files" on storage.objects;

-- =============================================
-- 2) Legacy tables: read-only for clients
-- =============================================
-- schema.sql
drop policy if exists "Authenticated users can create batches" on public.upload_batches;
drop policy if exists "Authenticated users can insert files" on public.uploaded_files;
-- 202608280001
drop policy if exists "Users can create own batches" on public.upload_batches;
drop policy if exists "Users can update own batches" on public.upload_batches;
drop policy if exists "Users can delete own batches" on public.upload_batches;
drop policy if exists "Users can insert files in own batches" on public.uploaded_files;
drop policy if exists "Users can update own files" on public.uploaded_files;
drop policy if exists "Users can update files in own batches" on public.uploaded_files;
drop policy if exists "Users can delete files in own batches" on public.uploaded_files;

revoke insert, update, delete on public.upload_batches from public, anon, authenticated;
revoke insert, update, delete on public.uploaded_files from public, anon, authenticated;

-- =============================================
-- 3) + 4) Internal helpers: service_role only
-- =============================================
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.migrate_batches_to_file_system()',
    'public.log_activity(text, text, uuid, text, uuid, jsonb)',
    'public.get_user_storage_usage_bytes(uuid)',
    'public.get_user_storage_quota_bytes(uuid)',
    'public.assert_storage_quota(uuid, bigint)',
    'public.share_resource_check(text, text)',
    'public.activity_files_trigger_fn()',
    'public.activity_folders_trigger_fn()',
    'public.activity_file_versions_trigger_fn()',
    'public.activity_file_shares_trigger_fn()',
    'public.activity_folder_shares_trigger_fn()',
    'public.activity_share_links_trigger_fn()',
    'public.handle_new_user_profile()',
    'public.find_user_by_email(text)'
  ] loop
    if to_regprocedure(f) is null then
      raise notice 'security_hardening: % not found, skipped', f;
      continue;
    end if;
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;

-- RLS helper: the upload_batches SELECT policy calls it as the caller, so
-- authenticated keeps execute (anon/public are removed by the sweep below).
grant execute on function public.can_view_upload_batch(uuid, uuid) to authenticated;

-- =============================================
-- 4b) Anon sweep
-- =============================================
do $$
declare
  -- Functions the signed-out pages need, as 'name(identity args)'. Empty:
  -- see the header. Keep in sync with supabase/tests/9930_security_hardening.sql.
  v_anon_allow text[] := array[]::text[];
  r record;
begin
  for r in
    select format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) as fn,
           has_function_privilege('authenticated', p.oid, 'execute') as authenticated_ok
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind in ('f', 'p')
      and has_function_privilege('anon', p.oid, 'execute')
      and not exists (
        select 1 from pg_depend d
        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
      )
      and format('%s(%s)', p.proname, pg_get_function_identity_arguments(p.oid)) <> all (v_anon_allow)
  loop
    execute format('revoke execute on routine %s from public, anon', r.fn);
    -- keep what signed-in users already had (revoking public may have been
    -- their only path to it)
    if r.authenticated_ok then
      execute format('grant execute on routine %s to authenticated', r.fn);
    end if;
    execute format('grant execute on routine %s to service_role', r.fn);
  end loop;
end;
$$;

-- New functions: stop the default grant to anon. [Unverified] on hosted
-- Supabase; explicit revokes stay mandatory in later migrations.
do $$
begin
  alter default privileges for role postgres in schema public revoke execute on functions from anon, public;
exception
  when insufficient_privilege or undefined_object then
    raise notice 'security_hardening: could not change default privileges (%), explicit revokes still apply', sqlerrm;
end;
$$;

-- =============================================
-- 5) Push endpoints: allowlisted push services only
-- =============================================
delete from public.push_subscriptions
where endpoint !~ '^https://(fcm\.googleapis\.com|[a-z0-9.-]*push\.services\.mozilla\.com|[a-z0-9.-]+\.notify\.windows\.com|web\.push\.apple\.com)/';

-- drop the old endpoint check (inline constraint, name looked up)
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.push_subscriptions'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%endpoint%'
  loop
    execute format('alter table public.push_subscriptions drop constraint %I', c.conname);
  end loop;
end;
$$;

alter table public.push_subscriptions
  add constraint push_subscriptions_endpoint_check check (
    endpoint ~ '^https://(fcm\.googleapis\.com|[a-z0-9.-]*push\.services\.mozilla\.com|[a-z0-9.-]+\.notify\.windows\.com|web\.push\.apple\.com)/'
    and length(endpoint) <= 1000
  );

-- Saves this browser's subscription for the caller. The browser holding the
-- endpoint is the device: a subscription left by another account on the same
-- browser (signed out without cleaning up) moves to the caller. Only known
-- push services are accepted, and each user keeps their 10 most recently
-- used devices (the one being saved always stays).
create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if p_endpoint is null
     or p_endpoint !~ '^https://(fcm\.googleapis\.com|[a-z0-9.-]*push\.services\.mozilla\.com|[a-z0-9.-]+\.notify\.windows\.com|web\.push\.apple\.com)/' then
    raise exception 'Unsupported push service';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  on conflict (endpoint) do update
  set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
      user_agent = excluded.user_agent, created_at = now();

  delete from public.push_subscriptions
  where user_id = auth.uid()
    and id not in (
      select s.id from public.push_subscriptions s
      where s.user_id = auth.uid()
      order by (s.endpoint = p_endpoint) desc, coalesce(s.last_used_at, s.created_at) desc, s.id
      limit 10
    );
end;
$$;

revoke all on function public.save_push_subscription(text, text, text, text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated, service_role;
