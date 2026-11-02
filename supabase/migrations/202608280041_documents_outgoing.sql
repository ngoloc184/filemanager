-- Outgoing and internal documents (văn bản đi / nội bộ): approval chain,
-- e-approval sign, issue with numbering, recall, withdraw and follow-ups
-- (reply / replacement / correction).
-- Run after 202608280036_documents_core.sql. Idempotent.
--
-- Flow: draft → (set_approval_chain, submit_for_approval) in_review →
-- (approve_step per step_no) awaiting_signature → (sign_document) signed →
-- (issue_document, clerk) issued → (recall_document) recalled.
-- return_document sends it back to draft as revision + 1 with the same chain;
-- reject_document and withdraw_document end it.
--
-- Freeze: submit freezes every linked file so the reviewers approve exactly
-- what they saw; return unfreezes them (an editable draft again). Signed,
-- issued, rejected, withdrawn and recalled documents keep them frozen.
--
-- Sign is an authenticated in-app approval (signer, authority, checksum of the
-- main file). It is NOT a digital signature (chữ ký số) under Decree 30 Art. 5.
--
-- Events use only the canonical names: chain_set, submitted_for_approval,
-- approved, returned, rejected, signed, issued, manual_number_override,
-- recalled, withdrawn, follow_up_created, created.
--
-- Rollback (manual):
--   drop function if exists public.create_follow_up(uuid, text);
--   drop function if exists public.withdraw_document(uuid);
--   drop function if exists public.recall_document(uuid, text);
--   drop function if exists public.issue_document(uuid, uuid, jsonb, int);
--   drop function if exists public.sign_document(uuid, text, text);
--   drop function if exists public.reject_document(uuid, text);
--   drop function if exists public.return_document(uuid, text);
--   drop function if exists public.approve_step(uuid, text);
--   drop function if exists public.submit_for_approval(uuid);
--   drop function if exists public.set_approval_chain(uuid, jsonb);
--   drop function if exists public.doc_out_activate(uuid, int);
--   drop function if exists public.doc_out_opinion(uuid, text, text);
--   drop function if exists public.doc_out_lock(uuid);
--   drop function if exists public.doc_can_sign_user(uuid, uuid);

-- =============================================
-- Internal helpers (definer RPCs only; service_role grant)
-- =============================================

-- Leaders, and members whose position may sign (positions.can_sign).
create or replace function public.doc_can_sign_user(p_org_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.org_members m
    left join public.positions p on p.id = m.position_id
    where m.org_id = p_org_id and m.user_id = p_user_id and m.status = 'active'
      and ('leader' = any (m.roles) or coalesce(p.can_sign, false))
  );
$$;

-- Locks an outgoing/internal document the caller can read, or raises.
create or replace function public.doc_out_lock(p_document_id uuid)
returns public.documents
language plpgsql security definer
set search_path = public
as $$
declare
  v_doc public.documents;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select * into v_doc from public.documents where id = p_document_id for update;
  if v_doc.id is null or not public.can_read_document(p_document_id) then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  if v_doc.direction not in ('outgoing', 'internal') then
    raise exception 'This applies to outgoing and internal documents only' using errcode = '22023';
  end if;
  return v_doc;
end;
$$;

-- Stores a non-blank comment as an opinion of the caller; returns its id.
create or replace function public.doc_out_opinion(p_document_id uuid, p_kind text, p_body text)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_body text := btrim(coalesce(p_body, ''));
  v_id uuid;
begin
  if v_body = '' then
    return null;
  end if;
  if char_length(v_body) > 5000 then
    raise exception 'A comment must be at most 5000 characters' using errcode = '22023';
  end if;
  insert into public.document_opinions (document_id, author_id, kind, body)
  values (p_document_id, auth.uid(), p_kind, v_body)
  returning id into v_id;
  return v_id;
end;
$$;

-- Makes the waiting steps of p_step_no (current revision) pending, moves the
-- document to that step and asks those approvers. Returns the new status.
create or replace function public.doc_out_activate(p_document_id uuid, p_step_no int)
returns text
language plpgsql security definer
set search_path = public
as $$
declare
  v_doc public.documents;
  v_status text;
  v_step record;
