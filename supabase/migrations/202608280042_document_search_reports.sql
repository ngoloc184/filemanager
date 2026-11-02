-- Documents: inbox views, search, dashboard counts, processing reports and
-- the deadline reminder job.
-- Run after 202608280036_documents_core.sql (and the other 03x migrations).
-- Idempotent.
--
-- Views ('mine' = assigned to the caller or to a department the caller heads;
-- an open assignment is pending, seen or in_progress; today is the company's
-- date, org_now_date):
--   needs_me           presented to me, a lead/support assignment of mine, my
--                      draft returned to me (revision > 1), my pending approval
--                      step, or (clerk) a signed document to issue
--   for_info           an info assignment of mine (or of my department)
--   awaiting_approval  my pending approval step
--   due_soon           needs_me, due between today and 2 working days ahead
--   overdue            a lead/support assignment of mine, or one I assigned,
--                      or a document presented to me, past its deadline
--   to_register        (clerk) incoming drafts
--   to_issue           (clerk) signed documents
--   following          registers I manage or follow, my unfinished documents
--   created_by_me      documents I created
--   done               work I finished, steps I acted on, documents I
--                      registered or issued
--   all                every document I can read
-- Every view is limited to the caller's company and to can_read_document.
--
-- Reminders: run_document_reminders (service role, called by
-- /api/cron/document-reminders) notifies lead/support assignees one working
-- day before, on, and after their deadline, at most once per assignment,
-- kind and day (document_reminder_log). Assigners hear about assignments that
-- are 2 or more working days late.
--
-- Rollback (manual):
--   drop function if exists public.run_document_reminders();
--   drop function if exists public.report_outgoing(date, date);
--   drop function if exists public.report_incoming_processing(date, date, uuid);
--   drop function if exists public.document_dashboard();
--   drop function if exists public.search_documents(jsonb, int, int);
--   drop function if exists public.doc_in_view(uuid, text, uuid);
--   drop table if exists public.document_reminder_log;

-- =============================================
-- Reminder log: one row per assignment, kind and day (idempotent cron)
-- =============================================
create table if not exists public.document_reminder_log (
  assignment_id uuid not null references public.document_assignments(id) on delete cascade,
  kind text not null,
  day date not null,
  primary key (assignment_id, kind, day)
);

alter table public.document_reminder_log enable row level security;
revoke all on table public.document_reminder_log from public, anon, authenticated;
grant all on table public.document_reminder_log to service_role;

-- open assignments of a user: the searches below filter on these
create index if not exists idx_document_assignments_assigned_by
  on public.document_assignments (assigned_by, status);

-- =============================================
-- doc_in_view: one predicate per view (internal; search and dashboard share it)
-- =============================================
create or replace function public.doc_in_view(p_document_id uuid, p_view text, p_user_id uuid)
returns boolean
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_doc public.documents;
  v_today date;
  v_open constant text[] := array['pending', 'seen', 'in_progress'];
  v_final constant text[] := array['completed', 'cancelled', 'archived', 'issued', 'rejected', 'withdrawn', 'recalled'];
  v_heads uuid[];
  v_my_due date;
  v_needs_me boolean;
