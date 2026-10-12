// Short-term conversation memory (framework-free; unit tested).
//
// The chat widget sends back the context returned with the previous answer.
// It only holds file ids, search parameters and the current task; never file
// names or content. Everything is re-validated here, and every id is checked
// against the user's permissions again before it is used, so a forged or
// stale context can never reveal anything.

import { normalize } from "./text.ts";
import type { Filters } from "./intent.ts";

export const MAX_RESULTS = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SavedFind = {
  terms: string[];
  phrase: string;
  mode: "name" | "content" | "auto";
  extensions: string[] | null;
  typeLabel: string | null;
  scope: "all" | "mine" | "shared";
  after: string | null;
  before: string | null;
  dateField: "updated" | "created";
  dateLabel: string | null;
  sort: "relevance" | "updated" | "created";
};

export type Task =
  | { kind: "find" }
  | { kind: "summarize"; fileId: string }
  | { kind: "ask"; question: string; fileIds: string[] }
  | { kind: "compare"; fileIds: string[]; topic: string[] };

export type ConversationContext = {
  v: 1;
  /** File ids of the last list shown, in display order. */
  results: string[];
  /** File that "it", "this file", "file đó" refers to. */
  focus: string | null;
  lastFind: SavedFind | null;
  task: Task | null;
  turn: number;
};

export const EMPTY_CONTEXT: ConversationContext = { v: 1, results: [], focus: null, lastFind: null, task: null, turn: 0 };

const ids = (value: unknown, max: number): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((x): x is string => typeof x === "string" && UUID.test(x)))].slice(0, max) : [];
const id = (value: unknown): string | null => (typeof value === "string" && UUID.test(value) ? value : null);
const str = (value: unknown, max: number): string | null => (typeof value === "string" ? value.slice(0, max) : null);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;
const iso = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length > 40) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

function sanitizeFind(value: unknown): SavedFind | null {
  if (!value || typeof value !== "object") return null;
  const f = value as Record<string, unknown>;
  const terms = Array.isArray(f.terms)
    ? f.terms.filter((t): t is string => typeof t === "string").map((t) => t.slice(0, 40)).slice(0, 10)
    : [];
  const extensions = Array.isArray(f.extensions)
    ? f.extensions.filter((e): e is string => typeof e === "string" && /^[a-z0-9]{1,10}$/.test(e)).slice(0, 12)
    : null;
  return {
    terms,
    phrase: str(f.phrase, 200) ?? terms.join(" "),
    mode: oneOf(f.mode, ["name", "content", "auto"] as const, "auto"),
    extensions: extensions?.length ? extensions : null,
    typeLabel: str(f.typeLabel, 60),
    scope: oneOf(f.scope, ["all", "mine", "shared"] as const, "all"),
    after: iso(f.after),
    before: iso(f.before),
    dateField: oneOf(f.dateField, ["updated", "created"] as const, "updated"),
    dateLabel: str(f.dateLabel, 60),
    sort: oneOf(f.sort, ["relevance", "updated", "created"] as const, "relevance"),
  };
}

function sanitizeTask(value: unknown): Task | null {
  if (!value || typeof value !== "object") return null;
  const t = value as Record<string, unknown>;
  switch (t.kind) {
    case "find":
      return { kind: "find" };
    case "summarize": {
      const fileId = id(t.fileId);
      return fileId ? { kind: "summarize", fileId } : null;
    }
    case "ask":
      return { kind: "ask", question: str(t.question, 300) ?? "", fileIds: ids(t.fileIds, 8) };
    case "compare": {
      const fileIds = ids(t.fileIds, 3);
      const topic = Array.isArray(t.topic) ? t.topic.filter((x): x is string => typeof x === "string").slice(0, 8) : [];
      return fileIds.length >= 2 ? { kind: "compare", fileIds, topic } : null;
    }
    default:
      return null;
  }
}

/** Never trusts the client: anything malformed is dropped. */
export function sanitizeContext(value: unknown, legacyFocus?: unknown): ConversationContext {
  const c = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    v: 1,
    results: ids(c.results, MAX_RESULTS),
    focus: id(legacyFocus) ?? id(c.focus),
    lastFind: sanitizeFind(c.lastFind),
    task: sanitizeTask(c.task),
    turn: typeof c.turn === "number" && Number.isFinite(c.turn) ? Math.min(Math.max(Math.trunc(c.turn), 0), 10_000) : 0,
  };
}

