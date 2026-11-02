-- Incoming documents (Văn bản đến) workflow: the clerk registers the document
-- in an incoming register (sổ) with the next arrival number and a duplicate
-- warning, presents it to a leader, the leader assigns a lead (chủ trì),
-- supports (phối hợp) and info recipients (để biết), a department head may
-- sub-assign, assignees report results and the document is completed.
-- Run after 202608280036_documents_core.sql. Idempotent.
--
-- Every RPC is security definer, starts with an auth.uid() check, loads the
-- document and checks roles against the document's company (active members
-- only). Events use only the canonical document_events actions: registered,
-- submitted, returned_to_clerk, assigned, seen, assignment_updated,
-- assignment_revoked, completed, reopened, cancelled. Urgent documents
-- (urgency <> 'normal') get '[URGENT] ' in front of notification titles.
--
-- mark_my_assignments_seen and update_assignment work for any direction
-- (outgoing/internal info assignments use them too).
--
-- Rollback (manual):
--   drop function if exists public.register_incoming(uuid, uuid, text);
--   drop function if exists public.submit_incoming(uuid, uuid, text);
--   drop function if exists public.assign_document(uuid, jsonb, uuid, text);
--   drop function if exists public.mark_my_assignments_seen(uuid);
--   drop function if exists public.update_assignment(uuid, text, text);
--   drop function if exists public.revoke_assignment(uuid);
--   drop function if exists public.complete_document(uuid, text);
--   drop function if exists public.return_to_clerk(uuid, text);
--   drop function if exists public.cancel_incoming(uuid, text);
--   drop function if exists public.reopen_document(uuid, text);
--   drop function if exists public.doc_is_my_assignment(uuid, uuid, uuid);
--   drop function if exists public.doc_assignment_recipient(uuid, uuid);
--   drop function if exists public.doc_title(text, text);
--   drop function if exists public.doc_clean_reason(text, text);

-- =============================================
-- Internal helpers (definer RPCs only; service_role grant)
-- =============================================