begin
  if p_document_id is null or p_user_id is null then
    return false;
  end if;
  select * into v_doc from public.documents where id = p_document_id;
  if v_doc.id is null then
    return false;
  end if;
  if p_view = 'all' then
    return true;
  end if;
  if p_view = 'created_by_me' then
    return v_doc.created_by = p_user_id;
  end if;
  if p_view = 'to_register' then
    return v_doc.direction = 'incoming' and v_doc.status = 'draft'
      and public.has_org_role_user(v_doc.org_id, 'clerk', p_user_id);
  end if;
  if p_view = 'to_issue' then
    return v_doc.status = 'signed' and public.has_org_role_user(v_doc.org_id, 'clerk', p_user_id);
  end if;
  if p_view = 'awaiting_approval' then
    return exists (
      select 1 from public.document_approval_steps s
      where s.document_id = v_doc.id and s.approver_user_id = p_user_id and s.status = 'pending'
    );
  end if;
  if p_view = 'following' then
    return coalesce((v_doc.created_by = p_user_id and not (v_doc.status = any (v_final)))
      or (v_doc.register_id is not null and exists (
        select 1 from public.doc_register_roles rr
        where rr.register_id = v_doc.register_id and rr.user_id = p_user_id
      )), false);
  end if;

  v_heads := array(select public.headed_departments_of(p_user_id));
  v_today := public.org_now_date(v_doc.org_id);

  if p_view = 'for_info' then
    return exists (
      select 1 from public.document_assignments a
      where a.document_id = v_doc.id and a.role = 'info' and a.status = any (v_open)
        and (
          a.assignee_user_id = p_user_id
          or a.assignee_department_id = any (v_heads)
          -- department info recipients read it as members (can_read_document rule e)
          or a.assignee_department_id = public.member_department(v_doc.org_id, p_user_id)
        )
    );
  end if;

  if p_view = 'done' then
    return exists (
        select 1 from public.document_assignments a
        where a.document_id = v_doc.id and a.status = 'done'
          and (a.assignee_user_id = p_user_id or a.assignee_department_id = any (v_heads))
      )
      or exists (
        select 1 from public.document_approval_steps s
        where s.document_id = v_doc.id and s.status in ('approved', 'returned', 'rejected')
          and (s.approver_user_id = p_user_id or s.acted_by = p_user_id)
      )
      or exists (
        select 1 from public.document_events e
        where e.document_id = v_doc.id and e.action in ('registered', 'issued') and e.actor_id = p_user_id
      );
  end if;

  if p_view = 'overdue' then
    return coalesce(exists (
        select 1 from public.document_assignments a
        where a.document_id = v_doc.id and a.status = any (v_open) and a.due_date < v_today
          and (
            (a.role in ('lead', 'support')
              and (a.assignee_user_id = p_user_id or a.assignee_department_id = any (v_heads)))
            or a.assigned_by = p_user_id
          )
      )
      or (v_doc.status in ('submitted', 'in_progress') and v_doc.presented_to = p_user_id
          and v_doc.due_date < v_today), false);
  end if;

  if p_view not in ('needs_me', 'due_soon') then
    raise exception 'Unknown view: %', p_view using errcode = '22023';
  end if;

  -- coalesce: a null presented_to/created_by must read as 'no', or due_soon
  -- below would run for documents that do not need the caller
  v_needs_me := coalesce((v_doc.presented_to = p_user_id and v_doc.status = 'submitted')
    or exists (
      select 1 from public.document_assignments a
      where a.document_id = v_doc.id and a.role in ('lead', 'support') and a.status = any (v_open)
        and (a.assignee_user_id = p_user_id or a.assignee_department_id = any (v_heads))
    )
    -- returned to the author
    or (v_doc.status = 'draft' and v_doc.created_by = p_user_id
        and v_doc.direction <> 'incoming' and v_doc.revision > 1)
    or exists (
      select 1 from public.document_approval_steps s
      where s.document_id = v_doc.id and s.revision = v_doc.revision
        and s.approver_user_id = p_user_id and s.status = 'pending'
    )
    or (v_doc.status = 'signed' and public.has_org_role_user(v_doc.org_id, 'clerk', p_user_id)), false);

  if p_view = 'needs_me' or not v_needs_me then
    return v_needs_me;
  end if;

  -- due_soon: my earliest open deadline, else the document's
  select min(a.due_date) into v_my_due
  from public.document_assignments a
  where a.document_id = v_doc.id and a.status = any (v_open)
    and (a.assignee_user_id = p_user_id or a.assignee_department_id = any (v_heads));
  return coalesce(coalesce(v_my_due, v_doc.due_date)
    between v_today and public.doc_add_working_days(v_doc.org_id, v_today, 2), false);
end;
$$;

