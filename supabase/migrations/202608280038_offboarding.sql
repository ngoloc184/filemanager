-- Offboarding: hand a leaving member's files, folders, chat groups and
-- document work to a successor, then mark the member 'left'.
-- Run after 202608280037_storage_hygiene.sql. Idempotent (create or replace).
--
-- Accounts are not deleted: an account that still owns files or folders
-- cannot be deleted (031 made owner FKs RESTRICT). After offboard_member the
-- leaver owns nothing, so an operator can delete the account in Supabase
-- without losing team files.
--
-- 1. offboarding_preview(user) (client RPC): what offboarding would move,
--    as counts. Admins of the company where the person is active or
--    suspended only (never a company they left).
-- 2. transfer_user_data(org, from, to) (INTERNAL, service_role only; only
--    offboard_member calls it):
--    * folders and files change owner (storage paths stay; access is by DB
--      ownership). Folder names that would collide with one of the
--      successor's folders in the same place (uq_folders_sibling_name) are
--      renamed '<name> (from <leaver>)', ' 2', ' 3' … when needed. The
--      leaver's 'Documents' system folder loses its purpose when the
--      successor already has one (uq_folders_documents_purpose).
--      Frozen document files are allowed: the freeze trigger does not watch
--      owner_id.
--    * shares to the successor on items they now own, and every share to
--      the leaver, are deleted (with their chat file grants).
--    * chat groups the leaver owns go to the successor when they are in the
--      group, else to the longest-standing admin, else the oldest member;
--      the leaver stays as a plain member. A group with nobody else is kept.
--    * open document assignments, waiting/pending approval steps (a step the
--      successor already has at the same document/revision/step is marked
--      'skipped' instead), 'presented to' on unfinished documents, drafts,
--      department head, register roles and (when 043 is applied) dossiers.
--      Each moved assignment or step is logged 'reassigned'.
--    * the successor gets one 'org.handover' notification.
-- 3. offboard_member(user, successor) (client RPC): admin of the company
--    where the person is active or suspended; never the caller; calls
--    transfer_user_data, sets status 'left' (left_at), deletes the leaver's
--    push subscriptions and keeps at least one admin. Signing the account
--    out is the server route's job (POST /api/org/offboard, auth admin API).
-- 4. revoke_user_sessions(user) (INTERNAL, service_role only): deletes the
--    account's rows in auth.sessions when that table exists and is writable,
--    so a banned account cannot refresh its session. Returns the number of
--    sessions removed, or null when it could not touch auth.sessions.
--    [Unverified] Whether the function owner may delete from auth.sessions
--    on hosted Supabase; the route treats null as "not revoked".
--
-- Rollback (manual; data already moved stays moved):
--   drop function if exists public.offboard_member(uuid, uuid);
--   drop function if exists public.transfer_user_data(uuid, uuid, uuid);
--   drop function if exists public.offboarding_preview(uuid);
--   drop function if exists public.offboarding_org_of(uuid);
--   drop function if exists public.revoke_user_sessions(uuid);

-- =============================================
-- 0. Finished assignments survive the account's deletion
-- =============================================
-- document_assignments.assignee_user_id is ON DELETE SET NULL, but 036
-- required exactly one of user/department, so deleting an account that ever
-- had an assignment (done or revoked ones stay as history) failed the check.
-- Now at most one is set; both null means "the assignee's account was
-- removed". Every RPC still sets exactly one.
alter table public.document_assignments drop constraint if exists document_assignments_check;
alter table public.document_assignments drop constraint if exists document_assignments_one_assignee;
alter table public.document_assignments add constraint document_assignments_one_assignee
  check (assignee_user_id is null or assignee_department_id is null);

-- =============================================
-- Internal helpers
-- =============================================

