"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { ArrowLeft, Loader2, Printer } from "lucide-react";
import { toast } from "sonner";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  ConfidentialityBadge,
  DirectionBadge,
  DueBadge,
  StatusBadge,
  UrgencyBadge,
} from "@/components/documents/doc-badges";
import { DocumentActions } from "@/components/documents/document-actions";
import { DocumentApprovals } from "@/components/documents/document-approvals";
import { DocumentAssignments } from "@/components/documents/document-assignments";
import { DocumentFiles } from "@/components/documents/document-files";
import { DocumentOpinions } from "@/components/documents/document-opinions";
import { DocumentProfile } from "@/components/documents/document-profile";
import { DocumentTimeline } from "@/components/documents/document-timeline";
import type { SessionUser } from "@/lib/auth";
import { holidaySet, todayIn } from "@/lib/documents/deadlines";
import { isMyAssignment } from "@/lib/documents/incoming";
import { formatNumberLabel } from "@/lib/documents/numbering";
import type { DocumentBundle } from "@/lib/documents/types";
import { getDocument, listHolidays, logDocumentAccess } from "@/lib/services/documents";
import { markMyAssignmentsSeen } from "@/lib/services/documents-incoming";
import { getMyOrg } from "@/lib/services/org";
import { getErrorMessage } from "@/lib/types/database";

// The document page (/documents/[id]): header with badges and actions, the
// profile, files, processing tree, approval chain and opinions in the main
// column, and the history in the side column. Opening it marks the caller's
// unseen assignments as seen. Print shows the profile, processing and history.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type LoadState =
  | { status: "loading" }
  | { status: "ready"; bundle: DocumentBundle }
  | { status: "missing" }
  | { status: "error"; message: string };

/** get_document says 'Document not found' for both a missing row and no access. */
function isNotFound(err: unknown): boolean {
  return /not found|invalid input syntax/i.test(getErrorMessage(err));
}

type FetchResult = { ok: true; bundle: DocumentBundle } | { ok: false; missing: boolean; message: string };

async function fetchBundle(id: string): Promise<FetchResult> {
  try {
    return { ok: true, bundle: await getDocument(id) };
  } catch (err) {
    return { ok: false, missing: isNotFound(err), message: getErrorMessage(err) };
  }
}

function hasUnseenAssignment(bundle: DocumentBundle): boolean {
  return bundle.assignments.some((a) => a.status === "pending" && isMyAssignment(a, bundle.me));
}

function relative(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : formatDistanceToNow(at, { addSuffix: true });
}

function BackLink() {
  return (
    <Link
      href="/documents"
      className="inline-flex items-center gap-1 rounded text-sm text-muted-foreground hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none print:hidden"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      Documents
    </Link>
  );
}

