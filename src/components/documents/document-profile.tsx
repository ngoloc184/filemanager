"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { format } from "date-fns";
import { Lock, Pencil } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatDay } from "@/lib/documents/deadlines";
import { RECIPIENT_METHOD_LABELS, relationLabel } from "@/lib/documents/labels";
import { padNumber } from "@/lib/documents/numbering";
import type { DocumentBundle, DocumentDetail, Recipient, RelatedDocument } from "@/lib/documents/types";
import { RESTRICTED_DOCUMENT_LABEL } from "@/lib/documents/dossiers";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// The metadata profile (thông tin văn bản) of one document as a definition
// list. Incoming documents follow the arrival register columns (sổ đến);
// outgoing and internal ones the issuing register (sổ đi), Decree 30/2020.

type Row = { label: string; value: ReactNode };

const EMPTY = <span className="text-muted-foreground">—</span>;

function day(value: string | null | undefined): ReactNode {
  return value ? formatDay(value.slice(0, 10)) : EMPTY;
}

function timestampDay(value: string | null | undefined): ReactNode {
  if (!value) return EMPTY;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? EMPTY : format(at, "dd/MM/yyyy");
}

function plain(value: string | number | null | undefined): ReactNode {
  if (value === null || value === undefined) return EMPTY;
  const text = String(value).trim();
  return text ? text : EMPTY;
}

/** 'KT. Giám đốc – Nguyễn Văn A'; the server's signer_display when the parts are missing. */
export function signerLine(doc: DocumentDetail): string {
  const name = doc.signer_name?.trim();
  const position = doc.signer_position?.trim();
  const authority = doc.signer_authority ? `${doc.signer_authority}. ` : "";
  if (name && position) return `${authority}${position} – ${name}`;
  if (name) return `${authority}${name}`;
  return doc.signer_display?.trim() ?? "";
}

function Keywords({ keywords }: { keywords: string[] }) {
  if (keywords.length === 0) return EMPTY;
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Keywords">
      {keywords.map((k) => (
        <li key={k}>
          <Badge variant="secondary">{k}</Badge>
        </li>
      ))}
    </ul>
  );
}

