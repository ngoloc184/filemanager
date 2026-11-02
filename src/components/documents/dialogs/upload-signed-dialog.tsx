"use client";

import { useId, useState } from "react";
import { Loader2, Lock, Upload } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { DocumentBundle } from "@/lib/documents/types";
import { attachDocumentFile, ensureDocumentFolder } from "@/lib/services/documents";
import { createUploadTasks, uploadOne, type UploadStatus } from "@/lib/services/uploads";
import { formatBytes } from "@/lib/utils";
import { getErrorMessage } from "@/lib/types/database";

// Upload signed copy (Bản đã ký), clerk, on a signed or issued document: the
// file goes into the clerk's 'Documents' folder and is linked as 'signed'.
// On an issued document the link is frozen at once (no new versions, rename
// or delete).

type Props = {
  bundle: DocumentBundle;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
};

type Step = UploadStatus | "attaching";

const STEP_LABELS: Partial<Record<Step, string>> = {
  uploading: "Uploading…",
  registering: "Saving…",
  attaching: "Attaching…",
};

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

export function UploadSignedDialog(props: Props) {
  const session = useOpenSession(props.open);
  return <UploadSignedDialogBody key={session} {...props} />;
}

function UploadSignedDialogBody({ bundle, open, onOpenChange, onDone }: Props) {
  const ids = useId();
  const doc = bundle.document;
  const [file, setFile] = useState<File | null>(null);
  const [step, setStep] = useState<Step | null>(null);

  const busy = step !== null;
  const existing = bundle.files.filter((f) => f.kind === "signed");

  const upload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !file) return;
    setStep("uploading");
    try {
      const folderId = await ensureDocumentFolder();
      const [task] = createUploadTasks([file], folderId);
      let failure: string | undefined;
      const row = await uploadOne(bundle.me.user_id, task, (status, error) => {
        if (status === "failed") failure = error;
        else if (status !== "done") setStep(status);
      }).catch((err: unknown) => {
        throw new Error(failure ?? getErrorMessage(err));
      });
      setStep("attaching");
      try {
        await attachDocumentFile(doc.id, row.id, "signed");
      } catch (err) {
        // the upload itself worked: say where the file is
        throw new Error(
          `${getErrorMessage(err)} The file "${row.name}" was uploaded to your Documents folder but is not attached.`
        );
      }
      toast.success(doc.status === "issued" ? "Signed copy attached and locked" : "Signed copy attached");
      onDone();
      onOpenChange(false);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setStep(null);
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
        <form onSubmit={(e) => void upload(e)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Upload signed copy (Bản đã ký)</DialogTitle>
            <DialogDescription>{doc.notation ? `${doc.notation} – ${doc.subject}` : doc.subject}</DialogDescription>
          </DialogHeader>

          <div
            role="note"
            className="flex gap-2 rounded-lg border bg-muted/50 p-3 text-sm text-foreground"
            id={`${ids}-note`}
          >
            <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <p>After issue, the signed copy is locked as soon as it is attached.</p>
          </div>

          {existing.length > 0 && (
            <div className="text-sm">
              <p className="text-muted-foreground">Already attached:</p>
              <ul className="mt-1 list-inside list-disc">
                {existing.map((f) => (
                  <li key={f.id} className="[overflow-wrap:anywhere]">
                    {f.name}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor={`${ids}-file`}>File (usually a scanned PDF)</Label>
            <Input
              id={`${ids}-file`}
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              disabled={busy}
              required
              aria-describedby={`${ids}-note`}
            />
            {file && (
              <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {file.name} · {formatBytes(file.size)}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !file}>
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Upload aria-hidden />}
              {step ? (STEP_LABELS[step] ?? "Uploading…") : "Upload and attach"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