export function saveFind(filters: Filters, find: { terms: string[]; phrase: string; mode: SavedFind["mode"]; sort: SavedFind["sort"] }): SavedFind {
  return {
    terms: find.terms,
    phrase: find.phrase,
    mode: find.mode,
    extensions: filters.extensions,
    typeLabel: filters.typeLabel,
    scope: filters.scope,
    after: filters.after?.toISOString() ?? null,
    before: filters.before?.toISOString() ?? null,
    dateField: filters.dateField,
    dateLabel: filters.dateLabel,
    sort: find.sort,
  };
}

export function restoreFilters(f: SavedFind): Filters {
  return {
    extensions: f.extensions,
    typeLabel: f.typeLabel,
    scope: f.scope,
    after: f.after ? new Date(f.after) : null,
    before: f.before ? new Date(f.before) : null,
    dateField: f.dateField,
    dateLabel: f.dateLabel,
  };
}

// ------------------------------------------------------------ references

const ORDINAL_WORDS: Record<string, number> = {
  nhat: 1, dau: 1, "dau tien": 1, mot: 1, first: 1,
  hai: 2, nhi: 2, second: 2,
  ba: 3, third: 3,
  tu: 4, bon: 4, fourth: 4,
  nam: 5, fifth: 5,
  sau: 6, sixth: 6,
  bay: 7, seventh: 7,
  tam: 8, eighth: 8,
  chin: 9, ninth: 9,
  muoi: 10, tenth: 10,
};

const NOUN = "(?:file|tep|tai lieu|ket qua|van ban|bao cao|hop dong|cai|muc|item|result|document|doc)";
const ORDW = "(\\d{1,2}|nhat|nhi|hai|ba|tu|bon|nam|sau|bay|tam|chin|muoi)";

// Word ordinals only after "thứ"/"số" ("file năm 2025" is a year, "từ" is "from").
const ORDINAL_RE = new RegExp(
  `\\b(?:${NOUN}\\s+(?:thu|so)\\s+${ORDW}|${NOUN}\\s+(\\d{1,2}|dau tien|cuoi cung|cuoi)|(?:cai\\s+)?thu\\s+${ORDW}|#(\\d{1,2})|(first|second|third|fourth|fifth|last)\\s+(?:file|one|result|document))\\b`,
  "g"
);
const ALL_RE =
  /\b(ca hai|ca 2|ca ba|hai file|2 file|(?:ba|3) file (?:tren|nay|do|dau|vua roi)|cac file (tren|nay|do|vua roi)|nhung file (tren|nay|do)|tat ca (cac )?(file|ket qua)( tren| nay)?|hai (hop dong|bao cao|tai lieu)( nay| tren| do)?|cac (hop dong|bao cao|tai lieu) (tren|nay|do)|both( files)?|all (of )?(them|these|those))\b/;
// "nó" only next to a verb: "nợ"/"ít" normalize to the same letters.
const PRONOUN_RE =
  /\b(file (nay|do|kia|ay|vua roi|vua tim)|tep (nay|do)|tai lieu (nay|do|kia|ay)|van ban (nay|do)|hop dong (nay|do|ay)|bao cao (nay|do|ay)|(?:tom tat|doc|mo|so sanh|chia se|doi ten|di chuyen|xoa|xem|tai|gui|xuat) no|no (noi|viet|co|de cap|ghi|nhac)|this (file|document|one)|that (file|document|one))\b/;

export type Reference =
  | { kind: "none" }
  | { kind: "ordinal"; indexes: number[]; ids: string[]; missing: number[] }
  | { kind: "all"; ids: string[] }
  | { kind: "pronoun"; id: string | null; ambiguous: boolean };

function ordinalValue(word: string, total: number): number | null {
  if (/^\d+$/.test(word)) return Number(word);
  if (word === "cuoi" || word === "cuoi cung" || word === "last") return total || null;
  return ORDINAL_WORDS[word] ?? null;
}