function Recipients({ recipients }: { recipients: Recipient[] }) {
  if (recipients.length === 0) return EMPTY;
  return (
    <ul className="space-y-1">
      {recipients.map((r) => (
        <li key={r.id} className="flex flex-wrap items-baseline gap-x-2">
          <span>{r.name_snapshot}</span>
          <span className="text-xs text-muted-foreground">
            {RECIPIENT_METHOD_LABELS[r.method] ?? r.method}
            {r.sent_at ? ` · sent ${format(new Date(r.sent_at), "dd/MM/yyyy")}` : r.kind === "external" ? " · not sent yet" : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Related({ related }: { related: RelatedDocument[] }) {
  if (related.length === 0) return EMPTY;
  return (
    <ul className="space-y-1">
      {related.map((r) => (
        <li key={`${r.relation}:${r.id}`} className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-xs text-muted-foreground">{relationLabel(r.relation)}</span>
          {r.readable ? (
            <Link href={`/documents/${r.id}`} className="font-medium text-primary underline-offset-4 hover:underline">
              {[r.notation, r.subject].filter(Boolean).join(" – ") || "Untitled document"}
            </Link>
          ) : (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <Lock className="size-3" aria-hidden="true" />
              {RESTRICTED_DOCUMENT_LABEL}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The result of complete_document (Kết quả xử lý). Only while the document is
 * completed or archived: reopening keeps the old result_note in the row.
 */
function completionRows(doc: Pick<DocumentDetail, "status" | "completed_at" | "result_note">): Row[] {
  if (doc.status !== "completed" && doc.status !== "archived") return [];
  const note = doc.result_note?.trim();
  if (!doc.completed_at && !note) return [];
  return [
    { label: "Completed on", value: timestampDay(doc.completed_at) },
    {
      label: "Result (Kết quả xử lý)",
      value: note ? <span className="whitespace-pre-wrap">{doc.result_note}</span> : EMPTY,
    },
  ];
}

function incomingRows(bundle: DocumentBundle): Row[] {
  const doc = bundle.document;
  return [
    { label: "Arrival no. (Số đến)", value: plain(doc.arrival_number) },
    { label: "Arrival date", value: day(doc.arrival_date) },
    { label: "Number/notation (Số, ký hiệu)", value: plain(doc.notation) },
    { label: "Date of document", value: day(doc.issued_date) },
    { label: "Issuing organisation (Tác giả)", value: plain(doc.external_org_name ?? doc.issuing_org_name) },
    { label: "Type", value: plain(doc.type_name) },
    { label: "Field (Lĩnh vực)", value: plain(doc.field_name) },
    { label: "Subject (Trích yếu)", value: plain(doc.subject) },
    { label: "Signer", value: plain(signerLine(doc)) },
    { label: "Pages", value: plain(doc.page_count) },
    { label: "Due date (Hạn xử lý)", value: day(doc.due_date) },
    { label: "Presented to", value: plain(doc.presented_to_name) },
    { label: "Register", value: plain(doc.register_name) },
    ...completionRows(doc),
    ...(bundle.related.length > 0 ? [{ label: "Related documents", value: <Related related={bundle.related} /> }] : []),
    { label: "Keywords", value: <Keywords keywords={doc.keywords} /> },
    {
      label: "Description",
      value: doc.description?.trim() ? <span className="whitespace-pre-wrap">{doc.description}</span> : EMPTY,
    },
  ];
}

function outgoingRows(bundle: DocumentBundle): Row[] {
  const doc = bundle.document;
  const number = doc.notation ?? (doc.number != null ? padNumber(doc.number) : null);
  return [
    {
      label: "Number/notation (Số, ký hiệu)",
      value: number ? plain(number) : <span className="text-muted-foreground">Not issued yet</span>,
    },
    { label: "Issued date", value: doc.issued_date ? day(doc.issued_date) : timestampDay(doc.issued_at) },
    { label: "Type", value: plain(doc.type_name) },
    { label: "Field (Lĩnh vực)", value: plain(doc.field_name) },
    { label: "Subject (Trích yếu)", value: plain(doc.subject) },
    { label: "Drafting department", value: plain(doc.drafting_department_name) },
    { label: "Signer", value: plain(signerLine(doc)) },
    { label: "Copies", value: plain(doc.copies) },
    { label: "Due date for reply", value: day(doc.due_date) },
    { label: "Register", value: plain(doc.register_name) },
    { label: "Recipients (Nơi nhận)", value: <Recipients recipients={bundle.recipients} /> },
    { label: "Related documents", value: <Related related={bundle.related} /> },
    { label: "Keywords", value: <Keywords keywords={doc.keywords} /> },
  ];
}

export function DocumentProfile({ bundle }: { bundle: DocumentBundle }) {
  const doc = bundle.document;
  const rows = doc.direction === "incoming" ? incomingRows(bundle) : outgoingRows(bundle);
  return (
    <Card className="print:shadow-none print:ring-0">
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-heading text-base font-medium">Details (Thông tin văn bản)</h2>
        {bundle.me.can_edit && (
          <Link
            href={`/documents/${doc.id}/edit`}
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "print:hidden")}
          >
            <Pencil aria-hidden="true" />
            Edit details
          </Link>
        )}
      </CardHeader>
      <CardContent>
        <dl className="grid gap-x-6 gap-y-2.5 sm:grid-cols-[minmax(9rem,max-content)_1fr]">
          {rows.map((row) => (
            // gap-y only: a plain gap would also set the subgrid's column gap and
            // override the dl's gap-x-6, so long labels would touch their values.
            <div key={row.label} className="grid gap-y-0.5 sm:col-span-2 sm:grid-cols-subgrid">
              <dt className="text-xs font-medium text-muted-foreground sm:pt-0.5">{row.label}</dt>
              <dd className="min-w-0 break-words">{row.value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