-- True when p_uid is the assignee: the user, or the head of the department.
create or replace function public.doc_is_my_assignment(p_user_id uuid, p_department_id uuid, p_uid uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select p_uid is not null and (
    p_user_id is not distinct from p_uid
    or (p_department_id is not null
        and p_department_id in (select public.headed_departments_of(p_uid)))
  );
$$;

-- Who is told about an assignment: the user, or the department's head.
create or replace function public.doc_assignment_recipient(p_user_id uuid, p_department_id uuid)
returns uuid
language sql stable security definer
set search_path = public
as $$
  select coalesce(p_user_id, (
    select d.head_user_id from public.departments d
    where d.id = p_department_id and d.archived_at is null
  ));
$$;

-- Notification title: '[URGENT] ' first when the document is urgent.
create or replace function public.doc_title(p_urgency text, p_title text)
returns text
language sql immutable
set search_path = public
as $$
  select case when coalesce(p_urgency, 'normal') <> 'normal' then '[URGENT] ' else '' end || p_title;
$$;

-- A required reason: trimmed, 1..2000 characters.
create or replace function public.doc_clean_reason(p_reason text, p_label text)
returns text
language plpgsql immutable
set search_path = public
as $$
declare
  v text := btrim(coalesce(p_reason, ''));
begin
  if char_length(v) not between 1 and 2000 then
    raise exception '% must be 1 to 2000 characters', p_label using errcode = '22023';
  end if;
  return v;
end;
$$;

-- =============================================
-- Register (vào sổ)
-- =============================================
create or replace function public.register_incoming(
  p_document_id uuid, p_register_id uuid, p_duplicate_reason text default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.documents;
  v_reg public.doc_registers;
  v_reason text := nullif(btrim(coalesce(p_duplicate_reason, '')), '');
  v_duplicates jsonb;
  v_today date;
  v_number int;
  v_data jsonb;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select * into v_doc from public.documents where id = p_document_id for update;
  if v_doc.id is null or not public.can_read_document(p_document_id) then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  if not public.has_org_role_user(v_doc.org_id, 'clerk', v_uid) then
    raise exception 'Only clerks (Văn thư) can register incoming documents' using errcode = '42501';
  end if;
  if v_doc.direction <> 'incoming' or v_doc.status <> 'draft' then
    raise exception 'Only an incoming draft can be registered' using errcode = '22023';
  end if;
  if v_doc.doc_type_id is null or btrim(coalesce(v_doc.subject, '')) = ''
     or btrim(coalesce(v_doc.issuing_org_name, '')) = '' or btrim(coalesce(v_doc.notation, '')) = ''
     or (select count(*) from public.document_files df
         where df.document_id = p_document_id and df.kind = 'main') <> 1 then
    raise exception 'Fill in type, subject, issuing organisation and number/notation, and attach the main file first'
      using errcode = '22023';
  end if;
  if v_reason is not null and char_length(v_reason) > 2000 then
    raise exception 'The reason is too long (max 2000 characters)' using errcode = '22023';
  end if;

  select * into v_reg from public.doc_registers where id = p_register_id;
  if v_reg.id is null or v_reg.org_id <> v_doc.org_id or v_reg.direction <> 'incoming' then
    raise exception 'Incoming register not found' using errcode = 'P0002';
  end if;
  if v_reg.closed_at is not null then
    raise exception 'This register is closed' using errcode = '22023';
  end if;
  if v_reg.year <> public.doc_year_for(v_doc.org_id, now()) then
    raise exception 'This register is for %; use a register of %',
      v_reg.year, public.doc_year_for(v_doc.org_id, now()) using errcode = '22023';
  end if;
  if cardinality(v_reg.allowed_type_ids) > 0 and not (v_doc.doc_type_id = any (v_reg.allowed_type_ids)) then
    raise exception 'This register does not take this document type' using errcode = '22023';
  end if;

  -- the same document from the same sender registered before
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', x.id,
      'notation', x.notation,
      'arrival_number', x.arrival_number,
      'subject', case when public.can_read_document(x.id) then x.subject end,
      'arrival_date', x.arrival_date
    ) order by x.arrival_date nulls last, x.arrival_number nulls last, x.created_at), '[]')
  into v_duplicates
  from (
    select d.* from public.documents d
    where d.org_id = v_doc.org_id
      and d.id <> v_doc.id
      and d.status not in ('cancelled')
      and lower(d.notation) = lower(v_doc.notation)
      and lower(d.issuing_org_name) = lower(v_doc.issuing_org_name)
      and (d.issued_date is not distinct from v_doc.issued_date
           or d.issued_date is null or v_doc.issued_date is null)
    order by d.created_at
    limit 20
  ) x;

  if jsonb_array_length(v_duplicates) > 0 and v_reason is null then
    return jsonb_build_object('ok', false, 'duplicates', v_duplicates);
  end if;

  v_today := public.org_now_date(v_doc.org_id);
  v_number := public.doc_next_number(p_register_id, null);

  update public.documents set
    register_id = p_register_id,
    arrival_number = v_number,
    arrival_date = coalesce(arrival_date, v_today),
    status = 'registered',
    registered_at = now(),
    due_date = coalesce(due_date,
      public.doc_add_working_days(org_id, v_today, public.doc_default_due_days(urgency)))
  where id = p_document_id;

  update public.document_files set frozen = true
  where document_id = p_document_id and kind in ('main', 'attachment');

  v_data := jsonb_build_object('arrival_number', v_number, 'register_id', p_register_id);
  if jsonb_array_length(v_duplicates) > 0 then
    v_data := v_data || jsonb_build_object('duplicate_reason', v_reason);
  end if;
  perform public.doc_log(p_document_id, 'registered', 'draft', 'registered', v_data);

  return jsonb_build_object('ok', true, 'arrival_number', v_number);
