"use client";

import { useId, useState } from "react";
import { Info, Loader2, PenLine } from "lucide-react";
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
import { nativeSelectClass } from "@/components/org/department-select";
import type { DocumentBundle, SignerAuthority } from "@/lib/documents/types";
import { signDocument } from "@/lib/services/documents-outgoing";
import { getErrorMessage } from "@/lib/types/database";

// Sign (Ký duyệt): the in-app e-approval of the last step. It records the
// signer, the authority prefix and the main file checksum; it is NOT a
// digital signature (chữ ký số) under Decree 30/2020, Article 5.

type Props = {
  bundle: DocumentBundle;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
};

/** Signing authority (thẩm quyền ký) prefixes, '' = the head signs directly. */
export const SIGN_AUTHORITIES: readonly { value: SignerAuthority; label: string }[] = [
  { value: "", label: "Head (ký trực tiếp)" },
  { value: "KT", label: "KT. – signing for the head" },
  { value: "TL", label: "TL. – by order" },
  { value: "TUQ", label: "TUQ. – by authorisation" },
  { value: "TM", label: "TM. – on behalf of the collective" },
  { value: "Q", label: "Q. – acting" },
];

export const SIGN_NOTICE =
  "This records your in-app approval. It is not a digital signature (chữ ký số) under Decree 30/2020, Article 5. Upload the signed copy if one is required.";

const MAX_COMMENT = 2000;

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

export function SignDialog(props: Props) {
  const session = useOpenSession(props.open);
  return <SignDialogBody key={session} {...props} />;
}

function SignDialogBody({ bundle, open, onOpenChange, onDone }: Props) {
  const ids = useId();
  const doc = bundle.document;
  const mainFile = bundle.files.find((f) => f.kind === "main") ?? null;
  const [authority, setAuthority] = useState<SignerAuthority>("");
  const [comment, setComment] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  const tooLong = comment.trim().length > MAX_COMMENT;
  const canSubmit = confirmed && !busy && !tooLong;

  const sign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    try {
      await signDocument(doc.id, authority, comment);
      toast.success("Signed (Đã ký duyệt). The clerk can now issue it.");
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
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <form onSubmit={(e) => void sign(e)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Sign (Ký duyệt)</DialogTitle>
            <DialogDescription>{doc.subject}</DialogDescription>
          </DialogHeader>

          <div
            id={`${ids}-notice`}
            role="note"
            className="flex gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-foreground"
          >
            <Info className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden />
            <p>{SIGN_NOTICE}</p>
          </div>

          {mainFile ? (
            <p className="text-sm text-muted-foreground">
              Final draft: <span className="font-medium text-foreground [overflow-wrap:anywhere]">{mainFile.name}</span>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">This document has no main file attached.</p>
          )}

          <div className="space-y-1.5">
            <Label htmlFor={`${ids}-authority`}>Signing authority (Thẩm quyền ký)</Label>
            <select
              id={`${ids}-authority`}
              className={nativeSelectClass}
              value={authority}
              onChange={(e) => setAuthority(e.target.value as SignerAuthority)}
              disabled={busy}
            >
              {SIGN_AUTHORITIES.map((a) => (
                <option key={a.value || "head"} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`${ids}-comment`}>Comment (optional)</Label>
            <Textarea
              id={`${ids}-comment`}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              maxLength={MAX_COMMENT}
              rows={3}
              disabled={busy}
              aria-invalid={tooLong || undefined}
            />
          </div>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-primary"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              disabled={busy}
              aria-describedby={`${ids}-notice`}
              required
            />
            <span>I have read the final draft</span>
          </label>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : <PenLine aria-hidden />}
              {busy ? "Signing…" : "Sign"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
