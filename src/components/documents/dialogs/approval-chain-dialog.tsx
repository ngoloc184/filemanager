"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Loader2, Plus, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { nativeSelectClass } from "@/components/org/department-select";
import { PersonPicker, type DirectoryPerson } from "@/components/org/person-picker";
import { STEP_KIND_LABELS } from "@/lib/documents/labels";
import {
  MAX_CHAIN_STEPS,
  currentSteps,
  validateApprovalChain,
  type ApprovalChainStepInput,
} from "@/lib/documents/outgoing";
import { STEP_KINDS, type DocumentBundle, type StepKind } from "@/lib/documents/types";
import { memberLabel } from "@/lib/org";
import { listOrgMembers } from "@/lib/services/org";
import { setApprovalChain, submitForApproval } from "@/lib/services/documents-outgoing";
import { getErrorMessage } from "@/lib/types/database";
import { cn } from "@/lib/utils";

// Approval chain (Luồng trình ký) of an outgoing/internal draft: an ordered
// list of approvers ending with the signer. The rules mirror
// set_approval_chain; the server checks them again.

type Props = {
  bundle: DocumentBundle;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
  /** 'Save and submit' is the main button (the action bar's 'Submit') */
  submitAfterSave?: boolean;
};

type Row = {
  key: number;
  userId: string | null;
  kind: StepKind;
  /** consult only: same step number as the row above */
  parallel: boolean;
  /** consult only: the chain can move on without this answer */
  optional: boolean;
};

type People = Map<string, { name: string; canSign: boolean }>;

let rowKeys = 0;

function newRow(kind: StepKind, userId: string | null = null): Row {
  rowKeys += 1;
  return { key: rowKeys, userId, kind, parallel: false, optional: kind === "consult" };
}

/** Leader role or a position with can_sign (doc_can_sign_user). */
function canSign(p: Pick<DirectoryPerson, "can_sign" | "roles">): boolean {
  return p.can_sign === true || (p.roles ?? []).includes("leader");
}

/** Signers last; only consult rows below the first keep 'parallel' / 'optional'. */
function normalize(rows: Row[]): Row[] {
  const ordered = [...rows.filter((r) => r.kind !== "sign"), ...rows.filter((r) => r.kind === "sign")];
  return ordered.map((r, i) => {
    const consult = r.kind === "consult";
    const parallel = consult && i > 0 && r.parallel;
    const optional = consult && r.optional;
    return parallel === r.parallel && optional === r.optional ? r : { ...r, parallel, optional };
  });
}

/** The current revision's steps as rows, or a lone signer for a new chain. */
function initialRows(bundle: DocumentBundle): Row[] {
  const rows: Row[] = [];
  for (const group of currentSteps(bundle)) {
    group.steps.forEach((step, i) => {
      const row = newRow(step.kind, step.approver_user_id);
      row.parallel = i > 0;
      row.optional = step.kind === "consult" && !step.required;
      rows.push(row);
    });
  }
  return rows.length > 0 ? normalize(rows) : [newRow("sign")];
}

function toInput(rows: Row[]): ApprovalChainStepInput[] {
  return rows.map((r) => ({
    approver_user_id: r.userId ?? "",
    kind: r.kind,
    parallel_with_previous: r.parallel,
    required: r.kind === "consult" ? !r.optional : true,
  }));
}

/** Bumps when the dialog opens, so each opening starts from fresh state. */
function useOpenSession(open: boolean): number {
  const [session, setSession] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setSession((s) => s + 1);
  }
  return session;
}

export function ApprovalChainDialog(props: Props) {
  const session = useOpenSession(props.open);
  return <ApprovalChainDialogBody key={session} {...props} />;
}

