"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { FileText } from "lucide-react";
import {
  ConfidentialityBadge,
  DirectionBadge,
  DueBadge,
  StatusBadge,
  UrgencyBadge,
} from "@/components/documents/doc-badges";
import type { DocumentSearchRow } from "@/lib/documents/filters";
import {
  counterpart,
  formatDate,
  formatDocNumber,
  rowTone,
  urgencyTone,
  type RowTone,
} from "@/lib/documents/table-format";
import { cn } from "@/lib/utils";

// Inbox results: a table from 640px up, stacked cards below. Each row links
// to /documents/[id]; the subject is the focusable link, and a click anywhere
// else on a table row follows it too.

const SKELETON_ROWS = 6;

const ROW_TONE_CLASSES: Record<RowTone, string> = {
  danger: "bg-destructive/5 dark:bg-destructive/10",
  warning: "bg-warning/5 dark:bg-warning/10",
};

const STRIPE_CLASSES: Record<RowTone | "none", string> = {
  danger: "border-l-destructive",
  warning: "border-l-warning",
  none: "border-l-transparent",
};

function relativeTime(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : formatDistanceToNow(at, { addSuffix: true });
}

function documentHref(id: string): string {
  return `/documents/${encodeURIComponent(id)}`;
}

/** Left stripe by urgency; the UrgencyBadge carries the same as text. */
function stripeClass(row: DocumentSearchRow): string {
  return STRIPE_CLASSES[urgencyTone(row.urgency) ?? "none"];
}

function Updated({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={formatDate(iso)}>
      {relativeTime(iso)}
    </time>
  );
}

export function DocumentTable({
  rows,
  today,
  holidays,
  emptyMessage,
  caption,
}: {
  /** null while loading (skeleton rows) */
  rows: DocumentSearchRow[] | null;
  /** yyyy-mm-dd in the company time zone */
  today: string;
  holidays?: ReadonlySet<string>;
  emptyMessage: string;
  caption?: string;
}) {
  const router = useRouter();

  if (rows === null) return <TableSkeleton />;

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-12 text-center">
        <FileText className="size-8 text-muted-foreground/60" aria-hidden />
        <p className="text-sm text-muted-foreground" role="status">
          {emptyMessage}
        </p>
      </div>
    );
  }

  return (
    <>
      {/* phones: stacked cards */}
      <ul className="space-y-2 sm:hidden" aria-label={caption ?? "Documents"}>
        {rows.map((row) => {
          const tone = rowTone(row, today, holidays);
          return (
            <li key={row.id}>
              <Link
                href={documentHref(row.id)}
                className={cn(
                  "block rounded-xl border border-l-4 p-3 outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50",
                  stripeClass(row),
                  tone && ROW_TONE_CLASSES[tone]
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {formatDocNumber(row)}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    <Updated iso={row.updated_at} />
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-sm font-medium [overflow-wrap:anywhere]">{row.subject}</p>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {[counterpart(row), row.type_name].filter(Boolean).join(" · ")}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <StatusBadge status={row.status} />
                  <UrgencyBadge urgency={row.urgency} />
                  <DueBadge
                    due={row.my_due_date ?? row.due_date}
                    today={today}
                    status={row.status}
                    holidays={holidays}
                  />
                  <ConfidentialityBadge confidentiality={row.confidentiality} />
                </div>
              </Link>
            </li>
          );
        })}
      </ul>

      {/* 640px and up: table */}
      <div className="hidden overflow-x-auto rounded-xl border sm:block">
        <table className="w-full min-w-[56rem] text-sm">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
            <tr className="border-b">
              <th scope="col" className="py-2 pr-2 pl-4 font-medium">
                Number
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Subject (Trích yếu)
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                From / To
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Type
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Due
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Status
              </th>
              <th scope="col" className="py-2 pr-4 pl-2 font-medium whitespace-nowrap">
                Updated
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const tone = rowTone(row, today, holidays);
              const href = documentHref(row.id);
              return (
                <tr
                  key={row.id}
                  onClick={(e) => {
                    // the subject link handles its own clicks (and new-tab clicks)
                    if ((e.target as HTMLElement).closest("a, button")) return;
                    // selecting text (e.g. to copy a number) is not a click on the row
                    if (window.getSelection()?.toString()) return;
                    router.push(href);
                  }}
                  className={cn(
                    "cursor-pointer border-b align-top transition-colors last:border-0 hover:bg-muted/50 focus-within:bg-muted/50",
                    tone && ROW_TONE_CLASSES[tone]
                  )}
                >
                  <td className={cn("border-l-4 py-3 pr-2 pl-3", stripeClass(row))}>
                    <span className="font-mono text-xs whitespace-nowrap">{formatDocNumber(row)}</span>
                    {row.direction === "incoming" && row.arrival_date && (
                      <span className="block text-xs text-muted-foreground">{formatDate(row.arrival_date)}</span>
                    )}
                    {row.direction !== "incoming" && row.issued_date && (
                      <span className="block text-xs text-muted-foreground">{formatDate(row.issued_date)}</span>
                    )}
                  </td>
                  <td className="max-w-md px-2 py-3">
                    <Link
                      href={href}
                      className="line-clamp-2 font-medium outline-none [overflow-wrap:anywhere] hover:underline focus-visible:underline focus-visible:ring-3 focus-visible:ring-ring/50 rounded-sm"
                    >
                      {row.subject}
                    </Link>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <DirectionBadge direction={row.direction} />
                      <UrgencyBadge urgency={row.urgency} />
                      <ConfidentialityBadge confidentiality={row.confidentiality} />
                    </div>
                  </td>
                  <td className="max-w-48 px-2 py-3 text-muted-foreground">
                    <span className="line-clamp-2 [overflow-wrap:anywhere]">{counterpart(row)}</span>
                  </td>
                  <td className="px-2 py-3 text-muted-foreground">{row.type_name ?? "—"}</td>
                  <td className="px-2 py-3">
                    <DueBadge
                      due={row.my_due_date ?? row.due_date}
                      today={today}
                      status={row.status}
                      holidays={holidays}
                    />
                  </td>
                  <td className="px-2 py-3">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="py-3 pr-4 pl-2 text-xs whitespace-nowrap text-muted-foreground">
                    <Updated iso={row.updated_at} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-2" role="status" aria-label="Loading documents">
      {Array.from({ length: SKELETON_ROWS }, (_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-xl border p-3" aria-hidden="true">
          <div className="h-4 w-20 shrink-0 animate-pulse rounded bg-muted" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
            <div className="h-3 w-1/3 animate-pulse rounded bg-muted/70" />
          </div>
          <div className="hidden h-5 w-24 shrink-0 animate-pulse rounded-full bg-muted sm:block" />
        </div>
      ))}
    </div>
  );
}
