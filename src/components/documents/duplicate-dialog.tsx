"use client";

import { useId, useState } from "react";
import { AlertTriangle, ExternalLink, Loader2 } from "lucide-react";
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
import { formatDay } from "@/lib/documents/deadlines";
import { MAX_DUPLICATE_REASON_LENGTH } from "@/lib/documents/form";
import type { DuplicateCandidate } from "@/lib/documents/incoming";
import { getErrorMessage } from "@/lib/types/database";

/**
 * Shown when register_incoming finds documents that may be the same one
 * (same number/notation, issuing organisation and document date). Registering anyway needs a
 * reason, which the audit timeline keeps; 'Keep as draft' leaves it unregistered.
 */
export function DuplicateDialog({
  open,
  duplicates,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  duplicates: DuplicateCandidate[];
  onConfirm: (reason: string) => Promise<void>;
  onCancel: () => void;
}) {
  const reasonId = useId();
  const errorId = useId();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = reason.trim();
  const tooLong = trimmed.length > MAX_DUPLICATE_REASON_LENGTH;

  const confirm = async () => {
    if (!trimmed) {
      setError("Enter why this is not a duplicate");
      return;
    }
    if (tooLong) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(trimmed);
      setReason("");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
            Possible duplicate (Văn bản trùng)
          </DialogTitle>
          <DialogDescription>
            {duplicates.length === 1
              ? "A document with the same number/notation from the same sender is already in the system."
              : `${duplicates.length} documents with the same number/notation from the same sender are already in the system.`}{" "}
            Check them before registering this one.
          </DialogDescription>
        </DialogHeader>

        <ul className="max-h-56 space-y-2 overflow-y-auto" aria-label="Possible duplicates">
          {duplicates.map((d) => (
            <li key={d.id} className="rounded-lg border bg-muted/30 p-2.5">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                <span>
                  Arrival no. <span className="font-medium text-foreground">{d.arrival_number ?? "—"}</span>
                </span>
                {d.notation && <span className="font-medium text-foreground">{d.notation}</span>}
                {d.arrival_date && <span>{formatDay(d.arrival_date)}</span>}
              </div>
              <a
                href={`/documents/${encodeURIComponent(d.id)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-flex max-w-full items-start gap-1 text-sm font-medium text-primary underline-offset-3 hover:underline focus-visible:rounded focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <span className={d.subject ? "[overflow-wrap:anywhere]" : "italic"}>
                  {d.subject ?? "Restricted document"}
                </span>
                <ExternalLink className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            </li>
          ))}
        </ul>

        <div className="space-y-1.5">
          <Label htmlFor={reasonId}>
            Reason for registering anyway <span aria-hidden className="text-destructive">*</span>
          </Label>
          <Textarea
            id={reasonId}
            value={reason}
            required
            maxLength={MAX_DUPLICATE_REASON_LENGTH + 100}
            disabled={busy}
            aria-invalid={!!error || tooLong || undefined}
            aria-describedby={error || tooLong ? errorId : undefined}
            placeholder="e.g. Re-sent by the sender with a corrected appendix"
            onChange={(e) => {
              setReason(e.target.value);
              if (error) setError(null);
            }}
          />
          {(error || tooLong) && (
            <p id={errorId} className="text-xs text-destructive" role="alert">
              {tooLong ? `The reason must be at most ${MAX_DUPLICATE_REASON_LENGTH} characters` : error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
            Keep as draft
          </Button>
          <Button type="button" disabled={busy || !trimmed || tooLong} onClick={() => void confirm()}>
            {busy && <Loader2 className="animate-spin" aria-hidden />}
            Register anyway
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