function ApprovalChainDialogBody({ bundle, open, onOpenChange, onDone, submitAfterSave = false }: Props) {
  const ids = useId();
  const documentId = bundle.document.id;
  const [rows, setRows] = useState<Row[]>(() => initialRows(bundle));
  const [people, setPeople] = useState<People>(() => new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState<"save" | "submit" | null>(null);

  // who may sign comes from the directory (can_sign, roles)
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listOrgMembers(null, false)
      .then((members) => {
        if (cancelled) return;
        setPeople((prev) => {
          const next: People = new Map(prev);
          for (const m of members) next.set(m.user_id, { name: memberLabel(m), canSign: canSign(m) });
          return next;
        });
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(getErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const errors = useMemo(() => validateApprovalChain(toInput(rows), people), [rows, people]);
  const hasSigner = rows.some((r) => r.kind === "sign");
  const full = rows.length >= MAX_CHAIN_STEPS;

  // step numbers as the server will store them (parallel rows share one)
  const stepNumbers = useMemo(() => {
    let n = 0;
    return rows.map((r, i) => (i === 0 || !r.parallel ? ++n : n));
  }, [rows]);

  const update = (key: number, patch: Partial<Row>) => {
    setRows((prev) => normalize(prev.map((r) => (r.key === key ? { ...r, ...patch } : r))));
  };

  const changeKind = (key: number, kind: StepKind) => {
    setRows((prev) =>
      normalize(
        prev.map((r) => {
          if (r.key === key) return { ...r, kind, optional: kind === "consult", parallel: false };
          // one signer only: the old one becomes a reviewer
          if (kind === "sign" && r.kind === "sign") return { ...r, kind: "review" };
          return r;
        })
      )
    );
  };

  const move = (index: number, by: -1 | 1) => {
    setRows((prev) => {
      const target = index + by;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return normalize(next);
    });
  };

  const remove = (key: number) => setRows((prev) => normalize(prev.filter((r) => r.key !== key)));

  const addStep = () => {
    setRows((prev) => {
      if (prev.length >= MAX_CHAIN_STEPS) return prev;
      const at = prev.findIndex((r) => r.kind === "sign");
      const row = newRow("review");
      return normalize(at < 0 ? [...prev, row] : [...prev.slice(0, at), row, ...prev.slice(at)]);
    });
  };

  const addSigner = () => setRows((prev) => (prev.length >= MAX_CHAIN_STEPS ? prev : normalize([...prev, newRow("sign")])));

  const onPick = (key: number, userId: string | null, person: DirectoryPerson | null) => {
    if (person) {
      setPeople((prev) => new Map(prev).set(person.user_id, { name: memberLabel(person), canSign: canSign(person) }));
    }
    update(key, { userId });
  };

  const save = async (submit: boolean) => {
    if (busy) return;
    setAttempted(true);
    if (errors.length > 0) return;
    setBusy(submit ? "submit" : "save");
    let saved = false;
    try {
      await setApprovalChain(documentId, toInput(rows));
      saved = true;
      if (submit) await submitForApproval(documentId);
      toast.success(submit ? "Submitted for approval (Đã trình duyệt)" : "Approval chain saved");
      onDone();
      onOpenChange(false);
    } catch (err) {
      const message = getErrorMessage(err);
      if (saved) {
        // the chain is stored even though the submit failed
        toast.error(`The chain was saved but not submitted: ${message}`);
        onDone();
      } else {
        toast.error(message);
      }
    } finally {
      setBusy(null);
    }
  };

  const disabled = busy !== null;
  const errorId = `${ids}-errors`;
  const showErrors = attempted && errors.length > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Approval chain (Luồng trình ký)</DialogTitle>
          <DialogDescription>
            Steps run in order. Consult steps (Xin ý kiến) can run in parallel with the step above. The signer (Ký
            duyệt) is always last.
          </DialogDescription>
        </DialogHeader>

        {loadError && (
          <p className="text-sm text-destructive" role="alert">
            Could not load the company directory: {loadError}
          </p>
        )}

        <ol className="space-y-2" aria-label="Approval steps" aria-describedby={showErrors ? errorId : undefined}>
          {rows.map((row, index) => {
            const isSign = row.kind === "sign";
            const label = `Step ${stepNumbers[index]}${row.parallel ? " (parallel)" : ""}`;
            const prevIsSign = rows[index - 1]?.kind === "sign";
            const nextIsSign = rows[index + 1]?.kind === "sign";
            const personId = `${ids}-person-${row.key}`;
            const kindId = `${ids}-kind-${row.key}`;
            return (
              <li
                key={row.key}
                className={cn(
                  "space-y-2 rounded-lg border p-3",
                  row.parallel && "ml-4 border-dashed",
                  isSign && "border-primary/40 bg-primary/5"
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    {label}
                    {isSign && " · pinned last"}
                  </span>
                  <div className="flex items-center gap-0.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => move(index, -1)}
                      disabled={disabled || isSign || index === 0 || prevIsSign}
                      aria-label={`Move ${label} up`}
                    >
                      <ArrowUp aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => move(index, 1)}
                      disabled={disabled || isSign || index === rows.length - 1 || nextIsSign}
                      aria-label={`Move ${label} down`}
                    >
                      <ArrowDown aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => remove(row.key)}
                      disabled={disabled}
                      aria-label={`Remove ${label}`}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                </div>

                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_13rem]">
                  <div className="min-w-0 space-y-1">
                    <Label htmlFor={personId} className="sr-only">
                      {`${label} approver`}
                    </Label>
                    <PersonPicker
                      id={personId}
                      value={row.userId}
                      onChange={(userId, person) => onPick(row.key, userId, person)}
                      filter={isSign ? canSign : undefined}
                      placeholder={isSign ? "Signer (leader or signing position)" : "Search people by name or email"}
                      disabled={disabled}
                    />
                  </div>
                  <div>
                    <Label htmlFor={kindId} className="sr-only">
                      {`${label} kind`}
                    </Label>
                    <select
                      id={kindId}
                      className={nativeSelectClass}
                      value={row.kind}
                      onChange={(e) => changeKind(row.key, e.target.value as StepKind)}
                      disabled={disabled}
                    >
                      {STEP_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {STEP_KIND_LABELS[k]}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {row.kind === "consult" && (
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        checked={row.parallel}
                        onChange={(e) => update(row.key, { parallel: e.target.checked })}
                        disabled={disabled || index === 0}
                      />
                      Parallel with previous
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        checked={row.optional}
                        onChange={(e) => update(row.key, { optional: e.target.checked })}
                        disabled={disabled}
                      />
                      Optional
                    </label>
                  </div>
                )}
              </li>
            );
          })}
        </ol>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={addStep} disabled={disabled || full}>
            <Plus aria-hidden />
            Add step
          </Button>
          {!hasSigner && (
            <Button type="button" variant="outline" size="sm" onClick={addSigner} disabled={disabled || full}>
              <Plus aria-hidden />
              Add signer
            </Button>
          )}
          <span className="text-xs text-muted-foreground">
            {rows.length} of {MAX_CHAIN_STEPS} steps
          </span>
        </div>

        {showErrors && (
          <ul id={errorId} className="list-inside list-disc space-y-0.5 text-sm text-destructive" role="alert">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={disabled}>
            Cancel
          </Button>
          <Button
            variant={submitAfterSave ? "outline" : "default"}
            onClick={() => void save(false)}
            disabled={disabled || loading}
          >
            {busy === "save" && <Loader2 className="animate-spin" aria-hidden />}
            {busy === "save" ? "Saving…" : "Save"}
          </Button>
          <Button
            variant={submitAfterSave ? "default" : "outline"}
            onClick={() => void save(true)}
            disabled={disabled || loading}
          >
            {busy === "submit" ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
            {busy === "submit" ? "Submitting…" : "Save and submit"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
