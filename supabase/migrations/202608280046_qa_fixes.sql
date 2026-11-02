-- Fixes found by the live UI QA run (round 1). Each function below is copied
-- from its latest definition and changed only where noted.
--
-- 1. doc_in_view 'done' (from 202608280042): also the documents the caller
--    completed ('completed' event), and those the caller assigned work on
--    once that assignment is done or the document is completed/archived.
--    Before, a leader who assigned and completed an incoming document did
--    not find it under Done. document_dashboard has no 'done' card, so its
--    counts are unchanged.
-- 2. report_incoming_processing (from 202608280042): counts only top-level
--    lead assignments (parent_id is null), so a document is counted once per
--    department and once in the total. Before, a lead the department head
--    sub-assigned to a person was counted a second time.
-- 3. issue_document (from 202608280041): the author is not notified again
--    when they were already notified as a member recipient (or as head of a
--    recipient department).
-- 4. accept_invitation (from 202608280034): marks the invitee's
--    'You are invited to join …' notification of this invitation read.
-- 5. get_document (from 202608280036): 'Document not found' is raised with
--    SQLSTATE PT404, which PostgREST answers with HTTP 404 instead of 500
--    (P0002). The message is unchanged; the client matches on it.
--
-- Run after 202608280045_documents_access_fixes.sql. Safe to run again.
--
-- Rollback (manual): re-run the definitions from the migrations named above.