export function DocumentDetail({ id, user }: { id: string; user: SessionUser }) {
  const validId = UUID_RE.test(id);
  const [state, setState] = useState<LoadState>(validId ? { status: "loading" } : { status: "missing" });
  const [today, setToday] = useState(() => todayIn(null));
  const [holidays, setHolidays] = useState<ReadonlySet<string>>(() => new Set());
  const [printing, setPrinting] = useState(false);
  const seenMarked = useRef(false);
  const latestLoad = useRef(0);
  const shown = useRef(false);

  /** Shows a fetch result unless a newer fetch started; a failed refresh of a shown page is a toast. */
  const apply = useCallback((ticket: number, result: FetchResult) => {
    if (ticket !== latestLoad.current) return;
    if (result.ok) {
      shown.current = true;
      setState({ status: "ready", bundle: result.bundle });
    } else if (result.missing) {
      setState({ status: "missing" });
    } else if (shown.current) {
      toast.error(result.message);
    } else {
      setState({ status: "error", message: result.message });
    }
  }, []);

  /** Refetches while the current page stays on screen. */
  const reload = useCallback(() => {
    if (!validId) return;
    const ticket = ++latestLoad.current;
    void fetchBundle(id).then((result) => apply(ticket, result));
  }, [apply, id, validId]);

  const retry = () => {
    setState({ status: "loading" });
    reload();
  };

  // the first load (state starts as "loading")
  useEffect(() => {
    if (!validId) return;
    const ticket = ++latestLoad.current;
    void fetchBundle(id).then((result) => apply(ticket, result));
  }, [apply, id, validId]);

  // the company's time zone and holidays drive the deadline chips
  useEffect(() => {
    let cancelled = false;
    Promise.all([getMyOrg().catch(() => null), listHolidays().catch(() => [])]).then(([org, rows]) => {
      if (cancelled) return;
      setToday(todayIn(org?.org.timezone));
      setHolidays(holidaySet(rows));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // opening the document counts as seeing my assignments on it (once per visit)
  const bundle = state.status === "ready" ? state.bundle : null;
  useEffect(() => {
    if (!bundle || seenMarked.current || !hasUnseenAssignment(bundle)) return;
    seenMarked.current = true;
    markMyAssignmentsSeen(id)
      .then((count) => {
        if (count > 0) reload();
      })
      .catch(() => {
        // not critical: the assignment stays "not seen" until the next visit
      });
  }, [bundle, id, reload]);

  const print = async () => {
    if (printing) return;
    setPrinting(true);
    try {
      await logDocumentAccess(id, "print");
    } catch (err) {
      toast.error(`Could not record the print: ${getErrorMessage(err)}`);
      return;
    } finally {
      setPrinting(false);
    }
    window.print();
  };

  if (state.status === "loading") {
    return (
      <div className="flex justify-center py-16" role="status">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="sr-only">Loading document…</span>
      </div>
    );
  }

  if (state.status === "missing" || state.status === "error") {
    return (
      <div className="mx-auto max-w-xl space-y-4 py-12 text-center">
        <p className="text-sm text-muted-foreground">
          {state.status === "missing"
            ? "This document does not exist or you do not have access."
            : state.message}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          {state.status === "error" && (
            <Button variant="outline" onClick={retry}>
              Try again
            </Button>
          )}
          <Link href="/documents" className={buttonVariants({ variant: state.status === "error" ? "ghost" : "outline" })}>
            <ArrowLeft aria-hidden="true" />
            Back to Documents
          </Link>
        </div>
      </div>
    );
  }

  const { bundle: data } = state;
  const doc = data.document;

  return (
    <div className="mx-auto max-w-6xl space-y-6 print:max-w-none print:space-y-4">
      <header className="space-y-3">
        <BackLink />
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0 space-y-2">
            <p className="text-sm font-medium text-muted-foreground">{formatNumberLabel(doc)}</p>
            <h1 className="text-xl font-semibold tracking-tight break-words sm:text-2xl">{doc.subject}</h1>
            <div className="flex flex-wrap gap-1.5">
              <DirectionBadge direction={doc.direction} />
              <StatusBadge status={doc.status} />
              <UrgencyBadge urgency={doc.urgency} />
              <ConfidentialityBadge confidentiality={doc.confidentiality} />
              <DueBadge due={doc.due_date} today={today} status={doc.status} holidays={holidays} />
            </div>
            <p className="text-xs text-muted-foreground">
              Created by {doc.created_by_name || "a former member"}
              {doc.created_at && (
                <>
                  {" · "}
                  <time dateTime={doc.created_at}>{relative(doc.created_at)}</time>
                </>
              )}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2 print:hidden">
            <DocumentActions bundle={data} onChanged={reload} />
            <Button variant="outline" onClick={() => void print()} disabled={printing}>
              {printing ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Printer aria-hidden="true" />}
              Print
            </Button>
          </div>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-3 print:block print:space-y-4">
        <div className="min-w-0 space-y-6 lg:col-span-2 print:space-y-4">
          <DocumentProfile bundle={data} />
          <DocumentFiles
            documentId={doc.id}
            files={data.files}
            status={doc.status}
            canEdit={data.me.can_edit}
            userId={user.id}
            onChanged={reload}
          />
          <DocumentAssignments assignments={data.assignments} today={today} holidays={holidays} />
          <DocumentApprovals bundle={data} />
          <DocumentOpinions bundle={data} onChanged={reload} />
        </div>
        <aside className="min-w-0 space-y-6" aria-label="History">
          <DocumentTimeline events={data.events} />
        </aside>
      </div>
    </div>
  );
}