/** Strips the reference words so the rest can be parsed as search terms. */
export function stripReferences(n: string): string {
  return n.replace(ORDINAL_RE, " ").replace(ALL_RE, " ").replace(PRONOUN_RE, " ").replace(/\s+/g, " ").trim();
}

/** Resolves "file thứ hai", "cả hai file", "nó"… against the conversation. */
export function resolveReference(message: string, ctx: ConversationContext): Reference {
  const n = normalize(message).replace(/[?!.,;:]+/g, " ").replace(/\s+/g, " ");
  const indexes: number[] = [];
  if (!ctx.results.length) {
    // "file thứ hai" with no list to point into: ask instead of guessing
    const ord = n.match(/\b(?:file|tep|tai lieu|ket qua|cai|muc)\s+thu\s+(\d{1,2}|nhat|hai|ba|tu|nam)\b|\b(?:file|ket qua|tai lieu)\s+(dau tien|cuoi cung)\b/);
    if (ord) {
      const value = ordinalValue(ord[1] ?? (ord[2] === "dau tien" ? "dau tien" : "1"), 0) ?? 1;
      return { kind: "ordinal", indexes: [value], ids: [], missing: [value] };
    }
    return PRONOUN_RE.test(n) ? pronoun(ctx) : { kind: "none" };
  }
  for (const m of n.matchAll(ORDINAL_RE)) {
    const word = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5];
    if (!word) continue;
    const value = ordinalValue(word, ctx.results.length);
    if (value && !indexes.includes(value)) indexes.push(value);
  }
  // "thứ nhất và thứ ba", "file 1 và 3"
  const extra = n.match(/\b(?:file|thu|so)\s+(\d{1,2}|nhat|hai|ba|tu|nam)\s+(?:va|voi|,)\s+(?:file\s+|thu\s+|so\s+)?(\d{1,2}|nhat|hai|ba|tu|nam)\b/);
  if (extra) {
    for (const w of [extra[1], extra[2]]) {
      const value = ordinalValue(w, ctx.results.length);
      if (value && !indexes.includes(value)) indexes.push(value);
    }
  }
  if (indexes.length) {
    const found = indexes.filter((i) => i >= 1 && i <= ctx.results.length);
    return {
      kind: "ordinal",
      indexes,
      ids: found.map((i) => ctx.results[i - 1]),
      missing: indexes.filter((i) => i < 1 || i > ctx.results.length),
    };
  }
  if (ALL_RE.test(n)) {
    const count = /\b(ca hai|ca 2|hai file|2 file|hai (hop dong|bao cao|tai lieu)|both)\b/.test(n) ? 2 : /\b(ca ba|ba file|3 file)\b/.test(n) ? 3 : 5;
    const pool = ctx.task?.kind === "compare" ? ctx.task.fileIds : ctx.results;
    return { kind: "all", ids: pool.slice(0, count) };
  }
  if (PRONOUN_RE.test(n)) return pronoun(ctx);
  return { kind: "none" };
}

function pronoun(ctx: ConversationContext): Reference {
  if (ctx.focus) return { kind: "pronoun", id: ctx.focus, ambiguous: false };
  if (ctx.results.length === 1) return { kind: "pronoun", id: ctx.results[0], ambiguous: false };
  return { kind: "pronoun", id: null, ambiguous: ctx.results.length > 1 };
}

/** True if the message points at earlier results or files at all. */
export function hasReference(message: string): boolean {
  const n = normalize(message).replace(/[?!.,;:]+/g, " ");
  return new RegExp(ORDINAL_RE.source).test(n) || ALL_RE.test(n) || PRONOUN_RE.test(n);
}

/** Context after a list of files was shown. */
export function withResults(ctx: ConversationContext, results: string[], find: SavedFind | null): ConversationContext {
  return {
    ...ctx,
    results: results.slice(0, MAX_RESULTS),
    focus: results.length === 1 ? results[0] : null,
    lastFind: find ?? ctx.lastFind,
    task: { kind: "find" },
  };
}

/** Context after working on specific file(s). */
export function withFocus(ctx: ConversationContext, fileId: string | null, task: Task | null = null): ConversationContext {
  return { ...ctx, focus: fileId ?? ctx.focus, task: task ?? ctx.task };
}