end;
$$;

-- =============================================
-- Present to a leader (trình)
-- =============================================
create or replace function public.submit_incoming(p_document_id uuid, p_to_user_id uuid, p_note text default null)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.documents;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_to_name text;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select * into v_doc from public.documents where id = p_document_id for update;
  if v_doc.id is null or not public.can_read_document(p_document_id) then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  if not public.has_org_role_user(v_doc.org_id, 'clerk', v_uid) then
    raise exception 'Only clerks (Văn thư) can present incoming documents' using errcode = '42501';
  end if;
  if v_doc.direction <> 'incoming' or v_doc.status <> 'registered' then
    raise exception 'Only a registered incoming document can be presented' using errcode = '22023';
  end if;
  if p_to_user_id is null or not exists (
    select 1 from public.org_members m
    where m.org_id = v_doc.org_id and m.user_id = p_to_user_id and m.status = 'active'
      and m.roles && array['leader', 'dept_head', 'org_admin']
  ) then
    raise exception 'Present it to a leader or department head of the company' using errcode = '22023';
  end if;
  if char_length(v_note) > 5000 then
    raise exception 'The note is too long (max 5000 characters)' using errcode = '22023';
  end if;

  update public.documents
  set status = 'submitted', presented_to = p_to_user_id, submitted_at = now()
  where id = p_document_id;

  if v_note is not null then
    insert into public.document_opinions (document_id, author_id, kind, body)
    values (p_document_id, v_uid, 'proposal', v_note);
  end if;

  v_to_name := public.doc_user_name(p_to_user_id);
  perform public.doc_notify(p_to_user_id, p_document_id, 'document.submitted',
    public.doc_title(v_doc.urgency, 'New incoming document: ' || left(v_doc.subject, 160)), v_note);
  perform public.doc_log(p_document_id, 'submitted', 'registered', 'submitted',
    jsonb_build_object('to_user_id', p_to_user_id, 'to_name', v_to_name));
end;
$$;

