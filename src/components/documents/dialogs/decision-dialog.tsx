"use client";

import { useId, useState } from "react";
import { Loader2 } from "lucide-react";
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
import { getErrorMessage } from "@/lib/types/database";
import { cn } from "@/lib/utils";

export const DECISION_COMMENT_MAX = 5000;

export type DecisionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel: string;
  tone: "default" | "danger";
  commentLabel?: string;
  commentRequired: boolean;
  /** Does the work; a thrown error is shown and the dialog stays open with the text. */
  onConfirm: (comment: string) => Promise<void>;
};

/**
 * A yes/no decision with a comment (approve, return, reject, cancel, reopen…).
 * It closes on success and keeps the text when the server refuses.
 */
export function DecisionDialog(props: DecisionDialogProps) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={props.open}
      onOpenChange={(next) => {
        if (!busy) props.onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        {/* the body unmounts when the dialog closes, so each opening starts empty */}
        <DecisionBody {...props} busy={busy} setBusy={setBusy} />
      </DialogContent>
    </Dialog>
  );
}

function DecisionBody({
  onOpenChange,
  title,
  description,
  confirmLabel,
  tone,
  commentLabel = "Comment",
  commentRequired,
  onConfirm,
  busy,
  setBusy,
}: DecisionDialogProps & { busy: boolean; setBusy: (busy: boolean) => void }) {
  const fieldId = useId();
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);

  const trimmed = comment.trim();
  const tooLong = comment.length > DECISION_COMMENT_MAX;
  const missing = commentRequired && !trimmed;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (missing) {
      setError(`${commentLabel} is required`);
      return;
    }
    if (tooLong) {
      setError(`${commentLabel} is too long (max ${DECISION_COMMENT_MAX} characters)`);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await onConfirm(trimmed);
      setBusy(false);
      onOpenChange(false);
    } catch (err) {
      setBusy(false);
      toast.error(getErrorMessage(err));
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description && <DialogDescription>{description}</DialogDescription>}
      </DialogHeader>
      <form id={`${fieldId}-form`} onSubmit={submit} className="space-y-2" noValidate>
        <Label htmlFor={fieldId}>
          {commentLabel}
          {commentRequired ? (
            <span className="text-destructive" aria-hidden>
              *
            </span>
          ) : (
            <span className="font-normal text-muted-foreground">(optional)</span>
          )}
        </Label>
        <Textarea
          id={fieldId}
          value={comment}
          onChange={(e) => {
            setComment(e.target.value);
            if (error) setError(null);
          }}
          rows={4}
          maxLength={DECISION_COMMENT_MAX}
          required={commentRequired}
          aria-invalid={!!error || tooLong}
          aria-describedby={`${fieldId}-count${error ? ` ${fieldId}-error` : ""}`}
          disabled={busy}
          className="max-h-64"
        />
        <div className="flex items-start justify-between gap-2 text-xs">
          <p id={`${fieldId}-error`} className="text-destructive" role={error ? "alert" : undefined}>
            {error}
          </p>
          <span
            id={`${fieldId}-count`}
            className={cn("shrink-0 tabular-nums text-muted-foreground", tooLong && "text-destructive")}
          >
            {comment.length}/{DECISION_COMMENT_MAX}
          </span>
        </div>
      </form>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
          Cancel
        </Button>
        {/* native submit: Base UI's Button forces type="button" */}
        <button
          type="submit"
          form={`${fieldId}-form`}
          className={buttonVariants({ variant: tone === "danger" ? "destructive" : "default" })}
          disabled={busy || missing || tooLong}
        >
          {busy && <Loader2 className="animate-spin" aria-hidden />}
          {confirmLabel}
        </button>
      </DialogFooter>
    </>
  );
}
