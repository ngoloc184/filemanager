-- Files published through the SuperApp API (POST /api/superapp/files) and
-- served publicly at /superapp/<name>.
-- Only the server (service role) reads or writes this table: RLS is enabled
-- with no policies, so anon/authenticated clients have no access.

create table if not exists public.superapp_files (
  name text primary key
    check (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'),
  storage_path text not null,
  mime_type text not null default 'application/octet-stream',
  size bigint not null default 0 check (size >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.superapp_files enable row level security;

revoke all on public.superapp_files from anon, authenticated;
grant all on public.superapp_files to service_role;
