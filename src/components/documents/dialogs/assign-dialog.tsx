"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Building2, Loader2, Plus, Trash2, User } from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DepartmentSelect, nativeSelectClass } from "@/components/org/department-select";
import { PersonPicker } from "@/components/org/person-picker";
import { listHolidays } from "@/lib/services/documents";
import { assignDocument } from "@/lib/services/documents-incoming";
import { getMyOrg } from "@/lib/services/org";
import {
  DEFAULT_ORG_TIME_ZONE,
  addWorkingDays,
  defaultDueDays,
  formatDay,
  holidaySet,
  todayIn,
} from "@/lib/documents/deadlines";
import {
  MAX_ASSIGNMENT_ITEMS,
  MAX_INSTRUCTION_LENGTH,
  hasActiveLead,
  isActiveAssignment,
  validateAssignmentItems,
  type AssignmentItemInput,
} from "@/lib/documents/incoming";
import { ASSIGNMENT_ROLE_LABELS } from "@/lib/documents/labels";
import { ASSIGNMENT_ROLES, type AssignmentRole, type DocumentBundle } from "@/lib/documents/types";
import { getErrorMessage } from "@/lib/types/database";
import { cn } from "@/lib/utils";

type AssigneeKind = "person" | "department";

type Row = {
  key: number;
  kind: AssigneeKind;
  userId: string | null;
  departmentId: string | null;
  role: AssignmentRole;
  /** yyyy-mm-dd or '' (no deadline) */
  due: string;
  instruction: string;
};

/** Today and the default deadline, both in the company's calendar. */
type Calendar = { today: string; defaultDue: string };

function toItem(row: Row): AssignmentItemInput {
  return {
    user_id: row.kind === "person" ? row.userId : null,
    department_id: row.kind === "department" ? row.departmentId : null,
    role: row.role,
    due_date: row.due || null,
    instruction: row.instruction.trim() || null,
  };
}

/**
 * Assign (Giao xử lý) an incoming document to a lead (Chủ trì), supports
 * (Phối hợp) and info recipients (Để biết), people or departments, each with
 * a deadline. With parentAssignmentId it sub-assigns the caller's own
 * assignment (Giao xử lý tiếp) inside their department.
 */
export function AssignDialog({
  bundle,
  open,
  onOpenChange,
  onDone,
  parentAssignmentId = null,
}: {
  bundle: DocumentBundle;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
  /** null = top level; an id = sub-assign under that assignment */
  parentAssignmentId?: string | null;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <AssignBody
          bundle={bundle}
          parentAssignmentId={parentAssignmentId}
          busy={busy}
          setBusy={setBusy}
          onClose={() => onOpenChange(false)}
          onDone={onDone}
        />
      </DialogContent>
    </Dialog>
  );
}

