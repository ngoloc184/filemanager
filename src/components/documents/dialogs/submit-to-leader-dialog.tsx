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
import { PersonPicker, type DirectoryPerson } from "@/components/org/person-picker";
import { submitIncoming } from "@/lib/services/documents-incoming";
import type { DocumentBundle } from "@/lib/documents/types";
import { getErrorMessage } from "@/lib/types/database";

/** submit_incoming takes a note of at most 5000 characters. */
const NOTE_MAX = 5000;

/** Leaders, department heads and company admins can receive a presented document. */
function canReceive(p: DirectoryPerson): boolean {
  return p.roles.some((r) => r === "leader" || r === "dept_head" || r === "org_admin");
}

/** The clerk presents a registered incoming document to a leader (Trình lãnh đạo). */
export function SubmitToLeaderDialog({
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
        <SubmitBody
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

function SubmitBody({
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
  const [toUserId, setToUserId] = useState<string | null>(bundle.document.presented_to);
  const [toPerson, setToPerson] = useState<DirectoryPerson | null>(null);
  const [note, setNote] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !toUserId) return;
    setBusy(true);
    try {
      await submitIncoming(bundle.document.id, toUserId, note);
      setBusy(false);
      toast.success(
        toPerson ? `Presented to ${toPerson.display_name || toPerson.email}` : "Presented to the leader"
      );
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
        <DialogTitle>Submit to leader (Trình lãnh đạo)</DialogTitle>
        <DialogDescription>
          The person you choose is notified and can assign the document for processing.
        </DialogDescription>
      </DialogHeader>
      <form id={`${id}-form`} onSubmit={submit} className="space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor={`${id}-to`}>
            Leader or department head
            <span className="text-destructive" aria-hidden>
              *
            </span>
          </Label>
          <PersonPicker
            id={`${id}-to`}
            value={toUserId}
            onChange={(userId, person) => {
              setToUserId(userId);
              setToPerson(person);
            }}
            filter={canReceive}
            placeholder="Search leaders and department heads"
            disabled={busy}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${id}-note`}>
            Note <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Textarea
            id={`${id}-note`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={NOTE_MAX}
            placeholder="e.g. Proposed for the HR department"
            disabled={busy}
            className="max-h-48"
          />
        </div>
      </form>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <button
          type="submit"
          form={`${id}-form`}
          className={buttonVariants()}
          disabled={busy || !toUserId}
        >
          {busy && <Loader2 className="animate-spin" aria-hidden />}
          Submit
        </button>
      </DialogFooter>
    </>
  );
}