begin
  select * into v_doc from public.documents where id = p_document_id;
  update public.document_approval_steps
  set status = 'pending'
  where document_id = p_document_id and revision = v_doc.revision
    and step_no = p_step_no and status = 'waiting';

  v_status := case when exists (
    select 1 from public.document_approval_steps
    where document_id = p_document_id and revision = v_doc.revision
      and step_no = p_step_no and kind = 'sign'
  ) then 'awaiting_signature' else 'in_review' end;

  update public.documents
  set current_step_no = p_step_no, status = v_status
  where id = p_document_id;

  for v_step in
    select s.approver_user_id, s.kind from public.document_approval_steps s
    where s.document_id = p_document_id and s.revision = v_doc.revision
      and s.step_no = p_step_no and s.status = 'pending'
  loop
    perform public.doc_notify(v_step.approver_user_id, p_document_id, 'document.approval_requested',
      case when v_step.kind = 'sign' then 'Please sign: ' else 'Please review: ' end
        || left(v_doc.subject, 150));
  end loop;
  return v_status;
end;
$$;

-- =============================================
-- Approval chain
-- =============================================

-- p_steps: ordered [{approver_user_id, kind, parallel_with_previous?, required?}].
-- Replaces the waiting steps of the current revision; returns how many.
create or replace function public.set_approval_chain(p_document_id uuid, p_steps jsonb)
returns int
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.documents;
  v_count int;
  v_item jsonb;
  v_ord bigint;
  v_user uuid;
  v_kind text;
  v_parallel boolean;
  v_required boolean;
  v_step int := 0;
  v_step_users uuid[] := '{}';
  v_users uuid[] := '{}';
  v_kinds text[] := '{}';
  v_steps int[] := '{}';
  v_requireds boolean[] := '{}';
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_doc := public.doc_out_lock(p_document_id);
  if v_doc.created_by is distinct from v_uid or v_doc.status <> 'draft' then
    raise exception 'Only the author can set the approval chain of a draft' using errcode = '42501';
  end if;
  if p_steps is null or jsonb_typeof(p_steps) <> 'array' then
    raise exception 'Invalid approval chain' using errcode = '22023';
  end if;
  v_count := jsonb_array_length(p_steps);
  if v_count = 0 then
    raise exception 'Add at least one approver, ending with the signer' using errcode = '22023';
  end if;
  if v_count > 10 then
    raise exception 'Add at most 10 steps' using errcode = '22023';
  end if;
  if (select count(*) from jsonb_array_elements(p_steps) e
      where jsonb_typeof(e) = 'object' and e ->> 'kind' = 'sign') <> 1 then
    raise exception 'End the chain with exactly one signer' using errcode = '22023';
  end if;

  for v_item, v_ord in
    select e.value, e.ordinality from jsonb_array_elements(p_steps) with ordinality as e
  loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'Invalid approval step' using errcode = '22023';
    end if;
    v_user := public.doc_json_uuid(v_item, 'approver_user_id', 'Approver');
    if v_user is null then
      raise exception 'Pick a person for every step' using errcode = '22023';
    end if;
    v_kind := public.doc_json_text(v_item, 'kind', 20, 'Step kind');
    if v_kind is null or v_kind not in ('review', 'format_check', 'consult', 'sign') then
      raise exception 'Unknown step kind: %', coalesce(v_kind, '(empty)') using errcode = '22023';
    end if;
    if coalesce(jsonb_typeof(v_item -> 'parallel_with_previous'), 'null') not in ('null', 'boolean')
       or coalesce(jsonb_typeof(v_item -> 'required'), 'null') not in ('null', 'boolean') then
      raise exception 'parallel_with_previous and required must be true or false' using errcode = '22023';
    end if;
    v_parallel := v_ord > 1 and coalesce((v_item ->> 'parallel_with_previous')::boolean, false);
    -- consult is optional unless asked for; every other kind is required
    v_required := case when v_kind = 'consult'
      then coalesce((v_item ->> 'required')::boolean, false) else true end;

    if v_kind = 'sign' and (v_ord <> v_count or v_parallel) then
      raise exception 'The signer must be last' using errcode = '22023';
    end if;
    if not public.is_org_member_user(v_doc.org_id, v_user) then
      raise exception 'Approvers must be active members of the company' using errcode = '22023';
    end if;
    if v_kind = 'sign' and not public.doc_can_sign_user(v_doc.org_id, v_user) then
      raise exception '% cannot sign documents', coalesce(public.doc_user_name(v_user), 'This person')
        using errcode = '22023';
    end if;

    if not v_parallel then
      v_step := v_step + 1;
      v_step_users := '{}';
    end if;
    if v_user = any (v_step_users) then
      raise exception 'A person appears twice in the same step' using errcode = '22023';
    end if;
    v_step_users := v_step_users || v_user;
    v_users := v_users || v_user;
    v_kinds := v_kinds || v_kind;
    v_steps := v_steps || v_step;
    v_requireds := v_requireds || v_required;
  end loop;

  delete from public.document_approval_steps
  where document_id = p_document_id and revision = v_doc.revision and status = 'waiting';

  insert into public.document_approval_steps (document_id, revision, step_no, kind, approver_user_id, required, status)
  select p_document_id, v_doc.revision, s.step_no, s.kind, s.approver, s.required, 'waiting'
  from unnest(v_steps, v_kinds, v_users, v_requireds) as s(step_no, kind, approver, required);

  perform public.doc_log(p_document_id, 'chain_set', v_doc.status, v_doc.status,
    jsonb_build_object('revision', v_doc.revision, 'steps', v_count, 'step_count', v_step));
  return v_count;
