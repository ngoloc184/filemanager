-- Agent self-learning: lessons ("when people say X they mean Y") shared
-- across users once enough of them taught or confirmed the same lesson.
-- Run after 202608280022_folder_owner_access.sql. Idempotent.
--
-- How a lesson becomes visible:
--   * to its author: as soon as they teach it explicitly (or confirm a
--     suggestion, or 👍 an answer that used it);
--   * to everyone ("global"): when it only uses the agent's own vocabulary
--     (generic), changes nothing (effect = 'read') or an administrator
--     approved it, at least 3 different users confirmed it (or 5 different
--     users produced it implicitly by rephrasing), and fewer than half as
--     many users rejected it;
--   * never to a user who rejected it, and never while status = 'blocked'.
-- The agent re-validates every lesson before applying it (packages/agent-core),
-- so a client that sends wrong effect/generic flags cannot hijack commands.
--
-- Administration (SQL editor):
--   select * from public.agent_lesson_stats order by confirmed_users desc;
--   update public.agent_lessons set status = 'blocked' where id = '…';   -- stop a lesson
--   update public.agent_lessons set approved = true where id = '…';      -- share a write lesson
-- Rollback:
--   drop view if exists public.agent_lesson_stats;
--   drop function if exists public.agent_lessons_for_me();
--   drop function if exists public.agent_teach(text, text, text, boolean, text);
--   drop function if exists public.agent_vote(uuid[], smallint);
--   drop function if exists public.agent_forget_lesson(uuid);
--   drop table if exists public.agent_lesson_votes;
--   drop table if exists public.agent_lessons;

create table if not exists public.agent_lessons (
  id uuid primary key default gen_random_uuid(),
  -- folded text only: lower-case ascii words, no e-mails, links or long numbers
  phrase text not null check (phrase ~ '^[a-z0-9]+( [a-z0-9]+)*$' and length(phrase) <= 200 and phrase !~ '[0-9]{6,}'),
  canonical text not null check (canonical ~ '^[a-z0-9]+( [a-z0-9]+)*$' and length(canonical) <= 200 and canonical !~ '[0-9]{6,}'),
  effect text not null check (effect in ('read', 'write')),
  generic boolean not null default false,
  status text not null default 'active' check (status in ('active', 'blocked')),
  approved boolean not null default false,
  created_at timestamptz not null default now(),
  unique (phrase, canonical),
  check (phrase <> canonical)
);

