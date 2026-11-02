// Register books (sổ đăng ký văn bản) for print and CSV: the columns of
// Decree 30/2020 Phụ lục IV and the rows of list_register_entries
// (202608280039_document_registers.sql). Pure: no Supabase imports.
//
// [Unverified] The header wording follows the task spec's reading of Phụ lục
// IV (mẫu sổ đăng ký văn bản đến / đi); it has not been checked word for word
// against the official text of the Decree.

import { DEFAULT_ORG_TIME_ZONE } from "./deadlines.ts";
import { statusLabel } from "./labels.ts";
import type { Direction } from "./types.ts";

/** One printed column; `kind: "date"` cells print as dd/MM/yyyy. */
export type RegisterColumn = { key: string; header: string; kind?: "date" };

/** list_register_entries row of an incoming register (văn bản đến). */
export type IncomingRegisterEntry = {
  id: string;
  /** false: the caller cannot read the document; text fields are null */
  readable: boolean;
  arrival_date: string | null;
  arrival_number: number | null;
  issuing_org_name: string | null;
  notation: string | null;
  issued_date: string | null;
  type_name: string | null;
  /** 'Restricted document' when not readable */
  subject: string;
  receiver: string | null;
  transferred_at: string | null;
  /** the status key */
  note: string | null;
};

/** list_register_entries row of an outgoing or internal register. */
export type OutgoingRegisterEntry = {
  id: string;
  readable: boolean;
  number: number | null;
  notation: string | null;
  issued_date: string | null;
  type_name: string | null;
  subject: string;
  signer: string | null;
  recipients: string | null;
  filed_unit: string | null;
  copies: number | null;
  sent_at: string | null;
  note: string | null;
};

export type RegisterEntry = IncomingRegisterEntry | OutgoingRegisterEntry;

/** Mẫu sổ đăng ký văn bản đến (10 columns). */
export const INCOMING_REGISTER_COLUMNS: readonly RegisterColumn[] = [
  { key: "arrival_date", header: "Ngày đến", kind: "date" },
  { key: "arrival_number", header: "Số đến" },
  { key: "issuing_org_name", header: "Tác giả" },
  { key: "notation", header: "Số, ký hiệu" },
  { key: "issued_date", header: "Ngày tháng văn bản", kind: "date" },
  { key: "type_subject", header: "Tên loại và trích yếu nội dung" },
  { key: "receiver", header: "Đơn vị hoặc người nhận" },
  { key: "transferred_at", header: "Ngày chuyển", kind: "date" },
  { key: "signature", header: "Ký nhận" },
  { key: "note", header: "Ghi chú" },
];

/** Mẫu sổ đăng ký văn bản đi (10 columns); internal registers use it too. */
export const OUTGOING_REGISTER_COLUMNS: readonly RegisterColumn[] = [
  { key: "notation", header: "Số, ký hiệu văn bản" },
  { key: "issued_date", header: "Ngày tháng văn bản", kind: "date" },
  { key: "type_subject", header: "Tên loại và trích yếu nội dung" },
  { key: "signer", header: "Người ký" },
  { key: "recipients", header: "Nơi nhận văn bản" },
  { key: "filed_unit", header: "Đơn vị, người nhận bản lưu" },
  { key: "copies", header: "Số lượng bản" },
  { key: "sent_at", header: "Ngày chuyển", kind: "date" },
  { key: "signature", header: "Ký nhận" },
  { key: "note", header: "Ghi chú" },
];

export function registerColumns(direction: Direction): readonly RegisterColumn[] {
  return direction === "incoming" ? INCOMING_REGISTER_COLUMNS : OUTGOING_REGISTER_COLUMNS;
}

const TITLES: Record<Direction, string> = {
  incoming: "SỔ ĐĂNG KÝ VĂN BẢN ĐẾN",
  outgoing: "SỔ ĐĂNG KÝ VĂN BẢN ĐI",
  internal: "SỔ ĐĂNG KÝ VĂN BẢN NỘI BỘ",
};

/** 'SỔ ĐĂNG KÝ VĂN BẢN ĐẾN — Năm 2026'. */
export function registerTitle(register: { direction: Direction; year: number }): string {
  return `${TITLES[register.direction]} — Năm ${register.year}`;
}

/**
 * Flat printable rows: 'Tên loại và trích yếu' joins type and subject, the
 * status key becomes its label, 'Ký nhận' stays blank for a pen signature.
 */
export function registerRows(entries: readonly RegisterEntry[]): Record<string, unknown>[] {
  return entries.map((entry) => ({
    ...entry,
    type_subject: [entry.type_name, entry.subject].filter(Boolean).join(": "),
    note: entry.note ? statusLabel(entry.note) : "",
    signature: "",
  }));
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/**
 * dd/MM/yyyy. A 'yyyy-mm-dd' day is printed as it is; a timestamp (ISO or
 * Postgres text) or Date is shown as the day in `timeZone`. Anything else is
 * returned unchanged; empty values give ''.
 */
export function formatRegisterDate(
  value: unknown,
  timeZone: string = DEFAULT_ORG_TIME_ZONE
): string {
  if (value == null || value === "") return "";
  if (typeof value === "string") {
    const day = DAY_RE.exec(value);
    if (day) return `${day[3]}/${day[2]}/${day[1]}`;
    if (!TIMESTAMP_RE.test(value)) return value;
  }
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  const format = (zone: string) => {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("day")}/${get("month")}/${get("year")}`;
  };
  try {
    return format(timeZone || DEFAULT_ORG_TIME_ZONE);
  } catch {
    return format(DEFAULT_ORG_TIME_ZONE);
  }
}

// Spreadsheet formula injection: a cell starting with = + @ (or a tab / CR,
// or '-' followed by something other than a space or digit) is prefixed
// with ' so Excel shows it as text. '- Như trên' and '-5' stay as they are.
const FORMULA_RE = /^(?:[=+@\t\r]|-(?![\s\d]))/;

function csvCell(text: string): string {
  const safe = FORMULA_RE.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function cellText(value: unknown, column: RegisterColumn, timeZone: string): string {
  if (column.kind === "date") return formatRegisterDate(value, timeZone);
  if (value == null) return "";
  if (value instanceof Date) return formatRegisterDate(value, timeZone);
  if (Array.isArray(value)) return value.map((v) => (v == null ? "" : String(v))).join(", ");
  return String(value);
}

/**
 * RFC 4180 CSV (CRLF line ends, quotes doubled, fields with a comma, quote
 * or line break quoted) with a UTF-8 BOM so Excel opens Vietnamese text
 * correctly. Date columns print as dd/MM/yyyy in `timeZone`.
 */
export function toCsv(
  columns: readonly RegisterColumn[],
  rows: readonly Record<string, unknown>[],
  timeZone: string = DEFAULT_ORG_TIME_ZONE
): string {
  const lines = [columns.map((c) => csvCell(c.header)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => csvCell(cellText(row[c.key], c, timeZone))).join(","));
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}
