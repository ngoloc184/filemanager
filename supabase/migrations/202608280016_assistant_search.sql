-- AI Assistant: permission-scoped, read-only search over files and their
-- extracted text. Additive only: no existing table, policy or access rule is
-- changed. Every function resolves the caller with auth.uid() and only ever
-- returns files the caller can already open (same rules as has_file_access).
-- Idempotent.

create extension if not exists pg_trgm;
create extension if not exists unaccent with schema extensions;

-- =============================================
-- fm_normalize: lower-case, accent-free text ("Hợp đồng" -> "hop dong") so
-- Vietnamese text matches with or without diacritics. Works wherever the
-- unaccent extension was installed.
-- =============================================
do $$
declare
  v_schema text;
begin
  select n.nspname into v_schema
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'unaccent';

  execute format($f$
    create or replace function public.fm_normalize(p text)
    returns text
    language sql immutable parallel safe
    as $body$
      select lower(%1$I.unaccent(%2$L::regdictionary, coalesce(p, '')))
    $body$
  $f$, v_schema, v_schema || '.unaccent');
end $$;

-- =============================================
-- Extracted text of each file's current version (search index).
-- Written only by the server indexer (service role); readable only by users
-- who can open the file.
-- =============================================
create table if not exists public.file_contents (
  file_id uuid primary key references public.files(id) on delete cascade,
  version_id uuid,
  status text not null check (status in ('indexed', 'empty', 'unsupported', 'too_large', 'failed')),
  content text not null default '',
  char_count integer not null default 0,
  truncated boolean not null default false,
  error text,
  search_vector tsvector generated always as (
    to_tsvector('simple', public.fm_normalize(left(content, 200000)))
  ) stored,
  indexed_at timestamptz not null default now()
);

create index if not exists idx_file_contents_search on public.file_contents using gin (search_vector);

alter table public.file_contents enable row level security;

drop policy if exists "file_contents_select_accessible" on public.file_contents;
create policy "file_contents_select_accessible"
  on public.file_contents for select to authenticated
  using (public.has_file_access(file_id, 'viewer'));

revoke all on public.file_contents from anon, authenticated;
grant select on public.file_contents to authenticated;
grant all on public.file_contents to service_role;

-- =============================================
-- assistant_accessible_files: every non-trashed file the caller may view,
-- mirroring has_file_access(): owner, direct share, share on the folder or
-- any ancestor, related user (legacy), public flag, short-lived link grant.
-- =============================================
create or replace function public.assistant_accessible_files()
returns table (file_id uuid, access text)
language sql stable security definer
set search_path = public
as $$
  with recursive
  me as (select auth.uid() as uid),
  shared_tree as (
    select fs.folder_id as id
    from public.folder_shares fs
    where fs.grantee_id = (select uid from me)
    union
    select child.id
    from public.folders child
    join shared_tree t on child.parent_id = t.id
  )
  select
    fi.id,
    case
      when fi.owner_id = (select uid from me) then 'owner'
      when exists (
             select 1 from public.file_shares s
             where s.file_id = fi.id and s.grantee_id = (select uid from me)
           )
           or fi.folder_id in (select id from shared_tree)
           or exists (
             select 1 from public.user_connections c
             where c.owner_id = fi.owner_id and c.related_user_id = (select uid from me)
           )
        then 'shared'
      when fi.is_public then 'public'
      else 'link'
    end
  from public.files fi
  where (select uid from me) is not null
    and fi.deleted_at is null
    and (
      fi.owner_id = (select uid from me)
      or fi.is_public
      or exists (
        select 1 from public.file_shares s
        where s.file_id = fi.id and s.grantee_id = (select uid from me)
      )
      or fi.folder_id in (select id from shared_tree)
      or exists (
        select 1 from public.user_connections c
        where c.owner_id = fi.owner_id and c.related_user_id = (select uid from me)
      )
      or exists (
        select 1 from public.share_link_access l
        where l.file_id = fi.id and l.user_id = (select uid from me) and l.expires_at > now()
      )
    );
$$;

