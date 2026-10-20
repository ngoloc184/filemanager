-- Saved links: a personal list of useful URLs (title + URL) per user.
-- Run after 202608280018_assistant_memory_feedback.sql. Idempotent.
-- Rollback: drop table if exists public.saved_links;

create table if not exists public.saved_links (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 200),
  -- only web links: blocks javascript:, data: and other schemes at the source
  url text not null check (length(url) <= 2048 and url ~* '^https?://[^\s/$.?#][^\s]*$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_saved_links_owner
  on public.saved_links(owner_id, created_at desc);

drop trigger if exists saved_links_set_updated_at on public.saved_links;
create trigger saved_links_set_updated_at
  before update on public.saved_links
  for each row execute function public.handle_updated_at();

-- Private to their owner: no sharing, so plain owner-only RLS is enough.
alter table public.saved_links enable row level security;

drop policy if exists "saved_links_all_own" on public.saved_links;
create policy "saved_links_all_own"
  on public.saved_links for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

grant select, insert, update, delete on public.saved_links to authenticated;
