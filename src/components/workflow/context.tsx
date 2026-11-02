"use client";

import { createContext, useContext } from "react";
import type { Slot, StepLog, WorkflowDoc } from "@/lib/workflow/model";
import type { ChangeInput } from "./use-workflow-sync";
import type { Reminders } from "./use-reminders";

/** What every part of the editor reads: the plan, its schedule and what the viewer may do. */
export interface WorkflowContextValue {
  workflowId: string;
  doc: WorkflowDoc;
  logs: StepLog[];
  slots: Map<string, Slot>;
  /** the viewer's clock, minutes (refreshed every minute) */
  now: number;
  /** signed in: may change everything; otherwise only extend and change lengths, with a log */
  canEdit: boolean;
  /** steps of other roles are dimmed */
  focusRoleId: string | null;
  edit: (fn: (doc: WorkflowDoc) => WorkflowDoc, key?: string | null) => void;
  openStep: (id: string, tab?: "details" | "history") => void;
  /** opens the logged form: extend, or change the length (viewers) */
  openChange: (stepId: string, kind: ChangeInput["kind"]) => void;
  openRoles: () => void;
  /** the role e-mail directory and reminders: signed-in members only */
  reminders: Reminders | null;
}

const Ctx = createContext<WorkflowContextValue | null>(null);

export const WorkflowProvider = Ctx.Provider;

export function useWorkflow(): WorkflowContextValue {
  const value = useContext(Ctx);
  if (!value) throw new Error("useWorkflow outside WorkflowProvider");
  return value;
}