-- =============================================
-- search_documents: the inbox list (views + filters), one page at a time
-- =============================================
create or replace function public.search_documents(
  p_filters jsonb default '{}',
  p_limit int default 50,
  p_offset int default 0
)
returns table (
  id uuid,
  direction text,
  status text,
  subject text,
  notation text,
  number int,
  arrival_number int,
  arrival_date date,
  issued_date date,
  issuing_org_name text,
  type_name text,
  urgency text,
  confidentiality text,
  due_date date,
  my_due_date date,
  updated_at timestamptz,
  created_at timestamptz,
  recipients_summary text,
  total_count bigint
)
language plpgsql stable security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_tz text;
  f jsonb := coalesce(p_filters, '{}');
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_view text;
  v_direction text;
  v_statuses text[];
  v_register uuid;
  v_year int;
  v_q text;
  v_like text;
  v_tsq tsquery;
  v_type uuid;
  v_field uuid;
  v_urgency text;
  v_conf text;
  v_from date;
  v_to date;
  v_dept uuid;
  v_ext uuid;
  v_heads uuid[];
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if jsonb_typeof(f) <> 'object' then
    raise exception 'Invalid filters' using errcode = '22023';
  end if;
  v_org := public.my_org_id();
  if v_org is null then
    return;
  end if;
  select o.timezone into v_tz from public.organizations o where o.id = v_org;
  v_tz := coalesce(v_tz, 'Asia/Ho_Chi_Minh');

  v_view := coalesce(public.doc_json_text(f, 'view', 40, 'View'), 'all');
  if v_view not in ('needs_me', 'for_info', 'awaiting_approval', 'due_soon', 'overdue', 'to_register',
                    'to_issue', 'following', 'created_by_me', 'done', 'all') then
    raise exception 'Unknown view: %', v_view using errcode = '22023';
  end if;

  v_direction := public.doc_json_text(f, 'direction', 20, 'Direction');
  if v_direction is not null and v_direction not in ('incoming', 'outgoing', 'internal') then
    raise exception 'Unknown direction' using errcode = '22023';
  end if;

  if jsonb_typeof(f -> 'status') = 'array' then
    select coalesce(array_agg(s), '{}') into v_statuses
    from jsonb_array_elements_text(f -> 'status') s
    where btrim(s) <> '';
    if cardinality(v_statuses) = 0 then
      v_statuses := null;
    end if;
  elsif public.doc_json_text(f, 'status', 40, 'Status') is not null then
    v_statuses := array[public.doc_json_text(f, 'status', 40, 'Status')];
  end if;

  v_register := public.doc_json_uuid(f, 'register_id', 'Register');
  v_year := public.doc_json_int(f, 'year', 'Year');
  v_type := public.doc_json_uuid(f, 'doc_type_id', 'Document type');
  v_field := public.doc_json_uuid(f, 'field_id', 'Field');
  v_urgency := public.doc_json_text(f, 'urgency', 20, 'Urgency');
  if v_urgency is not null and v_urgency not in ('normal', 'khan', 'thuong_khan', 'hoa_toc') then
    raise exception 'Unknown urgency' using errcode = '22023';
  end if;
  v_conf := public.doc_json_text(f, 'confidentiality', 20, 'Confidentiality');
  if v_conf is not null and v_conf not in ('normal', 'internal', 'restricted', 'confidential') then
    raise exception 'Unknown confidentiality' using errcode = '22023';
  end if;
  v_from := public.doc_json_date(f, 'date_from', 'From date');
  v_to := public.doc_json_date(f, 'date_to', 'To date');
  v_dept := public.doc_json_uuid(f, 'department_id', 'Department');
  v_ext := public.doc_json_uuid(f, 'external_org_id', 'Organization');

  v_q := public.fm_normalize(btrim(coalesce(public.doc_json_text(f, 'q', 200, 'Search text'), '')));
  if v_q = '' then
    v_q := null;
  else
    -- a literal match: % and _ typed by the user are not wildcards
    v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    v_tsq := websearch_to_tsquery('simple', v_q);
    if numnode(v_tsq) = 0 then
      v_tsq := null;
    end if;
  end if;

  v_heads := array(select public.headed_departments_of(v_uid));

  return query
  with hits as (
    select
      d.id, d.direction, d.status, d.subject, d.notation, d.number, d.arrival_number,
      d.arrival_date, d.issued_date, d.issuing_org_name, d.doc_type_id, d.urgency,
      d.confidentiality, d.due_date, d.updated_at, d.created_at,
      (
        select min(a.due_date) from public.document_assignments a
        where a.document_id = d.id and a.status in ('pending', 'seen', 'in_progress')
          and (a.assignee_user_id = v_uid or a.assignee_department_id = any (v_heads))
      ) as my_due
    from public.documents d
    where d.org_id = v_org
      and (v_direction is null or d.direction = v_direction)
      and (v_statuses is null or d.status = any (v_statuses))
      and (v_register is null or d.register_id = v_register)
      and (v_year is null or extract(year from coalesce(
            d.issued_date, d.arrival_date, (d.created_at at time zone v_tz)::date)) = v_year)
      and (v_type is null or d.doc_type_id = v_type)
      and (v_field is null or d.field_id = v_field)
      and (v_urgency is null or d.urgency = v_urgency)
      and (v_conf is null or d.confidentiality = v_conf)
      and (v_from is null or coalesce(d.issued_date, d.arrival_date) >= v_from)
      and (v_to is null or coalesce(d.issued_date, d.arrival_date) <= v_to)
      and (v_ext is null or d.external_org_id = v_ext)
      and (v_dept is null or d.drafting_department_id = v_dept or exists (
            select 1 from public.document_assignments a
            where a.document_id = d.id and a.assignee_department_id = v_dept and a.status <> 'revoked'
          ))
      and (v_q is null
           or d.search_norm ilike v_like
           or (v_tsq is not null and exists (
                select 1
                from public.document_files df
                join public.files fi on fi.id = df.file_id
                join public.file_contents fc
                  on fc.file_id = df.file_id
                 and fc.status = 'indexed'
                 and fc.version_id is not distinct from fi.current_version_id
                where df.document_id = d.id and fc.search_vector @@ v_tsq
              )))
      and (v_view = 'all' or public.doc_in_view(d.id, v_view, v_uid))
      and public.can_read_document(d.id)
  ),
  page as (
    select h.*, count(*) over () as total
    from hits h
    order by
      case h.urgency when 'hoa_toc' then 3 when 'thuong_khan' then 2 when 'khan' then 1 else 0 end desc,
      coalesce(h.my_due, h.due_date) asc nulls last,
      h.updated_at desc,
      h.id
    limit v_limit offset v_offset
  )
  select
    p.id, p.direction, p.status, p.subject, p.notation, p.number, p.arrival_number,
    p.arrival_date, p.issued_date, p.issuing_org_name,
    (select t.name from public.doc_types t where t.id = p.doc_type_id),
    p.urgency, p.confidentiality, p.due_date, p.my_due, p.updated_at, p.created_at,
    (
      select case
        when count(*) = 0 then null
        when count(*) <= 3 then string_agg(r.name_snapshot, ', ' order by r.rn)
        else string_agg(r.name_snapshot, ', ' order by r.rn) filter (where r.rn <= 3)
             || ' +' || (count(*) - 3)
      end
      from (
        select dr.name_snapshot,
               row_number() over (order by dr.kind, dr.name_snapshot, dr.id) as rn
        from public.document_recipients dr
        where dr.document_id = p.id
      ) r
    ),
    p.total
  from page p
  order by
    case p.urgency when 'hoa_toc' then 3 when 'thuong_khan' then 2 when 'khan' then 1 else 0 end desc,
    coalesce(p.my_due, p.due_date) asc nulls last,
    p.updated_at desc,
    p.id;
