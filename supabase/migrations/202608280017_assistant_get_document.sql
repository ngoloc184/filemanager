-- AI summaries: read one file's full extracted text plus version information.
-- Additive only (one new read-only function). Same access rule as the
-- assistant search functions; returns nothing at all without access.
-- Idempotent.

create or replace function public.assistant_get_document(p_file_id uuid)
returns table (
  file_id uuid,
  name text,
  extension text,
  mime_type text,
  size bigint,
  folder_id uuid,
  folder_name text,
  updated_at timestamptz,
  current_version_id uuid,
  indexed_version_id uuid,
  status text,
  error text,
  truncated boolean,
  char_count integer,
  content text
)
language plpgsql stable security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if auth.uid() is null
     or not exists (select 1 from public.assistant_accessible_files() a where a.file_id = p_file_id)
     or not public.has_file_access(p_file_id, 'viewer') then
    return;
  end if;

  return query
  select
    f.id, f.name, f.extension, f.mime_type, f.size, f.folder_id, d.name, f.updated_at,
    f.current_version_id,
    fc.version_id,
    fc.status,
    fc.error,
    coalesce(fc.truncated, false),
    coalesce(fc.char_count, 0),
    case
      when fc.version_id is not distinct from f.current_version_id then coalesce(fc.content, '')
      else ''
    end
  from public.files f
  left join public.folders d on d.id = f.folder_id
  left join public.file_contents fc on fc.file_id = f.id
  where f.id = p_file_id;
end;
$$;

revoke all on function public.assistant_get_document(uuid) from public, anon;
grant execute on function public.assistant_get_document(uuid) to authenticated, service_role;
