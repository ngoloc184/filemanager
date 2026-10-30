-- Ownership safety: block move-based privilege escalation and make the
-- account foreign keys safe for offboarding.
-- Run after 202608280030. Idempotent (safe to run again).
--
-- 1. folder_chain_owners(): internal helper, the distinct owners of a folder
--    and all its ancestors. Not callable by clients.
-- 2. move_file / move_folder: a non-owner (editor/admin through a share or as
--    an owner of a parent folder) may only move an item into a folder whose
--    owner chain is already allowed to manage it: the item owner or an owner
--    of its current folder chain. Before, an editor could move someone else's
--    file into a folder they own and become admin of it (audit escalate.sql).
--    Non-owners can no longer move items to My Files (root). The owner moving
--    their own item is unchanged.
-- 3. Foreign keys to auth.users whose delete rule changed (offboarding keeps
--    company data: an account that still owns files or folders cannot be
--    deleted, its audit traces are kept with the user id cleared):
--      public.folders.owner_id             cascade   -> restrict
--      public.files.owner_id               cascade   -> restrict
--      public.folders.deleted_by           no action -> set null
--      public.files.deleted_by             no action -> set null
--      public.file_versions.uploaded_by    no action -> set null (drop not null)
--      public.file_shares.granted_by       no action -> set null (drop not null)
--      public.folder_shares.granted_by     no action -> set null (drop not null)
--      public.share_links.created_by       cascade   -> set null (drop not null)
--      public.item_comments.author_id      cascade   -> set null (drop not null)
--      public.activity_events.actor_id     cascade   -> set null (drop not null)
--      public.activity_events.owner_id     cascade   -> set null
--    Left as cascade on purpose (rows that only make sense for that user):
--    user_profiles.id, user_connections.*, tags.owner_id (personal labels),
--    file_shares/folder_shares.grantee_id, share_link_access.user_id,
--    saved_links, assistant_*, agent_lesson_votes, push_subscriptions,
--    user_preferences, chat tables and the legacy upload_batches.
-- 3b. file_versions_storage_path_guard (021) fires on "update of uploaded_by",
--    so the SET NULL action above runs it. It now lets exactly that update
--    through, and it rejects a NULL uploaded_by from signed-in requests
--    (before, NOT NULL made that impossible and the path check relied on it).
-- 4. Nullable comparisons: update_item_comment / delete_item_comment compared
--    author_id with "<>" / "=" inside "not (...)", which is NULL (not false)
--    for a comment whose author was removed, so any viewer could edit or
--    delete it. They now use "is distinct from" / coalesce. Every other
--    "uploaded_by / granted_by / created_by / actor_id = auth.uid()" test is a
--    positive match and simply denies on NULL.

-- =============================================
-- 1. Owners of a folder chain (internal)
-- =============================================
create or replace function public.folder_chain_owners(p_folder_id uuid)
returns setof uuid
language sql stable security definer
set search_path = public
as $$
  -- "union" (not "union all") also stops on a damaged parent cycle
  with recursive chain as (
    select f.id, f.parent_id, f.owner_id from public.folders f where f.id = p_folder_id
    union
    select p.id, p.parent_id, p.owner_id
    from public.folders p
    join chain c on c.parent_id = p.id
  )
  select distinct chain.owner_id from chain;
$$;

revoke all on function public.folder_chain_owners(uuid) from public, anon, authenticated;
grant execute on function public.folder_chain_owners(uuid) to service_role;

