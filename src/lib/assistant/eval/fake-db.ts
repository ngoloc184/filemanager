// In-memory stand-in for the permission-scoped database functions, used by
// the evaluation suite and unit tests. Mirrors the access rule of the SQL
// functions: a user only ever sees files they own or that are shared with
// them, and shares can be revoked between turns.

import { normalize } from "../text.ts";
import { CORPUS, USERS, type CorpusFile, type UserKey } from "./corpus.ts";
import type { MemoryInput, MemoryItem, MemoryStore } from "../memory.ts";

type Row = Record<string, unknown>;

const words = (s: string) => normalize(s).split(/[^a-z0-9]+/).filter(Boolean);

export class FakeDb {
  files: CorpusFile[];
  memories = new Map<UserKey, MemoryItem[]>();
  folders = [
    { id: "d1000000-0000-0000-0000-000000000001", name: "Hợp đồng", owner: "alice" as UserKey },
    { id: "d1000000-0000-0000-0000-000000000002", name: "Báo cáo", owner: "alice" as UserKey },
  ];
  calls: { user: UserKey; fn: string }[] = [];

  constructor(files: CorpusFile[] = CORPUS) {
    this.files = files.map((f) => ({ ...f, sharedWith: [...(f.sharedWith ?? [])] }));
  }

  revoke(fileId: string, user: UserKey) {
    const file = this.files.find((f) => f.id === fileId);
    if (file) file.sharedWith = (file.sharedWith ?? []).filter((u) => u !== user);
  }

  private access(user: UserKey, file: CorpusFile): "owner" | "shared" | null {
    if (file.owner === user) return "owner";
    if (file.sharedWith?.includes(user)) return "shared";
    return null;
  }

  private visible(user: UserKey) {
    return this.files
      .map((f) => ({ f, access: this.access(user, f) }))
      .filter((x): x is { f: CorpusFile; access: "owner" | "shared" } => x.access !== null);
  }

  private base(f: CorpusFile, access: string) {
    return {
      file_id: f.id,
      name: f.name,
      extension: f.extension,
      mime_type: f.mimeType,
      size: f.size,
      folder_id: f.folderId,
      folder_name: f.folderName,
      access,
      owner_email: USERS[f.owner].email,
      created_at: f.updatedAt,
      updated_at: f.updatedAt,
    };
  }

  rpcFor(user: UserKey) {
    return async <T,>(fn: string, args: Record<string, unknown>): Promise<T[]> => {
      this.calls.push({ user, fn });
      return this.rpc(user, fn, args) as T[];
    };
  }

