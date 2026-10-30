// Document number and notation (số, ký hiệu) rendering. renderNotation is the
// TypeScript twin of SQL doc_render_notation in 202608280036_documents_core.sql:
// both are tested against the same case table, so a preview in the UI shows
// exactly what issuing will store.

import type { Direction } from "./types.ts";

export type NotationParts = {
  n: number;
  /** doc type abbreviation, e.g. "QĐ"; empty for công văn */
  type?: string | null;
  /** company code */
  org?: string | null;
  /** drafting department code */
  dept?: string | null;
  year: number;
};

export const DEFAULT_NOTATION_TEMPLATE = "{n}/{type}-{org}";
export const DEFAULT_CONG_VAN_TEMPLATE = "{n}/{org}-{dept}";

/** "1" → "01", "123" → "123": at least two digits. */
export function padNumber(n: number): string {
  const s = String(n);
  return s.length >= 2 ? s : s.padStart(2, "0");
}

/**
 * Fills {n} (zero-padded to 2), {type}, {org}, {dept} and {yyyy}, then
 * removes the separators an empty token leaves behind:
 *   runs of '-' become one '-', a '-' next to '/' goes, runs of '/' become one
 *   '/', and leading/trailing '-' or '/' are trimmed.
 * ('{n}/{type}-{org}', 2, '', 'ABC') → '02/ABC'; ('{n}/{org}-{dept}', 5, '', 'ABC', '') → '05/ABC'.
 */
export function renderNotation(template: string, parts: NotationParts): string {
  const filled = template
    .split("{n}").join(padNumber(parts.n))
    .split("{type}").join(parts.type ?? "")
    .split("{org}").join(parts.org ?? "")
    .split("{dept}").join(parts.dept ?? "")
    .split("{yyyy}").join(String(parts.year));
  return filled
    .replace(/-{2,}/g, "-")
    .replace(/\/-+/g, "/")
    .replace(/-+\//g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^[-/]+|[-/]+$/g, "");
}

/**
 * Short number label for lists and headers:
 * issued outgoing/internal → 'Số: 15/QĐ-ABC', registered incoming → 'Đến số 12',
 * anything not numbered yet → 'Draft'.
 */
export function formatNumberLabel(doc: {
  direction: Direction;
  notation?: string | null;
  number?: number | null;
  arrival_number?: number | null;
}): string {
  if (doc.direction === "incoming") {
    return doc.arrival_number != null ? `Đến số ${doc.arrival_number}` : "Draft";
  }
  if (doc.notation) return `Số: ${doc.notation}`;
  if (doc.number != null) return `Số: ${padNumber(doc.number)}`;
  return "Draft";
}
