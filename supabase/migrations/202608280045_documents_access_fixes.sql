-- Documents access fixes found by the end-to-end test (9999):
--
-- 1. Recall takes access back from people named as recipients. Before, only
--    department recipients lost it (their info assignments are revoked);
--    a member recipient kept reading a recalled document and its files
--    through rule (h) of can_read_document. document_recipients gets
--    revoked_at, set by a trigger when a document becomes 'recalled', and
--    rule (h) ignores revoked rows. The same trigger revokes the info
--    copies already marked as read ('done'): recall_document revokes only
--    open ones (after notifying them), and rules (c)/(e) let any non-revoked
--    assignment read, so a recipient (or a whole department, once its head
--    marked the copy read) kept access. can_read_document is copied unchanged
--    from 202608280036_documents_core.sql except for that rule.
-- 2. A main file or attachment added to an incoming document after it was
--    registered is frozen at once, like the files register_incoming froze.
--    Before, it stayed editable for good (Phụ lục VI III.5.d).
--
-- Run after 202608280044_custom_stickers.sql. Safe to run again.

-- =============================================
-- 1. Recall revokes recipients
-- =============================================
alter table public.document_recipients add column if not exists revoked_at timestamptz;

create or replace function public.can_read_document(p_document_id uuid)
returns boolean
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.documents;
  v_private_draft boolean;
begin
  if v_uid is null or p_document_id is null then
    return false;
  end if;
  select * into v_doc from public.documents where id = p_document_id;
  if v_doc.id is null or not public.is_org_member_user(v_doc.org_id, v_uid) then
    return false;
  end if;

  -- outgoing/internal drafts that were never submitted belong to their author
  v_private_draft := v_doc.direction in ('outgoing', 'internal')
    and v_doc.status = 'draft' and v_doc.submitted_at is null;

  -- (b) author, the person it is presented to, the signer
  if v_doc.created_by = v_uid or v_doc.presented_to = v_uid or v_doc.signer_user_id = v_uid then
    return true;
  end if;

  if v_doc.confidentiality <> 'confidential' then
    -- (a) admins, leaders and clerks see the company's documents
    if not v_private_draft and exists (
      select 1 from public.org_members m
      where m.org_id = v_doc.org_id and m.user_id = v_uid and m.status = 'active'
        and m.roles && array['org_admin', 'leader', 'clerk']
    ) then
      return true;
    end if;
  else
    -- (k) confidential: only the clerk who registered it
    if exists (
      select 1 from public.document_events e
      where e.document_id = p_document_id and e.action = 'registered' and e.actor_id = v_uid
    ) then
      return true;
    end if;
  end if;

  -- (c) assigned to me, (d) to a department I head, (e) for information to my department
  if exists (
    select 1 from public.document_assignments a
    where a.document_id = p_document_id
      and a.status <> 'revoked'
      and (
        a.assignee_user_id = v_uid
        or a.assignee_department_id in (select public.headed_departments_of(v_uid))
        or (a.role = 'info' and a.assignee_department_id = public.member_department(v_doc.org_id, v_uid))
      )
  ) then
    return true;
  end if;

  -- (f) department heads see what their department drafts
  if v_doc.confidentiality <> 'confidential' and not v_private_draft
     and v_doc.drafting_department_id is not null
     and public.has_org_role_user(v_doc.org_id, 'dept_head', v_uid)
     and v_doc.drafting_department_id in (select public.headed_departments_of(v_uid)) then
    return true;
  end if;

  -- (g) approvers
  if exists (
    select 1 from public.document_approval_steps s
    where s.document_id = p_document_id and s.approver_user_id = v_uid
  ) then
    return true;
  end if;

  -- (h) member recipients, until the document is recalled (045)
  if exists (
    select 1 from public.document_recipients r
    where r.document_id = p_document_id and r.kind = 'member' and r.user_id = v_uid
      and r.revoked_at is null
  ) then
    return true;
  end if;

  -- (i) managers and followers of the register (never an unsubmitted draft)
  if v_doc.confidentiality <> 'confidential' and not v_private_draft
     and v_doc.register_id is not null and exists (
       select 1 from public.doc_register_roles rr
       where rr.register_id = v_doc.register_id and rr.user_id = v_uid
     ) then
    return true;
  end if;

  -- (j) shared with me
  return exists (
    select 1 from public.document_grants g
    where g.document_id = p_document_id and g.user_id = v_uid
  );
end;
$$;

create or replace function public.documents_recall_revokes_recipients()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  update public.document_recipients set revoked_at = now()
  where document_id = new.id and revoked_at is null;
  -- read copies only: recall_document notifies the open ones, then revokes them
  update public.document_assignments set status = 'revoked'
  where document_id = new.id and role = 'info' and status = 'done';
  return null;
end;
$$;

drop trigger if exists documents_recall_revokes_recipients on public.documents;
create trigger documents_recall_revokes_recipients
  after update of status on public.documents
  for each row
  when (new.status = 'recalled' and old.status is distinct from 'recalled')
  execute function public.documents_recall_revokes_recipients();

-- documents recalled before this migration
update public.document_recipients r set revoked_at = coalesce(d.recalled_at, now())
from public.documents d
where d.id = r.document_id and d.status = 'recalled' and r.revoked_at is null;
update public.document_assignments a set status = 'revoked'
from public.documents d
where d.id = a.document_id and d.status = 'recalled' and a.role = 'info' and a.status <> 'revoked';

-- =============================================
-- 2. Files added to a registered incoming document are frozen
-- =============================================
create or replace function public.documents_freeze_late_files()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if new.kind in ('main', 'attachment') and exists (
    select 1 from public.documents d
    where d.id = new.document_id and d.direction = 'incoming' and d.status <> 'draft'
  ) then
    new.frozen := true;
  end if;
  return new;
end;
$$;

drop trigger if exists documents_freeze_late_files on public.document_files;
create trigger documents_freeze_late_files
  before insert on public.document_files
  for each row execute function public.documents_freeze_late_files();

-- attachments added late before this migration
update public.document_files df set frozen = true
from public.documents d
where d.id = df.document_id and d.direction = 'incoming' and d.status not in ('draft', 'cancelled')
  and df.kind in ('main', 'attachment') and not df.frozen;

-- =============================================
-- Privileges: trigger functions are never called directly
-- =============================================
revoke all on function public.documents_recall_revokes_recipients() from public, anon, authenticated;
revoke all on function public.documents_freeze_late_files() from public, anon, authenticated;