  rpc(user: UserKey, fn: string, args: Record<string, unknown>): Row[] {
    const scope = (args.p_scope as string) ?? "all";
    const exts = (args.p_extensions as string[] | null) ?? null;
    const inScope = ({ f, access }: { f: CorpusFile; access: string }) =>
      (scope === "all" || (scope === "mine" ? access === "owner" : access !== "owner")) &&
      (!exts || exts.includes(f.extension));
    const limit = Math.min(Number(args.p_limit ?? 10), 50);
    const offset = Number(args.p_offset ?? 0);

    switch (fn) {
      case "assistant_find_files": {
        const terms = ((args.p_terms as string[] | null) ?? []).map((t) => normalize(t));
        const needed = terms.length ? Math.max(1, Math.ceil(terms.length / 2)) : 0;
        const after = args.p_after ? new Date(args.p_after as string) : null;
        const before = args.p_before ? new Date(args.p_before as string) : null;
        const rows = this.visible(user)
          .filter(inScope)
          .filter(({ f }) => (!after || new Date(f.updatedAt) >= after) && (!before || new Date(f.updatedAt) < before))
          .map((x) => {
            const hay = `${normalize(x.f.name.replace(/[-_.]+/g, " "))} ${normalize(x.f.folderName ?? "")}`;
            const m = terms.filter((t) => hay.includes(t)).length;
            return { x, m };
          })
          .filter(({ m }) => m >= needed)
          .sort((a, b) =>
            args.p_sort === "relevance" || !args.p_sort
              ? b.m - a.m || b.x.f.updatedAt.localeCompare(a.x.f.updatedAt)
              : b.x.f.updatedAt.localeCompare(a.x.f.updatedAt)
          );
        return rows.slice(offset, offset + limit).map(({ x, m }) => ({
          ...this.base(x.f, x.access),
          matched_terms: m,
          score: m,
          total_count: rows.length,
        }));
      }
      case "assistant_search_content": {
        const query = normalize(String(args.p_query ?? ""));
        const any = / or /.test(query);
        const tokens = words(query).filter((w) => w !== "or");
        if (!tokens.length) return [];
        const rows = this.visible(user)
          .filter(inScope)
          .filter(({ f }) => f.status === "indexed" && f.content && f.id !== args.p_exclude_file)
          .map((x) => {
            const text = normalize(x.f.content!);
            const hits = tokens.filter((t) => new RegExp(`(^|[^a-z0-9])${t}([^a-z0-9]|$)`).test(text));
            return { x, hits: hits.length };
          })
          .filter(({ hits }) => (any ? hits > 0 : hits === tokens.length))
          .sort((a, b) => b.hits - a.hits);
        return rows.slice(offset, offset + limit).map(({ x, hits }) => ({
          ...this.base(x.f, x.access),
          snippet: x.f.content!.slice(0, 160),
          rank: hits,
          total_count: rows.length,
        }));
      }
      case "assistant_get_content":
      case "assistant_get_document": {
        const hit = this.visible(user).find(({ f }) => f.id === args.p_file_id);
        if (!hit) return [];
        const { f } = hit;
        const content = f.content ?? "";
        return [
          {
            ...this.base(f, hit.access),
            current_version_id: `v-${f.id}`,
            indexed_version_id: f.content === null ? null : `v-${f.id}`,
            status: f.content === null ? null : f.status,
            error: f.error ?? null,
            truncated: false,
            char_count: content.length,
            content: fn === "assistant_get_content" ? content.slice(0, Number(args.p_max_chars ?? 20000)) : content,
            is_current: true,
          },
        ];
      }
      case "assistant_file_stats": {
        const mine = this.visible(user).filter((x) => x.access === "owner");
        return [
          {
            owned_files: mine.length,
            owned_bytes: mine.reduce((n, x) => n + x.f.size, 0),
            owned_folders: this.folders.filter((d) => d.owner === user).length,
            shared_files: this.visible(user).length - mine.length,
            public_files: 0,
            indexable_files: mine.length,
            indexed_files: mine.filter((x) => x.f.status === "indexed").length,
            last_upload: mine[0]?.f.updatedAt ?? null,
            top_extensions: [],
          },
        ];
      }
      case "assistant_my_shares":
      case "assistant_index_candidates":
        return [];
      default:
        throw new Error(`fake db: unknown function ${fn}`);
    }
  }

  findFolders(user: UserKey) {
    return async (name: string) => {
      const n = normalize(name);
      return this.folders
        .filter((d) => d.owner === user && normalize(d.name).includes(n))
        .map((d) => ({ id: d.id, name: d.name }));
    };
  }

  memoryStore(user: UserKey): MemoryStore {
    const list = () => this.memories.get(user) ?? [];
    const set = (items: MemoryItem[]) => this.memories.set(user, items);
    let seq = 0;
    return {
      list: async () => list(),
      save: async (input: MemoryInput) => {
        const existing = list().find((m) => m.kind === input.kind && m.key !== null && m.key === input.key);
        const now = new Date().toISOString();
        if (existing) {
          const updated = { ...existing, value: input.value, source: input.source, updatedAt: now };
          set(list().map((m) => (m.id === existing.id ? updated : m)));
          return updated;
        }
        seq += 1;
        const item: MemoryItem = {
          id: `m${user}-${list().length + 1}-${seq}`,
          kind: input.kind,
          key: input.key,
          value: input.value,
          source: input.source,
          createdAt: now,
          updatedAt: now,
          expiresAt: input.expiresAt ?? null,
        };
        set([...list(), item]);
        return item;
      },
      remove: async (ids: string[]) => {
        const before = list().length;
        set(list().filter((m) => !ids.includes(m.id)));
        return before - list().length;
      },
    };
  }
}
