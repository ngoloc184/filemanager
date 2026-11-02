"use client";

import { useEffect, useId, useState } from "react";
import { AlertTriangle, ExternalLink, Loader2 } from "lucide-react";
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
import { nativeSelectClass } from "@/components/org/department-select";
import { listRegisters } from "@/lib/services/documents";
import { peekNextNumber } from "@/lib/services/document-admin";
import { registerIncoming } from "@/lib/services/documents-incoming";
import { getMyOrg } from "@/lib/services/org";
import { DEFAULT_ORG_TIME_ZONE, formatDay, todayIn } from "@/lib/documents/deadlines";
import { MAX_INSTRUCTION_LENGTH, type DuplicateCandidate } from "@/lib/documents/incoming";
import type { DocRegister, DocumentBundle } from "@/lib/documents/types";
import { getErrorMessage } from "@/lib/types/database";

/** Registers that can take this document now: open, and the type allowed. */
function usableRegisters(registers: DocRegister[], docTypeId: string | null): DocRegister[] {
  return registers.filter(
    (r) =>
      !r.closed_at &&
      (r.allowed_type_ids.length === 0 || (!!docTypeId && r.allowed_type_ids.includes(docTypeId)))
  );
}

/**
 * The clerk enters an incoming draft into a register book (Vào sổ văn bản
 * đến). When the same document may already be registered, the possible
 * duplicates are listed and registering again needs a reason.
 */