end;
$$;

-- =============================================
-- document_dashboard: counts for the inbox cards
-- =============================================
create or replace function public.document_dashboard()
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_dept uuid;
  v_heads uuid[];
  v_result jsonb;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_org := public.my_org_id();
  if v_org is null then
    return jsonb_build_object(
      'needs_me', 0, 'for_info', 0, 'awaiting_approval', 0, 'due_soon', 0,
      'overdue', 0, 'to_register', 0, 'to_issue', 0, 'urgent', 0);
  end if;
  v_dept := public.member_department(v_org, v_uid);
  v_heads := array(select public.headed_departments_of(v_uid));

  with candidates as (
    -- every document any card can count: something points at the caller,
    -- or it waits for a clerk (the predicates below decide the rest)
    select d.id, d.urgency
    from public.documents d
    where d.org_id = v_org
      and (
        d.presented_to = v_uid
        or d.created_by = v_uid
        or (d.direction = 'incoming' and d.status = 'draft')
        or d.status = 'signed'
        or exists (
          select 1 from public.document_assignments a
          where a.document_id = d.id and a.status in ('pending', 'seen', 'in_progress')
            and (a.assignee_user_id = v_uid or a.assigned_by = v_uid
                 or a.assignee_department_id = any (v_heads)
                 or (v_dept is not null and a.assignee_department_id = v_dept))
        )
        or exists (
          select 1 from public.document_approval_steps s
          where s.document_id = d.id and s.approver_user_id = v_uid and s.status = 'pending'
        )
      )
      and public.can_read_document(d.id)
  ),
  flags as (
    select
      c.urgency,
      public.doc_in_view(c.id, 'needs_me', v_uid) as needs_me,
      public.doc_in_view(c.id, 'for_info', v_uid) as for_info,
      public.doc_in_view(c.id, 'awaiting_approval', v_uid) as awaiting_approval,
      public.doc_in_view(c.id, 'due_soon', v_uid) as due_soon,
      public.doc_in_view(c.id, 'overdue', v_uid) as overdue,
      public.doc_in_view(c.id, 'to_register', v_uid) as to_register,
      public.doc_in_view(c.id, 'to_issue', v_uid) as to_issue
    from candidates c
  )
  select jsonb_build_object(
    'needs_me', count(*) filter (where needs_me),
    'for_info', count(*) filter (where for_info),
    'awaiting_approval', count(*) filter (where awaiting_approval),
    'due_soon', count(*) filter (where due_soon),
    'overdue', count(*) filter (where overdue),
    'to_register', count(*) filter (where to_register),
    'to_issue', count(*) filter (where to_issue),
    'urgent', count(*) filter (where needs_me and urgency <> 'normal')
  ) into v_result
  from flags;
  return v_result;