-- =============================================
-- assistant_find_files: metadata search (name, folder, tags, type, dates,
-- ownership scope). Terms are compared accent-insensitively with position(),
-- so user input is never interpreted as a pattern.
-- =============================================
create or replace function public.assistant_find_files(
  p_terms text[] default null,
  p_extensions text[] default null,
  p_scope text default 'all',
  p_after timestamptz default null,
  p_before timestamptz default null,
  p_date_field text default 'updated',
  p_sort text default 'relevance',
  p_limit integer default 10,
  p_offset integer default 0
)
returns table (
  file_id uuid,
  name text,
  extension text,
  mime_type text,
  size bigint,
  folder_id uuid,
  folder_name text,
  access text,
  owner_email text,
  created_at timestamptz,
  updated_at timestamptz,
  matched_terms integer,
  score real,
  total_count bigint
)
language plpgsql stable security definer
set search_path = public, extensions
as $$
#variable_conflict use_column
declare
  v_terms text[];
  v_needed integer;
  v_joined text;
  v_exts text[];
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 50);
  v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 1000);
  v_scope text := coalesce(p_scope, 'all');
  v_sort text := coalesce(p_sort, 'relevance');
  v_field text := coalesce(p_date_field, 'updated');
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if v_scope not in ('all', 'mine', 'shared') then
    raise exception 'Invalid scope';
  end if;
  if v_sort not in ('relevance', 'updated', 'created', 'name', 'size') then
    raise exception 'Invalid sort';
  end if;
  if v_field not in ('updated', 'created') then
    raise exception 'Invalid date field';
  end if;

  select coalesce(array_agg(distinct t), '{}') into v_terms
  from (
    select public.fm_normalize(trim(x)) as t
    from unnest(coalesce(p_terms, '{}'::text[])) as x
    limit 12
  ) s
  where length(t) between 1 and 64;

  v_needed := case
    when cardinality(v_terms) = 0 then 0
    else greatest(1, ceil(cardinality(v_terms) / 2.0)::integer)
  end;
  v_joined := array_to_string(v_terms, ' ');

  select array_agg(lower(e)) into v_exts
  from unnest(coalesce(p_extensions, '{}'::text[])) as e
  where e ~* '^[a-z0-9]{1,10}$';

  return query
  with acc as (
    select a.file_id, a.access from public.assistant_accessible_files() a
  ),
  base as (
    select
      f.id, f.name, f.extension, f.mime_type, f.size, f.folder_id, f.owner_id,
      f.created_at, f.updated_at, acc.access,
      d.name as folder_name,
      public.fm_normalize(regexp_replace(f.name, '[-_.]+', ' ', 'g')) as n_name,
      public.fm_normalize(coalesce(d.name, '')) as n_folder,
      coalesce((
        select string_agg(public.fm_normalize(t.name), ' ')
        from public.file_tags ft
        join public.tags t on t.id = ft.tag_id
        where ft.file_id = f.id
      ), '') as n_tags
    from acc
    join public.files f on f.id = acc.file_id
    left join public.folders d on d.id = f.folder_id
    where (
        v_scope = 'all'
        or (v_scope = 'mine' and acc.access = 'owner')
        or (v_scope = 'shared' and acc.access <> 'owner')
      )
      and (v_exts is null or f.extension = any (v_exts))
      and (p_after is null or (case when v_field = 'created' then f.created_at else f.updated_at end) >= p_after)
      and (p_before is null or (case when v_field = 'created' then f.created_at else f.updated_at end) < p_before)
  ),
  scored as (
    select
      b.*,
      (
        select count(*)::integer
        from unnest(v_terms) as term
        where position(term in b.n_name) > 0
           or position(term in b.n_folder) > 0
           or position(term in b.n_tags) > 0
      ) as m,
      case when v_joined = '' then 0 else word_similarity(v_joined, b.n_name) end as sim
    from base b
  )
  select
    s.id, s.name, s.extension, s.mime_type, s.size, s.folder_id, s.folder_name,
    s.access,
    (select up.email from public.user_profiles up where up.id = s.owner_id),
    s.created_at, s.updated_at,
    s.m,
    (s.m + s.sim)::real,
    count(*) over ()
  from scored s
  where s.m >= v_needed
  order by
    case when v_sort = 'relevance' then s.m + s.sim end desc nulls last,
    case when v_sort = 'name' then s.name end asc,
    case when v_sort = 'size' then s.size end desc,
    case when v_sort = 'created' then s.created_at end desc,
    s.updated_at desc,
    s.id
  limit v_limit offset v_offset;
