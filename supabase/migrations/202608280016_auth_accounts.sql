-- Email / Google sign-in support.
--
-- * Keeps public.user_profiles (used by sharing and related users) in sync
--   with auth.users for every sign-up method (password, magic link, Google)
--   and for e-mail changes, storing addresses trimmed and lower-cased.
-- * Enforces one profile per e-mail address, case-insensitively.
-- * Adds a service-role-only table + functions used by the app to throttle
--   sign-in, sign-up and e-mail sending (brute-force protection).
-- * Adds current_user_has_password() for the account settings page.
--
-- File, folder and sharing permissions are not touched.
-- Idempotent: safe to re-run. Run after 202608280015_superapp_files_versioned.sql.

-- =============================================
-- Profile mirror: normalised, never blocks auth
-- =============================================
create or replace function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email is not null and btrim(new.email) <> '' then
    begin
      insert into public.user_profiles (id, email)
      values (new.id, lower(btrim(new.email)))
      on conflict (id) do update set email = excluded.email;
    exception when unique_violation then
      -- Another profile still holds this address. The mirror table must
      -- never make a sign-up fail, so log and continue.
      raise warning 'user_profiles: e-mail already used by another profile (user %)', new.id;
    end;
  end if;
  return new;
end;
$$;

-- Same function body for e-mail changes (confirmed via Supabase Auth).
create or replace function public.handle_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email is distinct from old.email
     and new.email is not null and btrim(new.email) <> '' then
    begin
      insert into public.user_profiles (id, email)
      values (new.id, lower(btrim(new.email)))
      on conflict (id) do update set email = excluded.email;
    exception when unique_violation then
      raise warning 'user_profiles: e-mail already used by another profile (user %)', new.id;
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user_profile();

drop trigger if exists on_auth_user_email_updated on auth.users;
create trigger on_auth_user_email_updated
  after update of email on auth.users
  for each row execute procedure public.handle_user_email_change();

-- One-time resync. Profiles created before this migration may hold a stale
-- or differently-cased address; rows that would collide are left as they are.
update public.user_profiles p
set email = lower(btrim(u.email))
from auth.users u
where u.id = p.id
  and u.email is not null
  and btrim(u.email) <> ''
  and p.email is distinct from lower(btrim(u.email))
  and not exists (
    select 1 from public.user_profiles o
    where o.id <> p.id and lower(o.email) = lower(btrim(u.email))
  );

insert into public.user_profiles (id, email)
select u.id, lower(btrim(u.email))
from auth.users u
where u.email is not null
  and btrim(u.email) <> ''
  and not exists (select 1 from public.user_profiles p where p.id = u.id)
on conflict do nothing;

-- Case-insensitive uniqueness (the existing unique constraint is
-- case-sensitive). Existing data is never deleted: if two profiles differ
-- only by case, the index is skipped with a warning so they can be merged
-- by hand before re-running this migration.
do $$
begin
  if exists (
    select 1 from public.user_profiles group by lower(email) having count(*) > 1
  ) then
    raise warning 'user_profiles contains e-mail addresses that differ only by case; resolve them and re-run this migration to add user_profiles_email_lower_key.';
  else
    create unique index if not exists user_profiles_email_lower_key
      on public.user_profiles (lower(email));
  end if;
end;
$$;

-- =============================================
-- Auth throttling (service role only)
-- =============================================
create table if not exists public.auth_rate_limits (
  key text primary key,
  hits integer not null default 0,
  window_start timestamptz not null default now()
);

alter table public.auth_rate_limits enable row level security;
-- No policies on purpose: only the service role (which bypasses RLS) may
-- read or write this table.
revoke all on table public.auth_rate_limits from anon, authenticated;

-- Records one attempt for p_key (p_consume = true) or only inspects the
-- current window (p_consume = false). A fixed window of p_window_seconds
-- allows p_limit attempts.
create or replace function public.auth_rate_limit_hit(
  p_key text,
  p_limit integer,
  p_window_seconds integer,
  p_consume boolean default true
)
returns table (allowed boolean, hits integer, retry_after_seconds integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_window interval := make_interval(secs => greatest(p_window_seconds, 1));
  v_row public.auth_rate_limits%rowtype;
begin
  if p_key is null or p_key = '' or p_limit < 1 then
    raise exception 'invalid rate limit arguments';
  end if;

  if p_consume then
    insert into public.auth_rate_limits as r (key, hits, window_start)
    values (p_key, 1, v_now)
    on conflict (key) do update
      set hits = case when r.window_start <= v_now - v_window then 1 else r.hits + 1 end,
          window_start = case when r.window_start <= v_now - v_window then v_now else r.window_start end
    returning * into v_row;

    -- Opportunistic cleanup of long-expired windows.
    if random() < 0.01 then
      delete from public.auth_rate_limits where window_start < v_now - interval '1 day';
    end if;

    return query select
      v_row.hits <= p_limit,
      v_row.hits,
      case when v_row.hits <= p_limit then 0
           else greatest(1, ceil(extract(epoch from (v_row.window_start + v_window - v_now)))::integer)
      end;
    return;
  end if;

  select * into v_row from public.auth_rate_limits r where r.key = p_key;
  if not found or v_row.window_start <= v_now - v_window then
    return query select true, 0, 0;
    return;
  end if;

  return query select
    v_row.hits < p_limit,
    v_row.hits,
    case when v_row.hits < p_limit then 0
         else greatest(1, ceil(extract(epoch from (v_row.window_start + v_window - v_now)))::integer)
    end;
end;
$$;

create or replace function public.auth_rate_limit_reset(p_key text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.auth_rate_limits where key = p_key;
$$;

revoke execute on function public.auth_rate_limit_hit(text, integer, integer, boolean) from public, anon, authenticated;
revoke execute on function public.auth_rate_limit_reset(text) from public, anon, authenticated;
grant execute on function public.auth_rate_limit_hit(text, integer, integer, boolean) to service_role;
grant execute on function public.auth_rate_limit_reset(text) to service_role;

-- =============================================
-- Account settings helper
-- =============================================
-- Accounts created with Google have no password until the user sets one.
create or replace function public.current_user_has_password()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select u.encrypted_password is not null and u.encrypted_password <> ''
      from auth.users u
      where u.id = auth.uid()
    ),
    false
  );
$$;

revoke execute on function public.current_user_has_password() from public, anon;
grant execute on function public.current_user_has_password() to authenticated;
