-- Workflow admins and timeline confirmation (chốt timeline).
-- Run after 202608280049_workflow_reminders.sql. Idempotent.
--
-- * workflow_members.role is now 'owner' | 'admin' | 'member' (the old 'editor' becomes 'member').
--   Only the owner and admins change the plan document (steps, roles, arrows, start, hours…).
--   The owner makes members admins and back (set_workflow_admin) and admins see who has opened
--   the plan (list_workflow_members). Cancelling an extension is for admins too.
-- * A step's timeline is confirmed once someone with the link (signed in or not) presses
--   "Xác nhận", possibly with a new length: the step gets "confirmed": {at, by, role} in the
--   document and a 'confirm' row in the step log. A confirmed step's length can then only be
--   extended (gia hạn), except by admins in the editor. workflow_public_change gains 'confirm' and
--   refuses 'duration' on a confirmed step (SQLSTATE PT409).
-- * workflow_reminders gains 'confirm' (a daily e-mail per role listing its unconfirmed steps),
--   keyed by role name; automatic ones stay once per day.
-- Rollback: re-run the policies and functions of 202608280047_workflows.sql and the index of
--   202608280049_workflow_reminders.sql; drop function public.is_workflow_admin(uuid),
--   public.set_workflow_admin(uuid, uuid, boolean), public.list_workflow_members(uuid).

-- =============================================
-- Admins
-- =============================================
alter table public.workflow_members drop constraint if exists workflow_members_role_check;
update public.workflow_members set role = 'member' where role = 'editor';
alter table public.workflow_members add constraint workflow_members_role_check check (role in ('owner', 'admin', 'member'));

create or replace function public.is_workflow_admin(p_workflow uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select auth.uid() is not null
     and exists (
       select 1 from public.workflow_members
       where workflow_id = p_workflow and user_id = auth.uid() and role in ('owner', 'admin')
     );
$$;

-- Opening the link makes a signed-in visitor a member (they may extend and confirm, not edit).
create or replace function public.join_workflow(p_workflow uuid)
returns text
language plpgsql security definer
set search_path = public
as $$
declare
  v_role text;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if not exists (select 1 from public.workflows where id = p_workflow) then
    return null;
  end if;
  insert into public.workflow_members (workflow_id, user_id, role)
  values (p_workflow, auth.uid(), 'member')
  on conflict (workflow_id, user_id) do update set last_opened_at = now()
  returning role into v_role;
  return v_role;
end;
$$;

-- The owner makes a member an admin (p_admin) or a member again.
create or replace function public.set_workflow_admin(p_workflow uuid, p_user uuid, p_admin boolean)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.workflow_members
    where workflow_id = p_workflow and user_id = auth.uid() and role = 'owner'
  ) then
    raise exception 'Only the owner can change admins' using errcode = '42501';
  end if;
  update public.workflow_members
  set role = case when p_admin then 'admin' else 'member' end
  where workflow_id = p_workflow and user_id = p_user and role <> 'owner';
  if not found then
    raise exception 'Member not found' using errcode = 'PT404';
  end if;
end;
$$;

-- Who has opened the plan, for its admins.
create or replace function public.list_workflow_members(p_workflow uuid)
returns table (user_id uuid, name text, email text, role text, last_opened_at timestamptz)
language sql stable security definer
set search_path = public
as $$
  select m.user_id, nullif(btrim(p.display_name), ''), coalesce(p.email, u.email), m.role, m.last_opened_at
  from public.workflow_members m
  left join public.user_profiles p on p.id = m.user_id
  left join auth.users u on u.id = m.user_id
  where m.workflow_id = p_workflow and public.is_workflow_admin(p_workflow)
  order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, m.last_opened_at desc;
$$;

drop policy if exists "workflows_update" on public.workflows;
create policy "workflows_update" on public.workflows for update to authenticated
  using (public.is_workflow_admin(id)) with check (public.is_workflow_admin(id));