end;
$$;

-- =============================================
-- assistant_snippet: excerpt of the original text around the first term hit.
-- =============================================
create or replace function public.assistant_snippet(
  p_content text,
  p_terms text[],
  p_width integer default 220
)
returns text
language plpgsql immutable
as $$
declare
  v_norm text := public.fm_normalize(left(coalesce(p_content, ''), 200000));
  v_pos integer := 0;
  v_term text;
begin
  foreach v_term in array coalesce(p_terms, '{}'::text[]) loop
    v_term := public.fm_normalize(v_term);
    if length(v_term) >= 2 then
      v_pos := position(v_term in v_norm);
      exit when v_pos > 0;
    end if;
  end loop;

  if v_pos = 0 then
    return left(regexp_replace(coalesce(p_content, ''), '\s+', ' ', 'g'), p_width);
  end if;

  return
    case when v_pos > 81 then '…' else '' end
    || trim(regexp_replace(substring(p_content from greatest(v_pos - 80, 1) for p_width), '\s+', ' ', 'g'))
    || case when v_pos - 80 + p_width < length(p_content) then '…' else '' end;
end;
$$;

-- =============================================
-- assistant_search_content: full-text search over indexed content of files
-- the caller can open. Only the index of the *current* version is used.
-- =============================================
create or replace function public.assistant_search_content(
  p_query text,
  p_terms text[] default null,
  p_extensions text[] default null,
  p_scope text default 'all',
  p_exclude_file uuid default null,
  p_limit integer default 10,
  p_offset integer default 0
)
returns table (
  file_id uuid,
  name text,
  extension text,
  mime_type text,
  size bigint,
  folder_id uuid,
  folder_name text,
  access text,
  owner_email text,
  created_at timestamptz,
  updated_at timestamptz,
  snippet text,
  rank real,
  total_count bigint
)
language plpgsql stable security definer
set search_path = public, extensions
as $$
#variable_conflict use_column
declare
  v_tsq tsquery;
  v_exts text[];
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 50);
  v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 1000);
  v_scope text := coalesce(p_scope, 'all');
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if v_scope not in ('all', 'mine', 'shared') then
    raise exception 'Invalid scope';
  end if;

  v_tsq := websearch_to_tsquery('simple', public.fm_normalize(left(coalesce(p_query, ''), 300)));
  if numnode(v_tsq) = 0 then
    return;
  end if;

  select array_agg(lower(e)) into v_exts
  from unnest(coalesce(p_extensions, '{}'::text[])) as e
  where e ~* '^[a-z0-9]{1,10}$';

  return query
  with acc as (
    select a.file_id, a.access from public.assistant_accessible_files() a
  ),
  hits as (
    select
      f.id, f.name, f.extension, f.mime_type, f.size, f.folder_id, f.owner_id,
      f.created_at, f.updated_at, acc.access, d.name as folder_name,
      fc.content,
      ts_rank_cd(fc.search_vector, v_tsq) as r
    from acc
    join public.files f on f.id = acc.file_id
    join public.file_contents fc
      on fc.file_id = f.id
     and fc.status = 'indexed'
     and fc.version_id is not distinct from f.current_version_id
    left join public.folders d on d.id = f.folder_id
    where fc.search_vector @@ v_tsq
      and (p_exclude_file is null or f.id <> p_exclude_file)
      and (
        v_scope = 'all'
        or (v_scope = 'mine' and acc.access = 'owner')
        or (v_scope = 'shared' and acc.access <> 'owner')
      )
      and (v_exts is null or f.extension = any (v_exts))
  ),
  page as (
    select h.*, count(*) over () as total
    from hits h
    order by h.r desc, h.updated_at desc, h.id
    limit v_limit offset v_offset
  )
  select
    p.id, p.name, p.extension, p.mime_type, p.size, p.folder_id, p.folder_name,
    p.access,
    (select up.email from public.user_profiles up where up.id = p.owner_id),
    p.created_at, p.updated_at,
    public.assistant_snippet(p.content, coalesce(p_terms, regexp_split_to_array(p_query, '\s+'))),
    p.r::real,
    p.total
  from page p
  order by p.r desc, p.updated_at desc, p.id;
