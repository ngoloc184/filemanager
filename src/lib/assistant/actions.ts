// File-management tools the assistant may propose (framework-free).
//
// Every write is a two-step operation: the chat answer only *proposes* an
// action (shown to the user with its exact scope) together with a signed,
// short-lived token; nothing changes until the user presses "Xác nhận". The
// action route then re-checks the session user and executes it with the
// user's own database permissions. Deleting, making files public and bulk
// permission changes are never available through the assistant, and nothing
// written inside a document can trigger an action.

import type { SavedFind } from "./context.ts";
import type { ExportFormat } from "./export.ts";

export type ExportSource =
  | { kind: "compare"; fileIds: string[]; topic: string[] }
  | { kind: "find"; find: SavedFind }
  | { kind: "summary"; fileId: string }
  | { kind: "ask"; question: string; fileIds: string[] };

export type ActionSpec =
  | { kind: "create_folder"; name: string; parentId: string | null }
  | { kind: "rename_file"; fileId: string; name: string }
  | { kind: "move_file"; fileId: string; folderId: string | null }
  | { kind: "share_file"; fileId: string; email: string; role: "viewer" | "editor" }
  | { kind: "create_export"; format: ExportFormat; title: string; source: ExportSource };

export type PendingAction = {
  /** an assistant action kind, or "agent:<tool>" for agent tools */
  kind: ActionSpec["kind"] | `agent:${string}`;
  title: string;
  /** exact scope shown before confirmation */
  summary: string;
  params: Record<string, unknown>;
  token: string;
  warning?: string;
};

export type ActionResult = { ok: true; message: string; fileId?: string; folderId?: string; openUrl?: string } | { ok: false; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

/** File/folder names: 1–200 chars, no path separators or control characters. */
export function cleanName(raw: string): string | null {
  const name = raw
    .normalize("NFC")
    .replace(/^["“”'‘’\s]+|["“”'‘’\s.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!name || name.length > 200 || /[\\/\u0000-\u001F<>:*?|"]/.test(name) || name === "." || name === "..") return null;
  return name;
}

export function isEmail(value: string): boolean {
  return EMAIL.test(value);
}

const isId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** Validates a spec coming back from a token (defense in depth). */
export function validateSpec(value: unknown): ActionSpec | null {
  if (!value || typeof value !== "object") return null;
  const s = value as Record<string, unknown>;
  switch (s.kind) {
    case "create_folder": {
      const name = typeof s.name === "string" ? cleanName(s.name) : null;
      return name && (s.parentId === null || isId(s.parentId)) ? { kind: "create_folder", name, parentId: (s.parentId as string | null) ?? null } : null;
    }
    case "rename_file": {
      const name = typeof s.name === "string" ? cleanName(s.name) : null;
      return name && isId(s.fileId) ? { kind: "rename_file", fileId: s.fileId, name } : null;
    }
    case "move_file":
      return isId(s.fileId) && (s.folderId === null || isId(s.folderId))
        ? { kind: "move_file", fileId: s.fileId, folderId: (s.folderId as string | null) ?? null }
        : null;
    case "share_file":
      return isId(s.fileId) && typeof s.email === "string" && isEmail(s.email) && (s.role === "viewer" || s.role === "editor")
        ? { kind: "share_file", fileId: s.fileId, email: s.email.toLowerCase(), role: s.role }
        : null;
    case "create_export": {
      if (!["xlsx", "csv", "md", "txt"].includes(s.format as string) || typeof s.title !== "string") return null;
      const src = s.source as Record<string, unknown> | undefined;
      if (!src || typeof src !== "object") return null;
      const ids = (v: unknown, max: number) => (Array.isArray(v) ? v.filter(isId).slice(0, max) : []);
      let source: ExportSource | null = null;
      if (src.kind === "compare" && ids(src.fileIds, 3).length >= 2) {
        source = { kind: "compare", fileIds: ids(src.fileIds, 3), topic: Array.isArray(src.topic) ? src.topic.filter((t): t is string => typeof t === "string").slice(0, 8) : [] };
      } else if (src.kind === "summary" && isId(src.fileId)) {
        source = { kind: "summary", fileId: src.fileId };
      } else if (src.kind === "ask" && typeof src.question === "string") {
        source = { kind: "ask", question: src.question.slice(0, 300), fileIds: ids(src.fileIds, 8) };
      } else if (src.kind === "find" && src.find && typeof src.find === "object") {
        source = { kind: "find", find: src.find as SavedFind };
      }
      return source ? { kind: "create_export", format: s.format as ExportFormat, title: s.title.slice(0, 120), source } : null;
    }
    default:
      return null;
  }
}
