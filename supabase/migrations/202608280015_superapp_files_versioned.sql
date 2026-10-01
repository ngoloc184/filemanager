-- Store SuperApp files per mini-app version.
-- Each (name, version) pair is an immutable snapshot served at
-- /superapp/<name>?v=<version>. Rows uploaded before this migration keep
-- version = null ("unversioned") and are only used as a fallback.

alter table public.superapp_files
  add column if not exists version text
    check (version is null or version ~ '^\d+\.\d+\.\d+$');

-- name alone is no longer unique: replace the primary key with a surrogate id
-- and make (name, version) unique, treating null versions as equal.
alter table public.superapp_files
  add column if not exists id uuid not null default gen_random_uuid();

alter table public.superapp_files drop constraint if exists superapp_files_pkey;
alter table public.superapp_files add primary key (id);

create unique index if not exists superapp_files_name_version_key
  on public.superapp_files (name, version) nulls not distinct;

create index if not exists superapp_files_version_idx
  on public.superapp_files (version);