end;
$$;

-- =============================================
-- assistant_file_stats: counts for "thống kê file của tôi".
-- =============================================
create or replace function public.assistant_file_stats(p_indexable text[] default null)
returns table (
  owned_files bigint,
  owned_bytes bigint,
  owned_folders bigint,
  shared_files bigint,
  public_files bigint,
  indexable_files bigint,
  indexed_files bigint,
  last_upload timestamptz,
  top_extensions jsonb
)
language plpgsql stable security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  return query
  with acc as (
    select a.file_id, a.access, f.size, f.extension, f.created_at, f.current_version_id
    from public.assistant_accessible_files() a
    join public.files f on f.id = a.file_id
  )
  select
    count(*) filter (where acc.access = 'owner'),
    coalesce(sum(acc.size) filter (where acc.access = 'owner'), 0)::bigint,
    (select count(*) from public.folders fo where fo.owner_id = auth.uid() and fo.deleted_at is null),
    count(*) filter (where acc.access in ('shared', 'link')),
    count(*) filter (where acc.access = 'public'),
    count(*) filter (where acc.extension = any (coalesce(p_indexable, '{}'::text[]))),
    count(*) filter (
      where exists (
        select 1 from public.file_contents fc
        where fc.file_id = acc.file_id
          and fc.version_id is not distinct from acc.current_version_id
      )
    ),
    max(acc.created_at) filter (where acc.access = 'owner'),
    coalesce((
      select jsonb_agg(jsonb_build_object('extension', x.extension, 'count', x.n) order by x.n desc)
      from (
        select coalesce(nullif(a2.extension, ''), '(none)') as extension, count(*) as n
        from acc a2
        where a2.access = 'owner'
        group by 1
        order by 2 desc
        limit 6
      ) x
    ), '[]'::jsonb)
  from acc;
end;
$$;

-- =============================================
-- assistant_my_shares: items the caller owns (or shared) and who has access.
-- p_grantee matches an e-mail or a name typed without accents/spaces
-- ("Nguyễn Văn A" -> "nguyenvana").
-- =============================================
create or replace function public.assistant_my_shares(
  p_grantee text default null,
  p_limit integer default 20
)
returns table (
  item_type text,
  item_id uuid,
  name text,
  folder_id uuid,
  grantee_email text,
  role text,
  shared_at timestamptz,
  total_count bigint
)
language plpgsql stable security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_needle text := regexp_replace(public.fm_normalize(coalesce(p_grantee, '')), '[^a-z0-9@]', '', 'g');
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  return query
  with items as (
    select 'file'::text as kind, f.id, f.name, f.folder_id as parent, s.grantee_id, s.role, s.created_at
    from public.file_shares s
    join public.files f on f.id = s.file_id
    where f.deleted_at is null
      and (f.owner_id = auth.uid() or s.granted_by = auth.uid())
    union all
    select 'folder'::text, fo.id, fo.name, fo.parent_id, s.grantee_id, s.role, s.created_at
    from public.folder_shares s
    join public.folders fo on fo.id = s.folder_id
    where fo.deleted_at is null
      and (fo.owner_id = auth.uid() or s.granted_by = auth.uid())
  ),
  matched as (
    select i.*, up.email
    from items i
    join public.user_profiles up on up.id = i.grantee_id
    where v_needle = ''
       or position(v_needle in regexp_replace(public.fm_normalize(up.email), '[^a-z0-9@]', '', 'g')) > 0
  )
  select m.kind, m.id, m.name, m.parent, m.email, m.role, m.created_at, count(*) over ()
  from matched m
  order by m.created_at desc
  limit v_limit;
