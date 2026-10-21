import "server-only";

// Finds the file or folder a user means: an id they picked from a list, a
// reference to earlier results ("file thứ hai", "nó"), or a name. Every query
// runs with the user's own session, so row-level security decides what can
// be found; nothing here widens access.

import { fold, isReference, resolveReference, type AgentMemory, type Choice } from "@ai-pro/agent-core";
import type { SupabaseClient } from "@supabase/supabase-js";

export type AgentCtx = {
  supabase: SupabaseClient;
  userId: string;
  /** makes a new file searchable right away (best effort, optional) */
  index?: (fileId: string) => Promise<void>;
};

export type FileHit = {
  id: string;
  name: string;
  folder_id: string | null;
  owner_id: string;
  extension: string;
  mime_type: string;
  size: number;
  updated_at: string;
  deleted_at: string | null;
  current_version_id?: string | null;
};
export type FolderHit = { id: string; name: string; parent_id: string | null; owner_id: string; deleted_at: string | null };

export type Resolved<T> =
  | { kind: "one"; item: T }
  | { kind: "many"; choices: Choice[] }
  | { kind: "none" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_COLUMNS = "id, name, folder_id, owner_id, extension, mime_type, size, updated_at, deleted_at, current_version_id";
const FOLDER_COLUMNS = "id, name, parent_id, owner_id, deleted_at";
const MAX_CHOICES = 8;

/** "file Báo cáo.pdf" -> "Báo cáo.pdf"; drops the words people put before a name. */
export function stripKind(value: string, kind: "file" | "folder"): string {
  const words =
    kind === "file"
      ? /^(?:(?:cai|mot|1|the|a)\s+)?(?:file|tep|tep tin|tai lieu|van ban|document)\s+(?:ten(?: la)?\s+|co ten\s+)?/i
      : /^(?:(?:cai|mot|1|the|a)\s+)?(?:thu muc|folder|directory)\s+(?:ten(?: la)?\s+|co ten\s+)?/i;
  // match on folded text, cut the same number of words from the original
  const folded = fold(value);
  const m = folded.match(words);
  if (!m) return value.trim();
  const drop = m[0].trim().split(/\s+/).length;
  return value.trim().split(/\s+/).slice(drop).join(" ") || value.trim();
}

/** Escapes LIKE wildcards in user text. */
const like = (s: string) => `%${s.replace(/[%_\\]/g, (c) => `\\${c}`).slice(0, 120)}%`;

const BULK = /^(?:tat ca|toan bo|het|moi|all|everything)(?: (?:file|tep|thu muc|folder|tai lieu))?$/;
export const isBulk = (value: string) => BULK.test(fold(value));

/** "gốc", "My Files": the root, where a file has no folder. */
export const isRoot = (value: string) =>
  /^(?:thu muc )?(?:goc|root|my files|trang chu|ngoai cung|thu muc chinh)$/.test(fold(value));

function pickBest<T extends { name: string }>(rows: T[], query: string): T[] {
  const q = fold(query);
  const exact = rows.filter((r) => fold(r.name) === q);
  if (exact.length) return exact;
  // "báo cáo q3" also finds "Báo cáo Q3.pdf"
  const base = rows.filter((r) => fold(r.name.replace(/\.[^.]+$/, "")) === q);
  return base.length ? base : rows;
}

export async function folderPath(ctx: AgentCtx, folderId: string | null): Promise<string> {
  if (!folderId) return "My Files";
  const { data } = await ctx.supabase.rpc("get_folder_ancestors", { p_id: folderId });
  const names = ((data ?? []) as { name: string }[]).map((r) => r.name);
  return names.length ? names.join(" / ") : "My Files";
}

export async function getFile(ctx: AgentCtx, id: string, opts: { deleted?: boolean } = {}): Promise<FileHit | null> {
  if (!UUID.test(id)) return null;
  const query = ctx.supabase.from("files").select(FILE_COLUMNS).eq("id", id);
  const { data } = await (opts.deleted ? query.not("deleted_at", "is", null) : query.is("deleted_at", null)).maybeSingle();
  return (data as FileHit | null) ?? null;
}

export async function getFolder(ctx: AgentCtx, id: string, opts: { deleted?: boolean } = {}): Promise<FolderHit | null> {
  if (!UUID.test(id)) return null;
  const query = ctx.supabase.from("folders").select(FOLDER_COLUMNS).eq("id", id);
  const { data } = await (opts.deleted ? query.not("deleted_at", "is", null) : query.is("deleted_at", null)).maybeSingle();
  return (data as FolderHit | null) ?? null;
}

async function fileChoices(ctx: AgentCtx, rows: FileHit[]): Promise<Choice[]> {
  const folderIds = [...new Set(rows.map((r) => r.folder_id).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (folderIds.length) {
    const { data } = await ctx.supabase.from("folders").select("id, name").in("id", folderIds);
    for (const f of (data ?? []) as { id: string; name: string }[]) names.set(f.id, f.name);
  }
  return rows.slice(0, MAX_CHOICES).map((r) => ({
    value: r.id,
    label: `${r.name} — ${r.folder_id ? names.get(r.folder_id) ?? "thư mục khác" : "My Files"}`,
  }));
}

export async function resolveFile(
  ctx: AgentCtx,
  input: { text?: string; picked?: string; memory: AgentMemory; deleted?: boolean }
): Promise<Resolved<FileHit>> {
  const byId = input.picked ?? (input.text ? resolveReference(input.text, input.memory) : null);
  if (byId) {
    const item = await getFile(ctx, byId, { deleted: input.deleted });
    return item ? { kind: "one", item } : { kind: "none" };
  }
  // "nó" with nothing to refer to must not become a search for the word "nó"
  if (input.text && isReference(input.text)) return { kind: "none" };
  const name = stripKind(input.text ?? "", "file");
  if (!name || isBulk(name)) return { kind: "none" };
  const query = ctx.supabase.from("files").select(FILE_COLUMNS).ilike("name", like(name));
  const { data } = await (input.deleted ? query.not("deleted_at", "is", null) : query.is("deleted_at", null))
    .order("updated_at", { ascending: false })
    .limit(20);
  const rows = pickBest((data ?? []) as FileHit[], name);
  if (rows.length === 1) return { kind: "one", item: rows[0] };
  if (!rows.length) return { kind: "none" };
  return { kind: "many", choices: await fileChoices(ctx, rows) };
}

export async function resolveFolder(
  ctx: AgentCtx,
  input: { text?: string; picked?: string; deleted?: boolean }
): Promise<Resolved<FolderHit>> {
  if (input.picked) {
    const item = await getFolder(ctx, input.picked, { deleted: input.deleted });
    return item ? { kind: "one", item } : { kind: "none" };
  }
  const name = stripKind(input.text ?? "", "folder");
  if (!name || isBulk(name)) return { kind: "none" };
  const query = ctx.supabase.from("folders").select(FOLDER_COLUMNS).ilike("name", like(name));
  const { data } = await (input.deleted ? query.not("deleted_at", "is", null) : query.is("deleted_at", null))
    .order("name")
    .limit(20);
  const rows = pickBest((data ?? []) as FolderHit[], name);
  if (rows.length === 1) return { kind: "one", item: rows[0] };
  if (!rows.length) return { kind: "none" };
  const choices = await Promise.all(
    rows.slice(0, MAX_CHOICES).map(async (r) => ({ value: r.id, label: `${r.name} — ${await folderPath(ctx, r.parent_id)}` }))
  );
  return { kind: "many", choices };
}