-- =============================================
-- 1. doc_in_view: Done includes completed and assigned work
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
      -- work I assigned, once it (or the whole document) is finished
      or exists (
        select 1 from public.document_assignments a
        where a.document_id = v_doc.id and a.assigned_by = p_user_id
          and (a.status = 'done'
               or (v_doc.status in ('completed', 'archived') and a.status not in ('revoked', 'returned')))
      )
      or exists (
        select 1 from public.document_events e
        where e.document_id = v_doc.id and e.action in ('registered', 'issued', 'completed')
          and e.actor_id = p_user_id
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
-- 2. report_incoming_processing: one count per document
-- =============================================
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
      -- the document's lead only: a lead sub-assigned inside a department
      -- is the same document and must not be counted again
      and a.parent_id is null
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
-- 3. issue_document: the author is notified once
-- =============================================
create or replace function public.issue_document(
  p_document_id uuid, p_register_id uuid, p_recipients jsonb, p_manual_number int default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.documents;
  v_reg public.doc_registers;
  v_type public.doc_types;
  v_org public.organizations;
  v_dept_code text;
  v_recipients jsonb := coalesce(p_recipients, '[]'::jsonb);
  v_item jsonb;
  v_kind text;
  v_id uuid;
  v_name text;
  v_method text;
  v_internal int := 0;
  v_total int := 0;
  v_year int;
  v_number int;
  v_notation text;
  v_key uuid;
  v_title text;
  v_head uuid;
  v_notified uuid[] := '{}';
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_doc := public.doc_out_lock(p_document_id);
  if not public.has_org_role_user(v_doc.org_id, 'clerk', v_uid) then
    raise exception 'Only clerks (Văn thư) can issue documents' using errcode = '42501';
  end if;
  if v_doc.status <> 'signed' then
    raise exception 'Only a signed document can be issued' using errcode = '22023';
  end if;

  select * into v_reg from public.doc_registers where id = p_register_id for update;
  if v_reg.id is null or v_reg.org_id <> v_doc.org_id then
    raise exception 'Register not found' using errcode = 'P0002';
  end if;
  if v_reg.direction <> v_doc.direction then
    raise exception 'Pick a register for % documents', v_doc.direction using errcode = '22023';
  end if;
  if v_reg.closed_at is not null then
    raise exception 'This register is closed' using errcode = '22023';
  end if;
  v_year := public.doc_year_for(v_doc.org_id, now());
  if v_reg.year <> v_year then
    raise exception 'This register is for %, not %', v_reg.year, v_year using errcode = '22023';
  end if;
  if cardinality(v_reg.allowed_type_ids) > 0
     and (v_doc.doc_type_id is null or not (v_doc.doc_type_id = any (v_reg.allowed_type_ids))) then
    raise exception 'This register does not take this document type' using errcode = '22023';
  end if;

  -- recipients are checked before a number is taken
  if jsonb_typeof(v_recipients) <> 'array' then
    raise exception 'Invalid recipients' using errcode = '22023';
  end if;
  if jsonb_array_length(v_recipients) > 200 then
    raise exception 'At most 200 recipients' using errcode = '22023';
  end if;
  for v_item in select e from jsonb_array_elements(v_recipients) e loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'Invalid recipient' using errcode = '22023';
    end if;
    v_kind := v_item ->> 'kind';
    if v_kind = 'member' then
      v_id := public.doc_json_uuid(v_item, 'user_id', 'Recipient');
      if v_id is null or not public.is_org_member_user(v_doc.org_id, v_id) then
        raise exception 'Recipients must be active members of the company' using errcode = '22023';
      end if;
      v_internal := v_internal + 1;
    elsif v_kind = 'department' then
      v_id := public.doc_json_uuid(v_item, 'department_id', 'Department');
      if v_id is null or not exists (
        select 1 from public.departments d
        where d.id = v_id and d.org_id = v_doc.org_id and d.archived_at is null
      ) then
        raise exception 'Department not found' using errcode = 'P0002';
      end if;
      v_internal := v_internal + 1;
    elsif v_kind = 'external' then
      v_id := public.doc_json_uuid(v_item, 'external_org_id', 'External organization');
      if v_id is not null and not exists (
        select 1 from public.external_orgs e where e.id = v_id and e.org_id = v_doc.org_id
      ) then
        raise exception 'External organization not found' using errcode = 'P0002';
      end if;
      if v_id is null and public.doc_json_text(v_item, 'name', 500, 'Recipient name') is null then
        raise exception 'Name the outside recipient' using errcode = '22023';
      end if;
      v_method := coalesce(public.doc_json_text(v_item, 'method', 20, 'Delivery method'), 'post');
      if v_method not in ('system', 'email', 'post', 'hand') then
        raise exception 'Unknown delivery method: %', v_method using errcode = '22023';
      end if;
    else
      raise exception 'Unknown recipient kind: %', coalesce(v_kind, '(empty)') using errcode = '22023';
    end if;
    v_total := v_total + 1;
  end loop;
  if v_doc.direction = 'outgoing' and v_total = 0 then
    raise exception 'Add at least one recipient' using errcode = '22023';
  end if;
  if v_doc.direction = 'internal' and v_internal = 0 then
    raise exception 'Send it to at least one person or department' using errcode = '22023';
  end if;

  select * into v_type from public.doc_types where id = v_doc.doc_type_id;
  select * into v_org from public.organizations where id = v_doc.org_id;
  select d.code into v_dept_code from public.departments d where d.id = v_doc.drafting_department_id;

  if p_manual_number is not null then
    if p_manual_number <= 0 or p_manual_number > 1000000 then
      raise exception 'The number must be a positive whole number' using errcode = '22023';
    end if;
    v_number := p_manual_number;
  else
    v_number := public.doc_next_number(p_register_id, v_doc.doc_type_id);
  end if;

  v_notation := public.doc_render_notation(
    case when coalesce(v_type.is_cong_van, false) then v_reg.cong_van_template else v_reg.notation_template end,
    v_number, v_type.abbreviation, v_org.code, v_dept_code, v_year);
  if exists (
    select 1 from public.documents d
    where d.register_id = p_register_id and d.notation = v_notation and d.id <> p_document_id
      and d.direction in ('outgoing', 'internal') and d.status <> 'cancelled'
  ) then
    raise exception 'That number is already used in this register' using errcode = '23505';
  end if;
  -- a manual number is unique in the register (per type for 'register_type'),
  -- also when the other document's template gives a different notation
  if p_manual_number is not null and exists (
    select 1 from public.documents d
    where d.register_id = p_register_id and d.number = v_number and d.id <> p_document_id
      and d.direction in ('outgoing', 'internal')
      and (v_reg.scope = 'register' or d.doc_type_id is not distinct from v_doc.doc_type_id)
  ) then
    raise exception 'That number is already used in this register' using errcode = '23505';
  end if;

  if p_manual_number is not null then
    v_key := case when v_reg.scope = 'register_type'
      then coalesce(v_doc.doc_type_id, '00000000-0000-0000-0000-000000000000'::uuid)
      else '00000000-0000-0000-0000-000000000000'::uuid end;
    insert into public.doc_register_counters (register_id, type_key, last_number)
    values (p_register_id, v_key, greatest(v_reg.start_number - 1, v_number))
    on conflict (register_id, type_key) do update
      set last_number = greatest(public.doc_register_counters.last_number, excluded.last_number);
    perform public.doc_log(p_document_id, 'manual_number_override', v_doc.status, v_doc.status,
      jsonb_build_object('number', v_number, 'register_id', p_register_id));
  end if;

  begin
    update public.documents
    set register_id = p_register_id, number = v_number, notation = v_notation,
        issued_date = public.org_now_date(v_doc.org_id), issued_at = now(),
        status = 'issued', current_step_no = null
    where id = p_document_id;
  exception when unique_violation then
    raise exception 'That number is already used in this register' using errcode = '23505';
  end;
  update public.document_files set frozen = true where document_id = p_document_id;

  -- recipients, info assignments and notifications
  v_title := 'New document: ' || v_notation || ' – ' || left(v_doc.subject, 150);
  for v_item in select e from jsonb_array_elements(v_recipients) e loop
    v_kind := v_item ->> 'kind';
    if v_kind = 'member' then
      v_id := (v_item ->> 'user_id')::uuid;
      if exists (
        select 1 from public.document_recipients r
        where r.document_id = p_document_id and r.kind = 'member' and r.user_id = v_id
      ) then
        continue;
      end if;
      insert into public.document_recipients (document_id, kind, user_id, name_snapshot, method, sent_at)
      values (p_document_id, 'member', v_id, coalesce(public.doc_user_name(v_id), 'Member'), 'system', now());
      insert into public.document_assignments (document_id, assignee_user_id, role, assigned_by, status)
      values (p_document_id, v_id, 'info', v_uid, 'pending');
      perform public.doc_notify(v_id, p_document_id, 'document.issued', v_title);
      v_notified := v_notified || v_id;
    elsif v_kind = 'department' then
      v_id := (v_item ->> 'department_id')::uuid;
      if exists (
        select 1 from public.document_recipients r
        where r.document_id = p_document_id and r.kind = 'department' and r.department_id = v_id
      ) then
        continue;
      end if;
      insert into public.document_recipients (document_id, kind, department_id, name_snapshot, method, sent_at)
      select p_document_id, 'department', v_id, d.name, 'system', now()
      from public.departments d where d.id = v_id;
      insert into public.document_assignments (document_id, assignee_department_id, role, assigned_by, status)
      values (p_document_id, v_id, 'info', v_uid, 'pending');
      perform public.doc_notify_department(v_id, p_document_id, 'document.issued', v_title);
      -- the head doc_notify_department told
      select d.head_user_id into v_head
      from public.departments d where d.id = v_id and d.archived_at is null;
      if v_head is not null then
        v_notified := v_notified || v_head;
      end if;
    else
      v_id := public.doc_json_uuid(v_item, 'external_org_id', 'External organization');
      v_name := coalesce(
        public.doc_json_text(v_item, 'name', 500, 'Recipient name'),
        (select e.name from public.external_orgs e where e.id = v_id)
      );
      v_method := coalesce(public.doc_json_text(v_item, 'method', 20, 'Delivery method'), 'post');
      insert into public.document_recipients (document_id, kind, external_org_id, name_snapshot, method, sent_at)
      values (p_document_id, 'external', v_id, v_name, v_method,
        case when v_method in ('post', 'hand') then null else now() end);
    end if;
  end loop;

  -- the author once: not again when they were a recipient above
  if v_doc.created_by is not null and not (v_doc.created_by = any (v_notified)) then
    perform public.doc_notify(v_doc.created_by, p_document_id, 'document.issued', v_title);
  end if;
  perform public.doc_log(p_document_id, 'issued', v_doc.status, 'issued',
    jsonb_build_object('number', v_number, 'notation', v_notation, 'register_id', p_register_id,
      'recipients', v_total));

  return jsonb_build_object('number', v_number, 'notation', v_notation);
end;
$$;

-- =============================================
-- 4. accept_invitation: the invitation notice is marked read
-- =============================================
create or replace function public.accept_invitation(p_token text)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_email text;
  v_invite public.org_invitations;
  v_department_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select lower(btrim(email)) into v_email from auth.users where id = auth.uid();

  select * into v_invite from public.org_invitations
  where token = p_token and v_email is not null and email = v_email
  for update;
  if v_invite.id is null then
    raise exception 'Invitation not found' using errcode = 'P0002';
  end if;
  if v_invite.revoked_at is not null then
    raise exception 'This invitation was revoked' using errcode = '22023';
  end if;
  if v_invite.accepted_at is not null then
    raise exception 'This invitation was already accepted' using errcode = '22023';
  end if;
  if v_invite.expires_at <= now() then
    raise exception 'This invitation has expired' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.org_members
    where user_id = auth.uid() and status in ('active', 'suspended') and org_id <> v_invite.org_id
  ) then
    raise exception 'You already belong to another company' using errcode = '23505';
  end if;
  -- a suspended member must not reactivate themselves with a fresh link
  if exists (
    select 1 from public.org_members
    where user_id = auth.uid() and org_id = v_invite.org_id and status in ('active', 'suspended')
  ) then
    raise exception 'You are already a member of this company' using errcode = '23505';
  end if;

  select id into v_department_id from public.departments
  where id = v_invite.department_id and archived_at is null;

  begin
    insert into public.org_members (org_id, user_id, department_id, position_id, roles, status)
    values (v_invite.org_id, auth.uid(), v_department_id, v_invite.position_id, v_invite.roles, 'active')
    on conflict (org_id, user_id) do update
      set department_id = excluded.department_id,
          position_id = excluded.position_id,
          roles = excluded.roles,
          title = null,
          status = 'active',
          joined_at = now(),
          left_at = null
      where public.org_members.status = 'left';
  exception when unique_violation then
    raise exception 'You already belong to another company' using errcode = '23505';
  end;

  update public.org_invitations
  set accepted_at = now(), accepted_by = auth.uid()
  where id = v_invite.id;
  -- the 'You are invited to join …' notice invite_member wrote for this link
  update public.notifications
  set read_at = now()
  where user_id = auth.uid() and kind = 'org.invite' and read_at is null
    and link = '/invite/' || v_invite.token;
  return v_invite.org_id;
end;
$$;

-- =============================================
-- 5. get_document: 'not found' is HTTP 404
-- =============================================
create or replace function public.get_document(p_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.documents;
  v_detail jsonb;
  v_files jsonb;
  v_assignments jsonb;
  v_steps jsonb;
  v_opinions jsonb;
  v_recipients jsonb;
  v_grants jsonb;
  v_events jsonb;
  v_related jsonb;
  v_me jsonb;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select * into v_doc from public.documents where id = p_id;
  if v_doc.id is null or not public.can_read_document(p_id) then
    -- PTxyz: PostgREST answers with HTTP xyz (P0002 was a 500)
    raise exception 'Document not found' using errcode = 'PT404';
  end if;

  if not exists (
    select 1 from public.document_access_log l
    where l.document_id = p_id and l.user_id = v_uid and l.action = 'view'
      and l.at > now() - interval '1 hour'
  ) then
    insert into public.document_access_log (document_id, user_id, action) values (p_id, v_uid, 'view');
  end if;

  v_detail := (to_jsonb(v_doc) - 'search_norm') || jsonb_build_object(
    'type_name', (select t.name from public.doc_types t where t.id = v_doc.doc_type_id),
    'type_abbreviation', (select t.abbreviation from public.doc_types t where t.id = v_doc.doc_type_id),
    'is_cong_van', (select t.is_cong_van from public.doc_types t where t.id = v_doc.doc_type_id),
    'field_name', (select f.name from public.doc_fields f where f.id = v_doc.field_id),
    'register_name', (select r.name from public.doc_registers r where r.id = v_doc.register_id),
    'external_org_name', (select e.name from public.external_orgs e where e.id = v_doc.external_org_id),
    'drafting_department_name',
      (select dep.name from public.departments dep where dep.id = v_doc.drafting_department_id),
    'drafting_department_code',
      (select dep.code from public.departments dep where dep.id = v_doc.drafting_department_id),
    'created_by_name', public.doc_user_name(v_doc.created_by),
    'presented_to_name', public.doc_user_name(v_doc.presented_to),
    'signer_display', nullif(concat_ws(' ',
      case when v_doc.signer_authority <> '' then v_doc.signer_authority || '.' end,
      nullif(btrim(v_doc.signer_position), ''),
      coalesce(nullif(btrim(v_doc.signer_name), ''), public.doc_user_name(v_doc.signer_user_id))
    ), '')
  );

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', df.id, 'file_id', df.file_id, 'kind', df.kind, 'frozen', df.frozen,
      'name', f.name, 'size', f.size, 'mime_type', f.mime_type,
      'current_version_id', f.current_version_id, 'owner_id', f.owner_id, 'added_at', df.added_at
    ) order by case df.kind when 'main' then 0 when 'signed' then 1 when 'attachment' then 2 else 3 end,
      df.added_at), '[]')
  into v_files
  from public.document_files df
  join public.files f on f.id = df.file_id
  where df.document_id = p_id;

  select coalesce(jsonb_agg(to_jsonb(a) || jsonb_build_object(
      'assignee_name', public.doc_user_name(a.assignee_user_id),
      'assignee_department_name', (select dep.name from public.departments dep where dep.id = a.assignee_department_id),
      'assigned_by_name', public.doc_user_name(a.assigned_by)
    ) order by a.assigned_at, a.id), '[]')
  into v_assignments
  from public.document_assignments a
  where a.document_id = p_id;

  select coalesce(jsonb_agg(to_jsonb(s) || jsonb_build_object(
      'approver_name', public.doc_user_name(s.approver_user_id)
    ) order by s.revision, s.step_no, s.id), '[]')
  into v_steps
  from public.document_approval_steps s
  where s.document_id = p_id;

  select coalesce(jsonb_agg(to_jsonb(o) || jsonb_build_object(
      'author_name', public.doc_user_name(o.author_id)
    ) order by o.created_at, o.id), '[]')
  into v_opinions
  from public.document_opinions o
  where o.document_id = p_id;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.sent_at nulls last, r.name_snapshot, r.id), '[]')
  into v_recipients
  from public.document_recipients r
  where r.document_id = p_id;

  select coalesce(jsonb_agg(jsonb_build_object(
      'user_id', g.user_id, 'name', public.doc_user_name(g.user_id), 'access', g.access
    ) order by g.created_at, g.user_id), '[]')
  into v_grants
  from public.document_grants g
  where g.document_id = p_id;

  select coalesce(jsonb_agg(to_jsonb(e) || jsonb_build_object(
      'actor_name', public.doc_user_name(e.actor_id)
    ) order by e.created_at, e.id), '[]')
  into v_events
  from public.document_events e
  where e.document_id = p_id;

  -- linked documents; unreadable ones keep only their id and direction
  with rel(id, relation, ord) as (
    select v_doc.reply_to_id, 'reply_to', 1 where v_doc.reply_to_id is not null
    union all
    select v_doc.replaces_id, 'replaces', 2 where v_doc.replaces_id is not null
    union all
    select v_doc.corrects_id, 'corrects', 3 where v_doc.corrects_id is not null
    union all
    select x.id, 'replied_by', 4 from public.documents x where x.reply_to_id = p_id
    union all
    select x.id, 'replaced_by', 5 from public.documents x where x.replaces_id = p_id
    union all
    select x.id, 'corrected_by', 6 from public.documents x where x.corrects_id = p_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', x.id,
      'subject', case when c.ok then x.subject end,
      'notation', case when c.ok then x.notation end,
      'direction', x.direction,
      'relation', rel.relation,
      'readable', c.ok
    ) order by rel.ord, x.created_at), '[]')
  into v_related
  from rel
  join public.documents x on x.id = rel.id
  cross join lateral (select public.can_read_document(x.id) as ok) c;

  select jsonb_build_object(
    'user_id', v_uid,
    'roles', coalesce((
      select to_jsonb(m.roles) from public.org_members m
      where m.org_id = v_doc.org_id and m.user_id = v_uid and m.status = 'active'
    ), '[]'::jsonb),
    'department_id', public.member_department(v_doc.org_id, v_uid),
    'headed_department_ids', coalesce((
      select jsonb_agg(h.id) from public.headed_departments_of(v_uid) as h(id)
    ), '[]'::jsonb),
    'can_edit', public.can_edit_document(p_id)
  ) into v_me;

  return jsonb_build_object(
    'document', v_detail,
    'files', v_files,
    'assignments', v_assignments,
    'approval_steps', v_steps,
    'opinions', v_opinions,
    'recipients', v_recipients,
    'grants', v_grants,
    'events', v_events,
    'related', v_related,
    'me', v_me
  );
