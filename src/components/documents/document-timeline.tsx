"use client";

import { format } from "date-fns";
import {
  Archive,
  ArchiveX,
  ArrowRightLeft,
  Ban,
  BookMarked,
  CircleCheck,
  CircleX,
  Eye,
  FileMinus,
  FilePlus,
  FolderInput,
  FolderOutput,
  GitBranch,
  Hash,
  History,
  ListChecks,
  ListOrdered,
  MessageSquare,
  Paperclip,
  PencilLine,
  PenLine,
  RotateCcw,
  Send,
  SendHorizontal,
  Stamp,
  ThumbsUp,
  Undo,
  Undo2,
  UserCheck,
  UserMinus,
  UserPlus,
  UserX,
  type LucideIcon,
} from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { eventIcon, eventLabel } from "@/lib/documents/events";
import type { DocEvent } from "@/lib/documents/types";

// The append-only processing history (lịch sử xử lý) from document_events,
// oldest first, as the register and Decree 30 audit expect.

// lucide components for the names eventIcon returns (EVENT_ICON_NAMES)
const ICONS: Record<string, LucideIcon> = {
  Archive,
  ArchiveX,
  ArrowRightLeft,
  Ban,
  BookMarked,
  CircleCheck,
  CircleX,
  Eye,
  FileMinus,
  FilePlus,
  FolderInput,
  FolderOutput,
  GitBranch,
  Hash,
  History,
  ListChecks,
  ListOrdered,
  MessageSquare,
  Paperclip,
  PencilLine,
  PenLine,
  RotateCcw,
  Send,
  SendHorizontal,
  Stamp,
  ThumbsUp,
  Undo,
  Undo2,
  UserCheck,
  UserMinus,
  UserPlus,
  UserX,
};

function at(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : format(date, "dd/MM/yyyy HH:mm");
}

export function DocumentTimeline({ events }: { events: DocEvent[] }) {
  const rows = [...events].sort(
    (a, b) => (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0) || a.id - b.id
  );
  return (
    <Card className="print:shadow-none print:ring-0">
      <CardHeader>
        <h2 className="font-heading text-base font-medium">History (Lịch sử xử lý)</h2>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
        ) : (
          <ol className="relative space-y-4 before:absolute before:top-2 before:bottom-2 before:left-3 before:border-l before:content-['']">
            {rows.map((e) => {
              const Icon = ICONS[eventIcon(e.action)] ?? History;
              return (
                <li key={e.id} className="relative flex gap-3 print:break-inside-avoid">
                  <span className="relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full border bg-background">
                    <Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm break-words">{eventLabel(e)}</p>
                    <p className="text-xs text-muted-foreground">
                      {e.actor_name || (e.actor_id ? "Former member" : "System")}
                      {" · "}
                      <time dateTime={e.created_at}>{at(e.created_at)}</time>
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
