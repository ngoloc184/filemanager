-- Workflow e-mail reminders: a shared role directory and a log of reminders sent.
-- Run after 202608280048_workflow_owner_select.sql. Idempotent.
--
-- * workflow_role_contacts: the team's directory of role → e-mail addresses, shared by every
--   workflow and matched on the role's name (case and outer spaces ignored), e.g. "QC HDBank".
--   Every signed-in user may read and edit it; people without an account never see it.
-- * workflow_reminders: each reminder e-mail sent for a step: 'upcoming' (starts on the next
--   working day), 'due' (ends today), 'overdue', or 'progress' (sent by hand while the step runs).
--   Automatic reminders are unique per step, kind and day, so a retried run sends nothing twice;
--   reminders sent with "Nhắc ngay" are marked manual. Written by the server only (service role),
--   readable by the plan's members.
-- Rollback:
--   drop table if exists public.workflow_reminders, public.workflow_role_contacts cascade;
--   drop function if exists public.workflow_valid_emails(text[]), public.workflow_role_contacts_stamp();

create or replace function public.workflow_valid_emails(p_emails text[])
returns boolean
language sql immutable
set search_path = public
as $$
  select coalesce(bool_and(char_length(e) between 3 and 254 and e ~ '^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$'), true)
  from unnest(p_emails) e;
$$;

create table if not exists public.workflow_role_contacts (
  id uuid primary key default gen_random_uuid(),
  role_name text not null check (char_length(btrim(role_name)) between 1 and 60),
  role_key text generated always as (lower(btrim(role_name))) stored,
  emails text[] not null default '{}' check (cardinality(emails) <= 50 and public.workflow_valid_emails(emails)),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
create unique index if not exists workflow_role_contacts_key on public.workflow_role_contacts (role_key);

create or replace function public.workflow_role_contacts_stamp()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.role_name := btrim(new.role_name);
  -- addresses are kept trimmed, lower-case and once each
  new.emails := coalesce((select array_agg(distinct lower(btrim(e))) from unnest(new.emails) e where btrim(e) <> ''), '{}');
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists workflow_role_contacts_stamp on public.workflow_role_contacts;
create trigger workflow_role_contacts_stamp
  before insert or update on public.workflow_role_contacts
  for each row execute function public.workflow_role_contacts_stamp();

create table if not exists public.workflow_reminders (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  step_id text not null check (step_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  kind text not null check (kind in ('upcoming', 'due', 'overdue', 'progress')),
  -- the plan's local day the reminder belongs to
  day date not null,
  manual boolean not null default false,
  recipients text[] not null default '{}',
  sent_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists workflow_reminders_once on public.workflow_reminders (workflow_id, step_id, kind, day) where not manual;
create index if not exists workflow_reminders_workflow_idx on public.workflow_reminders (workflow_id, created_at desc);

alter table public.workflow_role_contacts enable row level security;
alter table public.workflow_reminders enable row level security;

drop policy if exists "workflow_role_contacts_select" on public.workflow_role_contacts;
create policy "workflow_role_contacts_select" on public.workflow_role_contacts for select to authenticated using (true);
drop policy if exists "workflow_role_contacts_insert" on public.workflow_role_contacts;
create policy "workflow_role_contacts_insert" on public.workflow_role_contacts for insert to authenticated with check (true);
drop policy if exists "workflow_role_contacts_update" on public.workflow_role_contacts;
create policy "workflow_role_contacts_update" on public.workflow_role_contacts for update to authenticated using (true) with check (true);
drop policy if exists "workflow_role_contacts_delete" on public.workflow_role_contacts;
create policy "workflow_role_contacts_delete" on public.workflow_role_contacts for delete to authenticated using (true);

drop policy if exists "workflow_reminders_select" on public.workflow_reminders;
create policy "workflow_reminders_select" on public.workflow_reminders for select to authenticated
  using (public.is_workflow_member(workflow_id));

revoke all on table public.workflow_role_contacts, public.workflow_reminders from public, anon, authenticated;
grant select, insert, delete on table public.workflow_role_contacts to authenticated;
grant update (role_name, emails) on table public.workflow_role_contacts to authenticated;
grant select on table public.workflow_reminders to authenticated;
grant all on table public.workflow_role_contacts, public.workflow_reminders to service_role;

revoke all on function public.workflow_valid_emails(text[]) from public, anon;
revoke all on function public.workflow_role_contacts_stamp() from public, anon, authenticated;
grant execute on function public.workflow_valid_emails(text[]) to authenticated;