-- =============================================
-- Assign (phân công) and sub-assign
-- =============================================
-- p_items: [{user_id?, department_id?, role: lead|support|info, due_date?, instruction?}]
create or replace function public.assign_document(
  p_document_id uuid, p_items jsonb, p_parent_assignment_id uuid default null, p_instruction text default null
)
returns int
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.documents;
  v_parent public.document_assignments;
  v_today date;
  v_instruction text := nullif(btrim(coalesce(p_instruction, '')), '');
  v_item jsonb;
  v_role text;
  v_user uuid;
  v_dept uuid;
  v_due date;
  v_item_instruction text;
  v_dep public.departments;
  v_keys text[] := '{}';
  v_key text;
  v_new_leads int := 0;
  v_active_lead boolean;
  v_lead_due date;
  v_id uuid;
  v_count int := 0;
  v_log jsonb := '[]';
  v_recipient uuid;
  v_title text;
  v_to_status text;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select * into v_doc from public.documents where id = p_document_id for update;
  if v_doc.id is null or not public.can_read_document(p_document_id) then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  if v_doc.direction <> 'incoming' then
    raise exception 'Only incoming documents are assigned here' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one person or department' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) > 50 then
    raise exception 'At most 50 assignees at a time' using errcode = '22023';
  end if;
  if char_length(v_instruction) > 2000 then
    raise exception 'The instruction is too long (max 2000 characters)' using errcode = '22023';
  end if;
  v_today := public.org_now_date(v_doc.org_id);

  if p_parent_assignment_id is null then
    if not (
      v_doc.presented_to is not distinct from v_uid
      or public.has_org_role_user(v_doc.org_id, 'leader', v_uid)
      or public.has_org_role_user(v_doc.org_id, 'org_admin', v_uid)
      or (v_doc.status = 'registered' and public.has_org_role_user(v_doc.org_id, 'clerk', v_uid))
    ) then
      raise exception 'Only the leader it was presented to can assign it' using errcode = '42501';
    end if;
    if v_doc.status not in ('registered', 'submitted', 'in_progress') then
      raise exception 'This document cannot be assigned now' using errcode = '22023';
    end if;
  else
    select * into v_parent from public.document_assignments
    where id = p_parent_assignment_id and document_id = p_document_id
    for update;
    if v_parent.id is null then
      raise exception 'Assignment not found' using errcode = 'P0002';
    end if;
    if not public.doc_is_my_assignment(v_parent.assignee_user_id, v_parent.assignee_department_id, v_uid) then
      raise exception 'Only the assignee can pass this assignment on' using errcode = '42501';
    end if;
    if v_parent.status in ('done', 'revoked', 'returned') then
      raise exception 'This assignment is closed' using errcode = '22023';
    end if;
    if v_doc.status not in ('in_progress', 'completed') then
      raise exception 'This document cannot be assigned now' using errcode = '22023';
    end if;
  end if;

  -- active siblings: same parent, not revoked or returned
  select coalesce(array_agg(case when a.assignee_user_id is not null
           then 'user:' || a.assignee_user_id else 'department:' || a.assignee_department_id end), '{}'),
         coalesce(bool_or(a.role = 'lead'), false)
  into v_keys, v_active_lead
  from public.document_assignments a
  where a.document_id = p_document_id
    and a.parent_id is not distinct from p_parent_assignment_id
    and a.status not in ('revoked', 'returned');

  select count(*) into v_new_leads
  from jsonb_array_elements(p_items) e
  where jsonb_typeof(e) = 'object' and e ->> 'role' = 'lead';

  if p_parent_assignment_id is null then
    if v_active_lead and v_new_leads > 0 then
      raise exception 'This document already has a lead. Revoke it first.' using errcode = '22023';
    end if;
    if not v_active_lead and v_new_leads <> 1 then
      raise exception 'Choose exactly one lead (Chủ trì)' using errcode = '22023';
    end if;
  else
    if v_active_lead and v_new_leads > 0 then
      raise exception 'This assignment already has a lead. Revoke it first.' using errcode = '22023';
    end if;
    if v_new_leads > 1 then
      raise exception 'Choose at most one lead (Chủ trì)' using errcode = '22023';
    end if;
  end if;

  -- a new top-level lead's deadline becomes the document's: supports default to it
  if p_parent_assignment_id is null then
    select public.doc_json_date(e, 'due_date', 'Deadline') into v_lead_due
    from jsonb_array_elements(p_items) e
    where jsonb_typeof(e) = 'object' and e ->> 'role' = 'lead'
    limit 1;
  end if;

  for v_item in select e from jsonb_array_elements(p_items) e loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'Invalid assignment' using errcode = '22023';
    end if;
    v_role := v_item ->> 'role';
    if v_role is null or v_role not in ('lead', 'support', 'info') then
      raise exception 'Unknown assignment role: %', coalesce(v_role, '(empty)') using errcode = '22023';
    end if;
    v_user := public.doc_json_uuid(v_item, 'user_id', 'Person');
    v_dept := public.doc_json_uuid(v_item, 'department_id', 'Department');
    if (v_user is null) = (v_dept is null) then
      raise exception 'Each row needs either a person or a department' using errcode = '22023';
    end if;
    v_item_instruction := public.doc_json_text(v_item, 'instruction', 2000, 'Instruction');
    v_due := public.doc_json_date(v_item, 'due_date', 'Deadline');

    if v_user is not null then
      if not public.is_org_member_user(v_doc.org_id, v_user) then
        raise exception 'Assignees must be active members of the company' using errcode = '22023';
      end if;
      v_key := 'user:' || v_user;
    else
      select * into v_dep from public.departments
      where id = v_dept and org_id = v_doc.org_id and archived_at is null;
      if v_dep.id is null then
        raise exception 'Department not found' using errcode = 'P0002';
      end if;
      if v_dep.head_user_id is null or not public.is_org_member_user(v_doc.org_id, v_dep.head_user_id) then
        raise exception 'Department % has no head', v_dep.name using errcode = '22023';
      end if;
      v_key := 'department:' || v_dept;
    end if;
    if v_key = any (v_keys) then
      raise exception 'Each person or department can only appear once' using errcode = '22023';
    end if;
    v_keys := v_keys || v_key;

    if v_due is not null and v_due < v_today then
      raise exception 'Deadline cannot be in the past' using errcode = '22023';
    end if;
    if v_due is null and v_role in ('lead', 'support') then
      -- parent's deadline, else the new lead's, else the document's
      v_due := coalesce(v_parent.due_date, v_lead_due, v_doc.due_date);
    end if;
    if v_parent.id is not null and v_parent.due_date is not null and v_due > v_parent.due_date then
      raise exception 'Deadline must be on or before %', to_char(v_parent.due_date, 'DD/MM/YYYY')
        using errcode = '22023';
    end if;

    insert into public.document_assignments (
      document_id, parent_id, assignee_user_id, assignee_department_id, role,
      instruction, due_date, assigned_by
    )
    values (
      p_document_id, p_parent_assignment_id, v_user, v_dept, v_role,
      coalesce(v_item_instruction, v_instruction), v_due, v_uid
    )
    returning id into v_id;
    v_count := v_count + 1;

    v_log := v_log || jsonb_build_array(jsonb_build_object(
      'assignment_id', v_id, 'role', v_role, 'user_id', v_user, 'department_id', v_dept,
      'name', case when v_user is not null then public.doc_user_name(v_user) else v_dep.name end,
      'due_date', v_due));

    v_recipient := public.doc_assignment_recipient(v_user, v_dept);
    v_title := case v_role
      when 'lead' then 'You are the lead for: '
      when 'support' then 'Please support: '
      else 'For your information: '
    end || left(v_doc.subject, 160);
    perform public.doc_notify(v_recipient, p_document_id, 'document.assigned',
      public.doc_title(v_doc.urgency, v_title), coalesce(v_item_instruction, v_instruction));
  end loop;

  if v_instruction is not null then
    insert into public.document_opinions (document_id, author_id, kind, body)
    values (p_document_id, v_uid, 'instruction', v_instruction);
  end if;

  -- passing an assignment on opens it: it can no longer be revoked (which
  -- would silently revoke the work under it)
  if v_parent.id is not null and v_parent.status = 'pending' then
    update public.document_assignments
    set status = 'seen', seen_at = coalesce(seen_at, now())
    where id = v_parent.id;
  end if;

  v_to_status := case when v_doc.status in ('registered', 'submitted') then 'in_progress' else v_doc.status end;
  update public.documents
  set status = v_to_status,
      due_date = coalesce(v_lead_due, due_date)
  where id = p_document_id;

  perform public.doc_log(p_document_id, 'assigned', v_doc.status, v_to_status,
    jsonb_build_object('parent_id', p_parent_assignment_id, 'items', v_log));
  return v_count;