end;
$$;

create or replace function public.submit_for_approval(p_document_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.documents;
  v_first int;
  v_bad uuid;
  v_status text;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_doc := public.doc_out_lock(p_document_id);
  if v_doc.created_by is distinct from v_uid or v_doc.status <> 'draft' then
    raise exception 'Only the author can submit a draft' using errcode = '42501';
  end if;
  if btrim(coalesce(v_doc.subject, '')) = '' then
    raise exception 'Subject is required' using errcode = '22023';
  end if;
  if v_doc.doc_type_id is null then
    raise exception 'Choose a document type first' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.document_files where document_id = p_document_id and kind = 'main'
  ) then
    raise exception 'Attach the main file first' using errcode = '22023';
  end if;

  select min(step_no) into v_first
  from public.document_approval_steps
  where document_id = p_document_id and revision = v_doc.revision and status = 'waiting';
  if v_first is null then
    raise exception 'Add at least one approver, ending with the signer' using errcode = '22023';
  end if;

  -- people may have left, or lost the right to sign, since the chain was set
  select s.approver_user_id into v_bad
  from public.document_approval_steps s
  where s.document_id = p_document_id and s.revision = v_doc.revision
    and (s.approver_user_id is null or not public.is_org_member_user(v_doc.org_id, s.approver_user_id))
  limit 1;
  if found then
    raise exception 'An approver is no longer an active member; update the approval chain' using errcode = '22023';
  end if;
  select s.approver_user_id into v_bad
  from public.document_approval_steps s
  where s.document_id = p_document_id and s.revision = v_doc.revision and s.kind = 'sign'
    and not public.doc_can_sign_user(v_doc.org_id, s.approver_user_id)
  limit 1;
  if found then
    raise exception '% cannot sign documents', coalesce(public.doc_user_name(v_bad), 'The signer')
      using errcode = '22023';
  end if;

  -- reviewers approve exactly what they see
  update public.document_files set frozen = true where document_id = p_document_id;
  update public.documents set submitted_at = now() where id = p_document_id;
  v_status := public.doc_out_activate(p_document_id, v_first);

  perform public.doc_log(p_document_id, 'submitted_for_approval', v_doc.status, v_status,
    jsonb_build_object('revision', v_doc.revision, 'step_no', v_first));
end;
$$;

