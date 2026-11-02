"use client";

import { useId, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
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
import { completeDocument } from "@/lib/services/documents-incoming";
import { MAX_RESULT_LENGTH, topLevelLead } from "@/lib/documents/incoming";
import type { DocumentBundle } from "@/lib/documents/types";
import { getErrorMessage } from "@/lib/types/database";
import { cn } from "@/lib/utils";

/**
 * Completes an incoming document in progress (Hoàn thành xử lý) with a result
 * note. A leader or company admin may complete before the lead has reported;
 * the server then records an override.
 */
export function CompleteDialog({
  bundle,
  open,
  onOpenChange,
  onDone,
}: {
  bundle: DocumentBundle;
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
        <CompleteBody
          bundle={bundle}
          busy={busy}
          setBusy={setBusy}
          onClose={() => onOpenChange(false)}
          onDone={onDone}
        />
      </DialogContent>
    </Dialog>
  );
}

function CompleteBody({
  bundle,
  busy,
  setBusy,
  onClose,
  onDone,
}: {
  bundle: DocumentBundle;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const id = useId();
  const [result, setResult] = useState("");

  const roles = bundle.me.roles;
  const leaderish = roles.includes("leader") || roles.includes("org_admin");
  const lead = topLevelLead(bundle.assignments);
  const override = leaderish && lead?.status !== "done";
  const trimmed = result.trim();
  const tooLong = trimmed.length > MAX_RESULT_LENGTH;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !trimmed || tooLong) return;
    setBusy(true);
    try {
      await completeDocument(bundle.document.id, trimmed);
      setBusy(false);
      toast.success("Document completed");
      onClose();
      onDone();
    } catch (err) {
      setBusy(false);
      toast.error(getErrorMessage(err));
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Complete (Hoàn thành xử lý)</DialogTitle>
        <DialogDescription className="line-clamp-2">{bundle.document.subject}</DialogDescription>
      </DialogHeader>

      {override && (
        <div
          className="flex items-start gap-2 rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm"
          role="note"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden />
          <p>The lead has not reported yet. Completing now records an override.</p>
        </div>
      )}

      <form id={`${id}-form`} onSubmit={submit} className="space-y-2" noValidate>
        <Label htmlFor={`${id}-result`}>
          Result note (Kết quả xử lý)
          <span className="text-destructive" aria-hidden>
            *
          </span>
        </Label>
        <Textarea
          id={`${id}-result`}
          value={result}
          onChange={(e) => setResult(e.target.value)}
          rows={5}
          maxLength={MAX_RESULT_LENGTH}
          required
          aria-invalid={tooLong}
          aria-describedby={`${id}-hint`}
          placeholder="How the document was handled and the outcome"
          disabled={busy}
          className="max-h-64"
        />
        <p id={`${id}-hint`} className="flex justify-between gap-2 text-xs text-muted-foreground">
          <span>Everyone who assigned it and any open supports are notified.</span>
          <span className={cn("shrink-0 tabular-nums", tooLong && "text-destructive")}>
            {result.length}/{MAX_RESULT_LENGTH}
          </span>
        </p>
      </form>

      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <button
          type="submit"
          form={`${id}-form`}
          className={buttonVariants()}
          disabled={busy || !trimmed || tooLong}
        >
          {busy && <Loader2 className="animate-spin" aria-hidden />}
          Complete
        </button>
      </DialogFooter>
    </>
  );
}