end;
$$;

-- =============================================
-- Assignees: seen, progress, done, return
-- =============================================
create or replace function public.mark_my_assignments_seen(p_document_id uuid)
returns int
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.documents;
  v_count int;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select * into v_doc from public.documents where id = p_document_id;
  if v_doc.id is null or not public.can_read_document(p_document_id) then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;

  update public.document_assignments a
  set status = 'seen', seen_at = now()
  where a.document_id = p_document_id
    and a.status = 'pending'
    and public.doc_is_my_assignment(a.assignee_user_id, a.assignee_department_id, v_uid);
  get diagnostics v_count = row_count;

  if v_count > 0 then
    perform public.doc_log(p_document_id, 'seen', v_doc.status, v_doc.status,
      jsonb_build_object('count', v_count));
  end if;
  return v_count;
end;
$$;

create or replace function public.update_assignment(p_assignment_id uuid, p_status text, p_result text default null)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_a public.document_assignments;
  v_doc public.documents;
  v_result text := nullif(btrim(coalesce(p_result, '')), '');
  v_name text;
  v_title text;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select * into v_a from public.document_assignments where id = p_assignment_id for update;
  if v_a.id is null or not public.can_read_document(v_a.document_id) then
    raise exception 'Assignment not found' using errcode = 'P0002';
  end if;
  select * into v_doc from public.documents where id = v_a.document_id;
  if not public.doc_is_my_assignment(v_a.assignee_user_id, v_a.assignee_department_id, v_uid) then
    raise exception 'Only the assignee can update this assignment' using errcode = '42501';
  end if;
  if v_doc.status in ('cancelled', 'archived') then
    raise exception 'This document is closed' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('in_progress', 'done', 'returned') then
    raise exception 'Unknown assignment status: %', coalesce(p_status, '(empty)') using errcode = '22023';
  end if;
  if (p_status = 'in_progress' and v_a.status not in ('pending', 'seen'))
     or (p_status in ('done', 'returned') and v_a.status not in ('pending', 'seen', 'in_progress')) then
    raise exception 'This assignment is already %', replace(v_a.status, '_', ' ') using errcode = '22023';
  end if;
  if char_length(v_result) > 5000 then
    raise exception 'The result is too long (max 5000 characters)' using errcode = '22023';
  end if;
  if p_status = 'done' and v_a.role <> 'info' and v_result is null then
    raise exception 'Write the result first' using errcode = '22023';
  end if;
  if p_status = 'returned' and v_result is null then
    raise exception 'Give a reason for returning it' using errcode = '22023';
  end if;

  update public.document_assignments
  set status = p_status,
      seen_at = coalesce(seen_at, now()),
      result = case when p_status in ('done', 'returned') then v_result else result end,
      done_at = case when p_status in ('done', 'returned') then now() else done_at end
  where id = p_assignment_id;

  if p_status = 'done' and v_a.role <> 'info' then
    insert into public.document_opinions (document_id, author_id, kind, body)
    values (v_a.document_id, v_uid, 'result', v_result);
  end if;

  v_name := public.notification_actor_name(v_uid);
  if p_status = 'done' and v_a.role <> 'info' then
    v_title := v_name || ' finished: ' || left(v_doc.subject, 160);
  elsif p_status = 'returned' then
    v_title := v_name || ' returned: ' || left(v_doc.subject, 160);
  end if;
  if v_title is not null then
    perform public.doc_notify(v_a.assigned_by, v_a.document_id, 'document.assignment_updated',
      public.doc_title(v_doc.urgency, v_title), left(v_result, 500));
    -- a returned top-level lead also goes back to the leader it was presented to
    if p_status = 'returned' and v_a.parent_id is null and v_a.role = 'lead'
       and v_doc.presented_to is distinct from v_a.assigned_by then
      perform public.doc_notify(v_doc.presented_to, v_a.document_id, 'document.assignment_updated',
        public.doc_title(v_doc.urgency, v_title), left(v_result, 500));
    end if;
  end if;

  perform public.doc_log(v_a.document_id, 'assignment_updated', v_doc.status, v_doc.status,
    jsonb_build_object('assignment_id', p_assignment_id, 'status', p_status)
      || case when p_status = 'returned' then jsonb_build_object('reason', v_result) else '{}'::jsonb end);