function AssignBody({
  bundle,
  parentAssignmentId,
  busy,
  setBusy,
  onClose,
  onDone,
}: {
  bundle: DocumentBundle;
  parentAssignmentId: string | null;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const id = useId();
  const doc = bundle.document;
  const isSub = !!parentAssignmentId;
  const parent = isSub ? (bundle.assignments.find((a) => a.id === parentAssignmentId) ?? null) : null;
  const parentDue = parent?.due_date ?? null;
  const leadTaken = hasActiveLead(bundle.assignments, parentAssignmentId);

  // active siblings already assigned: each person or department appears once
  const existing = useMemo(
    () =>
      bundle.assignments
        .filter((a) => (a.parent_id ?? null) === parentAssignmentId && isActiveAssignment(a))
        .map((a) => ({ user_id: a.assignee_user_id, department_id: a.assignee_department_id })),
    [bundle.assignments, parentAssignmentId]
  );

  const [calendar, setCalendar] = useState<Calendar | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [instruction, setInstruction] = useState("");
  const [attempted, setAttempted] = useState(false);
  const nextKey = useRef(1);

  // The company's today and holidays give the default deadline; rows start once it is known.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [org, holidays] = await Promise.all([
        getMyOrg().catch(() => null),
        listHolidays().catch(() => []),
      ]);
      const today = todayIn(org?.org.timezone || DEFAULT_ORG_TIME_ZONE);
      const byUrgency = addWorkingDays(today, defaultDueDays(doc.urgency), holidaySet(holidays));
      let defaultDue = doc.due_date && doc.due_date >= today ? doc.due_date : byUrgency;
      if (parentDue && defaultDue > parentDue) {
        // an overdue parent leaves no valid date: empty lets the server use the parent's deadline
        defaultDue = parentDue >= today ? parentDue : "";
      }
      if (cancelled) return;
      setCalendar({ today, defaultDue });
      // a refreshed bundle must not wipe rows the user already edited
      setRows((prev) =>
        prev.length > 0
          ? prev
          : [
              {
                key: 0,
                kind: "person",
                userId: null,
                departmentId: null,
                role: leadTaken ? "support" : "lead",
                due: defaultDue,
                instruction: "",
              },
            ]
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [doc.urgency, doc.due_date, parentDue, leadTaken]);

  const items = rows.map(toItem);
  const errors = calendar
    ? validateAssignmentItems(items, {
        hasActiveLead: leadTaken,
        isSub,
        parentDue,
        today: calendar.today,
        existing,
      })
    : [];
  const generalTooLong = instruction.trim().length > MAX_INSTRUCTION_LENGTH;
  const shownErrors = attempted
    ? [...errors, ...(generalTooLong ? [`The instruction is too long (max ${MAX_INSTRUCTION_LENGTH} characters)`] : [])]
    : [];

  const update = (key: number, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const changeRole = (row: Row, role: AssignmentRole) => {
    if (!calendar) return;
    // info rows have no deadline by default; lead/support get the default back
    let due = row.due;
    if (role === "info" && row.role !== "info" && row.due === calendar.defaultDue) due = "";
    if (role !== "info" && row.role === "info" && !row.due) due = calendar.defaultDue;
    update(row.key, { role, due });
  };

  const addRow = () => {
    if (!calendar || rows.length >= MAX_ASSIGNMENT_ITEMS) return;
    const hasLeadRow = leadTaken || rows.some((r) => r.role === "lead");
    const role: AssignmentRole = hasLeadRow ? "support" : "lead";
    setRows((prev) => [
      ...prev,
      {
        key: nextKey.current++,
        kind: "person",
        userId: null,
        departmentId: null,
        role,
        due: calendar.defaultDue,
        instruction: "",
      },
    ]);
  };

  const removeRow = (key: number) => setRows((prev) => prev.filter((r) => r.key !== key));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !calendar) return;
    setAttempted(true);
    if (errors.length > 0 || generalTooLong) return;
    setBusy(true);
    try {
      const count = await assignDocument(doc.id, items, {
        parentAssignmentId,
        instruction,
      });
      setBusy(false);
      toast.success(
        count === 1 ? "Assigned to 1 person or department" : `Assigned to ${count} people or departments`
      );
      onClose();
      onDone();
    } catch (err) {
      setBusy(false);
      toast.error(getErrorMessage(err));
    }
  };

  const takenUsers = (except: number) => [
    ...existing.flatMap((e) => (e.user_id ? [e.user_id] : [])),
    ...rows.flatMap((r) => (r.key !== except && r.kind === "person" && r.userId ? [r.userId] : [])),
  ];
  const takenDepartments = (except: number) => [
    ...existing.flatMap((e) => (e.department_id ? [e.department_id] : [])),
    ...rows.flatMap((r) =>
      r.key !== except && r.kind === "department" && r.departmentId ? [r.departmentId] : []
    ),
  ];

  return (
    <>
      <DialogHeader>
        <DialogTitle>{isSub ? "Sub-assign (Giao xử lý tiếp)" : "Assign (Giao xử lý)"}</DialogTitle>
        <DialogDescription>
          {isSub
            ? `Pass your assignment on inside your department.${
                parentDue ? ` Deadlines must be on or before ${formatDay(parentDue)}.` : ""
              }`
            : leadTaken
              ? "This document already has a lead (Chủ trì). Add supports or people for information."
              : "Choose exactly one lead (Chủ trì), plus any supports (Phối hợp) and people for information (Để biết)."}
        </DialogDescription>
      </DialogHeader>

      {!calendar ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Loading…
        </div>
      ) : (
        <form id={`${id}-form`} onSubmit={submit} className="min-w-0 space-y-4" noValidate>
          <ol className="space-y-3" aria-label="Assignees">
            {rows.map((row, index) => {
              const n = index + 1;
              return (
                <li key={row.key} className="min-w-0 space-y-3 rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div
                      className="inline-flex rounded-lg border p-0.5"
                      role="group"
                      aria-label={`Assignee ${n} type`}
                    >
                      {(
                        [
                          ["person", "Person", User],
                          ["department", "Department", Building2],
                        ] as const
                      ).map(([kind, label, Icon]) => (
                        <button
                          key={kind}
                          type="button"
                          aria-pressed={row.kind === kind}
                          disabled={busy}
                          onClick={() => update(row.key, { kind })}
                          className={cn(
                            "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50",
                            row.kind === kind
                              ? "bg-primary text-primary-foreground"
                              : "text-muted-foreground hover:bg-muted hover:text-foreground"
                          )}
                        >
                          <Icon className="size-3.5" aria-hidden />
                          {label}
                        </button>
                      ))}
                    </div>
                    {rows.length > 1 && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => removeRow(row.key)}
                        disabled={busy}
                        aria-label={`Remove assignee ${n}`}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    )}
                  </div>

                  {/* Who spans the row so the role select fits 'For information (Để biết)'. */}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="min-w-0 space-y-1.5 sm:col-span-2">
                      <Label htmlFor={`${id}-who-${row.key}`}>
                        {row.kind === "person" ? "Person" : "Department"}
                      </Label>
                      {row.kind === "person" ? (
                        <PersonPicker
                          id={`${id}-who-${row.key}`}
                          value={row.userId}
                          onChange={(userId) => update(row.key, { userId })}
                          excludeIds={takenUsers(row.key)}
                          disabled={busy}
                        />
                      ) : (
                        <>
                          <DepartmentSelect
                            id={`${id}-who-${row.key}`}
                            value={row.departmentId}
                            onChange={(departmentId) => update(row.key, { departmentId })}
                            excludeIds={takenDepartments(row.key)}
                            placeholder="Choose a department"
                            disabled={busy}
                          />
                          <p className="text-xs text-muted-foreground">The department head receives it.</p>
                        </>
                      )}
                    </div>
                    <div className="min-w-0 space-y-1.5">
                      <Label htmlFor={`${id}-role-${row.key}`}>Role</Label>
                      <select
                        id={`${id}-role-${row.key}`}
                        className={nativeSelectClass}
                        value={row.role}
                        disabled={busy}
                        onChange={(e) => changeRole(row, e.target.value as AssignmentRole)}
                      >
                        {ASSIGNMENT_ROLES.map((role) => (
                          <option key={role} value={role}>
                            {ASSIGNMENT_ROLE_LABELS[role]}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="min-w-0 space-y-1.5">
                      <Label htmlFor={`${id}-due-${row.key}`}>Deadline (Hạn xử lý)</Label>
                      <Input
                        id={`${id}-due-${row.key}`}
                        type="date"
                        value={row.due}
                        min={calendar.today}
                        max={isSub && parentDue ? parentDue : undefined}
                        disabled={busy}
                        onChange={(e) => update(row.key, { due: e.target.value })}
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor={`${id}-note-${row.key}`}>
                      Instruction for this assignee{" "}
                      <span className="font-normal text-muted-foreground">(optional)</span>
                    </Label>
                    <Input
                      id={`${id}-note-${row.key}`}
                      value={row.instruction}
                      maxLength={MAX_INSTRUCTION_LENGTH}
                      placeholder="Uses the general instruction when empty"
                      disabled={busy}
                      onChange={(e) => update(row.key, { instruction: e.target.value })}
                    />
                  </div>
                </li>
              );
            })}
          </ol>

          <Button
            variant="outline"
            size="sm"
            onClick={addRow}
            disabled={busy || rows.length >= MAX_ASSIGNMENT_ITEMS}
          >
            <Plus aria-hidden />
            Add row
          </Button>

          <div className="space-y-1.5">
            <Label htmlFor={`${id}-instruction`}>
              Instruction (Ý kiến chỉ đạo){" "}
              <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id={`${id}-instruction`}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={3}
              maxLength={MAX_INSTRUCTION_LENGTH}
              placeholder="Recorded as the leader's instruction and sent to every assignee"
              disabled={busy}
              className="max-h-48"
            />
          </div>

          {shownErrors.length > 0 && (
            <ul
              className="list-disc space-y-1 rounded-lg border border-destructive/40 bg-destructive/5 py-2 pr-3 pl-7 text-sm text-destructive"
              role="alert"
            >
              {shownErrors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </form>
      )}

      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <button
          type="submit"
          form={`${id}-form`}
          className={buttonVariants()}
          disabled={busy || !calendar || (attempted && shownErrors.length > 0)}
        >
          {busy && <Loader2 className="animate-spin" aria-hidden />}
          {isSub ? "Sub-assign" : "Assign"}
        </button>
      </DialogFooter>
    </>
  );
}