-- =============================================
-- 2. Moves never hand an item to a new owner chain
-- =============================================
create or replace function public.move_folder(p_id uuid, p_new_parent_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_parent uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.has_folder_access(p_id, 'editor') then
    raise exception 'You do not have permission to move this folder';
  end if;
  if p_new_parent_id is not null and not public.has_folder_access(p_new_parent_id, 'editor') then
    raise exception 'You do not have permission to move folders there';
  end if;
  if p_new_parent_id = p_id then
    raise exception 'Cannot move a folder into itself';
  end if;
  if p_new_parent_id is not null and exists (
    with recursive ancestors as (
      select id, parent_id from public.folders where id = p_new_parent_id
      union all
      select f.id, f.parent_id
      from public.folders f
      join ancestors a on f.id = a.parent_id
    )
    select 1 from ancestors where id = p_id
  ) then
    raise exception 'Cannot move a folder into its own subfolder';
  end if;

  -- a non-owner may only move the folder under owners who can already manage it
  select owner_id, parent_id into v_owner, v_parent from public.folders where id = p_id;
  if auth.uid() is distinct from v_owner then
    if p_new_parent_id is null then
      raise exception 'Only the owner can move this item to My Files';
    end if;
    if exists (
      select 1 from public.folder_chain_owners(p_new_parent_id) as dest(owner_id)
      where dest.owner_id is distinct from v_owner
        and (v_parent is null or not exists (
          select 1 from public.folder_chain_owners(v_parent) as cur(owner_id)
          where cur.owner_id = dest.owner_id))
    ) then
      raise exception 'You cannot move this item into a folder owned by someone else'
        using errcode = '42501';
    end if;
  end if;

  update public.folders set parent_id = p_new_parent_id where id = p_id;
exception
  when unique_violation then
    raise exception 'A folder with this name already exists there';
end;
$$;

create or replace function public.move_file(p_id uuid, p_folder_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_folder uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.has_file_access(p_id, 'editor') then
    raise exception 'You do not have permission to move this file';
  end if;
  if p_folder_id is not null then
    if not public.has_folder_access(p_folder_id, 'editor') then
      raise exception 'You do not have permission to move files there';
    end if;
    if exists (
      select 1 from public.folders where id = p_folder_id and deleted_at is not null
    ) then
      raise exception 'Cannot move into a deleted folder';
    end if;
  end if;

  -- a non-owner may only move the file under owners who can already manage it
  select owner_id, folder_id into v_owner, v_folder from public.files where id = p_id;
  if auth.uid() is distinct from v_owner then
    if p_folder_id is null then
      raise exception 'Only the owner can move this item to My Files';
    end if;
    if exists (
      select 1 from public.folder_chain_owners(p_folder_id) as dest(owner_id)
      where dest.owner_id is distinct from v_owner
        and (v_folder is null or not exists (
          select 1 from public.folder_chain_owners(v_folder) as cur(owner_id)
          where cur.owner_id = dest.owner_id))
    ) then
      raise exception 'You cannot move this item into a folder owned by someone else'
        using errcode = '42501';
    end if;
  end if;

  update public.files set folder_id = p_folder_id where id = p_id;
end;
$$;

revoke all on function public.move_folder(uuid, uuid) from public, anon;
revoke all on function public.move_file(uuid, uuid) from public, anon;
grant execute on function public.move_folder(uuid, uuid) to authenticated;
grant execute on function public.move_file(uuid, uuid) to authenticated;

-- =============================================
-- 3. Foreign keys to auth.users
-- =============================================
do $$
declare
  r record;
  c record;
begin
  for r in
    select * from (values
      ('folders',         'owner_id',    'restrict', false),
      ('files',           'owner_id',    'restrict', false),
      ('folders',         'deleted_by',  'set null', false),
      ('files',           'deleted_by',  'set null', false),
      ('file_versions',   'uploaded_by', 'set null', true),
      ('file_shares',     'granted_by',  'set null', true),
      ('folder_shares',   'granted_by',  'set null', true),
      ('share_links',     'created_by',  'set null', true),
      ('item_comments',   'author_id',   'set null', true),
      ('activity_events', 'actor_id',    'set null', true),
      ('activity_events', 'owner_id',    'set null', false)
    ) as v(tbl, col, on_delete, drop_not_null)
  loop
    if to_regclass(format('public.%I', r.tbl)) is null then
      continue;
    end if;

    if r.drop_not_null then
      execute format('alter table public.%I alter column %I drop not null', r.tbl, r.col);
    end if;

    -- whatever the constraint is called, drop every single-column FK from
    -- this column to auth.users, then add it back with the new rule
    for c in
      select con.conname
      from pg_constraint con
      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
      where con.contype = 'f'
        and con.conrelid = format('public.%I', r.tbl)::regclass
        and con.confrelid = 'auth.users'::regclass
        and array_length(con.conkey, 1) = 1
        and a.attname = r.col
    loop
      execute format('alter table public.%I drop constraint %I', r.tbl, c.conname);
    end loop;

    execute format(
      'alter table public.%I add constraint %I foreign key (%I) references auth.users(id) on delete %s',
      r.tbl, r.tbl || '_' || r.col || '_fkey', r.col, r.on_delete);
  end loop;
end;
$$;

-- =============================================
-- 3b. Storage path guard lets the SET NULL action through
-- =============================================
create or replace function public.file_versions_storage_path_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- the uploader's account was removed (ON DELETE SET NULL): nothing else changes
  if tg_op = 'UPDATE'
     and new.uploaded_by is null and old.uploaded_by is not null
     and new.storage_path = old.storage_path
     and new.file_id = old.file_id then
    return new;
  end if;

  -- Applies to requests from signed-in users (PostgREST runs them as role
  -- "authenticated", which stays set inside security-definer RPCs). Migrations,
  -- the SQL editor and the service role keep full control.
  if coalesce(current_setting('role', true), 'none') in ('authenticated', 'anon')
     and (new.storage_path is null
          -- uploaded_by became nullable; without this the check below is NULL
          or new.uploaded_by is null
          or left(new.storage_path, 74) <> new.uploaded_by::text || '/' || new.file_id::text || '/'
          -- ".." as a whole path segment; dots inside names are fine
          or new.storage_path ~ '(^|/)\.\.(/|$)') then
    raise exception 'Invalid storage path for this file';
  end if;
  return new;
end;
$$;

-- trigger function only: triggers fire without EXECUTE, clients never call it
revoke all on function public.file_versions_storage_path_guard() from public, anon, authenticated;

-- =============================================
-- 4. Comments whose author account was removed
-- =============================================
create or replace function public.update_item_comment(p_id uuid, p_body text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_body text := public.clean_comment_body(p_body);
  c public.item_comments%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  select * into c from public.item_comments where item_comments.id = p_id;
  if not found or c.author_id is distinct from auth.uid() then
    raise exception 'You can only edit your own comments';
  end if;
  -- the author may have lost access to the item since writing the comment
  perform public.comment_target_check(c.file_id, c.folder_id, 'viewer');

  update public.item_comments set body = v_body where item_comments.id = p_id;
end;
$$;

create or replace function public.delete_item_comment(p_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  c public.item_comments%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  select * into c from public.item_comments where item_comments.id = p_id;
  if not found then
    raise exception 'Comment not found';
  end if;
  if not coalesce(
    (c.author_id = auth.uid()
      and ((c.file_id is not null and public.has_file_access(c.file_id, 'viewer'))
        or (c.folder_id is not null and public.has_folder_access(c.folder_id, 'viewer'))))
    or (c.file_id is not null and public.has_file_access(c.file_id, 'admin'))
    or (c.folder_id is not null and public.has_folder_access(c.folder_id, 'admin')),
    false
  ) then
    raise exception 'You do not have permission to delete this comment';
  end if;

  delete from public.item_comments where item_comments.id = p_id;
end;
$$;

revoke all on function public.update_item_comment(uuid, text) from public, anon;
revoke all on function public.delete_item_comment(uuid) from public, anon;
grant execute on function public.update_item_comment(uuid, text) to authenticated;
grant execute on function public.delete_item_comment(uuid) to authenticated;