end;
$$;

-- =============================================
-- assistant_index_candidates: current versions the caller can open that have
-- no up-to-date index yet (or one specific file). Used by the server indexer,
-- which downloads the object with the caller's own session.
-- =============================================
create or replace function public.assistant_index_candidates(
  p_extensions text[],
  p_file_id uuid default null,
  p_limit integer default 5
)
returns table (
  file_id uuid,
  version_id uuid,
  storage_path text,
  name text,
  extension text,
  mime_type text,
  size bigint
)
language plpgsql stable security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  return query
  select f.id, v.id, v.storage_path, f.name, f.extension, v.mime_type, v.size
  from public.assistant_accessible_files() a
  join public.files f on f.id = a.file_id
  join public.file_versions v on v.id = f.current_version_id
  left join public.file_contents fc on fc.file_id = f.id
  where f.extension = any (coalesce(p_extensions, '{}'::text[]))
    and (p_file_id is null or f.id = p_file_id)
    and (fc.file_id is null or fc.version_id is distinct from f.current_version_id)
  order by f.updated_at desc
  limit least(greatest(coalesce(p_limit, 5), 1), 20);
end;
$$;

-- =============================================
-- assistant_get_content: indexed text of one file for summaries / similar
-- documents. Returns nothing (not even the name) without access.
-- =============================================
create or replace function public.assistant_get_content(
  p_file_id uuid,
  p_max_chars integer default 20000
)
returns table (
  file_id uuid,
  name text,
  extension text,
  folder_id uuid,
  folder_name text,
  updated_at timestamptz,
  status text,
  content text,
  is_current boolean
)
language plpgsql stable security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if auth.uid() is null
     or not exists (select 1 from public.assistant_accessible_files() a where a.file_id = p_file_id)
     or not public.has_file_access(p_file_id, 'viewer') then
    return;
  end if;

  return query
  select
    f.id, f.name, f.extension, f.folder_id, d.name, f.updated_at,
    fc.status,
    left(coalesce(fc.content, ''), least(greatest(coalesce(p_max_chars, 20000), 0), 50000)),
    fc.version_id is not distinct from f.current_version_id
  from public.files f
  left join public.folders d on d.id = f.folder_id
  left join public.file_contents fc on fc.file_id = f.id
  where f.id = p_file_id;
end;
$$;

-- =============================================
-- Grants: callable by signed-in users only.
-- =============================================
revoke all on function public.assistant_accessible_files() from public, anon;
revoke all on function public.assistant_find_files(text[], text[], text, timestamptz, timestamptz, text, text, integer, integer) from public, anon;
revoke all on function public.assistant_search_content(text, text[], text[], text, uuid, integer, integer) from public, anon;
revoke all on function public.assistant_file_stats(text[]) from public, anon;
revoke all on function public.assistant_my_shares(text, integer) from public, anon;
revoke all on function public.assistant_index_candidates(text[], uuid, integer) from public, anon;
revoke all on function public.assistant_get_content(uuid, integer) from public, anon;

grant execute on function public.assistant_accessible_files() to authenticated, service_role;
grant execute on function public.assistant_find_files(text[], text[], text, timestamptz, timestamptz, text, text, integer, integer) to authenticated, service_role;
grant execute on function public.assistant_search_content(text, text[], text[], text, uuid, integer, integer) to authenticated, service_role;
grant execute on function public.assistant_file_stats(text[]) to authenticated, service_role;
grant execute on function public.assistant_my_shares(text, integer) to authenticated, service_role;
grant execute on function public.assistant_index_candidates(text[], uuid, integer) to authenticated, service_role;
grant execute on function public.assistant_get_content(uuid, integer) to authenticated, service_role;
grant execute on function public.fm_normalize(text) to anon, authenticated, service_role;
grant execute on function public.assistant_snippet(text, text[], integer) to authenticated, service_role;