end;
$$;

-- =============================================
-- report_incoming_processing: lead assignments of incoming documents
-- =============================================
-- One row per department and assignee (a department row has no assignee),
-- then a 'Total' row (department_id and assignee null). Revoked and returned
-- assignments are not counted, so received = done_on_time + done_late +
-- open_on_time + open_overdue on every row.
create or replace function public.report_incoming_processing(
  p_from date,
  p_to date,
  p_department_id uuid default null
)
returns table (
  department_id uuid,
  department_name text,
  assignee_user_id uuid,
  assignee_name text,
  received int,
  done_on_time int,
  done_late int,
  open_on_time int,
  open_overdue int,
  avg_days numeric
)
language plpgsql stable security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_tz text;
  v_today date;
  v_all boolean;
  v_heads uuid[];
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_org := public.my_org_id();
  if v_org is null then
    raise exception 'Reports need a company' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Choose a valid date range' using errcode = '22023';
  end if;
  if p_to - p_from > 3660 then
    raise exception 'The date range is too long (max 10 years)' using errcode = '22023';
  end if;

  v_all := public.has_org_role_user(v_org, 'leader', v_uid)
    or public.has_org_role_user(v_org, 'org_admin', v_uid)
    or public.has_org_role_user(v_org, 'clerk', v_uid);
  if not v_all then
    if not public.has_org_role_user(v_org, 'dept_head', v_uid) then
      raise exception 'Only leaders, clerks, admins and department heads can view reports'
        using errcode = '42501';
    end if;
    v_heads := array(select public.headed_departments_of(v_uid));
    if p_department_id is not null and not (p_department_id = any (v_heads)) then
      raise exception 'You can only view reports for the departments you head' using errcode = '42501';
    end if;
  end if;
  if p_department_id is not null and not exists (
    select 1 from public.departments dp where dp.id = p_department_id and dp.org_id = v_org
  ) then
    raise exception 'Department not found' using errcode = 'P0002';
  end if;

  select o.timezone into v_tz from public.organizations o where o.id = v_org;
  v_tz := coalesce(v_tz, 'Asia/Ho_Chi_Minh');
  v_today := public.org_now_date(v_org);

  return query
  with leads as (
    select
      coalesce(a.assignee_department_id, public.member_department(v_org, a.assignee_user_id)) as dept_id,
      a.assignee_user_id as user_id,
      a.status,
      a.due_date,
      a.assigned_at,
      a.done_at,
      (a.done_at at time zone v_tz)::date as done_day
    from public.document_assignments a
    join public.documents d on d.id = a.document_id
    where d.org_id = v_org
      and d.direction = 'incoming'
      and d.arrival_date between p_from and p_to
      and a.role = 'lead'
      and a.status in ('pending', 'seen', 'in_progress', 'done')
  ),
  scoped as (
    select l.* from leads l
    where (p_department_id is null or l.dept_id = p_department_id)
      and (v_all or l.dept_id = any (v_heads))
  ),
  measured as (
    select
      s.dept_id, s.user_id,
      (s.status = 'done' and (s.due_date is null or s.done_day <= s.due_date)) as on_time_done,
      (s.status = 'done' and s.due_date is not null and s.done_day > s.due_date) as late_done,
      (s.status <> 'done' and (s.due_date is null or s.due_date >= v_today)) as on_time_open,
      (s.status <> 'done' and s.due_date < v_today) as overdue_open,
      case when s.status = 'done' and s.done_at is not null
        then extract(epoch from (s.done_at - s.assigned_at)) / 86400.0 end as days
    from scoped s
  ),
  grouped as (
    select
      grouping(m.dept_id, m.user_id) as g,
      m.dept_id, m.user_id,
      count(*)::int as received,
      count(*) filter (where m.on_time_done)::int as done_on_time,
      count(*) filter (where m.late_done)::int as done_late,
      count(*) filter (where m.on_time_open)::int as open_on_time,
      count(*) filter (where m.overdue_open)::int as open_overdue,
      round(avg(m.days)::numeric, 1) as avg_days
    from measured m
    group by grouping sets ((m.dept_id, m.user_id), ())
  )
  select
    case when g.g = 0 then g.dept_id end,
    case
      when g.g <> 0 then 'Total'
      else coalesce((select dp.name from public.departments dp where dp.id = g.dept_id), 'No department')
    end,
    case when g.g = 0 then g.user_id end,
    case when g.g = 0 and g.user_id is not null then public.doc_user_name(g.user_id) end,
    g.received, g.done_on_time, g.done_late, g.open_on_time, g.open_overdue, g.avg_days
  from grouped g
  order by
    (g.g <> 0),
    (select dp.sort_order from public.departments dp where dp.id = g.dept_id) nulls last,
    (select dp.name from public.departments dp where dp.id = g.dept_id) nulls last,
    (g.user_id is not null),
    public.doc_user_name(g.user_id) nulls first;