-- The company where the person is active or suspended (at most one row,
-- uq_org_members_one_company), or null.
create or replace function public.offboarding_org_of(p_user_id uuid)
returns uuid
language sql stable security definer
set search_path = public
as $$
  select m.org_id from public.org_members m
  where m.user_id = p_user_id and m.status in ('active', 'suspended')
  limit 1;
$$;

-- Statuses after which a document needs nobody's attention any more
-- (used inline below):
--   incoming: completed, cancelled, archived
--   outgoing/internal: issued, rejected, withdrawn, recalled, archived

-- =============================================
-- 1. Preview
-- =============================================
create or replace function public.offboarding_preview(p_user_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_dossiers bigint := 0;
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_org_id := public.offboarding_org_of(p_user_id);
  if v_org_id is null or not public.is_org_admin(v_org_id) then
    raise exception 'Only company admins can offboard members' using errcode = '42501';
  end if;

  if to_regclass('public.dossiers') is not null then
    execute 'select count(*) from public.dossiers where org_id = $1 and owner_id = $2'
      into v_dossiers using v_org_id, p_user_id;
  end if;

  select jsonb_build_object(
    'files', (select count(*) from public.files f where f.owner_id = p_user_id),
    'folders', (select count(*) from public.folders f where f.owner_id = p_user_id),
    'bytes', (
      select coalesce(sum(fv.size), 0)
      from public.file_versions fv
      join public.files f on f.id = fv.file_id
      where f.owner_id = p_user_id
    ),
    'open_assignments', (
      select count(*)
      from public.document_assignments a
      join public.documents d on d.id = a.document_id
      where d.org_id = v_org_id and a.assignee_user_id = p_user_id
        and a.status in ('pending', 'seen', 'in_progress')
    ),
    'pending_steps', (
      select count(*)
      from public.document_approval_steps s
      join public.documents d on d.id = s.document_id
      where d.org_id = v_org_id and s.approver_user_id = p_user_id
        and s.status in ('waiting', 'pending')
    ),
    'presented_documents', (
      select count(*) from public.documents d
      where d.org_id = v_org_id and d.presented_to = p_user_id
        and d.status not in ('completed', 'cancelled', 'archived', 'issued', 'rejected', 'withdrawn', 'recalled')
    ),
    'draft_documents', (
      select count(*) from public.documents d
      where d.org_id = v_org_id and d.created_by = p_user_id and d.status = 'draft'
    ),
    'headed_departments', (
      select count(*) from public.departments d
      where d.org_id = v_org_id and d.head_user_id = p_user_id
    ),
    'owned_chat_groups', (
      select count(*)
      from public.chat_members m
      join public.chat_conversations c on c.id = m.conversation_id and c.kind = 'group'
      where m.user_id = p_user_id and m.role = 'owner'
        and exists (
          select 1 from public.chat_members o
          where o.conversation_id = m.conversation_id and o.user_id <> p_user_id
        )
    ),
    'register_roles', (
      select count(*)
      from public.doc_register_roles rr
      join public.doc_registers r on r.id = rr.register_id
      where r.org_id = v_org_id and rr.user_id = p_user_id
    ),
    'dossiers', v_dossiers
  ) into v_result;
  return v_result;
end;
$$;

-- =============================================
-- 2. Transfer (internal)
-- =============================================
create or replace function public.transfer_user_data(p_org_id uuid, p_from uuid, p_to uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  c_zero constant uuid := '00000000-0000-0000-0000-000000000000';
  v_leaver text;
  v_folder record;
  v_name text;
  v_i int;
  v_row record;
  v_new_owner uuid;
  v_files int := 0;
  v_folders int := 0;
  v_renamed int := 0;
  v_shares int := 0;
  v_n int := 0;
  v_groups int := 0;
  v_assignments int := 0;
  v_steps int := 0;
  v_skipped int := 0;
  v_presented int := 0;
  v_drafts int := 0;
  v_departments int := 0;
  v_register_roles int := 0;
  v_dossiers int := 0;
  v_counts jsonb;
begin
  if p_org_id is null or p_from is null or p_to is null then
    raise exception 'Pick a successor' using errcode = '22023';
  end if;
  if p_from = p_to then
    raise exception 'The successor must be a different person' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.org_members
    where org_id = p_org_id and user_id = p_from and status in ('active', 'suspended')
  ) then
    raise exception 'Member not found' using errcode = 'P0002';
  end if;
  if not public.is_org_member_user(p_org_id, p_to) then
    raise exception 'The successor must be an active member of the company' using errcode = '22023';
  end if;

  v_leaver := coalesce(
    public.doc_user_name(p_from),
    (select u.email from auth.users u where u.id = p_from),
    'a former member'
  );

  -- ---------------------------------------------------------------- folders and files
  -- one 'Documents' system folder per owner
  if exists (
    select 1 from public.folders
    where owner_id = p_to and purpose = 'documents' and deleted_at is null
  ) then
    update public.folders set purpose = null
    where owner_id = p_from and purpose = 'documents';
  end if;

  -- names that would collide with the successor's folder in the same place
  for v_folder in
    select f.id, f.name, f.parent_id
    from public.folders f
    where f.owner_id = p_from and f.deleted_at is null
      and exists (
        select 1 from public.folders g
        where g.owner_id = p_to and g.deleted_at is null
          and coalesce(g.parent_id, c_zero) = coalesce(f.parent_id, c_zero)
          and lower(g.name) = lower(f.name)
      )
    order by f.created_at, f.id
  loop
    v_i := 1;
    loop
      v_name := v_folder.name || ' (from ' || v_leaver || ')'
        || case when v_i = 1 then '' else ' ' || v_i end;
      exit when not exists (
        select 1 from public.folders g
        where g.owner_id in (p_from, p_to) and g.deleted_at is null and g.id <> v_folder.id
          and coalesce(g.parent_id, c_zero) = coalesce(v_folder.parent_id, c_zero)
          and lower(g.name) = lower(v_name)
      );
      v_i := v_i + 1;
    end loop;
    update public.folders set name = v_name where id = v_folder.id;
    v_renamed := v_renamed + 1;
  end loop;

  update public.folders set owner_id = p_to where owner_id = p_from;
  get diagnostics v_folders = row_count;
  update public.files set owner_id = p_to where owner_id = p_from;
  get diagnostics v_files = row_count;

  -- ---------------------------------------------------------------- shares
  -- the successor owns these now; the leaver needs nothing any more
  delete from public.chat_file_grants g
  where g.grantee_id = p_from
     or (g.grantee_id = p_to and exists (
       select 1 from public.files f where f.id = g.file_id and f.owner_id = p_to));
  delete from public.file_shares s
  where s.grantee_id = p_from
     or (s.grantee_id = p_to and exists (
       select 1 from public.files f where f.id = s.file_id and f.owner_id = p_to));
  get diagnostics v_n = row_count;
  v_shares := v_n;
  delete from public.folder_shares s
  where s.grantee_id = p_from
     or (s.grantee_id = p_to and exists (
       select 1 from public.folders f where f.id = s.folder_id and f.owner_id = p_to));
  get diagnostics v_n = row_count;
  v_shares := v_shares + v_n;

  -- ---------------------------------------------------------------- chat groups
  -- mirrors transfer_chat_ownership (027); the system message reads
  -- "<leaver> made <new owner> the group owner"
  for v_row in
    select m.conversation_id
    from public.chat_members m
    join public.chat_conversations c on c.id = m.conversation_id and c.kind = 'group'
    where m.user_id = p_from and m.role = 'owner'
  loop
    select o.user_id into v_new_owner
    from public.chat_members o
    where o.conversation_id = v_row.conversation_id and o.user_id <> p_from
    order by (o.user_id = p_to) desc, (o.role = 'admin') desc, o.joined_at, o.user_id
    limit 1;
    continue when v_new_owner is null;

    update public.chat_members set role = 'member'
    where conversation_id = v_row.conversation_id and user_id = p_from;
    update public.chat_members set role = 'owner'
    where conversation_id = v_row.conversation_id and user_id = v_new_owner;
    insert into public.chat_messages (conversation_id, sender_id, kind, meta)
    values (v_row.conversation_id, p_from, 'system',
            jsonb_build_object('type', 'owner', 'user_id', v_new_owner));
    update public.chat_conversations set last_message_at = clock_timestamp()
    where id = v_row.conversation_id;
    v_groups := v_groups + 1;
  end loop;

  -- ---------------------------------------------------------------- documents
  for v_row in
    update public.document_assignments a
    set assignee_user_id = p_to, status = 'pending', seen_at = null
    from public.documents d
    where d.id = a.document_id and d.org_id = p_org_id
      and a.assignee_user_id = p_from
      and a.status in ('pending', 'seen', 'in_progress')
    returning a.id, a.document_id, a.role
  loop
    perform public.doc_log(v_row.document_id, 'reassigned', null, null, jsonb_build_object(
      'assignment_id', v_row.id, 'role', v_row.role, 'from', p_from, 'to', p_to, 'reason', 'offboarding'));
    v_assignments := v_assignments + 1;
  end loop;

  for v_row in
    select s.id, s.document_id, s.revision, s.step_no
    from public.document_approval_steps s
    join public.documents d on d.id = s.document_id
    where d.org_id = p_org_id and s.approver_user_id = p_from
      and s.status in ('waiting', 'pending')
    order by s.document_id, s.revision, s.step_no
  loop
    if exists (
      select 1 from public.document_approval_steps t
      where t.document_id = v_row.document_id and t.revision = v_row.revision
        and t.step_no = v_row.step_no and t.approver_user_id = p_to
    ) then
      -- unique (document_id, revision, step_no, approver_user_id): the
      -- successor already approves at this step
      update public.document_approval_steps
      set status = 'skipped', acted_at = now(), acted_by = auth.uid(),
          comment = coalesce(comment, 'Skipped on offboarding: the successor already has this step')
      where id = v_row.id;
      v_skipped := v_skipped + 1;
    else
      update public.document_approval_steps set approver_user_id = p_to where id = v_row.id;
      v_steps := v_steps + 1;
    end if;
    perform public.doc_log(v_row.document_id, 'reassigned', null, null, jsonb_build_object(
      'approval_step_id', v_row.id, 'step_no', v_row.step_no, 'from', p_from, 'to', p_to,
      'reason', 'offboarding'));
  end loop;

  update public.documents
  set presented_to = p_to
  where org_id = p_org_id and presented_to = p_from
    and status not in ('completed', 'cancelled', 'archived', 'issued', 'rejected', 'withdrawn', 'recalled');
  get diagnostics v_presented = row_count;

  update public.documents
  set created_by = p_to
  where org_id = p_org_id and created_by = p_from and status = 'draft';
  get diagnostics v_drafts = row_count;

  update public.departments set head_user_id = p_to
  where org_id = p_org_id and head_user_id = p_from;
  get diagnostics v_departments = row_count;

  insert into public.doc_register_roles (register_id, user_id, role)
  select rr.register_id, p_to, rr.role
  from public.doc_register_roles rr
  join public.doc_registers r on r.id = rr.register_id
  where r.org_id = p_org_id and rr.user_id = p_from
  -- a follower who takes over a manager keeps the register managed
  on conflict (register_id, user_id) do update set role = 'manager'
    where excluded.role = 'manager';
  delete from public.doc_register_roles rr
  using public.doc_registers r
  where r.id = rr.register_id and r.org_id = p_org_id and rr.user_id = p_from;
  get diagnostics v_register_roles = row_count;

  -- dossiers come from 202608280043 (same batch); skip until it is applied
  if to_regclass('public.dossiers') is not null then
    execute 'update public.dossiers set owner_id = $1 where org_id = $2 and owner_id = $3'
      using p_to, p_org_id, p_from;
    get diagnostics v_dossiers = row_count;
  end if;

  v_counts := jsonb_build_object(
    'files', v_files,
    'folders', v_folders,
    'renamed_folders', v_renamed,
    'shares_removed', v_shares,
    'chat_groups', v_groups,
    'assignments', v_assignments,
    'approval_steps', v_steps,
    'skipped_steps', v_skipped,
    'presented_documents', v_presented,
    'draft_documents', v_drafts,
    'departments', v_departments,
    'register_roles', v_register_roles,
    'dossiers', v_dossiers
  );

  perform public.create_notification(
    p_to, 'org.handover', 'You received work from ' || v_leaver,
    format('%s files, %s folders and %s document tasks were handed over to you.',
      v_files, v_folders, v_assignments + v_steps),
    '/documents', 'org', p_org_id, p_org_id
  );
  return v_counts;
end;
$$;

-- =============================================
-- 3. Offboard (client RPC)
-- =============================================
create or replace function public.offboard_member(p_user_id uuid, p_successor uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_counts jsonb;
  v_push int := 0;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if p_user_id is null then
    raise exception 'Pick the person who is leaving' using errcode = '22023';
  end if;
  v_org_id := public.offboarding_org_of(p_user_id);
  if v_org_id is null or not public.is_org_admin(v_org_id) then
    raise exception 'Only company admins can offboard members' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'You cannot offboard yourself' using errcode = '22023';
  end if;
  if p_successor is null then
    raise exception 'Pick a successor' using errcode = '22023';
  end if;
  if p_successor = p_user_id then
    raise exception 'The successor must be a different person' using errcode = '22023';
  end if;

  -- one admin change at a time per company (as set_member_status)
  perform 1 from public.organizations where id = v_org_id for update;

  v_counts := public.transfer_user_data(v_org_id, p_user_id, p_successor);

  update public.org_members
  set status = 'left', left_at = coalesce(left_at, now())
  where org_id = v_org_id and user_id = p_user_id;
  -- a department may still name them when the transfer found none (defensive)
  update public.departments set head_user_id = null
  where org_id = v_org_id and head_user_id = p_user_id;

  delete from public.push_subscriptions where user_id = p_user_id;
  get diagnostics v_push = row_count;

  perform public.org_require_an_admin(v_org_id);
  return v_counts || jsonb_build_object('push_subscriptions', v_push);
end;
$$;

-- =============================================
-- 4. Sessions (internal; the route calls it with the service role)
-- =============================================
create or replace function public.revoke_user_sessions(p_user_id uuid)
returns integer
language plpgsql security definer
set search_path = public
as $$
declare
  v_n int;
begin
  if p_user_id is null or to_regclass('auth.sessions') is null then
    return null;
  end if;
  begin
    execute 'delete from auth.sessions where user_id = $1' using p_user_id;
    get diagnostics v_n = row_count;
    return v_n;
  exception when others then
    -- not allowed or a different auth schema: the caller reports "not revoked"
    return null;
  end;
end;
$$;

-- =============================================
-- Privileges: nothing for public/anon; the two client RPCs for
-- authenticated; the rest service_role only.
-- =============================================
revoke all on function public.offboarding_org_of(uuid) from public, anon, authenticated;
revoke all on function public.transfer_user_data(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.revoke_user_sessions(uuid) from public, anon, authenticated;
grant execute on function public.offboarding_org_of(uuid) to service_role;
grant execute on function public.transfer_user_data(uuid, uuid, uuid) to service_role;
grant execute on function public.revoke_user_sessions(uuid) to service_role;

revoke all on function public.offboarding_preview(uuid) from public, anon;
revoke all on function public.offboard_member(uuid, uuid) from public, anon;
grant execute on function public.offboarding_preview(uuid) to authenticated;
grant execute on function public.offboard_member(uuid, uuid) to authenticated;