create table if not exists public.agent_lesson_votes (
  lesson_id uuid not null references public.agent_lessons(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  vote smallint not null check (vote in (-1, 1)),
  source text not null check (source in ('explicit', 'implicit', 'feedback')),
  updated_at timestamptz not null default now(),
  primary key (lesson_id, user_id)
);

create index if not exists idx_agent_lesson_votes_user on public.agent_lesson_votes(user_id, updated_at desc);

-- No direct access: everything goes through the functions below.
alter table public.agent_lessons enable row level security;
alter table public.agent_lesson_votes enable row level security;
revoke all on public.agent_lessons from anon, authenticated;
revoke all on public.agent_lesson_votes from anon, authenticated;

-- Review view for administrators (RLS-protected tables: empty for app users).
create or replace view public.agent_lesson_stats
with (security_invoker = true) as
select
  l.id, l.phrase, l.canonical, l.effect, l.generic, l.status, l.approved, l.created_at,
  count(*) filter (where v.vote = 1 and v.source <> 'implicit') as confirmed_users,
  count(*) filter (where v.vote = 1 and v.source = 'implicit') as observed_users,
  count(*) filter (where v.vote = -1) as rejected_users,
  max(v.updated_at) as last_activity
from public.agent_lessons l
left join public.agent_lesson_votes v on v.lesson_id = l.id
group by l.id;
revoke all on public.agent_lesson_stats from anon, authenticated;

-- =============================================
-- Lessons the caller should use
-- =============================================
create or replace function public.agent_lessons_for_me()
returns table (id uuid, phrase text, canonical text, scope text, approved boolean)
language sql stable security definer
set search_path = public
as $$
  with stats as (
    select
      l.id, l.phrase, l.canonical, l.effect, l.generic, l.approved,
      count(*) filter (where v.vote = 1 and v.source <> 'implicit') as confirmed,
      count(*) filter (where v.vote = 1 and v.source = 'implicit') as observed,
      count(*) filter (where v.vote = -1) as rejected,
      bool_or(v.user_id = auth.uid() and v.vote = 1 and v.source <> 'implicit') as mine,
      bool_or(v.user_id = auth.uid() and v.vote = -1) as my_reject
    from public.agent_lessons l
    join public.agent_lesson_votes v on v.lesson_id = l.id
    where l.status = 'active'
    group by l.id
  )
  select s.id, s.phrase, s.canonical, case when s.mine then 'mine' else 'global' end, s.approved
  from stats s
  where auth.uid() is not null
    and not coalesce(s.my_reject, false)
    and (
      s.mine
      or (
        s.generic
        and (s.effect = 'read' or s.approved)
        and (s.confirmed >= 3 or s.confirmed + s.observed >= 5)
        and s.rejected * 2 < s.confirmed + s.observed
      )
    )
  order by s.mine desc, length(s.phrase) desc
  limit 500;
$$;

-- =============================================
-- Teach / observe
-- =============================================
create or replace function public.agent_teach(
  p_phrase text,
  p_canonical text,
  p_effect text,
  p_generic boolean,
  p_source text
)
returns table (id uuid, phrase text, canonical text, scope text, approved boolean)
language plpgsql security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_id uuid;
  v_recent integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if p_effect not in ('read', 'write') or p_source not in ('explicit', 'implicit') then
    raise exception 'Invalid lesson';
  end if;

  -- keep one account from flooding the shared lessons
  select count(*) into v_recent
  from public.agent_lesson_votes v
  where v.user_id = auth.uid() and v.updated_at > now() - interval '1 day';
  if v_recent >= 100 then
    raise exception 'Too many lessons today';
  end if;

  insert into public.agent_lessons as l (phrase, canonical, effect, generic)
  values (p_phrase, p_canonical, p_effect, coalesce(p_generic, false))
  on conflict (phrase, canonical) do update
    -- the most conservative view wins: any "write" or "not generic" sticks
    set effect = case when l.effect = 'write' or excluded.effect = 'write' then 'write' else 'read' end,
        generic = l.generic and excluded.generic
  returning l.id into v_id;

  insert into public.agent_lesson_votes as v (lesson_id, user_id, vote, source)
  values (v_id, auth.uid(), 1, p_source)
  on conflict (lesson_id, user_id) do update
    -- an observation never overrides what the user said themselves: it keeps
    -- an explicit confirmation and, above all, a rejection (-1)
    set vote = case when excluded.source = 'implicit' then v.vote else 1 end,
        source = case when excluded.source = 'implicit' then v.source else excluded.source end,
        updated_at = now();

  return query
  select l.id, l.phrase, l.canonical,
         case when p_source = 'explicit' then 'mine' else 'global' end,
         l.approved
  from public.agent_lessons l
  where l.id = v_id;
end;
$$;

-- 👍 / 👎 / "sai rồi" on an answer that used these lessons
create or replace function public.agent_vote(p_ids uuid[], p_vote smallint)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if p_vote not in (-1, 1) then
    raise exception 'Invalid vote';
  end if;

  -- anyone may reject a lesson; only lessons the caller actually gets can be
  -- confirmed (a 👍 on an answer that used them), so ids cannot be upvoted blindly
  insert into public.agent_lesson_votes as v (lesson_id, user_id, vote, source)
  select l.id, auth.uid(), p_vote, 'feedback'
  from public.agent_lessons l
  where l.id = any((coalesce(p_ids, '{}'::uuid[]))[1:10])
    and (p_vote = -1 or l.id in (select m.id from public.agent_lessons_for_me() m))
  on conflict (lesson_id, user_id) do update
    set vote = excluded.vote, source = 'feedback', updated_at = now();
end;
$$;

-- "Quên cách nói X": a rejection, so a shared lesson stops applying too
create or replace function public.agent_forget_lesson(p_id uuid)
returns void
language sql security definer
set search_path = public
as $$
  insert into public.agent_lesson_votes as v (lesson_id, user_id, vote, source)
  select l.id, auth.uid(), -1, 'feedback'
  from public.agent_lessons l
  where l.id = p_id and auth.uid() is not null
  on conflict (lesson_id, user_id) do update
    set vote = -1, source = 'feedback', updated_at = now();
$$;

revoke all on function public.agent_lessons_for_me() from public, anon;
revoke all on function public.agent_teach(text, text, text, boolean, text) from public, anon;
revoke all on function public.agent_vote(uuid[], smallint) from public, anon;
revoke all on function public.agent_forget_lesson(uuid) from public, anon;
grant execute on function public.agent_lessons_for_me() to authenticated;
grant execute on function public.agent_teach(text, text, text, boolean, text) to authenticated;
grant execute on function public.agent_vote(uuid[], smallint) to authenticated;
grant execute on function public.agent_forget_lesson(uuid) to authenticated;
