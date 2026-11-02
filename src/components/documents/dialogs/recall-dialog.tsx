"use client";

import { useId, useState } from "react";
import { Loader2, TriangleAlert, Undo2 } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import type { DocumentBundle } from "@/lib/documents/types";
import { recallDocument } from "@/lib/services/documents-outgoing";
import { getErrorMessage } from "@/lib/types/database";

// Recall (Thu hồi) of an issued document, clerk or leader. The reason is
// required and goes to the recipients' notifications and the history.

type Props = {
  bundle: DocumentBundle;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
};

const MAX_REASON = 2000;

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

export function RecallDialog(props: Props) {
  const session = useOpenSession(props.open);
  return <RecallDialogBody key={session} {...props} />;
}

function RecallDialogBody({ bundle, open, onOpenChange, onDone }: Props) {
  const ids = useId();
  const doc = bundle.document;
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const trimmed = reason.trim();
  const canSubmit = !busy && trimmed.length > 0 && trimmed.length <= MAX_REASON;

  const recall = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    try {
      await recallDocument(doc.id, trimmed);
      toast.success(doc.notation ? `${doc.notation} recalled` : "Document recalled");
      onDone();
      onOpenChange(false);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form onSubmit={(e) => void recall(e)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Recall (Thu hồi)</DialogTitle>
            <DialogDescription>
              {doc.notation ? `${doc.notation} – ${doc.subject}` : doc.subject}
            </DialogDescription>
          </DialogHeader>

          <div
            role="note"
            className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-foreground"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            <p>Recipients will be notified and their copies cancelled.</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`${ids}-reason`}>Reason (required)</Label>
            <Textarea
              id={`${ids}-reason`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={MAX_REASON}
              rows={3}
              required
              disabled={busy}
              placeholder="Why is this document recalled?"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={!canSubmit}>
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Undo2 aria-hidden />}
              {busy ? "Recalling…" : "Recall"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