export function RegisterDialog({
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
      <DialogContent className="sm:max-w-lg">
        <RegisterBody
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

function RegisterBody({
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
  const doc = bundle.document;
  const [registers, setRegisters] = useState<DocRegister[] | null>(null);
  const [year, setYear] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [registerId, setRegisterId] = useState<string>("");
  // the preview belongs to one register: a stale one reads as loading
  const [peek, setPeek] = useState<{ registerId: string; value: number | null } | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[] | null>(null);
  const [reason, setReason] = useState("");

  // This year's open incoming registers; the year comes from the company's time zone.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let timeZone = DEFAULT_ORG_TIME_ZONE;
      try {
        timeZone = (await getMyOrg())?.org.timezone || DEFAULT_ORG_TIME_ZONE;
      } catch {
        // fall back to the default zone; the server checks the register's year anyway
      }
      const currentYear = Number(todayIn(timeZone).slice(0, 4));
      const rows = usableRegisters(await listRegisters("incoming", currentYear), doc.doc_type_id);
      if (cancelled) return;
      setYear(currentYear);
      setRegisters(rows);
      setRegisterId(
        rows.find((r) => r.id === doc.register_id)?.id ?? rows[0]?.id ?? ""
      );
    })().catch((err: unknown) => {
      if (cancelled) return;
      setRegisters([]);
      setLoadError(getErrorMessage(err));
    });
    return () => {
      cancelled = true;
    };
  }, [doc.doc_type_id, doc.register_id]);

  // Preview of the arrival number this register would hand out (nothing is taken).
  // register_incoming numbers without a type (doc_next_number(register, null)),
  // so the preview must not use the per-type counter of a 'register_type' book.
  useEffect(() => {
    if (!registerId) return;
    let cancelled = false;
    peekNextNumber(registerId, null)
      .then((n) => {
        if (!cancelled) setPeek({ registerId, value: Number.isFinite(n) ? n : null });
      })
      .catch(() => {
        // the preview is optional; registering still works
        if (!cancelled) setPeek({ registerId, value: null });
      });
    return () => {
      cancelled = true;
    };
  }, [registerId]);

  const reasonTrimmed = reason.trim();
  const reasonTooLong = reasonTrimmed.length > MAX_INSTRUCTION_LENGTH;

  const register = async (duplicateReason: string | null) => {
    if (busy || !registerId) return;
    setBusy(true);
    try {
      const result = await registerIncoming(doc.id, registerId, duplicateReason);
      setBusy(false);
      if (!result.ok) {
        setDuplicates(result.duplicates ?? []);
        return;
      }
      toast.success(
        result.arrival_number != null
          ? `Registered as arrival no. ${result.arrival_number}`
          : "Registered"
      );
      onClose();
      onDone();
    } catch (err) {
      setBusy(false);
      toast.error(getErrorMessage(err));
    }
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (duplicates) {
      if (!reasonTrimmed || reasonTooLong) return;
      void register(reasonTrimmed);
    } else {
      void register(null);
    }
  };

  const loading = registers === null;
  const peekLoading = !!registerId && peek?.registerId !== registerId;
  const nextNumber = peekLoading ? null : (peek?.value ?? null);
  const selected = registers?.find((r) => r.id === registerId) ?? null;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Register (Vào sổ văn bản đến)</DialogTitle>
        <DialogDescription>
          The document gets the next arrival number of the register. Its files are locked once it is registered.
        </DialogDescription>
      </DialogHeader>
      <form id={`${id}-form`} onSubmit={onSubmit} className="min-w-0 space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor={`${id}-register`}>
            Register (Sổ văn bản đến{year ? ` ${year}` : ""})
          </Label>
          <select
            id={`${id}-register`}
            className={nativeSelectClass}
            value={registerId}
            onChange={(e) => {
              setRegisterId(e.target.value);
              setDuplicates(null);
            }}
            disabled={busy || loading || (registers?.length ?? 0) === 0}
            aria-describedby={`${id}-next`}
          >
            {loading && <option value="">Loading…</option>}
            {!loading && (registers?.length ?? 0) === 0 && <option value="">No open register</option>}
            {(registers ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
                {r.is_confidential ? " (confidential)" : ""}
              </option>
            ))}
          </select>
          <p id={`${id}-next`} className="text-xs text-muted-foreground" aria-live="polite">
            {loadError ? (
              <span className="text-destructive">{loadError}</span>
            ) : !loading && (registers?.length ?? 0) === 0 ? (
              `There is no open incoming register for ${year ?? "this year"} that takes this document type. Ask a company admin to open one.`
            ) : selected ? (
              <>
                Next arrival number:{" "}
                <span className="font-medium text-foreground tabular-nums">
                  {peekLoading ? "…" : (nextNumber ?? "—")}
                </span>
              </>
            ) : null}
          </p>
        </div>

        {duplicates && (
          <div
            className="space-y-3 rounded-lg border border-warning/50 bg-warning/10 p-3"
            role="alert"
            aria-labelledby={`${id}-dup-title`}
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden />
              <div className="min-w-0">
                <p id={`${id}-dup-title`} className="font-medium">
                  This document may already be registered
                </p>
                <p className="text-xs text-muted-foreground">
                  Same sender number/notation or subject. Check these before registering it again.
                </p>
              </div>
            </div>
            {duplicates.length > 0 ? (
              <ul className="max-h-48 space-y-1 overflow-y-auto">
                {duplicates.map((d) => (
                  <li key={d.id}>
                    <a
                      href={`/documents/${encodeURIComponent(d.id)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                      <span className="w-14 shrink-0 text-xs text-muted-foreground tabular-nums">
                        {d.arrival_number != null ? `No. ${d.arrival_number}` : "—"}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">
                          {d.subject ?? "Restricted document"}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {[d.notation, d.arrival_date ? `received ${formatDay(d.arrival_date)}` : null]
                            .filter(Boolean)
                            .join(" · ") || "—"}
                        </span>
                      </span>
                      <ExternalLink className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="sr-only">(opens in a new tab)</span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">You cannot see the matching documents.</p>
            )}
            <div className="space-y-2">
              <Label htmlFor={`${id}-reason`}>
                Reason for registering anyway
                <span className="text-destructive" aria-hidden>
                  *
                </span>
              </Label>
              <Textarea
                id={`${id}-reason`}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                maxLength={MAX_INSTRUCTION_LENGTH}
                required
                aria-invalid={reasonTooLong}
                placeholder="e.g. A corrected copy sent by the same sender"
                disabled={busy}
                className="max-h-40 bg-background"
              />
            </div>
          </div>
        )}
      </form>
      <DialogFooter>
        {duplicates ? (
          <>
            <Button variant="outline" onClick={onClose} disabled={busy}>
              Keep as draft
            </Button>
            <button
              type="submit"
              form={`${id}-form`}
              className={buttonVariants()}
              disabled={busy || !registerId || !reasonTrimmed || reasonTooLong}
            >
              {busy && <Loader2 className="animate-spin" aria-hidden />}
              Register anyway
            </button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <button
              type="submit"
              form={`${id}-form`}
              className={buttonVariants()}
              disabled={busy || !registerId}
            >
              {busy && <Loader2 className="animate-spin" aria-hidden />}
              Register
            </button>
          </>
        )}
      </DialogFooter>
    </>
  );
}