end;
$$;

-- Takes back an assignment nobody opened yet (and everything under it).
create or replace function public.revoke_assignment(p_assignment_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_a public.document_assignments;
  v_doc public.documents;
  v_count int;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select * into v_a from public.document_assignments where id = p_assignment_id for update;
  if v_a.id is null or not public.can_read_document(v_a.document_id) then
    raise exception 'Assignment not found' using errcode = 'P0002';
  end if;
  select * into v_doc from public.documents where id = v_a.document_id;
  if v_a.assigned_by is distinct from v_uid
     and not public.has_org_role_user(v_doc.org_id, 'org_admin', v_uid) then
    raise exception 'Only the person who assigned it can revoke it' using errcode = '42501';
  end if;
  if v_a.status <> 'pending' then
    raise exception 'It was already opened; ask the person to return it instead' using errcode = '22023';
  end if;

  with recursive tree as (
    select id from public.document_assignments where id = p_assignment_id
    union all
    select c.id from public.document_assignments c join tree t on c.parent_id = t.id
  )
  update public.document_assignments a set status = 'revoked'
  where a.id in (select id from tree) and a.status <> 'revoked';
  get diagnostics v_count = row_count;

  perform public.doc_notify(
    public.doc_assignment_recipient(v_a.assignee_user_id, v_a.assignee_department_id),
    v_a.document_id, 'document.assignment_revoked',
    public.doc_title(v_doc.urgency, 'Assignment withdrawn: ' || left(v_doc.subject, 160)));
  perform public.doc_log(v_a.document_id, 'assignment_revoked', v_doc.status, v_doc.status,
    jsonb_build_object('assignment_id', p_assignment_id, 'count', v_count));
end;
$$;

-- =============================================
-- Complete, return, cancel, reopen
-- =============================================
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
    case when v_override then jsonb_build_object('override', true) else '{}'::jsonb end);
