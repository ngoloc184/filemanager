"use client";

import { useId, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import {
  Ban,
  BookPlus,
  CheckCircle2,
  CircleCheckBig,
  ClipboardCheck,
  CornerUpLeft,
  FilePen,
  FilePlus2,
  FileSignature,
  Forward,
  ListOrdered,
  Loader2,
  MoreHorizontal,
  PenLine,
  Play,
  RotateCcw,
  Send,
  Share2,
  Stamp,
  Undo2,
  Upload,
  UserMinus,
  Users,
  XCircle,
  type LucideIcon,
} from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AddToDossier } from "@/components/documents/add-to-dossier";
import { ApprovalChainDialog } from "@/components/documents/dialogs/approval-chain-dialog";
import { AssignDialog } from "@/components/documents/dialogs/assign-dialog";
import { AssignmentUpdateDialog } from "@/components/documents/dialogs/assignment-update-dialog";
import { CompleteDialog } from "@/components/documents/dialogs/complete-dialog";
import { DecisionDialog, type DecisionDialogProps } from "@/components/documents/dialogs/decision-dialog";
import { IssueDialog } from "@/components/documents/dialogs/issue-dialog";
import { RecallDialog } from "@/components/documents/dialogs/recall-dialog";
import { RegisterDialog } from "@/components/documents/dialogs/register-dialog";
import { ShareDraftDialog } from "@/components/documents/dialogs/share-draft-dialog";
import { SignDialog } from "@/components/documents/dialogs/sign-dialog";
import { SubmitToLeaderDialog } from "@/components/documents/dialogs/submit-to-leader-dialog";
import { UploadSignedDialog } from "@/components/documents/dialogs/upload-signed-dialog";
import {
  actionCopy,
  barActions,
  primaryAction,
  type DocumentAction,
} from "@/lib/documents/action-copy";
import { formatDay } from "@/lib/documents/deadlines";
import { incomingActions, myOpenAssignments, topLevelLead } from "@/lib/documents/incoming";
import { ASSIGNMENT_ROLE_LABELS, ASSIGNMENT_STATUS_LABELS } from "@/lib/documents/labels";
import { chainProgressLabel, currentSteps, outgoingActions, type FollowUpKind } from "@/lib/documents/outgoing";
import type { Assignment, DocumentBundle } from "@/lib/documents/types";
import {
  cancelIncoming,
  reopenDocument,
  returnToClerk,
  revokeAssignment,
} from "@/lib/services/documents-incoming";
import {
  approveStep,
  createFollowUp,
  rejectDocument,
  returnDocument,
  submitForApproval,
  withdrawDocument,
} from "@/lib/services/documents-outgoing";
import { getErrorMessage } from "@/lib/types/database";
import { cn } from "@/lib/utils";

// The workflow buttons of the document page. incomingActions /
// outgoingActions decide what the caller may do (the server checks again);
// the most important one is the filled button, the rest sit under 'More'.
// Each action opens its dialog (T25 incoming, T26 outgoing), a decision
// with a comment, or an inline confirm.

const ICONS: Record<DocumentAction, LucideIcon> = {
  register: BookPlus,
  submit: Send,
  assign: Users,
  sub_assign: Forward,
  start: Play,
  finish: ClipboardCheck,
  return_assignment: Undo2,
  revoke: UserMinus,
  complete: CircleCheckBig,
  return_to_clerk: Undo2,
  cancel: Ban,
  reopen: RotateCcw,
  edit: FilePen,
  reply: CornerUpLeft,
  set_chain: ListOrdered,
  approve: CheckCircle2,
  return: Undo2,
  reject: XCircle,
  sign: PenLine,
  issue: Stamp,
  recall: RotateCcw,
  withdraw: Ban,
  replacement: FilePlus2,
  correction: FileSignature,
  upload_signed: Upload,
  share_draft: Share2,
};

const FOLLOW_UPS: Partial<Record<DocumentAction, FollowUpKind>> = {
  reply: "reply",
  replacement: "replacement",
  correction: "correction",
};

/** What is open: a dialog of an action, or the assignment picker in front of one. */
type Active =
  | { kind: "action"; action: DocumentAction; assignment?: Assignment; submitAfterSave?: boolean }
  | { kind: "pick"; action: "sub_assign" | "finish"; choices: Assignment[] };

