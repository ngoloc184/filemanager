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
  /** the plan's owner or an admin: may change everything */
  canEdit: boolean;
  /** signed in: logged changes go under the account's name (no name field) */
  signedIn: boolean;
  /** the steps under way now (isCurrent), highlighted on the diagram and the timeline */
  currentIds: Set<string>;
  /** steps of other roles are dimmed */
  focusRoleId: string | null;
  edit: (fn: (doc: WorkflowDoc) => WorkflowDoc, key?: string | null) => void;
  openStep: (id: string, tab?: "details" | "history") => void;
  /** opens the logged form: extend, change an unconfirmed length, or confirm the timeline */
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
