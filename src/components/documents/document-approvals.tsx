"use client";

import { useState } from "react";
import { format } from "date-fns";
import {
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleSlash,
  CircleX,
  Clock,
  Undo2,
  type LucideIcon,
} from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { chainProgressLabel } from "@/lib/documents/outgoing";
import { STEP_KIND_LABELS, stepStatusLabel } from "@/lib/documents/labels";
import type { ApprovalStep, DocumentBundle, StepStatus } from "@/lib/documents/types";
import { cn } from "@/lib/utils";

// The approval chain (luồng trình duyệt) of an outgoing or internal document,
// one block per revision: the current one open, returned ones collapsed.
// Steps that share a step number run in parallel and sit side by side.

const STATUS_STYLE: Record<StepStatus, { icon: LucideIcon; className: string }> = {
  waiting: { icon: Circle, className: "text-muted-foreground" },
  pending: { icon: Clock, className: "text-amber-700 dark:text-amber-300" },
  approved: { icon: CircleCheck, className: "text-emerald-700 dark:text-emerald-300" },
  returned: { icon: Undo2, className: "text-amber-700 dark:text-amber-300" },
  rejected: { icon: CircleX, className: "text-destructive" },
  skipped: { icon: CircleSlash, className: "text-muted-foreground" },
};

type Revision = { revision: number; groups: { step_no: number; steps: ApprovalStep[] }[]; outcome: string };

function revisions(steps: readonly ApprovalStep[]): Revision[] {
  const byRevision = new Map<number, Map<number, ApprovalStep[]>>();
  for (const step of steps) {
    let groups = byRevision.get(step.revision);
    if (!groups) byRevision.set(step.revision, (groups = new Map()));
    const list = groups.get(step.step_no);
    if (list) list.push(step);
    else groups.set(step.step_no, [step]);
  }
  return [...byRevision.entries()]
    .sort(([a], [b]) => b - a)
    .map(([revision, groups]) => {
      const all = [...groups.values()].flat();
      const outcome = all.some((s) => s.status === "returned")
        ? "returned"
        : all.some((s) => s.status === "rejected")
          ? "rejected"
          : "";
      return {
        revision,
        outcome,
        groups: [...groups.entries()].sort(([a], [b]) => a - b).map(([step_no, list]) => ({ step_no, steps: list })),
      };
    });
}

function StepCard({ step }: { step: ApprovalStep }) {
  const style = STATUS_STYLE[step.status] ?? STATUS_STYLE.waiting;
  const Icon = style.icon;
  const actedAt = step.acted_at ? new Date(step.acted_at) : null;
  return (
    <div
      className={cn(
        "min-w-0 flex-1 rounded-lg border bg-background p-3 print:break-inside-avoid",
        step.status === "pending" && "border-amber-500/50"
      )}
    >
      <div className="flex items-start gap-2">
        <Icon className={cn("mt-0.5 size-4 shrink-0", style.className)} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">
            {STEP_KIND_LABELS[step.kind] ?? step.kind}
            {!step.required && " · optional"}
          </p>
          <p className="font-medium break-words">{step.approver_name || "Former member"}</p>
          <p className={cn("text-xs font-medium", style.className)}>
            {stepStatusLabel(step.kind, step.status)}
            {actedAt && !Number.isNaN(actedAt.getTime()) && (
              <span className="font-normal text-muted-foreground"> · {format(actedAt, "dd/MM/yyyy HH:mm")}</span>
            )}
          </p>
          {step.comment && <p className="mt-1.5 text-sm whitespace-pre-wrap">{step.comment}</p>}
          {step.kind === "sign" && step.status === "approved" && (
            <p className="mt-1.5 text-xs text-muted-foreground">
              E-approval in this system, not a digital signature (chữ ký số).
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function RevisionSteps({ revision }: { revision: Revision }) {
  return (
    <ol className="space-y-2">
      {revision.groups.map((group, index) => (
        <li key={group.step_no} className="flex gap-2">
          <span
            className="mt-2.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium"
            aria-label={`Step ${index + 1}`}
          >
            {index + 1}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row">
            {group.steps.map((step) => (
              <StepCard key={step.id} step={step} />
            ))}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function DocumentApprovals({ bundle }: { bundle: DocumentBundle }) {
  const [openOld, setOpenOld] = useState<ReadonlySet<number>>(new Set());
  const doc = bundle.document;
  if (doc.direction === "incoming") return null;

  const all = revisions(bundle.approval_steps);
  const progress = chainProgressLabel(bundle);
  // the current revision is open; earlier ones (returned, rejected) start collapsed
  const latest = all.find((r) => r.revision === doc.revision) ?? null;
  const older = all.filter((r) => r !== latest);

  const toggle = (revision: number) =>
    setOpenOld((current) => {
      const next = new Set(current);
      if (next.has(revision)) next.delete(revision);
      else next.add(revision);
      return next;
    });

  return (
    <Card className="print:shadow-none print:ring-0">
      <CardHeader>
        <h2 className="font-heading text-base font-medium">Approval (Trình duyệt)</h2>
        {progress && <p className="text-sm text-muted-foreground">{progress}</p>}
      </CardHeader>
      <CardContent className="space-y-4">
        {!latest && (
          <p className="text-sm text-muted-foreground">
            {older.length > 0 ? "No approval steps for this revision yet." : "No approval steps yet."}
          </p>
        )}
        {latest && (
          <section aria-label={`Revision ${latest.revision}`} className="space-y-2">
            {older.length > 0 && (
              <h3 className="text-sm font-medium">
                Revision {latest.revision}
                {latest.outcome && ` (${latest.outcome})`}
              </h3>
            )}
            <RevisionSteps revision={latest} />
          </section>
        )}
        {older.map((rev) => {
          const open = openOld.has(rev.revision);
          const panelId = `approval-revision-${rev.revision}`;
          return (
            <section key={rev.revision} className={cn("print:hidden", latest && "border-t pt-3")}>
              <button
                type="button"
                className="flex items-center gap-1 rounded text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => toggle(rev.revision)}
              >
                {open ? <ChevronDown className="size-4" aria-hidden="true" /> : <ChevronRight className="size-4" aria-hidden="true" />}
                Revision {rev.revision}
                {rev.outcome && ` (${rev.outcome})`}
              </button>
              {open && (
                <div id={panelId} className="mt-2">
                  <RevisionSteps revision={rev} />
                </div>
              )}
            </section>
          );
        })}
      </CardContent>
    </Card>
  );
}