export function DocumentActions({ bundle, onChanged }: { bundle: DocumentBundle; onChanged: () => void }) {
  const router = useRouter();
  const doc = bundle.document;
  const isIncoming = doc.direction === "incoming";

  const actions = useMemo<DocumentAction[]>(
    () => barActions<DocumentAction>(isIncoming ? incomingActions(bundle) : outgoingActions(bundle)),
    [bundle, isIncoming]
  );
  const primary = primaryAction(
    actions,
    isIncoming ? { leadReported: topLevelLead(bundle.assignments)?.status === "done" } : undefined
  );
  const others = actions.filter((a) => a !== primary);
  const regular = others.filter((a) => actionCopy(a, doc.direction).tone !== "danger");
  const dangerous = others.filter((a) => actionCopy(a, doc.direction).tone === "danger");

  const [active, setActive] = useState<Active | null>(null);
  const [open, setOpen] = useState(false);
  const [followingUp, setFollowingUp] = useState<FollowUpKind | null>(null);

  const showAddToDossier = doc.status !== "draft";
  if (actions.length === 0 && !showAddToDossier) return null;

  const show = (next: Active) => {
    setActive(next);
    setOpen(true);
  };
  const isOpen = (action: DocumentAction) => open && active?.kind === "action" && active.action === action;
  const mounted = (action: DocumentAction) => active?.kind === "action" && active.action === action;

  /** My assignments the action can work on: open ones, lead and support before info. */
  const assignmentChoices = (action: "sub_assign" | "finish"): Assignment[] => {
    const mine = myOpenAssignments(bundle);
    if (action === "finish") return mine;
    const working = mine.filter((a) => a.role !== "info");
    return working.length > 0 ? working : mine;
  };

  const followUp = async (kind: FollowUpKind) => {
    if (followingUp) return;
    setFollowingUp(kind);
    try {
      const newId = await createFollowUp(doc.id, kind);
      toast.success("Draft created");
      router.push(`/documents/${newId}/edit`);
    } catch (err) {
      toast.error(getErrorMessage(err));
      setFollowingUp(null);
    }
  };

  const run = (action: DocumentAction) => {
    const kind = FOLLOW_UPS[action];
    if (kind) {
      void followUp(kind);
      return;
    }
    if (action === "sub_assign" || action === "finish") {
      const choices = assignmentChoices(action);
      if (choices.length === 0) {
        toast.error("You have no open assignment on this document");
      } else if (choices.length === 1) {
        show({ kind: "action", action, assignment: choices[0] });
      } else {
        show({ kind: "pick", action, choices });
      }
      return;
    }
    if (action === "submit" && !isIncoming && currentSteps(bundle).length === 0) {
      // no chain yet: build it first, then submit from the same dialog
      show({ kind: "action", action: "set_chain", submitAfterSave: true });
      return;
    }
    show({ kind: "action", action });
  };

  const busy = followingUp !== null;
  const copyOf = (action: DocumentAction) => actionCopy(action, doc.direction);

  const decision = decisionProps(active, bundle, onChanged);
  const pendingToRevoke = bundle.assignments.filter(
    (a) => a.status === "pending" && (a.assigned_by === bundle.me.user_id || bundle.me.roles.includes("org_admin"))
  );
  const activeAssignment = active?.kind === "action" ? active.assignment : undefined;

  return (
    <>
      {primary &&
        (primary === "edit" ? (
          <Link href={`/documents/${doc.id}/edit`} className={buttonVariants({ variant: "default" })}>
            <FilePen aria-hidden />
            {copyOf("edit").label}
          </Link>
        ) : (
          <Button onClick={() => run(primary)} disabled={busy} title={copyOf(primary).description}>
            {followingUp && FOLLOW_UPS[primary] === followingUp ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <ActionIcon action={primary} />
            )}
            {copyOf(primary).label}
          </Button>
        ))}

      {others.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={busy}
            render={<Button variant="outline" aria-label="More actions" />}
          >
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <MoreHorizontal aria-hidden />}
            More
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto max-w-[min(20rem,calc(100vw-2rem))] min-w-56">
            {regular.map((action) =>
              action === "edit" ? (
                <DropdownMenuItem key={action} render={<Link href={`/documents/${doc.id}/edit`} />}>
                  <ActionIcon action={action} />
                  {copyOf(action).label}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem key={action} onClick={() => run(action)}>
                  <ActionIcon action={action} />
                  {copyOf(action).label}
                </DropdownMenuItem>
              )
            )}
            {regular.length > 0 && dangerous.length > 0 && <DropdownMenuSeparator />}
            {dangerous.map((action) => (
              <DropdownMenuItem key={action} variant="destructive" onClick={() => run(action)}>
                <ActionIcon action={action} />
                {copyOf(action).label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {showAddToDossier && <AddToDossier documentId={doc.id} onAdded={onChanged} />}

      {/* ---- incoming dialogs (T25) ---- */}
      {mounted("register") && (
        <RegisterDialog bundle={bundle} open={isOpen("register")} onOpenChange={setOpen} onDone={onChanged} />
      )}
      {mounted("submit") && isIncoming && (
        <SubmitToLeaderDialog bundle={bundle} open={isOpen("submit")} onOpenChange={setOpen} onDone={onChanged} />
      )}
      {mounted("assign") && (
        <AssignDialog
          bundle={bundle}
          open={isOpen("assign")}
          onOpenChange={setOpen}
          onDone={onChanged}
          parentAssignmentId={null}
        />
      )}
      {mounted("sub_assign") && activeAssignment && (
        <AssignDialog
          key={activeAssignment.id}
          bundle={bundle}
          open={isOpen("sub_assign")}
          onOpenChange={setOpen}
          onDone={onChanged}
          parentAssignmentId={activeAssignment.id}
        />
      )}
      {mounted("finish") && activeAssignment && (
        <AssignmentUpdateDialog
          key={activeAssignment.id}
          bundle={bundle}
          assignment={bundle.assignments.find((a) => a.id === activeAssignment.id) ?? activeAssignment}
          open={isOpen("finish")}
          onOpenChange={setOpen}
          onDone={onChanged}
        />
      )}
      {mounted("complete") && (
        <CompleteDialog bundle={bundle} open={isOpen("complete")} onOpenChange={setOpen} onDone={onChanged} />
      )}
      {mounted("revoke") && (
        <RevokeConfirm
          open={isOpen("revoke")}
          onOpenChange={setOpen}
          candidates={pendingToRevoke}
          onDone={onChanged}
        />
      )}

      {/* ---- outgoing / internal dialogs (T26) ---- */}
      {mounted("set_chain") && (
        <ApprovalChainDialog
          bundle={bundle}
          open={isOpen("set_chain")}
          onOpenChange={setOpen}
          onDone={onChanged}
          submitAfterSave={active?.kind === "action" && !!active.submitAfterSave}
        />
      )}
      {mounted("submit") && !isIncoming && (
        <ConfirmDialog
          open={isOpen("submit")}
          onOpenChange={setOpen}
          title={copyOf("submit").label}
          description={chainProgressLabel(bundle)}
          confirmLabel="Submit"
          tone="default"
          onConfirm={async () => {
            await submitForApproval(doc.id);
            toast.success("Submitted for approval");
            onChanged();
          }}
        >
          <p className="text-sm text-muted-foreground">
            The first approvers are notified. The files are locked from now on and unlock only if a reviewer returns
            the draft for revision.
          </p>
        </ConfirmDialog>
      )}
      {mounted("sign") && (
        <SignDialog bundle={bundle} open={isOpen("sign")} onOpenChange={setOpen} onDone={onChanged} />
      )}
      {mounted("issue") && (
        <IssueDialog bundle={bundle} open={isOpen("issue")} onOpenChange={setOpen} onDone={onChanged} />
      )}
      {mounted("recall") && (
        <RecallDialog bundle={bundle} open={isOpen("recall")} onOpenChange={setOpen} onDone={onChanged} />
      )}
      {mounted("upload_signed") && (
        <UploadSignedDialog bundle={bundle} open={isOpen("upload_signed")} onOpenChange={setOpen} onDone={onChanged} />
      )}
      {mounted("share_draft") && (
        <ShareDraftDialog bundle={bundle} open={isOpen("share_draft")} onOpenChange={setOpen} onDone={onChanged} />
      )}
      {mounted("withdraw") && (
        <ConfirmDialog
          open={isOpen("withdraw")}
          onOpenChange={setOpen}
          title="Withdraw this document?"
          description={copyOf("withdraw").description}
          confirmLabel="Withdraw"
          tone="danger"
          onConfirm={async () => {
            await withdrawDocument(doc.id);
            toast.success("Document withdrawn");
            onChanged();
          }}
        />
      )}

      {/* ---- decisions with a comment (both flows) ---- */}
      {decision && <DecisionDialog {...decision} open={open} onOpenChange={setOpen} />}

      {/* ---- which of my assignments ---- */}
      {active?.kind === "pick" && (
        <AssignmentPicker
          open={open}
          onOpenChange={setOpen}
          title={copyOf(active.action).label}
          choices={active.choices}
          onPick={(assignment) => show({ kind: "action", action: active.action, assignment })}
        />
      )}
    </>
  );
}

function ActionIcon({ action }: { action: DocumentAction }) {
  const Icon = ICONS[action];
  return <Icon aria-hidden />;
}

/** DecisionDialog settings of the open action, or null when it is not a decision. */
function decisionProps(
  active: Active | null,
  bundle: DocumentBundle,
  onChanged: () => void
): Omit<DecisionDialogProps, "open" | "onOpenChange"> | null {
  if (active?.kind !== "action") return null;
  const doc = bundle.document;
  const id = doc.id;
  const done = (message: string) => {
    toast.success(message);
    onChanged();
  };

  switch (active.action) {
    case "approve":
      return {
        title: actionCopy("approve").label,
        description: `${actionCopy("approve").description} ${chainProgressLabel(bundle)}`.trim(),
        confirmLabel: "Approve",
        tone: "default",
        commentLabel: "Comment (Ý kiến)",
        commentRequired: false,
        onConfirm: async (comment) => {
          await approveStep(id, comment);
          done("Approved");
        },
      };
    case "return":
      return {
        title: actionCopy("return").label,
        description: `The author gets the draft back as revision ${doc.revision + 1}.`,
        confirmLabel: "Return",
        tone: "default",
        commentLabel: "What needs to change",
        commentRequired: true,
        onConfirm: async (comment) => {
          await returnDocument(id, comment);
          done("Returned to the author");
        },
      };
    case "reject":
      return {
        title: actionCopy("reject").label,
        description: "This ends the workflow. The author cannot resubmit this document.",
        confirmLabel: "Reject",
        tone: "danger",
        commentLabel: "Reason",
        commentRequired: true,
        onConfirm: async (comment) => {
          await rejectDocument(id, comment);
          done("Document rejected");
        },
      };
    case "return_to_clerk":
      return {
        title: actionCopy("return_to_clerk").label,
        description: "The clerk is notified and can present it again or cancel it.",
        confirmLabel: "Return",
        tone: "default",
        commentLabel: "Reason",
        commentRequired: true,
        onConfirm: async (comment) => {
          await returnToClerk(id, comment);
          done("Returned to the clerk");
        },
      };
    case "cancel":
      return {
        title: actionCopy("cancel").label,
        description:
          doc.status === "registered"
            ? "The document is cancelled. Its arrival number stays used and is not given out again."
            : "The draft is cancelled.",
        confirmLabel: "Cancel document",
        tone: "danger",
        commentLabel: "Reason",
        commentRequired: true,
        onConfirm: async (comment) => {
          await cancelIncoming(id, comment);
          done("Document cancelled");
        },
      };
    case "reopen":
      return {
        title: actionCopy("reopen").label,
        description: "It goes back to in progress and the assignees can report again.",
        confirmLabel: "Reopen",
        tone: "default",
        commentLabel: "Reason",
        commentRequired: true,
        onConfirm: async (comment) => {
          await reopenDocument(id, comment);
          done("Document reopened");
        },
      };
    default:
      return null;
  }
}

/**
 * A short yes/no question (Base UI alert dialog). It stays open with a toast
 * when the server refuses, and closes on success.
 */
function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  tone,
  confirmDisabled = false,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel: string;
  tone: "default" | "danger";
  confirmDisabled?: boolean;
  onConfirm: () => Promise<void>;
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (busy || confirmDisabled) return;
    setBusy(true);
    try {
      await onConfirm();
      setBusy(false);
      onOpenChange(false);
    } catch (err) {
      setBusy(false);
      toast.error(getErrorMessage(err));
    }
  };

  return (
    <AlertDialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Backdrop className="fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <AlertDialogPrimitive.Popup className="fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 grid-cols-[minmax(0,1fr)] gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-md data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
          <DialogHeader className="pr-0">
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          {children}
          <DialogFooter>
            <AlertDialogPrimitive.Close render={<Button variant="outline" disabled={busy} />}>
              Cancel
            </AlertDialogPrimitive.Close>
            <Button
              variant={tone === "danger" ? "destructive" : "default"}
              disabled={busy || confirmDisabled}
              onClick={() => void confirm()}
            >
              {busy && <Loader2 className="animate-spin" aria-hidden />}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </AlertDialogPrimitive.Popup>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}

/** One line about an assignment for the pickers: who, role, status, deadline. */
function AssignmentOption({ assignment }: { assignment: Assignment }) {
  const who = assignment.assignee_name ?? assignment.assignee_department_name ?? "Unknown assignee";
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate font-medium">{who}</span>
      <span className="block text-xs text-muted-foreground">
        {ASSIGNMENT_ROLE_LABELS[assignment.role]} · {ASSIGNMENT_STATUS_LABELS[assignment.status]}
        {assignment.due_date && <> · due {formatDay(assignment.due_date)}</>}
      </span>
    </span>
  );
}

/** A radio list of assignments; the first one is chosen until the user picks another. */
function AssignmentRadioList({
  name,
  choices,
  value,
  onChange,
  label,
}: {
  name: string;
  choices: Assignment[];
  value: string | null;
  onChange: (id: string) => void;
  label: string;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="mb-2 text-sm font-medium">{label}</legend>
      <div className="max-h-64 space-y-1.5 overflow-y-auto">
        {choices.map((a) => (
          <label
            key={a.id}
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-lg border p-2.5 transition-colors hover:bg-muted/50 has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
              value === a.id && "border-primary bg-primary/5"
            )}
          >
            <input
              type="radio"
              name={name}
              value={a.id}
              checked={value === a.id}
              onChange={() => onChange(a.id)}
              className="mt-1 size-4 shrink-0 accent-primary"
            />
            <AssignmentOption assignment={a} />
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Take back (Thu hồi) an assignment nobody has opened yet. */
function RevokeConfirm({
  open,
  onOpenChange,
  candidates,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidates: Assignment[];
  onDone: () => void;
}) {
  const name = useId();
  const [picked, setPicked] = useState<string | null>(null);
  const selected = candidates.find((a) => a.id === picked) ?? candidates[0] ?? null;

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Take back this assignment?"
      description="Only possible before the person opens it. Anything passed on under it is taken back too."
      confirmLabel="Take back"
      tone="default"
      confirmDisabled={!selected}
      onConfirm={async () => {
        if (!selected) return;
        await revokeAssignment(selected.id);
        toast.success("Assignment taken back");
        onDone();
      }}
    >
      {candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">Every assignment you made has already been opened.</p>
      ) : (
        <AssignmentRadioList
          name={name}
          label="Not opened yet (Chưa xem)"
          choices={candidates}
          value={selected?.id ?? null}
          onChange={setPicked}
        />
      )}
    </ConfirmDialog>
  );
}

/** When I hold several open assignments on the document, which one to act on. */
function AssignmentPicker({
  open,
  onOpenChange,
  title,
  choices,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  choices: Assignment[];
  onPick: (assignment: Assignment) => void;
}) {
  const name = useId();
  const [picked, setPicked] = useState<string | null>(null);
  const selected = choices.find((a) => a.id === picked) ?? choices[0] ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>You have more than one open assignment on this document.</DialogDescription>
        </DialogHeader>
        <form
          id={`${name}-form`}
          onSubmit={(e) => {
            e.preventDefault();
            if (selected) onPick(selected);
          }}
        >
          <AssignmentRadioList
            name={name}
            label="Choose the assignment"
            choices={choices}
            value={selected?.id ?? null}
            onChange={setPicked}
          />
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form={`${name}-form`} disabled={!selected}>
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
