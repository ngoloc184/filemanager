-- Latest published version of each FBiz mini-app.
-- Read publicly through GET /api/superapp/versions and written through
-- PUT /api/superapp/versions/<name> (API key). Only the server (service role)
-- touches the table: RLS is enabled with no policies.

create table if not exists public.superapp_versions (
  name text primary key,
  version text not null,
  updated_at timestamptz not null default now()
);

alter table public.superapp_versions enable row level security;

revoke all on public.superapp_versions from anon, authenticated;
grant all on public.superapp_versions to service_role;

-- Keep updated_at = now() on every update, whatever the client sends.
create or replace function public.touch_superapp_versions_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists superapp_versions_touch_updated_at on public.superapp_versions;
create trigger superapp_versions_touch_updated_at
  before update on public.superapp_versions
  for each row execute function public.touch_superapp_versions_updated_at();
