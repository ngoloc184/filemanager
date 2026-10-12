-- AI assistant: long-term memory, feedback, quality metrics and versioned
-- retrieval tuning. Additive only: new tables and functions; nothing existing
-- is modified. Idempotent. Run after 202608280016 and 202608280017.
--
-- Privacy rules enforced here (RLS), not only in the app:
--   * memories, events and feedback are visible to their owner only;
--   * events never contain the question or any file content;
--   * feedback keeps keywords (not the question) and an optional correction;
--   * reports and tuning changes are available to the service role only.

-- =============================================
-- assistant_memories: what the assistant remembers about one user
-- (preferences, terms they explained, notes they asked to keep).
-- =============================================
create table if not exists public.assistant_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null check (kind in ('preference', 'glossary', 'note')),
  key text check (key is null or length(key) between 1 and 60),
  value text not null check (length(value) between 1 and 300),
  source text not null default 'explicit' check (source in ('explicit', 'confirmed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz,
  constraint assistant_memories_key_required check (kind = 'note' or key is not null)
);

create unique index if not exists assistant_memories_user_kind_key
  on public.assistant_memories (user_id, kind, key) where key is not null;
create index if not exists assistant_memories_user_created
  on public.assistant_memories (user_id, created_at);

alter table public.assistant_memories enable row level security;

drop policy if exists "assistant_memories_select_own" on public.assistant_memories;
create policy "assistant_memories_select_own" on public.assistant_memories
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "assistant_memories_insert_own" on public.assistant_memories;
create policy "assistant_memories_insert_own" on public.assistant_memories
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "assistant_memories_update_own" on public.assistant_memories;
create policy "assistant_memories_update_own" on public.assistant_memories
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "assistant_memories_delete_own" on public.assistant_memories;
create policy "assistant_memories_delete_own" on public.assistant_memories
  for delete to authenticated using (user_id = auth.uid());

revoke all on public.assistant_memories from anon;
grant select, insert, update, delete on public.assistant_memories to authenticated;

-- At most 50 memories per user; updated_at maintained by the database.
create or replace function public.assistant_memories_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if (select count(*) from public.assistant_memories m where m.user_id = new.user_id) >= 50 then
      raise exception 'Memory limit reached (50 items)' using errcode = 'check_violation';
    end if;
  else
    new.updated_at := now();
    new.user_id := old.user_id;
  end if;
  return new;
end;
$$;

drop trigger if exists assistant_memories_guard on public.assistant_memories;
create trigger assistant_memories_guard
  before insert or update on public.assistant_memories
  for each row execute function public.assistant_memories_guard();

-- =============================================
-- assistant_events: one row per answered question (metadata only).
-- =============================================
create table if not exists public.assistant_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  intent text not null check (length(intent) between 1 and 40),
  method text check (length(method) <= 40),
  result_count integer not null default 0 check (result_count between 0 and 1000),
  grounded boolean,
  confidence text check (confidence in ('high', 'medium', 'low', 'none')),
  latency_ms integer check (latency_ms between 0 and 600000),
  llm_calls smallint not null default 0 check (llm_calls between 0 and 50),
  tokens_est integer not null default 0 check (tokens_est between 0 and 1000000),
  tuning_version text check (length(tuning_version) <= 40),
  error_code text check (length(error_code) <= 40)
);

create index if not exists assistant_events_user_created on public.assistant_events (user_id, created_at desc);
create index if not exists assistant_events_created on public.assistant_events (created_at desc);

alter table public.assistant_events enable row level security;

drop policy if exists "assistant_events_select_own" on public.assistant_events;
create policy "assistant_events_select_own" on public.assistant_events
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "assistant_events_insert_own" on public.assistant_events;
create policy "assistant_events_insert_own" on public.assistant_events
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "assistant_events_delete_own" on public.assistant_events;
create policy "assistant_events_delete_own" on public.assistant_events
  for delete to authenticated using (user_id = auth.uid());

revoke all on public.assistant_events from anon;
grant select, insert, delete on public.assistant_events to authenticated;

