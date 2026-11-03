-- Hourly workflow reminders and the list of every workflow.
-- Run after 202608280050_workflow_admins_confirm.sql. Idempotent.
--
-- * The reminder job now runs every hour inside the plan's working hours. A step in days is
--   reminded on the day it starts ('start') and on its due day when it lasts more than one day
--   ('due'); a step in hours in its first hour ('start') and its last hour before the deadline
--   ('due'); an overdue step once a day. workflow_reminders.kind gains 'start'; automatic rows
--   stay unique per step, kind and day (workflow_reminders_once_v2).
-- * Signed-in users may list every workflow (/workflow "Tất cả", "Đổi workflow"). The list is
--   read on the server with the service role, so no policy changes here.
-- Rollback:
--   delete from public.workflow_reminders where kind = 'start';
--   re-run the kind check of 202608280050_workflow_admins_confirm.sql.

alter table public.workflow_reminders drop constraint if exists workflow_reminders_kind_check;
alter table public.workflow_reminders add constraint workflow_reminders_kind_check
  check (kind in ('upcoming', 'start', 'due', 'overdue', 'progress', 'confirm'));
