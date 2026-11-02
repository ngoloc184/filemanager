-- Fix: creating a workflow from the app failed with "new row violates row-level security policy".
-- Run after 202608280047_workflows.sql. Idempotent.
--
-- supabase-js inserts with RETURNING, and Postgres checks the SELECT policy on the new row before
-- the AFTER INSERT trigger adds the creator to workflow_members. The owner (set by the BEFORE
-- trigger) may now always read their own plan, so the new row passes that check.
-- Rollback: re-run the "workflows_select" policy from 202608280047_workflows.sql.

drop policy if exists "workflows_select" on public.workflows;
create policy "workflows_select" on public.workflows for select to authenticated
  using (owner_id = auth.uid() or public.is_workflow_member(id));
