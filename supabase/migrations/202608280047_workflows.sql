-- Workflow builder (/workflow): plans drawn as connected steps with PIC roles and durations.
-- Run after 202608280046_qa_fixes.sql. Idempotent.
--
-- * workflows: one plan; the drawing (steps, arrows, roles, start, working hours) is the JSON
--   document `doc`, validated by the app (src/lib/workflow/model.ts). `revision` goes up by one on
--   every save, so a save sent with an old revision changes nothing (the app merges and retries).
-- * workflow_members: who may edit everything. The creator is the owner; any signed-in user who
--   opens the link becomes an editor (join_workflow). Nobody can list plans they have not opened.
-- * workflow_step_logs: the history of each step's duration:
--     'extend'   — a deadline extension (gia hạn) of amount/unit, with a required reason;
--     'duration' — the step's length changed from old_amount/old_unit to amount/unit.
--   Each row has the name and role the person typed. Anyone with the link may extend a step or
--   change its length, signed in or not: those go through the server (service role,
--   /api/workflows/[id]/changes → workflow_public_change). A signed-in editor changing a length in
--   the editor is logged by a trigger on workflows. A signed-in person is always logged under their
--   profile name ("Thành viên" without one), never a typed name and never their e-mail. Members
--   can cancel an extension, which keeps it in the history. Requests without an account are
--   limited to 30 per plan per 10 minutes and 1000 per plan in all.
-- * Every save must keep each step's duration in the form {"amount": 1..999, "unit": "h"|"d"}
--   (so every change of length is logged) and at most 200 steps.
-- * Public viewing goes through the server too (service role); anon has no grant here.
-- Rollback:
--   drop table if exists public.workflow_step_logs, public.workflow_members, public.workflows cascade;
--   drop function if exists public.is_workflow_member(uuid), public.join_workflow(uuid),
--     public.cancel_workflow_extension(uuid), public.workflows_before_write(),
--     public.workflows_after_insert(), public.workflows_log_durations(), public.workflow_step_duration(jsonb),
--     public.workflow_person_name(uuid),
--     public.workflow_public_change(uuid, text, text, integer, text, text, text, text, uuid);

create table if not exists public.workflows (
  id uuid primary key default gen_random_uuid(),
  -- kept when the creator's account is removed, so the team keeps the plan
  owner_id uuid references auth.users(id) on delete set null,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  doc jsonb not null check (jsonb_typeof(doc) = 'object' and octet_length(doc::text) <= 524288),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

create table if not exists public.workflow_members (
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'editor')),
  last_opened_at timestamptz not null default now(),
  primary key (workflow_id, user_id)
);
create index if not exists workflow_members_user_idx on public.workflow_members (user_id, last_opened_at desc);