-- =============================================
-- assistant_feedback: 👍/👎, reason and optional correction for an answer.
-- =============================================
create table if not exists public.assistant_feedback (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.assistant_events(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  rating smallint not null check (rating in (-1, 1)),
  reason text check (reason in ('wrong', 'not_found', 'irrelevant', 'missing_source', 'incomplete', 'other')),
  correction text check (length(correction) <= 500),
  query_terms text[] not null default '{}' check (cardinality(query_terms) <= 12),
  cited_files uuid[] not null default '{}' check (cardinality(cited_files) <= 10),
  -- reviewed by an admin before anything is applied to shared behaviour
  status text not null default 'new' check (status in ('new', 'reviewed', 'applied', 'rejected')),
  unique (event_id, user_id)
);

create index if not exists assistant_feedback_created on public.assistant_feedback (created_at desc);

alter table public.assistant_feedback enable row level security;

drop policy if exists "assistant_feedback_select_own" on public.assistant_feedback;
create policy "assistant_feedback_select_own" on public.assistant_feedback
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "assistant_feedback_insert_own" on public.assistant_feedback;
create policy "assistant_feedback_insert_own" on public.assistant_feedback
  for insert to authenticated with check (
    user_id = auth.uid()
    and exists (select 1 from public.assistant_events e where e.id = event_id and e.user_id = auth.uid())
  );
drop policy if exists "assistant_feedback_update_own" on public.assistant_feedback;
create policy "assistant_feedback_update_own" on public.assistant_feedback
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "assistant_feedback_delete_own" on public.assistant_feedback;
create policy "assistant_feedback_delete_own" on public.assistant_feedback
  for delete to authenticated using (user_id = auth.uid());

revoke all on public.assistant_feedback from anon, authenticated;
grant select, delete on public.assistant_feedback to authenticated;
grant insert (event_id, rating, reason, correction, query_terms, cited_files) on public.assistant_feedback to authenticated;
-- users may change their verdict, never the review status
grant update (rating, reason, correction) on public.assistant_feedback to authenticated;

-- =============================================
-- assistant_tuning: versioned retrieval settings shared by all users.
-- Users read the active version; only the service role writes/activates.
-- =============================================
create table if not exists public.assistant_tuning (
  version text primary key check (version ~ '^[A-Za-z0-9._-]{1,40}$'),
  config jsonb not null,
  active boolean not null default false,
  eval_summary jsonb,
  note text check (length(note) <= 500),
  created_at timestamptz not null default now(),
  activated_at timestamptz
);

create unique index if not exists assistant_tuning_single_active on public.assistant_tuning (active) where active;

alter table public.assistant_tuning enable row level security;

drop policy if exists "assistant_tuning_read_active" on public.assistant_tuning;
create policy "assistant_tuning_read_active" on public.assistant_tuning
  for select to authenticated using (active);

revoke all on public.assistant_tuning from anon, authenticated;
grant select on public.assistant_tuning to authenticated;

-- Activates one version (and deactivates the others). Rollback = activate
-- the previous version again.
create or replace function public.assistant_activate_tuning(p_version text)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.assistant_tuning where version = p_version) then
    raise exception 'Unknown tuning version %', p_version;
  end if;
  update public.assistant_tuning set active = false where active and version <> p_version;
  update public.assistant_tuning set active = true, activated_at = now() where version = p_version;
  return p_version;
end;
$$;

-- =============================================
-- Reports for administrators (service role only).
-- =============================================
create or replace function public.assistant_quality_report(p_days integer default 30)
returns table (
  intent text,
  questions bigint,
  avg_latency_ms numeric,
  p95_latency_ms numeric,
  found_rate numeric,
  grounded_rate numeric,
  helpful bigint,
  unhelpful bigint,
  unhelpful_rate numeric,
  llm_calls bigint,
  tokens_est bigint,
  errors bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with ev as (
    select e.* from public.assistant_events e
    where e.created_at >= now() - make_interval(days => greatest(coalesce(p_days, 30), 1))
  ),
  fb as (
    select f.event_id, f.rating from public.assistant_feedback f join ev on ev.id = f.event_id
  )
  select
    coalesce(ev.intent, 'TOTAL'),
    count(*),
    round(avg(ev.latency_ms)::numeric, 1),
    round((percentile_cont(0.95) within group (order by ev.latency_ms))::numeric, 1),
    round(avg(case when ev.result_count > 0 then 1 else 0 end)::numeric, 3),
    round(avg(case when ev.grounded then 1 when ev.grounded = false then 0 end)::numeric, 3),
    count(*) filter (where fb.rating = 1),
    count(*) filter (where fb.rating = -1),
    round((count(*) filter (where fb.rating = -1))::numeric / nullif(count(fb.rating), 0), 3),
    sum(ev.llm_calls),
    sum(ev.tokens_est),
    count(*) filter (where ev.error_code is not null)
  from ev
  left join fb on fb.event_id = ev.id
  group by rollup (ev.intent)
  order by count(*) desc;
$$;

-- Keywords that keep getting negative feedback: candidates for synonyms,
-- intent rules and new evaluation cases (reviewed by a person first).
create or replace function public.assistant_feedback_terms(p_days integer default 30, p_limit integer default 50)
returns table (term text, negative bigint, positive bigint, reasons text[], corrections bigint)
language sql
stable
security definer
set search_path = public
as $$
  select
    t.term,
    count(*) filter (where f.rating = -1),
    count(*) filter (where f.rating = 1),
    array_remove(array_agg(distinct f.reason), null),
    count(f.correction)
  from public.assistant_feedback f
  cross join lateral unnest(f.query_terms) as t(term)
  where f.created_at >= now() - make_interval(days => greatest(coalesce(p_days, 30), 1))
  group by t.term
  order by count(*) filter (where f.rating = -1) desc, count(*) desc
  limit least(greatest(coalesce(p_limit, 50), 1), 500);
$$;

-- Retention: old events (and their feedback) and expired memories.
create or replace function public.assistant_purge(p_event_days integer default 180)
returns table (events_deleted bigint, memories_deleted bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_events bigint;
  v_memories bigint;
begin
  delete from public.assistant_events where created_at < now() - make_interval(days => greatest(coalesce(p_event_days, 180), 7));
  get diagnostics v_events = row_count;
  delete from public.assistant_memories where expires_at is not null and expires_at <= now();
  get diagnostics v_memories = row_count;
  return query select v_events, v_memories;
end;
$$;

revoke all on function public.assistant_activate_tuning(text) from public, anon, authenticated;
revoke all on function public.assistant_quality_report(integer) from public, anon, authenticated;
revoke all on function public.assistant_feedback_terms(integer, integer) from public, anon, authenticated;
revoke all on function public.assistant_purge(integer) from public, anon, authenticated;
grant execute on function public.assistant_activate_tuning(text) to service_role;
grant execute on function public.assistant_quality_report(integer) to service_role;
grant execute on function public.assistant_feedback_terms(integer, integer) to service_role;
grant execute on function public.assistant_purge(integer) to service_role;
