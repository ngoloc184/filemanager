-- File visibility and related-user access
-- Run this migration in Supabase Dashboard > SQL Editor before deploying the UI.

alter table public.uploaded_files
  add column if not exists is_public boolean not null default false;

create table if not exists public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  created_at timestamptz not null default now()
);

insert into public.user_profiles (id, email)
select id, email
from auth.users
where email is not null
on conflict (id) do update set email = excluded.email;

create or replace function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email is not null then
    insert into public.user_profiles (id, email)
    values (new.id, new.email)
    on conflict (id) do update set email = excluded.email;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user_profile();

create table if not exists public.user_connections (
  owner_id uuid not null references auth.users(id) on delete cascade,
  related_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (owner_id, related_user_id),
  check (owner_id <> related_user_id)
);

create index if not exists idx_user_connections_related_user
  on public.user_connections (related_user_id);

alter table public.user_profiles enable row level security;
alter table public.user_connections enable row level security;

drop policy if exists "Users can view their own connections" on public.user_connections;
drop policy if exists "Users can add their own connections" on public.user_connections;
drop policy if exists "Users can remove their own connections" on public.user_connections;

create policy "Users can view their own connections"
  on public.user_connections for select to authenticated
  using (owner_id = auth.uid());

create policy "Users can add their own connections"
  on public.user_connections for insert to authenticated
  with check (owner_id = auth.uid() and related_user_id <> auth.uid());

create policy "Users can remove their own connections"
  on public.user_connections for delete to authenticated
  using (owner_id = auth.uid());

create or replace function public.find_user_by_email(related_email text)
returns table (id uuid, email text)
language sql
security definer
set search_path = public
as $$
  select p.id, p.email
  from public.user_profiles p
  where auth.uid() is not null
    and lower(p.email) = lower(trim(related_email))
  limit 1;
$$;

create or replace function public.list_related_users()
returns table (id uuid, email text, created_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select p.id, p.email, c.created_at
  from public.user_connections c
  join public.user_profiles p on p.id = c.related_user_id
  where c.owner_id = auth.uid()
  order by p.email;
$$;

create or replace function public.add_related_user(related_email text)
returns table (id uuid, email text)
language plpgsql
security definer
set search_path = public
as $$
declare
  matched_user public.user_profiles%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into matched_user
  from public.user_profiles
  where lower(email) = lower(trim(related_email));

  if not found then
    raise exception 'No registered user found for this email address';
  end if;

  if matched_user.id = auth.uid() then
    raise exception 'You cannot add yourself';
  end if;

  insert into public.user_connections (owner_id, related_user_id)
  values (auth.uid(), matched_user.id)
  on conflict (owner_id, related_user_id) do nothing;

  return query select matched_user.id, matched_user.email;
end;
$$;

create or replace function public.remove_related_user(user_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.user_connections
  where owner_id = auth.uid() and related_user_id = user_id;
$$;

grant execute on function public.find_user_by_email(text) to authenticated;
grant execute on function public.list_related_users() to authenticated;
grant execute on function public.add_related_user(text) to authenticated;
grant execute on function public.remove_related_user(uuid) to authenticated;

drop policy if exists "Authenticated users can view batches" on public.upload_batches;
drop policy if exists "Authenticated users can create batches" on public.upload_batches;
drop policy if exists "Users can update own batches" on public.upload_batches;
drop policy if exists "Users can delete own batches" on public.upload_batches;

create policy "Users can view permitted batches"
  on public.upload_batches for select to authenticated
  using (
    created_by = auth.uid()
    or exists (
      select 1 from public.uploaded_files f
      where f.batch_id = upload_batches.id and f.is_public
    )
    or exists (
      select 1 from public.user_connections c
      where c.owner_id = upload_batches.created_by
        and c.related_user_id = auth.uid()
    )
  );

create policy "Users can create own batches"
  on public.upload_batches for insert to authenticated
  with check (created_by = auth.uid());

create policy "Users can update own batches"
  on public.upload_batches for update to authenticated
  using (created_by = auth.uid())
  with check (created_by = auth.uid());

create policy "Users can delete own batches"
  on public.upload_batches for delete to authenticated
  using (created_by = auth.uid());

drop policy if exists "Authenticated users can view files" on public.uploaded_files;
drop policy if exists "Authenticated users can insert files" on public.uploaded_files;
drop policy if exists "Users can delete files in own batches" on public.uploaded_files;
drop policy if exists "Users can update files in own batches" on public.uploaded_files;

create policy "Users can view permitted files"
  on public.uploaded_files for select to authenticated
  using (
    is_public
    or exists (
      select 1 from public.upload_batches b
      where b.id = uploaded_files.batch_id and b.created_by = auth.uid()
    )
    or exists (
      select 1
      from public.upload_batches b
      join public.user_connections c on c.owner_id = b.created_by
      where b.id = uploaded_files.batch_id and c.related_user_id = auth.uid()
    )
  );

create policy "Users can insert files in own batches"
  on public.uploaded_files for insert to authenticated
  with check (
    exists (
      select 1 from public.upload_batches b
      where b.id = batch_id and b.created_by = auth.uid()
    )
  );

create policy "Users can update own files"
  on public.uploaded_files for update to authenticated
  using (
    exists (
      select 1 from public.upload_batches b
      where b.id = uploaded_files.batch_id and b.created_by = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.upload_batches b
      where b.id = uploaded_files.batch_id and b.created_by = auth.uid()
    )
  );

create policy "Users can delete files in own batches"
  on public.uploaded_files for delete to authenticated
  using (
    exists (
      select 1 from public.upload_batches b
      where b.id = uploaded_files.batch_id and b.created_by = auth.uid()
    )
  );

drop policy if exists "Authenticated users can upload files" on storage.objects;
drop policy if exists "Authenticated users can read files" on storage.objects;
drop policy if exists "Authenticated users can delete files" on storage.objects;

create policy "Users can upload to their own batches"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'uploads'
    and exists (
      select 1 from public.upload_batches b
      where b.created_by = auth.uid()
        and storage.objects.name like b.id::text || '/%'
    )
  );

create policy "Users can read permitted stored files"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'uploads'
    and exists (
      select 1
      from public.uploaded_files f
      join public.upload_batches b on b.id = f.batch_id
      where f.storage_path = storage.objects.name
        and (
          f.is_public
          or b.created_by = auth.uid()
          or exists (
            select 1 from public.user_connections c
            where c.owner_id = b.created_by and c.related_user_id = auth.uid()
          )
        )
    )
  );

create policy "Users can delete their own stored files"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'uploads'
    and exists (
      select 1
      from public.uploaded_files f
      join public.upload_batches b on b.id = f.batch_id
      where f.storage_path = storage.objects.name and b.created_by = auth.uid()
    )
  );