create table if not exists public.workflow_step_logs (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  step_id text not null check (step_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  kind text not null check (kind in ('extend', 'duration')),
  amount integer not null check (amount between 1 and 999),
  unit text not null check (unit in ('h', 'd')),
  old_amount integer check (old_amount between 1 and 999),
  old_unit text check (old_unit in ('h', 'd')),
  reason text check (reason is null or char_length(reason) between 1 and 1000),
  requester_name text not null check (char_length(btrim(requester_name)) between 1 and 80),
  requester_role text not null check (char_length(btrim(requester_role)) between 1 and 80),
  -- set when the person was signed in
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete set null,
  check (kind <> 'extend' or char_length(btrim(coalesce(reason, ''))) >= 3),
  check (kind <> 'duration' or (old_amount is not null and old_unit is not null and cancelled_at is null))
);
create index if not exists workflow_step_logs_workflow_idx on public.workflow_step_logs (workflow_id, created_at);

alter table public.workflows enable row level security;
alter table public.workflow_members enable row level security;
alter table public.workflow_step_logs enable row level security;

-- =============================================
-- Helpers and triggers
-- =============================================
create or replace function public.is_workflow_member(p_workflow uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select auth.uid() is not null
     and exists (select 1 from public.workflow_members where workflow_id = p_workflow and user_id = auth.uid());
$$;

-- A step's duration in the document: {"amount": 1..999, "unit": "h" | "d"}; null when malformed.
create or replace function public.workflow_step_duration(p_step jsonb)
returns table (amount integer, unit text)
language sql immutable
set search_path = public
as $$
  select (p_step -> 'duration' ->> 'amount')::integer, p_step -> 'duration' ->> 'unit'
  where coalesce(p_step -> 'duration' ->> 'amount', '') ~ '^[0-9]{1,3}$'
    and (p_step -> 'duration' ->> 'amount')::integer between 1 and 999
    and p_step -> 'duration' ->> 'unit' in ('h', 'd');
$$;

-- The name logged for a signed-in person: their profile name, never their e-mail.
create or replace function public.workflow_person_name(p_user uuid)
returns text
language sql stable security definer
set search_path = public
as $$
  select left(coalesce((select nullif(btrim(display_name), '') from public.user_profiles where id = p_user), 'Thành viên'), 80);
$$;

-- owner, revision and timestamps are the database's business, whatever the app sends
create or replace function public.workflows_before_write()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if jsonb_typeof(new.doc -> 'steps') is distinct from 'array' or jsonb_array_length(new.doc -> 'steps') > 200 then
    raise exception 'A plan has a list of at most 200 steps' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(new.doc -> 'steps') s
    where not exists (select 1 from public.workflow_step_duration(s.value))
  ) then
    raise exception 'Every step needs a duration of 1-999 hours or days' using errcode = '22023';
  end if;
  if tg_op = 'INSERT' then
    new.owner_id := coalesce(auth.uid(), new.owner_id);
    new.revision := 1;
    new.created_at := now();
  else
    new.id := old.id;
    new.owner_id := old.owner_id;
    new.created_at := old.created_at;
    new.revision := old.revision + 1;
  end if;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists workflows_before_write on public.workflows;
create trigger workflows_before_write
  before insert or update on public.workflows
  for each row execute function public.workflows_before_write();

create or replace function public.workflows_after_insert()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if new.owner_id is not null then
    insert into public.workflow_members (workflow_id, user_id, role)
    values (new.id, new.owner_id, 'owner')
    on conflict (workflow_id, user_id) do update set role = 'owner';
  end if;
  return new;
end;
$$;

drop trigger if exists workflows_after_insert on public.workflows;
create trigger workflows_after_insert
  after insert on public.workflows
  for each row execute function public.workflows_after_insert();

-- An editor's save that changes step lengths logs each change, named after their profile.
-- workflow_public_change logs its own change and sets app.workflow_logged to skip this.
create or replace function public.workflows_log_durations()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if coalesce(current_setting('app.workflow_logged', true), '') = 'on' then
    return new;
  end if;
  insert into public.workflow_step_logs
    (workflow_id, step_id, kind, amount, unit, old_amount, old_unit, requester_name, requester_role, created_by)
  select new.id, n.value ->> 'id', 'duration', nd.amount, nd.unit, od.amount, od.unit,
         public.workflow_person_name(auth.uid()), 'Người chỉnh sửa', auth.uid()
  from jsonb_array_elements(coalesce(new.doc -> 'steps', '[]'::jsonb)) n
  join jsonb_array_elements(coalesce(old.doc -> 'steps', '[]'::jsonb)) o on o.value ->> 'id' = n.value ->> 'id'
  cross join lateral public.workflow_step_duration(n.value) nd
  cross join lateral public.workflow_step_duration(o.value) od
  where (n.value ->> 'id') ~ '^[A-Za-z0-9_-]{1,64}$'
    and (nd.amount, nd.unit) is distinct from (od.amount, od.unit);
  return new;
end;
$$;

drop trigger if exists workflows_log_durations on public.workflows;
create trigger workflows_log_durations
  after update of doc on public.workflows
  for each row execute function public.workflows_log_durations();

-- =============================================
-- Changes from the public page (server only)
-- =============================================
-- Extends a step or sets its length, and logs it. p_user is the signed-in caller the server
-- verified, or null. Returns the new revision of the plan.
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
  elsif p_kind <> 'duration' then
    raise exception 'Unknown change' using errcode = '22023';
  end if;

  select * into v_old from public.workflow_step_duration(v_step);
  if v_old.amount is null then
    raise exception 'The step has no valid duration' using errcode = '22023';
  end if;
  if v_old.amount = p_amount and v_old.unit = p_unit then
    return v_revision;
  end if;
  perform set_config('app.workflow_logged', 'on', true);
  update public.workflows
  set doc = jsonb_set(doc, '{steps}', (
    select jsonb_agg(
      case when s.value ->> 'id' = p_step
        then jsonb_set(s.value, '{duration}', jsonb_build_object('amount', p_amount, 'unit', p_unit))
        else s.value end
      order by s.ordinality)
    from jsonb_array_elements(doc -> 'steps') with ordinality s))
  where id = p_workflow
  returning revision into v_revision;
  perform set_config('app.workflow_logged', '', true);
  insert into public.workflow_step_logs
    (workflow_id, step_id, kind, amount, unit, old_amount, old_unit, reason, requester_name, requester_role, created_by)
  values (p_workflow, p_step, 'duration', p_amount, p_unit, v_old.amount, v_old.unit,
          nullif(btrim(coalesce(p_reason, '')), ''), v_name, btrim(p_role), p_user);
  return v_revision;
end;
$$;

-- =============================================
-- Joining by link and cancelling an extension
-- =============================================
-- The page calls this for a signed-in visitor before loading the plan: returns the caller's role,
-- or null when the plan does not exist.
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
  values (p_workflow, auth.uid(), 'editor')
  on conflict (workflow_id, user_id) do update set last_opened_at = now()
  returning role into v_role;
  return v_role;
end;
$$;

create or replace function public.cancel_workflow_extension(p_log uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_workflow uuid;
begin
  select workflow_id into v_workflow from public.workflow_step_logs where id = p_log and kind = 'extend';
  if v_workflow is null or not public.is_workflow_member(v_workflow) then
    raise exception 'Extension not found' using errcode = 'PT404';
  end if;
  update public.workflow_step_logs
  set cancelled_at = now(), cancelled_by = auth.uid()
  where id = p_log and cancelled_at is null;
end;
$$;

-- =============================================
-- Policies and grants
-- =============================================
drop policy if exists "workflows_select" on public.workflows;
create policy "workflows_select" on public.workflows for select to authenticated
  using (public.is_workflow_member(id));
drop policy if exists "workflows_insert" on public.workflows;
create policy "workflows_insert" on public.workflows for insert to authenticated
  with check (owner_id = auth.uid());
drop policy if exists "workflows_update" on public.workflows;
create policy "workflows_update" on public.workflows for update to authenticated
  using (public.is_workflow_member(id)) with check (public.is_workflow_member(id));
drop policy if exists "workflows_delete" on public.workflows;
create policy "workflows_delete" on public.workflows for delete to authenticated
  using (owner_id = auth.uid());

drop policy if exists "workflow_members_select" on public.workflow_members;
create policy "workflow_members_select" on public.workflow_members for select to authenticated
  using (user_id = auth.uid());
drop policy if exists "workflow_members_leave" on public.workflow_members;
create policy "workflow_members_leave" on public.workflow_members for delete to authenticated
  using (user_id = auth.uid() and role <> 'owner');

drop policy if exists "workflow_step_logs_select" on public.workflow_step_logs;
create policy "workflow_step_logs_select" on public.workflow_step_logs for select to authenticated
  using (public.is_workflow_member(workflow_id));

revoke all on table public.workflows, public.workflow_members, public.workflow_step_logs from public, anon, authenticated;
grant select, insert, delete on table public.workflows to authenticated;
grant update (name, doc) on table public.workflows to authenticated;
grant select, delete on table public.workflow_members to authenticated;
grant select on table public.workflow_step_logs to authenticated;
grant all on table public.workflows, public.workflow_members, public.workflow_step_logs to service_role;

revoke all on function public.is_workflow_member(uuid) from public, anon;
revoke all on function public.join_workflow(uuid) from public, anon;
revoke all on function public.cancel_workflow_extension(uuid) from public, anon;
revoke all on function public.workflow_step_duration(jsonb) from public, anon;
revoke all on function public.workflow_person_name(uuid) from public, anon, authenticated;
revoke all on function public.workflows_before_write() from public, anon, authenticated;
revoke all on function public.workflows_after_insert() from public, anon, authenticated;
revoke all on function public.workflows_log_durations() from public, anon, authenticated;
revoke all on function public.workflow_public_change(uuid, text, text, integer, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.is_workflow_member(uuid) to authenticated;
grant execute on function public.join_workflow(uuid) to authenticated;
grant execute on function public.cancel_workflow_extension(uuid) to authenticated;
grant execute on function public.workflow_step_duration(jsonb) to authenticated;
grant execute on function public.workflow_public_change(uuid, text, text, integer, text, text, text, text, uuid) to service_role;
