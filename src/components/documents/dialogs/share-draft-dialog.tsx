"use client";

import { useId, useState } from "react";
import { Loader2, Share2, UserMinus } from "lucide-react";
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
import type { DocAccess, DocGrant, DocumentBundle } from "@/lib/documents/types";
import { memberLabel } from "@/lib/org";
import { grantDocumentAccess, revokeDocumentAccess } from "@/lib/services/documents";
import { getErrorMessage } from "@/lib/types/database";

// Share draft (author or company admin): explicit read / edit grants on a
// draft (document_grants). Edit access also lets the person change the
// draft's files while they are not frozen. The dialog stays open so several
// people can be added; onDone() lets the page reload the bundle.

type Props = {
  bundle: DocumentBundle;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
};

const ACCESS_LABELS: Record<DocAccess, string> = {
  read: "Read",
  edit: "Edit",
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

export function ShareDraftDialog(props: Props) {
  const session = useOpenSession(props.open);
  return <ShareDraftDialogBody key={session} {...props} />;
}

function ShareDraftDialogBody({ bundle, open, onOpenChange, onDone }: Props) {
  const ids = useId();
  const doc = bundle.document;
  // local copy so the list updates at once; a reloaded bundle replaces it
  const [grants, setGrants] = useState<DocGrant[]>(bundle.grants);
  const [source, setSource] = useState<DocGrant[]>(bundle.grants);
  if (bundle.grants !== source) {
    setSource(bundle.grants);
    setGrants(bundle.grants);
  }

  const [person, setPerson] = useState<DirectoryPerson | null>(null);
  const [access, setAccess] = useState<DocAccess>("read");
  // '' = the add form; otherwise the user id of the row being changed
  const [busy, setBusy] = useState<string | null>(null);

  const excluded = [
    ...grants.map((g) => g.user_id),
    ...(bundle.me.user_id ? [bundle.me.user_id] : []),
    ...(doc.created_by ? [doc.created_by] : []),
  ];

  const grant = async (userId: string, name: string | null, level: DocAccess, key: string) => {
    if (busy !== null) return;
    setBusy(key);
    try {
      await grantDocumentAccess(doc.id, userId, level);
      setGrants((prev) =>
        prev.some((g) => g.user_id === userId)
          ? prev.map((g) => (g.user_id === userId ? { ...g, access: level } : g))
          : [...prev, { user_id: userId, name, access: level }]
      );
      toast.success(`${name || "They"} can now ${level === "edit" ? "edit" : "read"} this draft`);
      onDone();
      return true;
    } catch (err) {
      toast.error(getErrorMessage(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!person) return;
    const ok = await grant(person.user_id, memberLabel(person), access, "");
    if (ok) {
      setPerson(null);
      setAccess("read");
    }
  };

  const revoke = async (g: DocGrant) => {
    if (busy !== null) return;
    setBusy(g.user_id);
    try {
      await revokeDocumentAccess(doc.id, g.user_id);
      setGrants((prev) => prev.filter((x) => x.user_id !== g.user_id));
      toast.success(`Removed ${g.name || "access"}`);
      onDone();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const disabled = busy !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && disabled) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share draft</DialogTitle>
          <DialogDescription>
            People you add here can open this draft before it is submitted. Edit access also lets them change its
            files.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => void add(e)} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_7rem_auto] sm:items-end">
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor={`${ids}-person`}>Person</Label>
            <PersonPicker
              id={`${ids}-person`}
              value={person?.user_id ?? null}
              onChange={(_, p) => setPerson(p)}
              excludeIds={excluded}
              disabled={disabled}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${ids}-access`}>Access</Label>
            <select
              id={`${ids}-access`}
              className={nativeSelectClass}
              value={access}
              onChange={(e) => setAccess(e.target.value as DocAccess)}
              disabled={disabled}
            >
              <option value="read">{ACCESS_LABELS.read}</option>
              <option value="edit">{ACCESS_LABELS.edit}</option>
            </select>
          </div>
          <Button type="submit" disabled={disabled || !person}>
            {busy === "" ? <Loader2 className="animate-spin" aria-hidden /> : <Share2 aria-hidden />}
            Share
          </Button>
        </form>

        <section aria-labelledby={`${ids}-shared`} className="space-y-2">
          <h3 id={`${ids}-shared`} className="text-sm font-medium">
            Shared with
          </h3>
          {grants.length === 0 ? (
            <p className="text-sm text-muted-foreground">Not shared with anyone yet.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {grants.map((g) => {
                const name = g.name || "Unknown person";
                return (
                  <li key={g.user_id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
                    <select
                      className={`${nativeSelectClass} w-24`}
                      value={g.access}
                      onChange={(e) => void grant(g.user_id, g.name, e.target.value as DocAccess, g.user_id)}
                      disabled={disabled}
                      aria-label={`Access for ${name}`}
                    >
                      <option value="read">{ACCESS_LABELS.read}</option>
                      <option value="edit">{ACCESS_LABELS.edit}</option>
                    </select>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void revoke(g)}
                      disabled={disabled}
                      aria-label={`Remove ${name}`}
                    >
                      {busy === g.user_id ? (
                        <Loader2 className="animate-spin" aria-hidden />
                      ) : (
                        <UserMinus aria-hidden />
                      )}
                      Remove
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={disabled}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