end;
$$;

-- =============================================
-- Privileges (unchanged; restated so a re-run keeps them)
-- =============================================
revoke all on function public.doc_in_view(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.doc_in_view(uuid, text, uuid) to service_role;
revoke all on function public.report_incoming_processing(date, date, uuid) from public, anon;
grant execute on function public.report_incoming_processing(date, date, uuid) to authenticated, service_role;
revoke all on function public.issue_document(uuid, uuid, jsonb, int) from public, anon;
grant execute on function public.issue_document(uuid, uuid, jsonb, int) to authenticated;
revoke all on function public.accept_invitation(text) from public, anon;
grant execute on function public.accept_invitation(text) to authenticated;
revoke all on function public.get_document(uuid) from public, anon;
grant execute on function public.get_document(uuid) to authenticated;

-- =============================================
-- 6. The history shows the result note (Kết quả xử lý) of a completed document
-- =============================================
-- complete_document is copied from 202608280040_documents_incoming.sql;
-- only the data it logs with the 'completed' event changes.
create or replace function public.complete_document(p_document_id uuid, p_result text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.documents;
  v_lead public.document_assignments;
  v_result text := nullif(btrim(coalesce(p_result, '')), '');
  v_leaderish boolean;
  v_override boolean := false;
  v_user uuid;
  v_title text;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select * into v_doc from public.documents where id = p_document_id for update;
  if v_doc.id is null or not public.can_read_document(p_document_id) then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  if v_doc.direction <> 'incoming' or v_doc.status <> 'in_progress' then
    raise exception 'Only an incoming document in progress can be completed' using errcode = '22023';
  end if;
  if char_length(v_result) > 5000 then
    raise exception 'The result is too long (max 5000 characters)' using errcode = '22023';
  end if;

  select * into v_lead from public.document_assignments
  where document_id = p_document_id and parent_id is null and role = 'lead'
    and status not in ('revoked', 'returned')
  order by assigned_at desc
  limit 1;

  v_leaderish := public.has_org_role_user(v_doc.org_id, 'leader', v_uid)
    or public.has_org_role_user(v_doc.org_id, 'org_admin', v_uid);
  if not (
    v_leaderish
    or v_doc.presented_to is not distinct from v_uid
    or (v_lead.id is not null
        and public.doc_is_my_assignment(v_lead.assignee_user_id, v_lead.assignee_department_id, v_uid))
  ) then
    raise exception 'Only the lead (Chủ trì) or the leader can complete this document' using errcode = '42501';
  end if;
  if v_lead.id is null or v_lead.status <> 'done' then
    if not v_leaderish then
      raise exception 'The lead (Chủ trì) has not finished yet' using errcode = '22023';
    end if;
    v_override := true;
  end if;

  update public.documents
  set status = 'completed', completed_at = now(), result_note = v_result
  where id = p_document_id;

  v_title := public.doc_title(v_doc.urgency, 'Completed: ' || left(v_doc.subject, 160));
  for v_user in
    select distinct s.u from (
      select v_doc.presented_to as u
      union all
      select a.assigned_by from public.document_assignments a
      where a.document_id = p_document_id and a.parent_id is null and a.status <> 'revoked'
      union all
      -- open supports stay open and are told
      select public.doc_assignment_recipient(a.assignee_user_id, a.assignee_department_id)
      from public.document_assignments a
      where a.document_id = p_document_id and a.role = 'support'
        and a.status in ('pending', 'seen', 'in_progress')
    ) s
    where s.u is not null
  loop
    perform public.doc_notify(v_user, p_document_id, 'document.completed', v_title, left(v_result, 500));
  end loop;

  perform public.doc_log(p_document_id, 'completed', 'in_progress', 'completed',
    jsonb_strip_nulls(jsonb_build_object(
      'override', case when v_override then true end,
      'result_note', nullif(left(v_result, 500), ''))));
end;
$$;
