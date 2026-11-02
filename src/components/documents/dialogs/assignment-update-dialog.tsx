"use client";

import { useId, useState } from "react";
import { CheckCheck, CheckCircle2, Loader2, Play, Undo2 } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { updateAssignment } from "@/lib/services/documents-incoming";
import { formatDay } from "@/lib/documents/deadlines";
import { MAX_RESULT_LENGTH } from "@/lib/documents/incoming";
import { ASSIGNMENT_ROLE_LABELS, ASSIGNMENT_STATUS_LABELS } from "@/lib/documents/labels";
import type { Assignment, DocumentBundle } from "@/lib/documents/types";
import { getErrorMessage } from "@/lib/types/database";
import { cn } from "@/lib/utils";

/** The form step: report the result, or give the reason for returning it. */
type Mode = "choose" | "done" | "return";

const OPEN_STATUSES: readonly Assignment["status"][] = ["pending", "seen", "in_progress"];

/**
 * The assignee moves their assignment on: start working, report done with the
 * result (Kết quả xử lý), return it with a reason, or mark an info copy as read.
 */
export function AssignmentUpdateDialog({
  bundle,
  assignment,
  open,
  onOpenChange,
  onDone,
}: {
  bundle: DocumentBundle;
  assignment: Assignment;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <UpdateBody
          bundle={bundle}
          assignment={assignment}
          busy={busy}
          setBusy={setBusy}
          onClose={() => onOpenChange(false)}
          onDone={onDone}
        />
      </DialogContent>
    </Dialog>
  );
}

function UpdateBody({
  bundle,
  assignment,
  busy,
  setBusy,
  onClose,
  onDone,
}: {
  bundle: DocumentBundle;
  assignment: Assignment;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const id = useId();
  const [mode, setMode] = useState<Mode>("choose");
  const [text, setText] = useState("");

  const isInfo = assignment.role === "info";
  const isOpen = OPEN_STATUSES.includes(assignment.status);
  const canStart = !isInfo && (assignment.status === "pending" || assignment.status === "seen");
  const trimmed = text.trim();
  const tooLong = trimmed.length > MAX_RESULT_LENGTH;
  const textRequired = mode === "return" || (mode === "done" && !isInfo);

  const run = async (status: "in_progress" | "done" | "returned", result: string | null, message: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await updateAssignment(assignment.id, status, result);
      setBusy(false);
      toast.success(message);
      onClose();
      onDone();
    } catch (err) {
      setBusy(false);
      toast.error(getErrorMessage(err));
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if ((textRequired && !trimmed) || tooLong) return;
    if (mode === "done") void run("done", trimmed || null, "Result reported");
    else if (mode === "return") void run("returned", trimmed, "Assignment returned");
  };

  const assignee =
    assignment.assignee_name ?? assignment.assignee_department_name ?? "You";

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {mode === "done"
            ? "Report done (Báo cáo kết quả)"
            : mode === "return"
              ? "Return assignment (Trả lại)"
              : "Update my assignment"}
        </DialogTitle>
        <DialogDescription className="line-clamp-2">{bundle.document.subject}</DialogDescription>
      </DialogHeader>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-lg border bg-muted/30 p-3 text-sm">
        <dt className="text-muted-foreground">Role</dt>
        <dd className="font-medium">{ASSIGNMENT_ROLE_LABELS[assignment.role]}</dd>
        <dt className="text-muted-foreground">Assignee</dt>
        <dd className="truncate">{assignee}</dd>
        <dt className="text-muted-foreground">Status</dt>
        <dd>{ASSIGNMENT_STATUS_LABELS[assignment.status]}</dd>
        {assignment.due_date && (
          <>
            <dt className="text-muted-foreground">Deadline</dt>
            <dd className="tabular-nums">{formatDay(assignment.due_date)}</dd>
          </>
        )}
        {assignment.assigned_by_name && (
          <>
            <dt className="text-muted-foreground">Assigned by</dt>
            <dd className="truncate">{assignment.assigned_by_name}</dd>
          </>
        )}
        {assignment.instruction && (
          <>
            <dt className="text-muted-foreground">Instruction</dt>
            <dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">{assignment.instruction}</dd>
          </>
        )}
      </dl>

      {!isOpen ? (
        <p className="text-sm text-muted-foreground">
          This assignment is {ASSIGNMENT_STATUS_LABELS[assignment.status].toLowerCase()}; there is nothing left to
          update.
        </p>
      ) : mode === "choose" ? (
        <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Actions">
          {canStart && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void run("in_progress", null, "Marked as in progress")}
            >
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Play aria-hidden />}
              Start working
            </Button>
          )}
          {isInfo ? (
            <Button disabled={busy} onClick={() => void run("done", null, "Marked as read")}>
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : <CheckCheck aria-hidden />}
              Mark as read
            </Button>
          ) : (
            <Button disabled={busy} onClick={() => setMode("done")}>
              <CheckCircle2 aria-hidden />
              Report done
            </Button>
          )}
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setMode("return")}
          >
            <Undo2 aria-hidden />
            Return
          </Button>
        </div>
      ) : (
        <form id={`${id}-form`} onSubmit={submit} className="space-y-2" noValidate>
          <Label htmlFor={`${id}-text`}>
            {mode === "return" ? "Reason for returning it" : "Result / Kết quả xử lý"}
            {textRequired ? (
              <span className="text-destructive" aria-hidden>
                *
              </span>
            ) : (
              <span className="font-normal text-muted-foreground">(optional)</span>
            )}
          </Label>
          <Textarea
            id={`${id}-text`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            maxLength={MAX_RESULT_LENGTH}
            required={textRequired}
            aria-invalid={tooLong}
            aria-describedby={`${id}-hint`}
            placeholder={
              mode === "return"
                ? "e.g. Not in our department's remit; suggest Finance"
                : "What was done, decisions taken, documents produced"
            }
            disabled={busy}
            autoFocus
            className="max-h-64"
          />
          <p id={`${id}-hint`} className="flex justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {mode === "return"
                ? "The person who assigned it is notified."
                : "Saved as a result opinion and sent to the person who assigned it."}
            </span>
            <span className={cn("shrink-0 tabular-nums", tooLong && "text-destructive")}>
              {text.length}/{MAX_RESULT_LENGTH}
            </span>
          </p>
        </form>
      )}

      <DialogFooter>
        {mode === "choose" || !isOpen ? (
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="outline" onClick={() => setMode("choose")} disabled={busy}>
              Back
            </Button>
            <button
              type="submit"
              form={`${id}-form`}
              className={buttonVariants({ variant: mode === "return" ? "destructive" : "default" })}
              disabled={busy || (textRequired && !trimmed) || tooLong}
            >
              {busy && <Loader2 className="animate-spin" aria-hidden />}
              {mode === "return" ? "Return" : "Report done"}
            </button>
          </>
        )}
      </DialogFooter>
    </>
  );
}
