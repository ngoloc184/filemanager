// Offboarding rules and copy. Pure: no React or Supabase imports, so they run
// in node:test, the API route and the client. The database repeats every
// check (202608280038_offboarding.sql); these only give fast feedback.

import { formatBytes } from "./utils.ts";

/** What offboarding_preview(user) returns: counts of what would move. */
export type OffboardingPreview = {
  files: number;
  folders: number;
  bytes: number;
  open_assignments: number;
  pending_steps: number;
  presented_documents: number;
  draft_documents?: number;
  headed_departments: number;
  owned_chat_groups: number;
  register_roles: number;
  dossiers: number;
};

/** What offboard_member(user, successor) returns: counts of what moved. */
export type OffboardingResult = {
  files: number;
  folders: number;
  renamed_folders: number;
  shares_removed: number;
  chat_groups: number;
  assignments: number;
  approval_steps: number;
  skipped_steps: number;
  presented_documents: number;
  draft_documents: number;
  departments: number;
  register_roles: number;
  dossiers: number;
  push_subscriptions: number;
};

/** Body of POST /api/org/offboard. */
export type OffboardRequest = { userId: string; successorId: string; blockSignIn: boolean };

/** Response of POST /api/org/offboard. */
export type OffboardResponse =
  | { ok: true; counts: OffboardingResult; banned: boolean; warning?: string }
  | { ok?: false; error: string };

/**
 * Ban length used to block sign-in (the auth API has no "forever"): about
 * 100 years. Lifted again with ban_duration 'none'.
 */
export const BAN_DURATION = "876000h";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** "1 file", "12 files"; `many` defaults to `one` + "s". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

const num = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Checklist lines for the confirm step, e.g.
 * "12 files and 3 folders (1.2 GB) will move to Carol". Zero counts are left out.
 */
export function previewLines(preview: OffboardingPreview, successorName: string): string[] {
  const to = successorName.trim() || "the successor";
  const files = num(preview.files);
  const folders = num(preview.folders);
  const bytes = num(preview.bytes);
  const lines: string[] = [];

  if (files > 0 || folders > 0) {
    const what = [files > 0 ? plural(files, "file") : null, folders > 0 ? plural(folders, "folder") : null]
      .filter(Boolean)
      .join(" and ");
    lines.push(`${what}${bytes > 0 ? ` (${formatBytes(bytes)})` : ""} will move to ${to}`);
  }

  const add = (n: unknown, one: string, many: string, rest: string) => {
    const count = num(n);
    if (count > 0) lines.push(`${plural(count, one, many)} ${rest}`);
  };
  add(preview.open_assignments, "open document task", "open document tasks", `will be reassigned to ${to}`);
  add(preview.pending_steps, "approval step", "approval steps", `will be handed to ${to}`);
  add(
    preview.presented_documents,
    "document awaiting their decision",
    "documents awaiting their decision",
    `will be presented to ${to}`
  );
  add(preview.draft_documents, "draft document", "draft documents", `will move to ${to}`);
  add(
    preview.headed_departments,
    "department they head",
    "departments they head",
    `will be headed by ${to}`
  );
  add(
    preview.owned_chat_groups,
    "chat group they own",
    "chat groups they own",
    `will get a new owner (${to} if they are in the group, else a group admin)`
  );
  add(preview.register_roles, "register (sổ) role", "register (sổ) roles", `will move to ${to}`);
  add(preview.dossiers, "dossier (hồ sơ)", "dossiers (hồ sơ)", `will move to ${to}`);
  return lines;
}

/** Summary lines after a successful offboarding. Zero counts are left out. */
export function resultLines(result: OffboardingResult, successorName: string): string[] {
  const to = successorName.trim() || "the successor";
  const lines: string[] = [];
  const files = num(result.files);
  const folders = num(result.folders);
  if (files > 0 || folders > 0) {
    const what = [files > 0 ? plural(files, "file") : null, folders > 0 ? plural(folders, "folder") : null]
      .filter(Boolean)
      .join(" and ");
    lines.push(`${what} moved to ${to}`);
  }
  const add = (n: unknown, one: string, many: string, rest: string) => {
    const count = num(n);
    if (count > 0) lines.push(`${plural(count, one, many)} ${rest}`);
  };
  add(result.renamed_folders, "folder was", "folders were", `renamed to avoid a name clash ("… (from …)")`);
  add(result.assignments, "document task", "document tasks", "reassigned");
  add(result.approval_steps, "approval step", "approval steps", "handed over");
  add(result.skipped_steps, "approval step", "approval steps", `skipped (${to} already had it)`);
  add(result.presented_documents, "document", "documents", `now presented to ${to}`);
  add(result.draft_documents, "draft document", "draft documents", "moved");
  add(result.departments, "department", "departments", `now headed by ${to}`);
  add(result.chat_groups, "chat group", "chat groups", "got a new owner");
  add(result.register_roles, "register (sổ) role", "register (sổ) roles", "moved");
  add(result.dossiers, "dossier (hồ sơ)", "dossiers (hồ sơ)", "moved");
  add(result.shares_removed, "share", "shares", "no longer needed were removed");
  add(result.push_subscriptions, "device", "devices", "stopped receiving notifications");
  return lines;
}

/** Form check before calling the server; null when the choice is valid. */
export function validateOffboard(
  from: string | null | undefined,
  to: string | null | undefined,
  me: string | null | undefined
): string | null {
  if (!from) return "Pick the person who is leaving";
  if (me && from === me) return "You cannot offboard yourself";
  if (!to) return "Pick a successor";
  if (to === from) return "The successor must be a different person";
  return null;
}

/**
 * Validates the JSON body of POST /api/org/offboard. blockSignIn defaults to
 * true (the safer choice) when it is missing.
 */
export function parseOffboardRequest(body: unknown): OffboardRequest | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "Invalid request" };
  }
  const b = body as Record<string, unknown>;
  if (!isUuid(b.userId)) return { error: "Pick the person who is leaving" };
  if (!isUuid(b.successorId)) return { error: "Pick a successor" };
  if (b.blockSignIn !== undefined && typeof b.blockSignIn !== "boolean") {
    return { error: "Invalid request" };
  }
  const userId = b.userId.toLowerCase();
  const successorId = b.successorId.toLowerCase();
  if (userId === successorId) return { error: "The successor must be a different person" };
  return { userId, successorId, blockSignIn: b.blockSignIn ?? true };
}
