-- Web Push for chat messages: each browser/device that allowed notifications
-- stores its push subscription here; the server (POST /api/push/chat, with
-- the service role) sends new messages to the other members' devices, so
-- they arrive even when the app is closed.
-- Run after 202608280027_chat_groups.sql. Idempotent.
-- Rollback: drop table if exists public.chat_push_log, public.push_subscriptions;
--           drop function if exists public.save_push_subscription(text, text, text, text);
--           drop function if exists public.delete_push_subscription(text);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  -- one row per browser: the push service URL identifies it
  endpoint text not null unique check (endpoint ~ '^https://' and length(endpoint) <= 1000),
  p256dh text not null check (length(p256dh) between 1 and 200),
  auth text not null check (length(auth) between 1 and 100),
  user_agent text check (user_agent is null or length(user_agent) <= 300),
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create index if not exists idx_push_subscriptions_user on public.push_subscriptions(user_id);

-- Owners see their own devices; writes go through the functions below.
-- The keys are never readable by other users (the server reads them with the
-- service role).
alter table public.push_subscriptions enable row level security;

drop policy if exists "push_subscriptions_select_own" on public.push_subscriptions;
create policy "push_subscriptions_select_own"
  on public.push_subscriptions for select to authenticated
  using (user_id = auth.uid());

revoke insert, update, delete on public.push_subscriptions from anon, authenticated;
grant select on public.push_subscriptions to authenticated;

-- Messages already pushed: the push route runs once per message.
create table if not exists public.chat_push_log (
  message_id uuid primary key references public.chat_messages(id) on delete cascade,
  pushed_at timestamptz not null default now()
);
alter table public.chat_push_log enable row level security;
revoke all on public.chat_push_log from anon, authenticated;

-- Saves this browser's subscription for the caller. The browser holding the
-- endpoint is the device: a subscription left by another account on the same
-- browser (signed out without cleaning up) moves to the caller.
create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  on conflict (endpoint) do update
  set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
      user_agent = excluded.user_agent, created_at = now();
end;
$$;

-- Removes this browser's subscription (sign-out, notifications turned off).
create or replace function public.delete_push_subscription(p_endpoint text)
returns void
language sql security definer
set search_path = public
as $$
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
$$;

revoke all on function public.save_push_subscription(text, text, text, text) from public, anon;
revoke all on function public.delete_push_subscription(text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;
grant execute on function public.delete_push_subscription(text) to authenticated;
