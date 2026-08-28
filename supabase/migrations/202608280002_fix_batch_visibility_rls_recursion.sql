-- Fix RLS recursion between upload_batches and uploaded_files.
-- Run after 202608280001_file_visibility_and_connections.sql.

create or replace function public.can_view_upload_batch(
  batch_id uuid,
  batch_owner_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    batch_owner_id = auth.uid()
    or exists (
      select 1
      from public.uploaded_files f
      where f.batch_id = can_view_upload_batch.batch_id
        and f.is_public
    )
    or exists (
      select 1
      from public.user_connections c
      where c.owner_id = batch_owner_id
        and c.related_user_id = auth.uid()
    );
$$;

drop policy if exists "Users can view permitted batches" on public.upload_batches;

create policy "Users can view permitted batches"
  on public.upload_batches for select to authenticated
  using (public.can_view_upload_batch(id, created_by));
