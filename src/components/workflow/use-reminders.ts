"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { roleKey, type ReminderKind } from "@/lib/workflow/reminders";

export interface SentReminder {
  id: string;
  stepId: string;
  kind: ReminderKind;
  manual: boolean;
  recipients: string[];
  createdAt: string;
}

export interface RemindResult {
  stepId: string;
  kind: ReminderKind;
  sent: number;
  skipped?: "no-recipients" | "already-sent" | "failed";
}

/**
 * Signed-in members only: the team's role → e-mail directory (shared by every workflow, matched on
 * the role name) and this plan's sent reminders.
 */
export function useReminders(workflowId: string, enabled: boolean) {
  const [directory, setDirectory] = useState<Map<string, { id: string; emails: string[] }>>(new Map());
  const [sent, setSent] = useState<SentReminder[]>([]);

  const reload = useCallback(async () => {
    if (!enabled) return;
    const supabase = createClient();
    const [contacts, reminders] = await Promise.all([
      supabase.from("workflow_role_contacts").select("id, role_name, emails"),
      supabase.from("workflow_reminders").select("id, step_id, kind, manual, recipients, created_at").eq("workflow_id", workflowId).order("created_at", { ascending: false }).limit(500),
    ]);
    type ContactRow = { id: string; role_name: string; emails: string[] };
    type ReminderRow = { id: string; step_id: string; kind: ReminderKind; manual: boolean; recipients: string[]; created_at: string };
    if (!contacts.error) setDirectory(new Map(((contacts.data ?? []) as ContactRow[]).map((r) => [roleKey(r.role_name), { id: r.id, emails: r.emails }])));
    if (!reminders.error)
      setSent(((reminders.data ?? []) as ReminderRow[]).map((r) => ({ id: r.id, stepId: r.step_id, kind: r.kind, manual: r.manual, recipients: r.recipients, createdAt: r.created_at })));
  }, [workflowId, enabled]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads once the page is in the browser
    void reload();
  }, [reload]);

  /** Saves a role's addresses in the shared directory; returns an error message or null. */
  const setRoleEmails = useCallback(
    async (roleName: string, emails: string[]): Promise<string | null> => {
      const supabase = createClient();
      const existing = directory.get(roleKey(roleName));
      const { error } = existing
        ? await supabase.from("workflow_role_contacts").update({ emails }).eq("id", existing.id)
        : await supabase.from("workflow_role_contacts").insert({ role_name: roleName.trim(), emails });
      await reload();
      return error ? "Không lưu được email (kiểm tra lại địa chỉ)" : null;
    },
    [directory, reload]
  );

  /** "Nhắc ngay" for one step, or for every step due a reminder today. */
  const remind = useCallback(
    async (stepId: string | null): Promise<{ results: RemindResult[] } | { error: string }> => {
      try {
        const res = await fetch(`/api/workflows/${workflowId}/remind`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(stepId ? { stepId } : {}),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) return { error: (body as { error?: string } | null)?.error ?? "Không gửi được nhắc nhở" };
        await reload();
        return body as { results: RemindResult[] };
      } catch {
        return { error: "Mất kết nối, hãy thử lại" };
      }
    },
    [workflowId, reload]
  );

  const emailsFor = useCallback((roleName: string) => directory.get(roleKey(roleName))?.emails ?? [], [directory]);

  return useMemo(() => ({ directory, sent, emailsFor, setRoleEmails, remind, reload }), [directory, sent, emailsFor, setRoleEmails, remind, reload]);
}

export type Reminders = ReturnType<typeof useReminders>;