end;
$$;

create or replace function public.return_to_clerk(p_document_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.documents;
  v_reason text;
  v_clerk uuid;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select * into v_doc from public.documents where id = p_document_id for update;
  if v_doc.id is null or not public.can_read_document(p_document_id) then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  if v_doc.presented_to is distinct from v_uid then
    raise exception 'Only the person it was presented to can return it' using errcode = '42501';
  end if;
  if v_doc.direction <> 'incoming' or v_doc.status <> 'submitted' then
    raise exception 'Only a presented incoming document can be returned' using errcode = '22023';
  end if;
  v_reason := public.doc_clean_reason(p_reason, 'The reason');

  update public.documents set status = 'registered', presented_to = null where id = p_document_id;

  select e.actor_id into v_clerk from public.document_events e
  where e.document_id = p_document_id and e.action = 'registered'
  order by e.created_at desc, e.id desc
  limit 1;
  perform public.doc_notify(v_clerk, p_document_id, 'document.returned_to_clerk',
    public.doc_title(v_doc.urgency, 'Returned to you: ' || left(v_doc.subject, 160)), left(v_reason, 500));
  perform public.doc_log(p_document_id, 'returned_to_clerk', 'submitted', 'registered',
    jsonb_build_object('reason', v_reason));
end;
$$;

-- Cancels a draft or registered document; the arrival number is never reused.
create or replace function public.cancel_incoming(p_document_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.documents;
  v_reason text;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select * into v_doc from public.documents where id = p_document_id for update;
  if v_doc.id is null or not public.can_read_document(p_document_id) then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  if not public.has_org_role_user(v_doc.org_id, 'clerk', v_uid) then
    raise exception 'Only clerks (Văn thư) can cancel incoming documents' using errcode = '42501';
  end if;
  if v_doc.direction <> 'incoming' or v_doc.status not in ('draft', 'registered') then
    raise exception 'Only a draft or registered incoming document can be cancelled' using errcode = '22023';
  end if;
  v_reason := public.doc_clean_reason(p_reason, 'The reason');

  update public.documents set status = 'cancelled', cancelled_at = now() where id = p_document_id;
  -- registered files stay frozen: they are part of the record
  if v_doc.status = 'draft' then
    update public.document_files set frozen = false where document_id = p_document_id and frozen;
  end if;

  perform public.doc_log(p_document_id, 'cancelled', v_doc.status, 'cancelled',
    jsonb_build_object('reason', v_reason, 'arrival_number', v_doc.arrival_number));
end;
$$;

create or replace function public.reopen_document(p_document_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.documents;
  v_reason text;
  v_lead public.document_assignments;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select * into v_doc from public.documents where id = p_document_id for update;
  if v_doc.id is null or not public.can_read_document(p_document_id) then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  if not public.has_org_role_user(v_doc.org_id, 'leader', v_uid)
     and not public.has_org_role_user(v_doc.org_id, 'org_admin', v_uid) then
    raise exception 'Only leaders can reopen a document' using errcode = '42501';
  end if;
  if v_doc.direction <> 'incoming' or v_doc.status <> 'completed' then
    raise exception 'Only a completed incoming document can be reopened' using errcode = '22023';
  end if;
  v_reason := public.doc_clean_reason(p_reason, 'The reason');

  update public.documents set status = 'in_progress', completed_at = null where id = p_document_id;

  select * into v_lead from public.document_assignments
  where document_id = p_document_id and parent_id is null and role = 'lead'
    and status not in ('revoked', 'returned')
  order by assigned_at desc
  limit 1;
  if v_lead.id is not null then
    perform public.doc_notify(
      public.doc_assignment_recipient(v_lead.assignee_user_id, v_lead.assignee_department_id),
      p_document_id, 'document.reopened',
      public.doc_title(v_doc.urgency, 'Reopened: ' || left(v_doc.subject, 160)), left(v_reason, 500));
  end if;
  perform public.doc_log(p_document_id, 'reopened', 'completed', 'in_progress',
    jsonb_build_object('reason', v_reason));
end;
$$;

-- =============================================
-- Privileges
-- =============================================
-- Supabase (and the test stubs) grant new functions to anon/authenticated by
-- default, so each one is revoked explicitly.
revoke all on function public.doc_is_my_assignment(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.doc_assignment_recipient(uuid, uuid) from public, anon, authenticated;
revoke all on function public.doc_title(text, text) from public, anon, authenticated;
revoke all on function public.doc_clean_reason(text, text) from public, anon, authenticated;
grant execute on function public.doc_is_my_assignment(uuid, uuid, uuid) to service_role;
grant execute on function public.doc_assignment_recipient(uuid, uuid) to service_role;
grant execute on function public.doc_title(text, text) to service_role;
grant execute on function public.doc_clean_reason(text, text) to service_role;

revoke all on function public.register_incoming(uuid, uuid, text) from public, anon;
revoke all on function public.submit_incoming(uuid, uuid, text) from public, anon;
revoke all on function public.assign_document(uuid, jsonb, uuid, text) from public, anon;
revoke all on function public.mark_my_assignments_seen(uuid) from public, anon;
revoke all on function public.update_assignment(uuid, text, text) from public, anon;
revoke all on function public.revoke_assignment(uuid) from public, anon;
revoke all on function public.complete_document(uuid, text) from public, anon;
revoke all on function public.return_to_clerk(uuid, text) from public, anon;
revoke all on function public.cancel_incoming(uuid, text) from public, anon;
revoke all on function public.reopen_document(uuid, text) from public, anon;

grant execute on function public.register_incoming(uuid, uuid, text) to authenticated;
grant execute on function public.submit_incoming(uuid, uuid, text) to authenticated;
grant execute on function public.assign_document(uuid, jsonb, uuid, text) to authenticated;
grant execute on function public.mark_my_assignments_seen(uuid) to authenticated;
grant execute on function public.update_assignment(uuid, text, text) to authenticated;
grant execute on function public.revoke_assignment(uuid) to authenticated;
grant execute on function public.complete_document(uuid, text) to authenticated;
grant execute on function public.return_to_clerk(uuid, text) to authenticated;
grant execute on function public.cancel_incoming(uuid, text) to authenticated;
grant execute on function public.reopen_document(uuid, text) to authenticated;