end;
$$;

-- =============================================
-- report_outgoing: issued outgoing/internal documents per month and type
-- =============================================
create or replace function public.report_outgoing(p_from date, p_to date)
returns table (month text, type_name text, issued int, avg_approval_hours numeric)
language plpgsql stable security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_tz text;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_org := public.my_org_id();
  if v_org is null then
    raise exception 'Reports need a company' using errcode = '42501';
  end if;
  if not (public.has_org_role_user(v_org, 'leader', v_uid)
          or public.has_org_role_user(v_org, 'org_admin', v_uid)
          or public.has_org_role_user(v_org, 'clerk', v_uid)) then
    raise exception 'Only leaders, clerks and admins can view this report' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Choose a valid date range' using errcode = '22023';
  end if;
  if p_to - p_from > 3660 then
    raise exception 'The date range is too long (max 10 years)' using errcode = '22023';
  end if;

  select o.timezone into v_tz from public.organizations o where o.id = v_org;
  v_tz := coalesce(v_tz, 'Asia/Ho_Chi_Minh');

  return query
  with issued_docs as (
    select
      coalesce(d.issued_date, (d.issued_at at time zone v_tz)::date) as day,
      coalesce((select t.name from public.doc_types t where t.id = d.doc_type_id), 'No type') as type_name,
      -- submitted_at is the last (final) submission of the approval chain
      case when d.signed_at is not null and d.submitted_at is not null and d.signed_at >= d.submitted_at
        then extract(epoch from (d.signed_at - d.submitted_at)) / 3600.0 end as hours
    from public.documents d
    where d.org_id = v_org
      and d.direction in ('outgoing', 'internal')
      and d.issued_at is not null
  )
  select
    to_char(i.day, 'YYYY-MM'),
    i.type_name,
    count(*)::int,
    round(avg(i.hours)::numeric, 1)
  from issued_docs i
  where i.day between p_from and p_to
  group by to_char(i.day, 'YYYY-MM'), i.type_name
  order by 1, 2;
end;
$$;

