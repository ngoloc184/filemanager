"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, CheckCircle2, Loader2, UserMinus } from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { PersonPicker, type DirectoryPerson } from "@/components/org/person-picker";
import { createClient } from "@/lib/supabase/client";
import { getMyOrg, listOrgMembers } from "@/lib/services/org";
import { flushNotificationPush } from "@/lib/services/notifications";
import { hasRole, memberLabel } from "@/lib/org";
import {
  isUuid,
  previewLines,
  resultLines,
  validateOffboard,
  type OffboardResponse,
  type OffboardingPreview,
  type OffboardingResult,
} from "@/lib/offboarding";
import { getErrorMessage } from "@/lib/types/database";
import type { SessionUser } from "@/lib/auth";
import { cn, formatBytes } from "@/lib/utils";

type Done = { counts: OffboardingResult; banned: boolean; warning?: string; leaver: string; successor: string };

/**
 * Offboarding (admins): pick the leaver and a successor, review what moves,
 * then hand everything over and mark the member 'left'.
 */
export default function OffboardingClient({ me, userId }: { me: SessionUser; userId: string | null }) {
  const [isAdmin, setIsAdmin] = useState<boolean | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMyOrg()
      .then((org) => {
        if (!cancelled) setIsAdmin(!!org && org.me.status === "active" && hasRole(org.me, "org_admin"));
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(getErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="max-w-3xl space-y-6">
      <div className="space-y-2">
        <Link href="/org" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "-ml-2")}>
          <ArrowLeft aria-hidden />
          Company
        </Link>
        <div className="flex items-center gap-3">
          <UserMinus className="size-7 shrink-0 text-primary" aria-hidden />
          <h2 className="text-2xl font-bold">Offboard a member</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Hand a leaving person&apos;s files, chat groups and document work to a successor. Nothing is deleted;
          the person is marked as left.
        </p>
      </div>

      {loadError ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
          {loadError}
        </p>
      ) : isAdmin === undefined ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Loading…
        </div>
      ) : !isAdmin ? (
        <Card>
          <CardHeader>
            <CardTitle>Not available</CardTitle>
            <CardDescription>Only company admins can offboard members.</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <OffboardingForm me={me} initialUserId={userId && isUuid(userId) && userId !== me.id ? userId : null} />
      )}
    </div>
  );
}