-- Approves the caller's pending review / format check / consult step and
-- moves on once no required step of that step_no is still pending.
create or replace function public.approve_step(p_document_id uuid, p_comment text default null)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.documents;
  v_step public.document_approval_steps;
  v_next int;
  v_status text;
  v_opinion uuid;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_doc := public.doc_out_lock(p_document_id);
  select * into v_step from public.document_approval_steps
  where document_id = p_document_id and revision = v_doc.revision
    and approver_user_id = v_uid and status = 'pending'
  for update;
  if v_step.id is null or v_doc.status not in ('in_review', 'awaiting_signature') then
    raise exception 'You have no pending step on this document' using errcode = '42501';
  end if;
  if v_step.kind = 'sign' then
    raise exception 'Use Sign for the final step' using errcode = '22023';
  end if;

  v_opinion := public.doc_out_opinion(p_document_id,
    case when v_step.kind = 'consult' then 'consult_reply' else 'comment' end, p_comment);
  update public.document_approval_steps
  set status = 'approved', acted_at = now(), acted_by = v_uid, comment = nullif(btrim(p_comment), '')
  where id = v_step.id;

  v_status := v_doc.status;
  if not exists (
    select 1 from public.document_approval_steps
    where document_id = p_document_id and revision = v_doc.revision
      and step_no = v_step.step_no and status = 'pending' and required
  ) then
    update public.document_approval_steps
    set status = 'skipped'
    where document_id = p_document_id and revision = v_doc.revision
      and step_no = v_step.step_no and status = 'pending' and not required;

    select min(step_no) into v_next
    from public.document_approval_steps
    where document_id = p_document_id and revision = v_doc.revision
      and step_no > v_step.step_no and status = 'waiting';
    if v_next is not null then
      v_status := public.doc_out_activate(p_document_id, v_next);
    end if;
  end if;

  perform public.doc_log(p_document_id, 'approved', v_doc.status, v_status,
    jsonb_build_object('step_no', v_step.step_no, 'kind', v_step.kind, 'opinion_id', v_opinion));
  perform public.doc_notify(v_doc.created_by, p_document_id, 'document.approved',
    public.notification_actor_name(v_uid) || ' approved: ' || left(v_doc.subject, 150),
    left(nullif(btrim(p_comment), ''), 140));
end;
$$;

