"use client";

import { useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Ban, Check, Copy, Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DepartmentSelect, nativeSelectClass } from "@/components/org/department-select";
import {
  inviteMember,
  listOrgInvitations,
  listPositions,
  revokeInvitation,
  type OrgInvitation,
  type Position,
} from "@/lib/services/org";
import { ORG_ROLES, ROLE_LABELS, roleLabels, type OrgRole } from "@/lib/org";
import { toggleRole, validateInviteForm } from "@/lib/org-forms";
import { getErrorMessage } from "@/lib/types/database";

function inviteUrl(token: string): string {
  return `${window.location.origin}/invite/${token}`;
}

async function copyLink(token: string) {
  try {
    await navigator.clipboard.writeText(inviteUrl(token));
    toast.success("Invitation link copied");
  } catch {
    toast.error("Could not copy the link. Select it and copy it by hand.");
  }
}

function isPending(i: OrgInvitation, now: number): boolean {
  return !i.accepted_at && !i.revoked_at && new Date(i.expires_at).getTime() > now;
}

/** Invite people by e-mail link (copied by hand) and manage pending links. */
export function InvitationsPanel() {
  const [email, setEmail] = useState("");
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [positionId, setPositionId] = useState<string | null>(null);
  const [roles, setRoles] = useState<OrgRole[]>(["staff"]);
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [invitations, setInvitations] = useState<OrgInvitation[] | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [created, setCreated] = useState<OrgInvitation | null>(null);
  const [revoking, setRevoking] = useState<OrgInvitation | null>(null);
  const [version, setVersion] = useState(0);
  const [now, setNow] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listOrgInvitations(), listPositions()])
      .then(([rows, pos]) => {
        if (cancelled) return;
        setInvitations(rows);
        setPositions(pos);
        setNow(Date.now());
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(getErrorMessage(err));
        setInvitations((prev) => prev ?? []);
        setPositions((prev) => prev ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sending) return;
    const problem = validateInviteForm({ email, roles });
    if (problem) {
      setFormError(problem);
      return;
    }
    setFormError(null);
    setSending(true);
    try {
      const invitation = await inviteMember({
        email: email.trim(),
        departmentId,
        positionId,
        roles,
      });
      setCreated(invitation);
      setEmail("");
      toast.success(`Invitation created for ${invitation.email}`);
      setVersion((v) => v + 1);
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSending(false);
    }
  };

  const pending = (invitations ?? []).filter((i) => isPending(i, now));

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Invite a person</CardTitle>
          <CardDescription>
            They join with the roles you pick here. Invitations are not e-mailed: copy the link and send it yourself.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={send} className="grid gap-4 sm:grid-cols-2" noValidate>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                inputMode="email"
                autoComplete="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@company.com"
                maxLength={320}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-dept">Department</Label>
              <DepartmentSelect id="invite-dept" value={departmentId} onChange={setDepartmentId} allowNone />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-position">Position</Label>
              <select
                id="invite-position"
                className={nativeSelectClass}
                value={positionId ?? ""}
                disabled={positions === null}
                onChange={(e) => setPositionId(e.target.value || null)}
              >
                <option value="">{positions === null ? "Loading…" : "No position"}</option>
                {(positions ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <fieldset className="space-y-2 sm:col-span-2">
              <legend className="text-sm font-medium">Roles</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {ORG_ROLES.map((role) => (
                  <label key={role} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      checked={roles.includes(role)}
                      onChange={(e) => setRoles((prev) => toggleRole(prev, role, e.target.checked))}
                    />
                    {ROLE_LABELS[role]}
                  </label>
                ))}
              </div>
            </fieldset>
            {formError && (
              <p className="text-sm text-destructive sm:col-span-2" role="alert">
                {formError}
              </p>
            )}
            <div className="sm:col-span-2">
              <button type="submit" disabled={sending} className={buttonVariants()}>
                {sending ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
                Send invitation
              </button>
            </div>
          </form>

          {created && (
            <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3" role="status">
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <Check className="size-4 text-primary" aria-hidden />
                Invitation for {created.email}
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  readOnly
                  value={inviteUrl(created.token)}
                  aria-label="Invitation link"
                  onFocus={(e) => e.currentTarget.select()}
                  className="font-mono text-xs md:text-xs"
                />
                <Button variant="outline" onClick={() => void copyLink(created.token)} className="shrink-0">
                  <Copy aria-hidden />
                  Copy link
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Share this link with the person. They must sign in with this email address.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pending invitations</CardTitle>
        </CardHeader>
        <CardContent>
          {loadError && (
            <p className="mb-3 text-sm text-destructive" role="alert">
              {loadError}
            </p>
          )}
          {invitations === null ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Loading invitations…
            </div>
          ) : pending.length === 0 ? (
            <p className="text-sm text-muted-foreground">No pending invitations.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Roles</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pending.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell className="max-w-56 truncate">{i.email}</TableCell>
                    <TableCell>
                      <div className="flex max-w-72 flex-wrap gap-1">
                        {roleLabels(i.roles).map((label) => (
                          <Badge key={label} variant="outline">
                            {label}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell title={new Date(i.expires_at).toLocaleString()}>
                      {formatDistanceToNow(new Date(i.expires_at), { addSuffix: true })}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => void copyLink(i.token)}>
                          <Copy aria-hidden />
                          Copy link
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive"
                          onClick={() => setRevoking(i)}
                        >
                          <Ban aria-hidden />
                          Revoke
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {revoking && (
        <RevokeDialog
          invitation={revoking}
          onOpenChange={(open) => !open && setRevoking(null)}
          onRevoked={() => {
            if (created?.id === revoking.id) setCreated(null);
            setVersion((v) => v + 1);
          }}
        />
      )}
    </div>
  );
}

function RevokeDialog({
  invitation,
  onOpenChange,
  onRevoked,
}: {
  invitation: OrgInvitation;
  onOpenChange: (open: boolean) => void;
  onRevoked: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await revokeInvitation(invitation.id);
      toast.success("Invitation revoked");
      onRevoked();
      onOpenChange(false);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke invitation</DialogTitle>
          <DialogDescription>
            The link sent to {invitation.email} will stop working.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void confirm()} disabled={busy}>
            {busy ? "Revoking…" : "Revoke"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