function OffboardingForm({ me, initialUserId }: { me: SessionUser; initialUserId: string | null }) {
  const ids = useId();
  const [fromId, setFromId] = useState<string | null>(initialUserId);
  const [fromPerson, setFromPerson] = useState<DirectoryPerson | null>(null);
  const [toId, setToId] = useState<string | null>(null);
  const [toPerson, setToPerson] = useState<DirectoryPerson | null>(null);
  const [preview, setPreview] = useState<OffboardingPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [blockSignIn, setBlockSignIn] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  // A preset leaver (from the People tab): resolve the name and status.
  useEffect(() => {
    if (!initialUserId) return;
    let cancelled = false;
    listOrgMembers(null, true)
      .then((people) => {
        if (!cancelled) setFromPerson(people.find((p) => p.user_id === initialUserId) ?? null);
      })
      .catch(() => {
        // the picker still shows the id; the preview reports real problems
      });
    return () => {
      cancelled = true;
    };
  }, [initialUserId]);

  // What would move, whenever the leaver changes.
  useEffect(() => {
    if (!fromId) return;
    let cancelled = false;
    const load = async () => {
      const { data, error: rpcError } = await createClient().rpc("offboarding_preview", { p_user_id: fromId });
      if (cancelled) return;
      if (rpcError) {
        setPreview(null);
        setPreviewError(rpcError.message);
      } else {
        setPreview(data as OffboardingPreview);
        setPreviewError(null);
      }
    };
    load().catch((err: unknown) => {
      if (!cancelled) setPreviewError(getErrorMessage(err));
    });
    return () => {
      cancelled = true;
    };
  }, [fromId]);

  if (done) return <Result done={done} />;

  const leaverName = fromPerson ? memberLabel(fromPerson) : "this person";
  const successorName = toPerson ? memberLabel(toPerson) : "the successor";
  const problem = validateOffboard(fromId, toId, me.id);
  const lines = preview ? previewLines(preview, successorName) : [];
  const bytes = preview ? Number(preview.bytes) || 0 : 0;
  const previewLoading = !!fromId && !preview && !previewError;
  const canSubmit = !problem && !!preview && confirmed && !submitting;

  const pickLeaver = (id: string | null, person: DirectoryPerson | null) => {
    setFromId(id);
    setFromPerson(person);
    setPreview(null);
    setPreviewError(null);
    setConfirmed(false);
    setError(null);
    if (id && id === toId) {
      setToId(null);
      setToPerson(null);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (problem) {
      setError(problem);
      return;
    }
    if (!canSubmit || !fromId || !toId) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/org/offboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ userId: fromId, successorId: toId, blockSignIn }),
      });
      const body = (await res.json().catch(() => null)) as OffboardResponse | null;
      if (!res.ok || !body || !("ok" in body) || body.ok !== true) {
        setError(body && "error" in body ? body.error : "Could not offboard this member. Please try again.");
        return;
      }
      flushNotificationPush();
      toast.success(`${leaverName} was offboarded`);
      setDone({
        counts: body.counts,
        banned: body.banned,
        warning: body.warning,
        leaver: leaverName,
        successor: successorName,
      });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      <Card>
        <CardHeader>
          <CardTitle>1. Who is leaving, and who takes over</CardTitle>
          <CardDescription>The successor must be an active member of the company.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={`${ids}-from`}>Leaving member</Label>
            <PersonPicker
              id={`${ids}-from`}
              value={fromId}
              onChange={pickLeaver}
              includeInactive
              filter={(p) => p.status !== "left"}
              excludeIds={[me.id]}
              placeholder="Search members"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${ids}-to`}>Successor (người tiếp nhận)</Label>
            <PersonPicker
              id={`${ids}-to`}
              value={toId}
              onChange={(id, person) => {
                setToId(id);
                setToPerson(person);
                setError(null);
              }}
              excludeIds={fromId ? [fromId] : []}
              placeholder="Search active members"
            />
          </div>
        </CardContent>
      </Card>

      {fromId && (
        <Card>
          <CardHeader>
            <CardTitle>2. What will move</CardTitle>
            <CardDescription>
              Everything {leaverName} owns or is working on goes to {successorName}. Storage paths stay the same.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {previewLoading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Checking what {leaverName} owns…
              </div>
            )}
            {previewError && (
              <p className="text-sm text-destructive" role="alert">
                {fromPerson?.status === "left" ? `${leaverName} has already left the company.` : previewError}
              </p>
            )}
            {preview &&
              (lines.length > 0 ? (
                <ul className="space-y-2" aria-label="Handover checklist">
                  {lines.map((line) => (
                    <li key={line} className="flex items-start gap-2 text-sm">
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                      <span className="min-w-0 [overflow-wrap:anywhere]">{line}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Nothing to hand over. {leaverName} will only be marked as left.
                </p>
              ))}
            {preview && bytes > 0 && (
              <p className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  {formatBytes(bytes)} will move. This counts toward {successorName}&apos;s storage quota, so
                  check they have room before you continue.
                </span>
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {fromId && (
        <Card>
          <CardHeader>
            <CardTitle>3. Confirm</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-primary"
                checked={blockSignIn}
                onChange={(e) => setBlockSignIn(e.target.checked)}
                aria-describedby={`${ids}-block-hint`}
              />
              <span>
                Block sign-in for this account
                <span id={`${ids}-block-hint`} className="block text-xs text-muted-foreground">
                  The account is blocked everywhere in this app, not only in this company.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-primary"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>I understand this cannot be undone automatically</span>
            </label>

            {(error || (toId && problem)) && (
              <p className="text-sm text-destructive" role="alert">
                {error ?? problem}
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="destructive" disabled={!canSubmit}>
                {submitting ? <Loader2 className="animate-spin" aria-hidden /> : <UserMinus aria-hidden />}
                {submitting ? "Offboarding…" : "Offboard and transfer"}
              </Button>
              <Link href="/org" className={buttonVariants({ variant: "outline" })}>
                Cancel
              </Link>
            </div>
          </CardContent>
        </Card>
      )}
    </form>
  );
}

function Result({ done }: { done: Done }) {
  const lines = resultLines(done.counts, done.successor);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CheckCircle2 className="size-5 text-primary" aria-hidden />
          {done.leaver} was offboarded
        </CardTitle>
        <CardDescription>
          {done.banned ? "Sign-in is blocked for this account. " : ""}
          {done.successor} was notified about the handover.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {lines.length > 0 ? (
          <ul className="space-y-2" aria-label="What was handed over">
            {lines.map((line) => (
              <li key={line} className="flex items-start gap-2 text-sm">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                <span className="min-w-0 [overflow-wrap:anywhere]">{line}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">There was nothing to hand over.</p>
        )}
        {done.warning && (
          <p className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300" role="status">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{done.warning}</span>
          </p>
        )}
        <Link href="/org" className={buttonVariants({ variant: "outline" })}>
          <ArrowLeft aria-hidden />
          Back to Company
        </Link>
      </CardContent>
    </Card>
  );
}
