-- Per-account preferences. First one: system notifications for new chat
-- messages (shown by the browser while the app is open in a tab).
-- Run after 202608280025_chat.sql. Idempotent.
-- Rollback: drop table if exists public.user_preferences;

create table if not exists public.user_preferences (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  -- off until the user turns it on (the browser also asks for permission)
  chat_notifications boolean not null default false,
  updated_at timestamptz not null default now()
);

drop trigger if exists user_preferences_set_updated_at on public.user_preferences;
create trigger user_preferences_set_updated_at
  before update on public.user_preferences
  for each row execute function public.handle_updated_at();

-- Private to their owner.
alter table public.user_preferences enable row level security;

drop policy if exists "user_preferences_all_own" on public.user_preferences;
create policy "user_preferences_all_own"
  on public.user_preferences for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update on public.user_preferences to authenticated;
