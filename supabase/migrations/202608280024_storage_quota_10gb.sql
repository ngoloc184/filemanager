-- Raise the default per-user storage quota from 1 GiB to 10 GiB.
-- Run after 202608280023_agent_lessons.sql. Idempotent.
--
-- * new users get 10 GiB (column default and the fallback in
--   get_user_storage_quota_bytes);
-- * users still on the old default (exactly 1 GiB) move to 10 GiB;
-- * quotas an administrator set by hand (any other value) are kept.
--
-- Change one user's quota (SQL editor):
--   update public.user_profiles set storage_quota_bytes = 20 * 1024::bigint ^ 3 where email = '…';
-- Rollback:
--   alter table public.user_profiles alter column storage_quota_bytes set default 1073741824;
--   (and restore the fallback below to 1073741824)

alter table public.user_profiles
  alter column storage_quota_bytes set default 10737418240;

update public.user_profiles
set storage_quota_bytes = 10737418240
where storage_quota_bytes = 1073741824;

create or replace function public.get_user_storage_quota_bytes(p_user_id uuid)
returns bigint
language sql stable security definer
set search_path = public
as $$
  select coalesce(
    (select up.storage_quota_bytes from public.user_profiles up where up.id = p_user_id),
    10737418240
  );
$$;