-- Back to the author as a new revision with the same chain (all waiting).
create or replace function public.return_document(p_document_id uuid, p_comment text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.documents;
  v_step public.document_approval_steps;
  v_opinion uuid;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_doc := public.doc_out_lock(p_document_id);
  select * into v_step from public.document_approval_steps
  where document_id = p_document_id and revision = v_doc.revision
    and approver_user_id = v_uid and status = 'pending'
  for update;
  if v_step.id is null or v_doc.status not in ('in_review', 'awaiting_signature') then
    raise exception 'You have no pending step on this document' using errcode = '42501';
  end if;
  if btrim(coalesce(p_comment, '')) = '' then
    raise exception 'Say what needs to change' using errcode = '22023';
  end if;

  v_opinion := public.doc_out_opinion(p_document_id, 'comment', p_comment);
  update public.document_approval_steps
  set status = 'returned', acted_at = now(), acted_by = v_uid, comment = btrim(p_comment)
  where id = v_step.id;
  update public.document_approval_steps
  set status = 'skipped'
  where document_id = p_document_id and revision = v_doc.revision
    and status in ('waiting', 'pending');

  insert into public.document_approval_steps (document_id, revision, step_no, kind, approver_user_id, required, status)
  select s.document_id, v_doc.revision + 1, s.step_no, s.kind, s.approver_user_id, s.required, 'waiting'
  from public.document_approval_steps s
  where s.document_id = p_document_id and s.revision = v_doc.revision
  on conflict (document_id, revision, step_no, approver_user_id) do nothing;

  update public.documents
  set status = 'draft', revision = v_doc.revision + 1, current_step_no = null
  where id = p_document_id;
  -- an editable draft again
  update public.document_files set frozen = false where document_id = p_document_id;

  perform public.doc_log(p_document_id, 'returned', v_doc.status, 'draft',
    jsonb_build_object('step_no', v_step.step_no, 'revision', v_doc.revision + 1, 'opinion_id', v_opinion));
  perform public.doc_notify(v_doc.created_by, p_document_id, 'document.returned_for_revision',
    public.notification_actor_name(v_uid) || ' returned for revision: ' || left(v_doc.subject, 150),
    left(btrim(p_comment), 140));
end;
$$;

-- Ends the document (terminal); its files stay frozen.
create or replace function public.reject_document(p_document_id uuid, p_comment text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.documents;
  v_step public.document_approval_steps;
  v_opinion uuid;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_doc := public.doc_out_lock(p_document_id);
  select * into v_step from public.document_approval_steps
  where document_id = p_document_id and revision = v_doc.revision
    and approver_user_id = v_uid and status = 'pending'
  for update;
  if v_step.id is null or v_doc.status not in ('in_review', 'awaiting_signature') then
    raise exception 'You have no pending step on this document' using errcode = '42501';
  end if;

  v_opinion := public.doc_out_opinion(p_document_id, 'comment', p_comment);
  update public.document_approval_steps
  set status = 'rejected', acted_at = now(), acted_by = v_uid, comment = nullif(btrim(p_comment), '')
  where id = v_step.id;
  update public.document_approval_steps
  set status = 'skipped'
  where document_id = p_document_id and revision = v_doc.revision
    and status in ('waiting', 'pending');
  update public.documents set status = 'rejected', current_step_no = null where id = p_document_id;

  perform public.doc_log(p_document_id, 'rejected', v_doc.status, 'rejected',
    jsonb_build_object('step_no', v_step.step_no, 'opinion_id', v_opinion));
  perform public.doc_notify(v_doc.created_by, p_document_id, 'document.rejected',
    public.notification_actor_name(v_uid) || ' rejected: ' || left(v_doc.subject, 150),
    left(nullif(btrim(p_comment), ''), 140));
end;
$$;

-- E-approval by the signer of the last step (not a chữ ký số).
create or replace function public.sign_document(
  p_document_id uuid, p_authority text default '', p_comment text default null
)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.documents;
  v_step public.document_approval_steps;
  v_authority text := upper(btrim(coalesce(p_authority, '')));
  v_checksum text;
  v_position text;
  v_title text;
  v_clerk uuid;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_doc := public.doc_out_lock(p_document_id);
  select * into v_step from public.document_approval_steps
  where document_id = p_document_id and revision = v_doc.revision
    and approver_user_id = v_uid and status = 'pending' and kind = 'sign'
  for update;
  if v_step.id is null or v_doc.status <> 'awaiting_signature' then
    raise exception 'You have no signature pending on this document' using errcode = '42501';
  end if;
  if v_authority not in ('', 'KT', 'TL', 'TUQ', 'TM', 'Q') then
    raise exception 'Unknown signing authority: %', v_authority using errcode = '22023';
  end if;
  if not public.doc_can_sign_user(v_doc.org_id, v_uid) then
    raise exception '% cannot sign documents', coalesce(public.doc_user_name(v_uid), 'You')
      using errcode = '42501';
  end if;

  select coalesce(fv.checksum, f.checksum) into v_checksum
  from public.document_files df
  join public.files f on f.id = df.file_id
  left join public.file_versions fv on fv.id = f.current_version_id
  where df.document_id = p_document_id and df.kind = 'main'
  limit 1;
  if not found then
    raise exception 'Attach the main file first' using errcode = '22023';
  end if;

  select coalesce(nullif(btrim(p.name), ''), nullif(btrim(m.title), '')) into v_position
  from public.org_members m
  left join public.positions p on p.id = m.position_id
  where m.org_id = v_doc.org_id and m.user_id = v_uid;

  perform public.doc_out_opinion(p_document_id, 'comment', p_comment);
  update public.document_approval_steps
  set status = 'approved', acted_at = now(), acted_by = v_uid, comment = nullif(btrim(p_comment), '')
  where id = v_step.id;
  update public.documents
  set status = 'signed', signed_at = now(), signer_user_id = v_uid,
      signer_name = left(public.doc_user_name(v_uid), 200),
      signer_position = left(v_position, 200),
      signer_authority = v_authority,
      signed_checksum = v_checksum,
      current_step_no = null
  where id = p_document_id;
  update public.document_files set frozen = true where document_id = p_document_id;

  perform public.doc_log(p_document_id, 'signed', v_doc.status, 'signed',
    jsonb_build_object('authority', v_authority, 'checksum', v_checksum));

  v_title := public.notification_actor_name(v_uid) || ' signed: ' || left(v_doc.subject, 150);
  perform public.doc_notify(v_doc.created_by, p_document_id, 'document.signed', v_title);
  for v_clerk in
    select m.user_id from public.org_members m
    where m.org_id = v_doc.org_id and m.status = 'active' and 'clerk' = any (m.roles)
      and m.user_id is distinct from v_doc.created_by
  loop
    perform public.doc_notify(v_clerk, p_document_id, 'document.ready_to_issue',
      'Ready to issue: ' || left(v_doc.subject, 150));
  end loop;
end;
$$;

-- =============================================
-- Issue (ban hành), recall, withdraw
-- =============================================

-- p_recipients: [{kind:'member', user_id} | {kind:'department', department_id}
--   | {kind:'external', external_org_id?, name?, method?}], at most 200.
-- A manual number never moves backwards later: the counter is raised to it,
-- so automatic numbers do not collide with it afterwards.
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

  perform public.doc_notify(v_doc.created_by, p_document_id, 'document.issued', v_title);
  perform public.doc_log(p_document_id, 'issued', v_doc.status, 'issued',
    jsonb_build_object('number', v_number, 'notation', v_notation, 'register_id', p_register_id,
      'recipients', v_total));

  return jsonb_build_object('number', v_number, 'notation', v_notation);
end;
$$;

-- Thu hồi: the issued document is withdrawn from its recipients.
create or replace function public.recall_document(p_document_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.documents;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_title text;
  v_user uuid;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_doc := public.doc_out_lock(p_document_id);
  if not public.has_org_role_user(v_doc.org_id, 'clerk', v_uid)
     and not public.has_org_role_user(v_doc.org_id, 'leader', v_uid) then
    raise exception 'Only clerks or leaders can recall a document' using errcode = '42501';
  end if;
  if v_doc.status <> 'issued' then
    raise exception 'Only an issued document can be recalled' using errcode = '22023';
  end if;
  if v_reason = '' then
    raise exception 'Give a reason for the recall' using errcode = '22023';
  end if;
  if char_length(v_reason) > 2000 then
    raise exception 'The reason is too long (max 2000 characters)' using errcode = '22023';
  end if;

  update public.documents
  set status = 'recalled', recalled_at = now(), recall_reason = v_reason
  where id = p_document_id;

  v_title := 'Recalled: ' || coalesce(v_doc.notation || ' – ', '') || left(v_doc.subject, 150);
  for v_user in
    select distinct s.u from (
      select v_doc.created_by as u
      union all
      select r.user_id from public.document_recipients r
      where r.document_id = p_document_id and r.kind = 'member'
      union all
      select a.assignee_user_id from public.document_assignments a
      where a.document_id = p_document_id and a.status in ('pending', 'seen', 'in_progress')
      union all
      select dep.head_user_id from public.document_assignments a
      join public.departments dep on dep.id = a.assignee_department_id
      where a.document_id = p_document_id and a.status in ('pending', 'seen', 'in_progress')
    ) s
    where s.u is not null
  loop
    perform public.doc_notify(v_user, p_document_id, 'document.recalled', v_title, left(v_reason, 140));
  end loop;

  update public.document_assignments
  set status = 'revoked'
  where document_id = p_document_id and role = 'info' and status in ('pending', 'seen', 'in_progress');

  perform public.doc_log(p_document_id, 'recalled', v_doc.status, 'recalled',
    jsonb_build_object('reason', v_reason));
end;
$$;

-- The author takes the document back for good; its files stay as they are.
create or replace function public.withdraw_document(p_document_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.documents;
  v_user uuid;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_doc := public.doc_out_lock(p_document_id);
  if v_doc.created_by is distinct from v_uid then
    raise exception 'Only the author can withdraw a document' using errcode = '42501';
  end if;
  if v_doc.status not in ('draft', 'in_review', 'awaiting_signature') then
    raise exception 'Only a document that is not signed yet can be withdrawn' using errcode = '22023';
  end if;

  for v_user in
    select distinct s.approver_user_id from public.document_approval_steps s
    where s.document_id = p_document_id and s.revision = v_doc.revision and s.status = 'pending'
      and s.approver_user_id is not null
  loop
    perform public.doc_notify(v_user, p_document_id, 'document.withdrawn',
      public.notification_actor_name(v_uid) || ' withdrew: ' || left(v_doc.subject, 150));
  end loop;

  update public.document_approval_steps
  set status = 'skipped'
  where document_id = p_document_id and revision = v_doc.revision and status in ('waiting', 'pending');
  update public.documents set status = 'withdrawn', current_step_no = null where id = p_document_id;

  perform public.doc_log(p_document_id, 'withdrawn', v_doc.status, 'withdrawn', '{}');
end;
$$;

-- =============================================
-- Follow-ups: reply (trả lời), replacement (thay thế), correction (đính chính)
-- =============================================
create or replace function public.create_follow_up(p_source_id uuid, p_kind text)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_src public.documents;
  v_direction text;
  v_subject text;
  v_type uuid;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select * into v_src from public.documents where id = p_source_id;
  if v_src.id is null or not public.can_read_document(p_source_id)
     or not public.is_org_member_user(v_src.org_id, v_uid) then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  if p_kind is null or p_kind not in ('reply', 'replacement', 'correction') then
    raise exception 'Unknown follow-up: %', coalesce(p_kind, '(empty)') using errcode = '22023';
  end if;

  if p_kind = 'reply' then
    if v_src.status = 'draft' then
      raise exception 'A draft cannot be replied to' using errcode = '22023';
    end if;
    v_direction := 'outgoing';
    v_subject := left('V/v trả lời ' || coalesce(nullif(btrim(v_src.notation), ''), v_src.subject), 500);
  else
    if v_src.direction not in ('outgoing', 'internal') or v_src.status <> 'issued' then
      raise exception 'Only an issued outgoing or internal document can be replaced or corrected'
        using errcode = '22023';
    end if;
    v_direction := v_src.direction;
    if p_kind = 'replacement' then
      v_subject := v_src.subject;
      v_type := v_src.doc_type_id;
    else
      v_subject := left('Đính chính ' || coalesce(nullif(btrim(v_src.notation), ''), v_src.subject), 500);
      select t.id into v_type from public.doc_types t
      where t.org_id = v_src.org_id and t.is_cong_van and t.active
      order by t.sort_order, t.name
      limit 1;
    end if;
  end if;

  insert into public.documents (
    org_id, direction, status, subject, doc_type_id, field_id, urgency, confidentiality,
    drafting_department_id, created_by, reply_to_id, replaces_id, corrects_id
  )
  values (
    v_src.org_id, v_direction, 'draft', v_subject, v_type,
    case when p_kind = 'replacement' then v_src.field_id end,
    case when p_kind = 'replacement' then v_src.urgency else 'normal' end,
    case when p_kind = 'replacement' then v_src.confidentiality else 'normal' end,
    public.member_department(v_src.org_id, v_uid), v_uid,
    case when p_kind = 'reply' then p_source_id end,
    case when p_kind = 'replacement' then p_source_id end,
    case when p_kind = 'correction' then p_source_id end
  )
  returning id into v_id;

  perform public.doc_log(v_id, 'created', null, 'draft',
    jsonb_build_object('direction', v_direction, 'follow_up', p_kind));
  perform public.doc_log(v_id, 'follow_up_created', 'draft', 'draft',
    jsonb_build_object('kind', p_kind, 'source_id', p_source_id));
  perform public.doc_log(p_source_id, 'follow_up_created', v_src.status, v_src.status,
    jsonb_build_object('kind', p_kind, 'document_id', v_id));
  return v_id;
end;
$$;

-- =============================================
-- Privileges
-- =============================================
revoke all on function public.doc_can_sign_user(uuid, uuid) from public, anon, authenticated;
revoke all on function public.doc_out_lock(uuid) from public, anon, authenticated;
revoke all on function public.doc_out_opinion(uuid, text, text) from public, anon, authenticated;
revoke all on function public.doc_out_activate(uuid, int) from public, anon, authenticated;
grant execute on function public.doc_can_sign_user(uuid, uuid) to service_role;
grant execute on function public.doc_out_lock(uuid) to service_role;
grant execute on function public.doc_out_opinion(uuid, text, text) to service_role;
grant execute on function public.doc_out_activate(uuid, int) to service_role;

revoke all on function public.set_approval_chain(uuid, jsonb) from public, anon;
revoke all on function public.submit_for_approval(uuid) from public, anon;
revoke all on function public.approve_step(uuid, text) from public, anon;
revoke all on function public.return_document(uuid, text) from public, anon;
revoke all on function public.reject_document(uuid, text) from public, anon;
revoke all on function public.sign_document(uuid, text, text) from public, anon;
revoke all on function public.issue_document(uuid, uuid, jsonb, int) from public, anon;
revoke all on function public.recall_document(uuid, text) from public, anon;
revoke all on function public.withdraw_document(uuid) from public, anon;
revoke all on function public.create_follow_up(uuid, text) from public, anon;

grant execute on function public.set_approval_chain(uuid, jsonb) to authenticated;
grant execute on function public.submit_for_approval(uuid) to authenticated;
grant execute on function public.approve_step(uuid, text) to authenticated;
grant execute on function public.return_document(uuid, text) to authenticated;
grant execute on function public.reject_document(uuid, text) to authenticated;
grant execute on function public.sign_document(uuid, text, text) to authenticated;
grant execute on function public.issue_document(uuid, uuid, jsonb, int) to authenticated;
grant execute on function public.recall_document(uuid, text) to authenticated;
grant execute on function public.withdraw_document(uuid) to authenticated;
grant execute on function public.create_follow_up(uuid, text) to authenticated;
