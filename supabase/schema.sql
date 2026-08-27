-- =============================================
-- Supabase Database Schema for File Manager
-- =============================================
-- Run this SQL in your Supabase SQL Editor (Dashboard > SQL Editor)
-- =============================================

-- Enable UUID extension (usually already enabled)
-- create extension if not exists "uuid-ossp";

-- =============================================
-- Table: upload_batches
-- =============================================
create table if not exists public.upload_batches (
  id uuid default gen_random_uuid() primary key,
  title text not null,
  comment text,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

-- =============================================
-- Table: uploaded_files
-- =============================================
create table if not exists public.uploaded_files (
  id uuid default gen_random_uuid() primary key,
  batch_id uuid not null references public.upload_batches(id) on delete cascade,
  original_filename text not null,
  storage_path text not null,
  file_size bigint not null default 0,
  mime_type text not null default 'application/octet-stream',
  uploaded_at timestamptz default now() not null
);

-- =============================================
-- Indexes
-- =============================================
create index if not exists idx_upload_batches_created_by on public.upload_batches(created_by);
create index if not exists idx_upload_batches_created_at on public.upload_batches(created_at desc);
create index if not exists idx_uploaded_files_batch_id on public.uploaded_files(batch_id);

-- =============================================
-- Row Level Security (RLS)
-- =============================================
alter table public.upload_batches enable row level security;
alter table public.uploaded_files enable row level security;

-- Policies for upload_batches
-- Anyone logged in can read all batches
create policy "Authenticated users can view batches"
  on public.upload_batches for select
  to authenticated
  using (true);

-- Authenticated users can create batches
create policy "Authenticated users can create batches"
  on public.upload_batches for insert
  to authenticated
  with check (auth.uid() = created_by);

-- Users can update their own batches
create policy "Users can update own batches"
  on public.upload_batches for update
  to authenticated
  using (auth.uid() = created_by)
  with check (auth.uid() = created_by);

-- Users can delete their own batches
create policy "Users can delete own batches"
  on public.upload_batches for delete
  to authenticated
  using (auth.uid() = created_by);

-- Policies for uploaded_files
-- Anyone logged in can read all files
create policy "Authenticated users can view files"
  on public.uploaded_files for select
  to authenticated
  using (true);

-- Authenticated users can upload files (insert through their own batch)
create policy "Authenticated users can insert files"
  on public.uploaded_files for insert
  to authenticated
  with check (
    exists (
      select 1 from public.upload_batches
      where id = batch_id and created_by = auth.uid()
    )
  );

-- Users can delete files in their own batches
create policy "Users can delete files in own batches"
  on public.uploaded_files for delete
  to authenticated
  using (
    exists (
      select 1 from public.upload_batches
      where id = batch_id and created_by = auth.uid()
    )
  );

-- =============================================
-- Storage Bucket: uploads
-- =============================================
-- Run this in Supabase Dashboard > Storage > New Bucket
-- Bucket name: uploads
-- Public: No (use signed URLs)
-- File size limit: 50 MB (or your preferred limit)
-- Allowed MIME types: * (or restrict as needed)

-- Storage policies
-- Allow authenticated users to upload
create policy "Authenticated users can upload files"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'uploads');

-- Allow authenticated users to read files
create policy "Authenticated users can read files"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'uploads');

-- Allow authenticated users to delete their own files
create policy "Authenticated users can delete files"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'uploads');

-- =============================================
-- Function: update updated_at timestamp
-- =============================================
create or replace function public.handle_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- Trigger for updated_at
create trigger set_updated_at
  before update on public.upload_batches
  for each row
  execute function public.handle_updated_at();