create or replace function public.cancel_workflow_extension(p_log uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_workflow uuid;
begin
  select workflow_id into v_workflow from public.workflow_step_logs where id = p_log and kind = 'extend';
  if v_workflow is null or not public.is_workflow_admin(v_workflow) then
    raise exception 'Extension not found' using errcode = 'PT404';
  end if;
  update public.workflow_step_logs
  set cancelled_at = now(), cancelled_by = auth.uid()
  where id = p_log and cancelled_at is null;
end;
$$;

-- =============================================
-- Confirming a step's timeline
-- =============================================
alter table public.workflow_step_logs drop constraint if exists workflow_step_logs_kind_check;
alter table public.workflow_step_logs add constraint workflow_step_logs_kind_check check (kind in ('extend', 'duration', 'confirm'));

-- Extends a step, changes the length of an unconfirmed step, or confirms its timeline (with a new
-- length or the current one), and logs it. p_user is the signed-in caller the server verified,
-- or null. Returns the plan's revision.
create or replace function public.workflow_public_change(
  p_workflow uuid, p_step text, p_kind text, p_amount integer, p_unit text,
  p_reason text, p_name text, p_role text, p_user uuid)
returns integer
language plpgsql security definer
set search_path = public
as $$
declare
  v_doc jsonb;
  v_revision integer;
  v_step jsonb;
  v_old record;
  v_changed boolean;
  v_new jsonb;
  v_name text := case when p_user is null then btrim(p_name) else public.workflow_person_name(p_user) end;
begin
  select doc, revision into v_doc, v_revision from public.workflows where id = p_workflow for update;
  if v_doc is null then
    raise exception 'Workflow not found' using errcode = 'PT404';
  end if;
  select s.value into v_step
  from jsonb_array_elements(coalesce(v_doc -> 'steps', '[]'::jsonb)) s
  where s.value ->> 'id' = p_step;
  if v_step is null then
    raise exception 'Step not found' using errcode = 'PT404';
  end if;
  if p_user is null and (
    (select count(*) from public.workflow_step_logs
     where workflow_id = p_workflow and created_by is null and created_at > now() - interval '10 minutes') >= 30
    or (select count(*) from public.workflow_step_logs where workflow_id = p_workflow and created_by is null) >= 1000
  ) then
    raise exception 'Too many requests, try again later' using errcode = 'PT429';
  end if;

  if p_kind = 'extend' then
    insert into public.workflow_step_logs
      (workflow_id, step_id, kind, amount, unit, reason, requester_name, requester_role, created_by)
    values (p_workflow, p_step, 'extend', p_amount, p_unit, nullif(btrim(p_reason), ''), v_name, btrim(p_role), p_user);
    return v_revision;
  elsif p_kind not in ('duration', 'confirm') then
    raise exception 'Unknown change' using errcode = '22023';
  end if;

  if jsonb_typeof(v_step -> 'confirmed') = 'object' then
    raise exception 'The timeline of this step is confirmed; it can only be extended' using errcode = 'PT409';
  end if;
  select * into v_old from public.workflow_step_duration(v_step);
  if v_old.amount is null then
    raise exception 'The step has no valid duration' using errcode = '22023';
  end if;
  v_changed := not (v_old.amount = p_amount and v_old.unit = p_unit);
  if p_kind = 'duration' and not v_changed then
    return v_revision;
  end if;

  v_new := jsonb_set(v_step, '{duration}', jsonb_build_object('amount', p_amount, 'unit', p_unit));
  if p_kind = 'confirm' then
    v_new := jsonb_set(v_new, '{confirmed}', jsonb_build_object(
      'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'by', v_name,
      'role', btrim(p_role)));
  end if;
  perform set_config('app.workflow_logged', 'on', true);
  update public.workflows
  set doc = jsonb_set(doc, '{steps}', (
    select jsonb_agg(case when s.value ->> 'id' = p_step then v_new else s.value end order by s.ordinality)
    from jsonb_array_elements(doc -> 'steps') with ordinality s))
  where id = p_workflow
  returning revision into v_revision;
  perform set_config('app.workflow_logged', '', true);

  if v_changed then
    insert into public.workflow_step_logs
      (workflow_id, step_id, kind, amount, unit, old_amount, old_unit, reason, requester_name, requester_role, created_by)
    values (p_workflow, p_step, 'duration', p_amount, p_unit, v_old.amount, v_old.unit,
            nullif(btrim(coalesce(p_reason, '')), ''), v_name, btrim(p_role), p_user);
  end if;
  if p_kind = 'confirm' then
    insert into public.workflow_step_logs
      (workflow_id, step_id, kind, amount, unit, reason, requester_name, requester_role, created_by)
    values (p_workflow, p_step, 'confirm', p_amount, p_unit, nullif(btrim(coalesce(p_reason, '')), ''), v_name, btrim(p_role), p_user);
  end if;
  return v_revision;
end;
$$;

-- =============================================
-- Confirmation reminders, one per role
-- =============================================
alter table public.workflow_reminders add column if not exists role_name text check (role_name is null or char_length(role_name) between 1 and 60);
alter table public.workflow_reminders drop constraint if exists workflow_reminders_kind_check;
alter table public.workflow_reminders add constraint workflow_reminders_kind_check check (kind in ('upcoming', 'due', 'overdue', 'progress', 'confirm'));
drop index if exists public.workflow_reminders_once;
create unique index if not exists workflow_reminders_once_v2
  on public.workflow_reminders (workflow_id, step_id, kind, day, coalesce(lower(role_name), '')) where not manual;

-- =============================================
-- Grants
-- =============================================
revoke all on function public.is_workflow_admin(uuid) from public, anon;
revoke all on function public.set_workflow_admin(uuid, uuid, boolean) from public, anon;
revoke all on function public.list_workflow_members(uuid) from public, anon;
revoke all on function public.join_workflow(uuid) from public, anon;
revoke all on function public.cancel_workflow_extension(uuid) from public, anon;
revoke all on function public.workflow_public_change(uuid, text, text, integer, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.is_workflow_admin(uuid) to authenticated;
grant execute on function public.set_workflow_admin(uuid, uuid, boolean) to authenticated;
grant execute on function public.list_workflow_members(uuid) to authenticated;
grant execute on function public.join_workflow(uuid) to authenticated;
grant execute on function public.cancel_workflow_extension(uuid) to authenticated;
grant execute on function public.workflow_public_change(uuid, text, text, integer, text, text, text, text, uuid) to service_role;
