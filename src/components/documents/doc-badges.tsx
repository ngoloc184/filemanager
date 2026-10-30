"use client";

import type { ComponentProps } from "react";
import {
  AlarmClock,
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUpFromLine,
  Flame,
  Lock,
  Zap,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { dueState, formatDay } from "@/lib/documents/deadlines";
import {
  CONFIDENTIALITY_LABELS,
  DIRECTION_LABELS,
  URGENCY_LABELS,
  statusLabel,
  statusTone,
  type StatusTone,
} from "@/lib/documents/labels";
import {
  isFinalStatus,
  type Confidentiality,
  type Direction,
  type DocumentStatus,
  type Urgency,
} from "@/lib/documents/types";

// Small status chips for document lists, headers and the inbox. Colours come
// from the theme tokens (warning / success / destructive / primary), so they
// follow light and dark mode; every chip carries text, never colour alone.

const TONE_CLASSES: Record<StatusTone, string> = {
  neutral: "bg-muted text-muted-foreground",
  info: "bg-primary/10 text-primary dark:bg-primary/20",
  warning: "bg-warning/15 text-amber-800 dark:bg-warning/20 dark:text-amber-200",
  success: "bg-success/15 text-emerald-700 dark:bg-success/20 dark:text-emerald-300",
  danger: "bg-destructive/10 text-destructive dark:bg-destructive/20",
};

function ToneBadge({
  tone,
  className,
  ...props
}: ComponentProps<typeof Badge> & { tone: StatusTone }) {
  return <Badge variant="secondary" className={cn(TONE_CLASSES[tone], className)} {...props} />;
}

export function StatusBadge({ status, className }: { status: DocumentStatus | string; className?: string }) {
  return (
    <ToneBadge tone={statusTone(status)} className={className}>
      {statusLabel(status)}
    </ToneBadge>
  );
}

/** Nothing for normal urgency; khẩn / thượng khẩn amber, hỏa tốc red. */
export function UrgencyBadge({ urgency, className }: { urgency: Urgency | string | null | undefined; className?: string }) {
  if (!urgency || urgency === "normal") return null;
  const label = URGENCY_LABELS[urgency as Urgency] ?? urgency;
  const Icon = urgency === "hoa_toc" ? Flame : Zap;
  return (
    <ToneBadge tone={urgency === "hoa_toc" ? "danger" : "warning"} className={className}>
      <Icon data-icon="inline-start" aria-hidden="true" />
      {label}
    </ToneBadge>
  );
}

/**
 * Deadline chip: Overdue / Due today / Due soon / Due <date>. Hidden without a
 * deadline and once the document is finished (FINAL_STATUSES).
 */
export function DueBadge({
  due,
  today,
  status,
  holidays,
  className,
}: {
  due: string | null | undefined;
  today: string;
  status?: DocumentStatus | string | null;
  holidays?: ReadonlySet<string>;
  className?: string;
}) {
  if (!due || isFinalStatus(status)) return null;
  let state: ReturnType<typeof dueState>;
  try {
    state = dueState(due, today, holidays);
  } catch {
    return null; // not a yyyy-mm-dd date: show nothing rather than break the list
  }
  if (!state) return null;
  const date = formatDay(due);
  const { tone, text }: { tone: StatusTone; text: string } =
    state === "overdue"
      ? { tone: "danger", text: `Overdue (Quá hạn) · ${date}` }
      : state === "due_today"
        ? { tone: "warning", text: "Due today (Đến hạn hôm nay)" }
        : state === "due_soon"
          ? { tone: "warning", text: `Due soon · ${date}` }
          : { tone: "neutral", text: `Due ${date}` };
  return (
    <ToneBadge tone={tone} className={className} title={`Deadline (Hạn xử lý): ${date}`}>
      <AlarmClock data-icon="inline-start" aria-hidden="true" />
      {text}
    </ToneBadge>
  );
}

const DIRECTION_ICONS = {
  incoming: ArrowDownToLine,
  outgoing: ArrowUpFromLine,
  internal: ArrowLeftRight,
} as const;

export function DirectionBadge({ direction, className }: { direction: Direction; className?: string }) {
  const Icon = DIRECTION_ICONS[direction] ?? ArrowLeftRight;
  return (
    <Badge variant="outline" className={className}>
      <Icon data-icon="inline-start" aria-hidden="true" />
      {DIRECTION_LABELS[direction] ?? direction}
    </Badge>
  );
}

/** Nothing for normal; internal neutral, return-after-reading amber, confidential red. */
export function ConfidentialityBadge({
  confidentiality,
  className,
}: {
  confidentiality: Confidentiality | string | null | undefined;
  className?: string;
}) {
  if (!confidentiality || confidentiality === "normal") return null;
  const tone: StatusTone =
    confidentiality === "confidential" ? "danger" : confidentiality === "restricted" ? "warning" : "neutral";
  return (
    <ToneBadge tone={tone} className={className}>
      <Lock data-icon="inline-start" aria-hidden="true" />
      {CONFIDENTIALITY_LABELS[confidentiality as Confidentiality] ?? confidentiality}
    </ToneBadge>
  );
}