-- =============================================
-- run_document_reminders: deadline reminders (service role / cron only)
-- =============================================
-- Lead/support assignments that are still open on documents still in
-- progress: 'document.due_tomorrow' (the deadline is the next working day),
-- 'document.due_today', 'document.overdue'. An assignment 2 or more working
-- days late also tells whoever assigned it. Department assignments go to the
-- department head. The log row is written first, so a second run on the same
-- day sends nothing. Returns the new notification ids (for Web Push).
create or replace function public.run_document_reminders()
returns table (notification_id uuid)
language plpgsql security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  r record;
  v_kind text;
  v_title text;
  v_user uuid;
  v_id uuid;
  v_logged int;
  v_name text;
begin
  for r in
    select
      a.id as assignment_id, a.document_id, a.assignee_user_id, a.assignee_department_id,
      a.assigned_by, a.due_date, d.subject, d.org_id,
      public.org_now_date(d.org_id) as today
    from public.document_assignments a
    join public.documents d on d.id = a.document_id
    where a.role in ('lead', 'support')
      and a.status in ('pending', 'seen', 'in_progress')
      and a.due_date is not null
      and d.status not in ('completed', 'cancelled', 'archived', 'issued', 'rejected', 'withdrawn', 'recalled')
    order by d.org_id, a.due_date, a.id
  loop
    if r.due_date < r.today then
      v_kind := 'document.overdue';
      v_title := 'Overdue since ' || to_char(r.due_date, 'DD/MM') || ': ' || r.subject;
    elsif r.due_date = r.today then
      v_kind := 'document.due_today';
      v_title := 'Due today: ' || r.subject;
    elsif r.due_date = public.doc_add_working_days(r.org_id, r.today, 1) then
      v_kind := 'document.due_tomorrow';
      v_title := 'Due tomorrow: ' || r.subject;
    else
      continue;
    end if;

    insert into public.document_reminder_log (assignment_id, kind, day)
    values (r.assignment_id, v_kind, r.today)
    on conflict do nothing;
    get diagnostics v_logged = row_count;
    if v_logged = 0 then
      continue;
    end if;

    if r.assignee_user_id is not null then
      v_user := r.assignee_user_id;
    else
      select dp.head_user_id into v_user
      from public.departments dp
      where dp.id = r.assignee_department_id and dp.archived_at is null;
    end if;
    if v_user is not null and public.is_org_member_user(r.org_id, v_user) then
      v_id := public.doc_notify(v_user, r.document_id, v_kind, v_title);
      if v_id is not null then
        notification_id := v_id;
        return next;
      end if;
    end if;

    -- 2+ working days late: the person who assigned it hears about it too
    if v_kind = 'document.overdue'
       and r.assigned_by is not null
       and r.assigned_by is distinct from v_user
       and public.doc_add_working_days(r.org_id, r.due_date, 2) <= r.today
       and public.is_org_member_user(r.org_id, r.assigned_by) then
      if r.assignee_user_id is not null then
        v_name := coalesce(public.doc_user_name(r.assignee_user_id), 'Someone');
      else
        select coalesce(dp.name, 'A department') into v_name
        from public.departments dp where dp.id = r.assignee_department_id;
        v_name := coalesce(v_name, 'A department');
      end if;
      v_id := public.doc_notify(r.assigned_by, r.document_id, 'document.overdue',
        v_name || ' is overdue: ' || r.subject);
      if v_id is not null then
        notification_id := v_id;
        return next;
      end if;
    end if;
  end loop;
end;
$$;

-- =============================================
-- Privileges
-- =============================================
-- Supabase (and the test stubs) grant new functions to anon/authenticated by
-- default, so each one is revoked explicitly.
revoke all on function public.doc_in_view(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.run_document_reminders() from public, anon, authenticated;
grant execute on function public.doc_in_view(uuid, text, uuid) to service_role;
grant execute on function public.run_document_reminders() to service_role;

revoke all on function public.search_documents(jsonb, int, int) from public, anon;
revoke all on function public.document_dashboard() from public, anon;
revoke all on function public.report_incoming_processing(date, date, uuid) from public, anon;
revoke all on function public.report_outgoing(date, date) from public, anon;
grant execute on function public.search_documents(jsonb, int, int) to authenticated, service_role;
grant execute on function public.document_dashboard() to authenticated, service_role;
grant execute on function public.report_incoming_processing(date, date, uuid) to authenticated, service_role;
grant execute on function public.report_outgoing(date, date) to authenticated, service_role;
