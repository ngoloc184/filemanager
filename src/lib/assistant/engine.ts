// The assistant's reasoning loop. For every message it:
//   1. understands the request (rules: intent.ts, memory.ts, context.ts),
//   2. works out what the conversation already provides (earlier results,
//      the file being discussed, the task in progress) and what is missing,
//   3. gathers data only through predefined, permission-scoped, read-only
//      database functions (never SQL built from text), re-checking access to
//      every file on every turn,
//   4. answers from the documents with sources, flags conflicts and weak
//      evidence, and asks back when the request is ambiguous,
//   5. proposes (never performs) write operations, which need confirmation.
// An optional language model is used only when injected, only for wording,
// and only with passages the user is allowed to read.

import { mentionsFiles, parseQuestion, type Filters, type Intent } from "./intent.ts";
import { isIndexable, INDEXABLE_EXTENSIONS } from "./formats.ts";
import { topKeywords } from "./summarize.ts";
import { buildDigest, type SummaryLength } from "./digest.ts";
import { normalize } from "./text.ts";
import {
  EMPTY_CONTEXT,
  resolveReference,
  restoreFilters,
  sanitizeContext,
  saveFind,
  withFocus,
  withResults,
  type ConversationContext,
  type Reference,
  type SavedFind,
} from "./context.ts";
import {
  applyGlossary,
  buildProfile,
  defaultExpiry,
  describeMemory,
  matchMemories,
  MAX_MEMORIES,
  parseMemoryCommand,
  STYLE_LABEL,
  type MemoryCommand,
  type MemoryItem,
  type MemoryStore,
  type Profile,
} from "./memory.ts";
import { retrieve, stripInjections, type SourceDoc } from "./retrieval.ts";
import { compareDocuments } from "./compare.ts";
import { cleanName, type ActionSpec, type ExportSource, type PendingAction } from "./actions.ts";
import { DEFAULT_TUNING, type Tuning } from "./tuning.ts";
import type {
  AssistantAnswer,
  AssistantChoice,
  AssistantFile,
  AssistantMeta,
  AssistantReply,
  AssistantRequest,
  AssistantShare,
  AssistantStats,
  AssistantStep,
  FileAccess,
} from "./types.ts";

/** The only database functions the assistant may call. */
export type AssistantRpc =
  | "assistant_find_files"
  | "assistant_search_content"
  | "assistant_file_stats"
  | "assistant_my_shares"
  | "assistant_index_candidates"
  | "assistant_get_content"
  | "assistant_get_document";

export type IndexResult = { indexed: number; remaining: number };

export type LlmPassage = { n: number; fileName: string; page: number | null; text: string };

export interface AssistantDeps {
  rpc<T>(fn: AssistantRpc, args: Record<string, unknown>): Promise<T[]>;
  /** Indexes pending files the user can open (optional; needs server config). */
  indexPending?: (options: { fileId?: string; limit: number; budgetMs: number }) => Promise<IndexResult>;
  /** Optional language model used only for summaries when explicitly enabled. */
  summarizeWithLlm?: (input: { fileName: string; content: string }) => Promise<string[] | null>;
  /** Optional language model that words an answer from the given passages only. */
  answerWithLlm?: (input: { question: string; passages: LlmPassage[] }) => Promise<string | null>;
  /** The signed-in user's long-term memory (RLS-scoped). */
  memory?: MemoryStore;
  /** Folders the user may move files into, by name. */
  findFolders?: (name: string) => Promise<{ id: string; name: string }[]>;
  /** Signs an action proposal for later confirmation. */
  signAction?: (spec: ActionSpec) => string;
  tuning?: Tuning;
  /** True when the route verified the context's signature (it came from us). */
  contextTrusted?: boolean;
  now?: Date;
  onLlmCall?: () => void;
}

export const PAGE_SIZE = 8;

const SUGGESTIONS = [
  "Tìm file gần đây",
  "Liệt kê các file PDF",
  "Tìm tài liệu có nội dung nhắc đến hợp đồng",
  "File được chia sẻ với tôi",
  "Thống kê file của tôi",
];

type FileRow = {
  file_id: string;
  name: string;
  extension: string;
  mime_type: string;
  size: number | string;
  folder_id: string | null;
  folder_name: string | null;
  access: FileAccess;
  owner_email: string | null;
  updated_at: string;
  total_count: number | string;
  matched_terms?: number;
  snippet?: string | null;
};

type ContentRow = {
  file_id: string;
  name: string;
  extension: string;
  folder_id: string | null;
  folder_name: string | null;
  updated_at: string;
  status: string | null;
  content: string;
  is_current: boolean | null;
};

type DocRow = {
  file_id: string;
  name: string;
  extension: string;
  mime_type: string;
  size: number | string;
  folder_id: string | null;
  folder_name: string | null;
  updated_at: string;
  current_version_id: string | null;
  indexed_version_id: string | null;
  status: string | null;
  error: string | null;
  content: string;
};

/** Per-request working state. */
type Turn = {
  deps: AssistantDeps;
  ctx: ConversationContext;
  profile: Profile;
  memories: MemoryItem[];
  tuning: Tuning;
  steps: AssistantStep[];
  notices: string[];
  llmCalls: number;
  tokensEst: number;
  method: string;
};

export function openUrl(fileId: string, folderId: string | null): string {
  const params = new URLSearchParams();
  if (folderId) params.set("folder", folderId);
  params.set("file", fileId);
  return `/dashboard?${params.toString()}`;
}

function toFile(row: FileRow): AssistantFile {
  return {
    id: row.file_id,
    name: row.name,
    extension: row.extension,
    mimeType: row.mime_type,
    size: Number(row.size),
    folderId: row.folder_id,
    folderName: row.folder_name,
    access: row.access,
    sharedBy: row.access === "shared" ? row.owner_email : null,
    updatedAt: row.updated_at,
    snippet: row.snippet ?? null,
    openUrl: openUrl(row.file_id, row.folder_id),
  };
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Ho_Chi_Minh" }).format(d);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${parseFloat((bytes / 1024 ** i).toFixed(1))} ${units[i]}`;
}

function describeCriteria(terms: string[], filters: Filters, mode: string): string {
  const parts: string[] = [];
  if (terms.length) parts.push(`${mode === "content" ? "nội dung có" : "từ khóa"} “${terms.join(" ")}”`);
  if (filters.typeLabel) parts.push(`loại ${filters.typeLabel}`);
  if (filters.dateLabel) parts.push(`${filters.dateField === "created" ? "tải lên" : "cập nhật"} ${filters.dateLabel}`);
  if (filters.scope === "mine") parts.push("file của bạn");
  if (filters.scope === "shared") parts.push("file được chia sẻ với bạn");
  return parts.join(", ");
}

const reply = (r: Omit<AssistantReply, "engine"> & { engine?: AssistantReply["engine"] }): AssistantReply => ({
  engine: "local",
  ...r,
});

const step = (t: Turn, label: string, detail?: string) => t.steps.push(detail ? { label, detail } : { label });

/** Drops ids the user can no longer open (revoked, deleted or forged). */
function forget(t: Turn, ids: string[]) {
  if (!ids.length) return;
  const drop = new Set(ids);
  const task = t.ctx.task;
  t.ctx = {
    ...t.ctx,
    results: t.ctx.results.filter((id) => !drop.has(id)),
    focus: t.ctx.focus && drop.has(t.ctx.focus) ? null : t.ctx.focus,
    task:
      task?.kind === "summarize" && drop.has(task.fileId)
        ? null
        : task?.kind === "ask" || task?.kind === "compare"
          ? { ...task, fileIds: task.fileIds.filter((id) => !drop.has(id)) }
          : task,
  };
}

function helpReply(intent: string): AssistantReply {
  return reply({
    intent,
    text:
      "Xin chào! Tôi là trợ lý cho các tài liệu bạn có quyền truy cập. Tôi có thể tìm file theo tên, loại, thời gian " +
      "hoặc nội dung; trả lời câu hỏi dựa trên tài liệu kèm nguồn trích dẫn; tóm tắt, so sánh file; xuất kết quả ra Excel/CSV; " +
      "tạo thư mục, đổi tên, di chuyển, chia sẻ file (sau khi bạn xác nhận) và ghi nhớ thuật ngữ, cách trả lời bạn muốn.",
    suggestions: SUGGESTIONS,
  });
}

// ------------------------------------------------------------------ loading

async function loadDocument(fileId: string, t: Turn): Promise<DocRow | null> {
  const get = async () => (await t.deps.rpc<DocRow>("assistant_get_document", { p_file_id: fileId }))[0] ?? null;
  let row = await get();
  const stale = row && (row.status === null || row.indexed_version_id !== row.current_version_id);
  if (row && stale && isIndexable(row.extension) && t.deps.indexPending) {
    try {
      await t.deps.indexPending({ fileId, limit: 1, budgetMs: 8000 });
      row = (await get()) ?? row;
    } catch {
      // keep the current state
    }
  }
  return row;
}

/** Documents with readable text, in order; every id is permission-checked. */
async function loadDocuments(ids: string[], t: Turn): Promise<{ docs: DocRow[]; problems: string[] }> {
  const unique = [...new Set(ids)];
  const rows = await Promise.all(unique.map((id) => loadDocument(id, t)));
  forget(t, unique.filter((_, i) => !rows[i]));
  const docs: DocRow[] = [];
  const problems: string[] = [];
  for (const row of rows) {
    if (!row) continue;
    const problem = documentProblem(row);
    if (problem) problems.push(`“${row.name}”: ${problem}`);
    else docs.push(row);
  }
  return { docs, problems };
}

function documentProblem(row: Pick<DocRow, "extension" | "status" | "error" | "indexed_version_id" | "current_version_id">): string | null {
  if (!isIndexable(row.extension)) {
    return `định dạng .${row.extension || "?"} chưa được hỗ trợ đọc nội dung (hỗ trợ: TXT, MD, CSV, JSON, HTML, PDF có lớp chữ, DOCX, XLSX, PPTX, ODT/ODS/ODP).`;
  }
  if (row.status === null || row.indexed_version_id !== row.current_version_id) return "chưa được lập chỉ mục nội dung, hãy thử lại sau ít phút.";
  switch (row.status) {
    case "too_large":
      return "file quá lớn để đọc nội dung.";
    case "empty":
      return row.error === "needs_ocr"
        ? "PDF dạng ảnh scan, không có lớp chữ: cần OCR để đọc (hiện chưa hỗ trợ)."
        : "không có văn bản để đọc.";
    case "failed":
      return "không đọc được (file lỗi hoặc được bảo vệ).";
    case "unsupported":
      return `định dạng .${row.extension} chưa được hỗ trợ.`;
    default:
      return null;
  }
}

/** Names of files (only those the user can still open) for "which one?" buttons. */
async function choicesFor(ids: string[], t: Turn): Promise<AssistantChoice[]> {
  const rows = await Promise.all(ids.slice(0, 5).map((id) => t.deps.rpc<DocRow>("assistant_get_document", { p_file_id: id })));
  forget(t, ids.slice(0, 5).filter((_, i) => !rows[i][0]));
  return rows.flatMap((r, i) => (r[0] ? [{ fileId: r[0].file_id, label: `${i + 1}. ${r[0].name}` }] : []));
}

/** Best file by name for typed terms (all terms must match). */
async function fileByName(terms: string[], t: Turn, exclude: string[] = []): Promise<FileRow | null> {
  if (!terms.length) return null;
  const rows = await t.deps.rpc<FileRow>("assistant_find_files", { p_terms: terms, p_sort: "relevance", p_limit: 5 });
  return rows.find((r) => !exclude.includes(r.file_id) && (r.matched_terms === undefined || r.matched_terms >= terms.length)) ?? null;
}

// --------------------------------------------------------------------- find

async function findFiles(intent: Extract<Intent, { kind: "find" }>, page: number, t: Turn, message: string): Promise<AssistantReply> {
  const { deps } = t;
  const { filters } = intent;
  const offset = (page - 1) * PAGE_SIZE;
  const notices: string[] = [];
  const wantName = intent.mode !== "content";
  const wantContent = intent.mode !== "name" && intent.phrase.length > 0;

  const nameRows = wantName
    ? await deps.rpc<FileRow>("assistant_find_files", {
        p_terms: intent.terms.length ? intent.terms : null,
        p_extensions: filters.extensions,
        p_scope: filters.scope,
        p_after: filters.after?.toISOString() ?? null,
        p_before: filters.before?.toISOString() ?? null,
        p_date_field: filters.dateField,
        p_sort: intent.sort,
        p_limit: intent.single ? 3 : PAGE_SIZE,
        p_offset: offset,
      })
    : [];
  if (wantName) step(t, "Tìm theo tên, loại, thời gian", `${nameRows.length} kết quả`);

  let contentRows: FileRow[] = [];
  let pending = 0;
  if (wantContent) {
    if (deps.indexPending && page === 1) {
      try {
        pending = (await deps.indexPending({ limit: 3, budgetMs: 4000 })).remaining;
      } catch {
        // indexing is best-effort; search still runs on what is indexed
      }
    }
    contentRows = await deps.rpc<FileRow>("assistant_search_content", {
      p_query: intent.phrase,
      p_terms: intent.terms,
      p_extensions: filters.extensions,
      p_scope: filters.scope,
      p_limit: PAGE_SIZE,
      p_offset: offset,
    });
    step(t, "Tìm toàn văn trong nội dung", `${contentRows.length} kết quả`);
    if (pending > 0) {
      notices.push(
        `Còn ${pending >= 20 ? "hơn 20" : pending} file chưa được lập chỉ mục nội dung nên chưa thể tìm bên trong các file đó.`
      );
    }
  }
  t.method = wantName && wantContent ? "name+fulltext" : wantContent ? "fulltext" : "name";

  const seen = new Set<string>();
  const files: AssistantFile[] = [];
  for (const row of [...nameRows, ...contentRows]) {
    if (seen.has(row.file_id)) {
      const existing = files.find((f) => f.id === row.file_id);
      if (existing && !existing.snippet && row.snippet) existing.snippet = row.snippet;
      continue;
    }
    seen.add(row.file_id);
    files.push(toFile(row));
  }

  const nameTotal = Number(nameRows[0]?.total_count ?? 0);
  const contentTotal = Number(contentRows[0]?.total_count ?? 0);
  const total = Math.max(nameTotal, contentTotal, files.length);
  const hasMore = !intent.single && (nameTotal > offset + nameRows.length || contentTotal > offset + contentRows.length);
  const criteria = describeCriteria(intent.mode === "content" ? [intent.phrase.replace(/"/g, "")] : intent.terms, filters, intent.mode);
  const saved = saveFind(filters, intent);

  if (files.length === 0) {
    if (page > 1) return reply({ intent: "find", text: "Không còn kết quả nào khác.", files: [], total, page });
    if (intent.terms.length > 0 && !filters.extensions && !mentionsFiles(message)) {
      return reply({
        intent: "out_of_scope",
        text:
          "Tôi chỉ hỗ trợ tra cứu các file và thư mục bạn có quyền truy cập trên hệ thống này, " +
          "nên chưa thể trả lời câu hỏi đó.",
        suggestions: SUGGESTIONS,
      });
    }
    t.ctx = { ...t.ctx, lastFind: saved, task: { kind: "find" } };
    return reply({
      intent: "find",
      text: `Tôi không tìm thấy file nào phù hợp${criteria ? ` với ${criteria}` : ""} trong các file bạn có quyền truy cập.`,
      files: [],
      total: 0,
      notices,
      suggestions: [
        ...(intent.mode !== "content" && intent.terms.length ? [`Tìm tài liệu có nội dung nhắc đến ${intent.terms.join(" ")}`] : []),
        ...(intent.terms.length > 1 ? [`Tìm file ${intent.terms[0]}`] : []),
        "Tìm file gần đây",
      ],
    });
  }

  let text: string;
  if (intent.single) {
    const top = files[0];
    text = `File ${intent.sort === "created" ? "được tải lên" : "được cập nhật"} gần đây nhất là “${top.name}” (${formatDate(top.updatedAt)}).`;
  } else {
    const shown = files.length;
    text =
      `Tìm thấy ${total} file${criteria ? ` (${criteria})` : ""}` +
      (total > shown ? `. Đang hiển thị ${offset + 1}–${offset + shown}.` : ".");
  }

  t.ctx = withResults(t.ctx, files.map((f) => f.id), saved);
  return reply({
    intent: "find",
    text,
    files,
    total,
    page,
    hasMore,
    notices,
    contextFileId: files.length === 1 || intent.single ? files[0].id : null,
    canIndex: pending > 0,
    suggestions:
      files.length > 1
        ? ["Tóm tắt file đầu tiên", ...(files.length > 1 ? ["So sánh hai file đầu"] : []), ...(total > PAGE_SIZE && !filters.extensions ? ["Chỉ file PDF"] : [])]
        : undefined,
  });
}

// ---------------------------------------------------------------- summarize

const NOT_FOUND = "Tôi không tìm thấy file này trong các file bạn có quyền truy cập.";

async function loadContent(fileId: string, deps: AssistantDeps): Promise<ContentRow | null> {
  const rows = await deps.rpc<ContentRow>("assistant_get_content", { p_file_id: fileId, p_max_chars: 20000 });
  let row = rows[0] ?? null;
  if (row && (row.status === null || row.is_current === false) && isIndexable(row.extension) && deps.indexPending) {
    try {
      await deps.indexPending({ fileId, limit: 1, budgetMs: 8000 });
      row = (await deps.rpc<ContentRow>("assistant_get_content", { p_file_id: fileId, p_max_chars: 20000 }))[0] ?? row;
    } catch {
      // fall through with the current state
    }
  }
  return row;
}

function contentProblem(row: ContentRow & { error?: string | null }): string | null {
  return documentProblem({
    extension: row.extension,
    status: row.status,
    error: row.error ?? null,
    indexed_version_id: row.is_current === false ? "stale" : "current",
    current_version_id: "current",
  });
}

const STYLE_LENGTH: Record<Profile["style"], SummaryLength> = { short: "short", normal: "keypoints", detailed: "detailed" };

async function summarizeOne(fileId: string, t: Turn): Promise<AssistantReply> {
  const { deps } = t;
  const row = await loadContent(fileId, deps);
  step(t, "Kiểm tra quyền và đọc nội dung file");
  if (!row) {
    forget(t, [fileId]);
    return reply({ intent: "summarize", text: NOT_FOUND });
  }
  const problem = contentProblem(row);
  const url = openUrl(row.file_id, row.folder_id);
  t.ctx = withFocus(t.ctx, row.file_id, { kind: "summarize", fileId: row.file_id });
  if (problem) {
    return reply({ intent: "summarize", text: `“${row.name}”: ${problem.charAt(0).toUpperCase()}${problem.slice(1)}`, contextFileId: row.file_id });
  }

  let points: string[] | null = null;
  let engine: AssistantReply["engine"] = "local";
  const notices: string[] = [];
  if (deps.summarizeWithLlm) {
    try {
      t.llmCalls += 1;
      t.tokensEst += Math.ceil(Math.min(row.content.length, 12_000) / 4) + 600;
      deps.onLlmCall?.();
      points = await deps.summarizeWithLlm({ fileName: row.name, content: stripInjections(row.content) });
      if (points?.length) engine = "llm";
    } catch {
      notices.push("Mô hình AI tùy chọn không phản hồi, đã dùng tóm tắt cục bộ.");
      points = null;
    }
  }
  const length = STYLE_LENGTH[t.profile.style];
  const digest = buildDigest(row.content, row.extension, length);
  const keyLimit = t.profile.style === "short" ? 2 : t.profile.style === "detailed" ? 10 : 6;
  const local = {
    points: [...digest.overview.slice(0, 1), ...digest.keyPoints.slice(0, keyLimit).map((p) => (p.page ? `${p.text} (trang ${p.page})` : p.text))],
    keywords: digest.keywords,
  };
  if (!points?.length) points = local.points;
  if (t.profile.style === "short") points = points.slice(0, 3);
  if (!points.length) {
    return reply({ intent: "summarize", text: `“${row.name}” không có đủ văn bản để tóm tắt.`, contextFileId: row.file_id });
  }
  step(t, engine === "llm" ? "Tóm tắt bằng mô hình AI tùy chọn" : "Trích xuất ý chính cục bộ", `${points.length} ý`);
  t.method = engine === "llm" ? "summary+llm" : "summary";

  return reply({
    intent: "summarize",
    engine,
    text:
      engine === "llm"
        ? `Tóm tắt “${row.name}” (do mô hình AI tạo, hãy đối chiếu với tài liệu gốc):`
        : `Các ý chính trích từ “${row.name}” (trích xuất tự động, không dùng AI):`,
    summary: { fileId: row.file_id, fileName: row.name, points, keywords: local.keywords, engine, openUrl: url },
    notices,
    contextFileId: row.file_id,
    suggestions: ["Tìm tài liệu tương tự file này", "Xuất tóm tắt ra file Markdown"],
  });
}

/** Turns a reference into file ids, or an answer asking the user to clarify. */
async function referencedFiles(ref: Reference, t: Turn, verb: string): Promise<{ ids: string[] } | { reply: AssistantReply }> {
  if (ref.kind === "ordinal") {
    if (ref.missing.length) {
      return {
        reply: reply({
          intent: "clarify",
          text: t.ctx.results.length
            ? `Danh sách trước chỉ có ${t.ctx.results.length} file, không có file thứ ${ref.missing.join(", ")}. Bạn muốn ${verb} file nào?`
            : `Tôi không có danh sách kết quả nào trước đó. Bạn muốn ${verb} file nào?`,
          choices: await choicesFor(t.ctx.results, t),
        }),
      };
    }
    return { ids: ref.ids };
  }
  if (ref.kind === "all") return { ids: ref.ids };
  if (ref.kind === "pronoun") {
    if (ref.id) return { ids: [ref.id] };
    if (ref.ambiguous) {
      const choices = await choicesFor(t.ctx.results, t);
      return {
        reply: reply({
          intent: "clarify",
          text: `Có ${t.ctx.results.length} file trong kết quả trước. Bạn muốn ${verb} file nào?`,
          choices,
        }),
      };
    }
  }
  return { ids: [] };
}

async function summarize(intent: Extract<Intent, { kind: "summarize" }>, ref: Reference, message: string, t: Turn): Promise<AssistantReply> {
  const target = await referencedFiles(ref, t, "tóm tắt");
  if ("reply" in target) return target.reply;
  if (target.ids.length === 1) return summarizeOne(target.ids[0], t);
  if (target.ids.length > 1) return topicAnswer(normalize(message), target.ids, t, "summarize");

  if (intent.terms.length) {
    const named = await fileByName(intent.terms, t);
    if (named) {
      step(t, "Tìm file theo tên", named.name);
      return summarizeOne(named.file_id, t);
    }
    // "Tóm tắt nghĩa vụ thanh toán": a topic, inside the files being discussed.
    const scope = contextFiles(t.ctx);
    return topicAnswer(intent.terms.join(" "), scope, t, "summarize");
  }
  if (intent.useContext && t.ctx.focus) return summarizeOne(t.ctx.focus, t);
  return reply({
    intent: "summarize",
    text: "Bạn muốn tóm tắt file nào? Hãy nhập tên file, ví dụ: “Tóm tắt file báo cáo quý 3”, hoặc bấm “Tóm tắt” trên một kết quả.",
  });
}

/** Files the conversation is about, most specific first. */
function contextFiles(ctx: ConversationContext): string[] {
  const ids: string[] = [];
  if (ctx.focus) ids.push(ctx.focus);
  if (ctx.task?.kind === "compare" || ctx.task?.kind === "ask") ids.push(...ctx.task.fileIds);
  ids.push(...ctx.results.slice(0, 5));
  return [...new Set(ids)].slice(0, 6);
}

// ---------------------------------------------------------------------- ask

async function searchDocuments(question: string, t: Turn, exclude: Set<string>): Promise<string[]> {
  const terms = retrieveTerms(question, t);
  if (!terms.length) return [];
  const rows = await t.deps.rpc<FileRow>("assistant_search_content", {
    p_query: terms.join(" or "),
    p_terms: terms,
    p_limit: t.tuning.maxDocs + 2,
  });
  step(t, "Tìm toàn văn trong các file bạn có quyền xem", `${rows.length} tài liệu`);
  return rows.map((r) => r.file_id).filter((id) => !exclude.has(id));
}

function retrieveTerms(question: string, t: Turn): string[] {
  const shape = retrieve([], question, { tuning: t.tuning }).shape;
  return [...shape.terms, ...shape.expansions].slice(0, 16);
}

function toSources(docs: DocRow[], contextIds: Set<string>, order: string[]): SourceDoc[] {
  return docs.map((d) => ({
    fileId: d.file_id,
    name: d.name,
    extension: d.extension,
    content: d.content,
    inContext: contextIds.has(d.file_id),
    searchRank: Math.max(order.indexOf(d.file_id), 0),
  }));
}

function answerText(question: string, r: ReturnType<typeof retrieve>, mode: "answer" | "topic"): string {
  const first = r.citations[0];
  if (!first) return "Tôi không tìm thấy thông tin này trong các tài liệu bạn có quyền truy cập.";
  const lines: string[] = [];
  if (mode === "topic") {
    const files = [...new Set(r.citations.map((c) => c.fileName))];
    lines.push(`Nội dung liên quan đến “${question}” trong ${files.length} tài liệu (trích nguyên văn):`);
  } else if (r.best) {
    const c = r.citations[r.best.citation - 1];
    const sup = r.shape.superlative === "max" ? "lớn nhất" : r.shape.superlative === "min" ? "nhỏ nhất" : null;
    lines.push(
      sup
        ? `Giá trị ${sup} tìm thấy là ${r.best.quantity.raw}, theo “${c.fileName}” [${c.n}]${c.heading ? ` (${c.heading})` : ""}.`
        : `Theo “${c.fileName}” [${c.n}]${c.heading ? ` (${c.heading})` : ""}: ${r.best.quantity.raw}.`
    );
  } else {
    lines.push(`Theo “${first.fileName}” [${first.n}]${first.page ? `, trang ${first.page}` : ""}:`);
  }
  if (r.conflicts.length) {
    for (const c of r.conflicts) {
      lines.push(`Lưu ý: các tài liệu ghi khác nhau: ${c.values.map((v) => `${v.raw} [${v.citation}]`).join(" · ")}. Hãy kiểm tra tài liệu nào đang có hiệu lực.`);
    }
  }
  if (r.confidence === "low") lines.push("Mức độ chắc chắn thấp: các đoạn trích chỉ khớp một phần câu hỏi.");
  return lines.join("\n");
}

async function answerFromDocuments(
  question: string,
  ids: string[],
  t: Turn,
  options: { mode: "answer" | "topic"; intent: string; scopeOnly?: boolean; message: string }
): Promise<AssistantReply> {
  const contextIds = new Set(ids);
  if (ids.length) step(t, "Dùng ngữ cảnh cuộc trò chuyện", `${ids.length} file đang xét`);
  const found = options.scopeOnly ? [] : await searchDocuments(question, t, contextIds);
  const order = [...ids, ...found].slice(0, t.tuning.maxDocs);
  const { docs, problems } = await loadDocuments(order, t);
  step(t, "Kiểm tra quyền và đọc nội dung", `${docs.length} tài liệu`);
  const style = t.profile.style;
  let r = retrieve(toSources(docs, contextIds, order), question, {
    tuning: t.tuning,
    limit: options.mode === "topic" ? (style === "short" ? 2 : style === "detailed" ? 6 : 4) : style === "short" ? 2 : style === "detailed" ? 5 : 3,
    perFile: 2,
    quoteSentences: style === "detailed" ? 3 : 2,
  });
  // Nothing relevant in the files being discussed: look everywhere else.
  if (r.confidence === "none" && ids.length && !options.scopeOnly && found.length === 0) {
    const wider = await searchDocuments(question, t, new Set());
    const more = await loadDocuments(wider.slice(0, t.tuning.maxDocs), t);
    r = retrieve(toSources(more.docs, new Set(), wider), question, { tuning: t.tuning });
  }
  t.method = options.mode === "topic" ? "topic-passages" : "passages";
  step(t, "Xếp hạng đoạn văn và đối chiếu nguồn", `${r.chunksScanned} đoạn · ${r.citations.length} trích dẫn`);

  if (r.confidence === "none" || !r.citations.length) {
    const outOfScope = options.mode === "answer" && !mentionsFiles(options.message);
    return reply({
      intent: outOfScope ? "out_of_scope" : options.intent,
      text:
        "Tôi không tìm thấy thông tin này trong các tài liệu bạn có quyền truy cập." +
        (outOfScope ? " Tôi chỉ trả lời dựa trên file của bạn, không dùng kiến thức bên ngoài." : ""),
      notices: problems.slice(0, 3),
      suggestions: ["Tìm file gần đây", ...(r.shape.terms.length ? [`Tìm file ${r.shape.terms.slice(0, 3).join(" ")}`] : [])],
    });
  }

  const docById = new Map(docs.map((d) => [d.file_id, d]));
  const citations = r.citations.map((c) => ({
    n: c.n,
    fileId: c.fileId,
    fileName: c.fileName,
    page: c.page,
    heading: c.heading,
    text: c.text,
    suspicious: c.suspicious,
    openUrl: openUrl(c.fileId, docById.get(c.fileId)?.folder_id ?? null),
  }));
  const notices = [...problems.slice(0, 2)];
  if (r.suspiciousFiles.length) {
    notices.push(
      `“${r.suspiciousFiles.join("”, “")}” có đoạn văn giống chỉ thị gửi cho AI (prompt injection). Trợ lý chỉ coi đó là dữ liệu, không làm theo và đã ẩn đoạn đó khỏi trích dẫn.`
    );
  }
  if (r.confidence === "low") notices.push("Câu trả lời chưa đủ căn cứ: hãy mở tài liệu nguồn để kiểm tra.");

  let inference: string | null = null;
  let engine: AssistantReply["engine"] = "local";
  if (t.deps.answerWithLlm && r.confidence !== "low") {
    try {
      const passages = citations.filter((c) => !c.suspicious).map((c) => ({ n: c.n, fileName: c.fileName, page: c.page, text: stripInjections(c.text) }));
      t.llmCalls += 1;
      t.tokensEst += Math.ceil(passages.reduce((s, p) => s + p.text.length, 0) / 4) + 500;
      t.deps.onLlmCall?.();
      inference = (await t.deps.answerWithLlm({ question, passages })) ?? null;
      if (inference) {
        engine = "llm";
        step(t, "Diễn giải bằng mô hình AI tùy chọn", "chỉ dùng các đoạn trích");
      }
    } catch {
      notices.push("Mô hình AI tùy chọn không phản hồi; câu trả lời dưới đây chỉ gồm trích dẫn.");
    }
  }

  const focusIds = [...new Set(citations.map((c) => c.fileId))];
  t.ctx = {
    ...t.ctx,
    focus: focusIds.length === 1 ? focusIds[0] : t.ctx.focus,
    task: { kind: "ask", question: question.slice(0, 300), fileIds: focusIds.slice(0, 8) },
  };
  const answer: AssistantAnswer = {
    mode: options.mode,
    question,
    text: answerText(question, r, options.mode),
    citations,
    confidence: r.confidence,
    conflicts: r.conflicts,
    inference,
    scope: ids.length ? "context" : "all",
  };
  return reply({
    intent: options.intent,
    engine,
    text: answer.text,
    answer,
    notices,
    contextFileId: focusIds.length === 1 ? focusIds[0] : null,
    suggestions: focusIds.length > 1 ? ["So sánh các file này", "Xuất kết quả ra file Markdown"] : ["Tóm tắt file này"],
  });
}

function topicAnswer(topic: string, ids: string[], t: Turn, intent: string): Promise<AssistantReply> {
  return answerFromDocuments(topic, ids, t, { mode: "topic", intent, message: topic });
}

async function ask(intent: Extract<Intent, { kind: "ask" }>, ref: Reference, t: Turn): Promise<AssistantReply> {
  const target = await referencedFiles(ref, t, "hỏi về");
  if ("reply" in target) return target.reply;
  if (target.ids.length) {
    return answerFromDocuments(intent.question, target.ids, t, { mode: "answer", intent: "ask", scopeOnly: true, message: intent.question });
  }
  return answerFromDocuments(intent.question, contextFiles(t.ctx), t, { mode: "answer", intent: "ask", message: intent.question });
}

// ------------------------------------------------------------------ compare

const PREVIOUS = /\b(nam truoc|nam ngoai|ky truoc|quy truoc|thang truoc|ban truoc|phien ban truoc|ban cu|lan truoc|previous|last year)\b/;

async function previousVersionOf(fileId: string, t: Turn): Promise<string | null> {
  const doc = (await t.deps.rpc<DocRow>("assistant_get_document", { p_file_id: fileId }))[0];
  if (!doc) return null;
  const nameWords = normalize(doc.name.replace(/\.[a-z0-9]+$/i, "")).split(/[^a-z0-9]+/).filter(Boolean);
  const numbers = nameWords.filter((w) => /^\d+$/.test(w));
  const terms = nameWords.filter((w) => !/^\d+$/.test(w)).slice(0, 6);
  const rows = await t.deps.rpc<FileRow>("assistant_find_files", { p_terms: terms, p_sort: "relevance", p_limit: 10 });
  const candidates = rows.filter((r) => r.file_id !== fileId);
  const wanted = numbers.map((n) => String(Number(n) - 1));
  const byNumber = candidates.find((r) => wanted.some((w) => normalize(r.name).includes(w)));
  return (byNumber ?? candidates[0])?.file_id ?? null;
}

async function compare(intent: Extract<Intent, { kind: "compare" }>, ref: Reference, message: string, t: Turn): Promise<AssistantReply> {
  const n = normalize(message);
  let ids: string[] = [];
  const target = await referencedFiles(ref, t, "so sánh");
  if ("reply" in target) return target.reply;
  ids = target.ids;

  if (ids.length < 2 && PREVIOUS.test(n)) {
    const base = ids[0] ?? t.ctx.focus;
    if (base) {
      const prev = await previousVersionOf(base, t);
      if (prev) ids = [base, prev];
      step(t, "Tìm phiên bản trước theo tên file", prev ? "đã tìm thấy" : "không thấy");
    }
  }
  if (ids.length < 2 && intent.terms.length) {
    const rows = await t.deps.rpc<FileRow>("assistant_find_files", { p_terms: intent.terms, p_sort: "relevance", p_limit: 3 });
    const extra = rows.map((r) => r.file_id).filter((id) => !ids.includes(id));
    ids = [...ids, ...extra].slice(0, ids.length ? 2 : Math.min(3, extra.length));
  }
  if (ids.length < 2) {
    const pool = t.ctx.task?.kind === "compare" ? t.ctx.task.fileIds : t.ctx.task?.kind === "ask" && t.ctx.task.fileIds.length > 1 ? t.ctx.task.fileIds : t.ctx.results;
    if (pool.length >= 2) ids = [...new Set([...ids, ...pool])].slice(0, 2);
  }
  if (ids.length < 2) {
    return reply({
      intent: "clarify",
      text: "Bạn muốn so sánh những file nào? Ví dụ: “So sánh file thứ nhất và thứ hai” sau khi tìm kiếm, hoặc “So sánh hợp đồng 2025 và 2026”.",
      choices: await choicesFor(t.ctx.results, t),
    });
  }

  const { docs, problems } = await loadDocuments(ids.slice(0, 3), t);
  step(t, "Kiểm tra quyền và đọc nội dung", `${docs.length}/${Math.min(ids.length, 3)} tài liệu`);
  if (docs.length < 2) {
    return reply({
      intent: "compare",
      text: `Cần ít nhất 2 tài liệu đọc được để so sánh. ${problems.join(" ") || NOT_FOUND}`,
    });
  }
  const comparison = compareDocuments(
    docs.map((d) => ({ fileId: d.file_id, name: d.name, extension: d.extension, size: Number(d.size), updatedAt: d.updated_at, folderName: d.folder_name, content: d.content })),
    intent.topic
  );
  step(t, "So sánh từng tiêu chí", `${comparison.differences} điểm khác`);
  t.method = "compare";
  const fileIds = docs.map((d) => d.file_id);
  t.ctx = { ...t.ctx, task: { kind: "compare", fileIds, topic: intent.topic } };
  const diffs = comparison.rows.filter((r) => r.kind === "fact" && r.differs).slice(0, 3);
  return reply({
    intent: "compare",
    text:
      `So sánh ${docs.map((d) => `“${d.name}”`).join(" và ")}: ` +
      (comparison.differences
        ? `${comparison.differences} điểm khác nhau${diffs.length ? `, ví dụ ${diffs.map((d) => `${d.label} (${d.values.join(" ↔ ")})`).join("; ")}` : ""}.`
        : "không thấy khác biệt về các số liệu có thể đối chiếu.") +
      " Giá trị được trích nguyên văn từ tài liệu.",
    comparison,
    notices: problems,
    suggestions: ["Xuất bảng so sánh ra file Excel"],
  });
}

// ------------------------------------------------------------------ actions

function propose(spec: ActionSpec, title: string, summary: string, params: Record<string, unknown>, t: Turn, warning?: string): AssistantReply {
  if (!t.deps.signAction) {
    return reply({ intent: "action", text: "Máy chủ chưa bật thao tác qua trợ lý. Bạn có thể thực hiện trực tiếp trong giao diện quản lý file." });
  }
  const action: PendingAction = { kind: spec.kind, title, summary, params, token: t.deps.signAction(spec), ...(warning ? { warning } : {}) };
  step(t, "Chuẩn bị thao tác, chờ bạn xác nhận");
  t.method = `action:${spec.kind}`;
  return reply({
    intent: "action",
    text: `${summary} Bấm “Xác nhận” để thực hiện, hoặc “Hủy” để bỏ qua.`,
    action,
  });
}

/** One file the user points at, by reference or by name, re-checked for access. */
async function oneTarget(ref: Reference, terms: string[], t: Turn, verb: string): Promise<{ doc: DocRow } | { reply: AssistantReply }> {
  const target = await referencedFiles(ref, t, verb);
  if ("reply" in target) return target;
  let id: string | null = target.ids[0] ?? null;
  if (!id && terms.length) id = (await fileByName(terms, t))?.file_id ?? null;
  if (!id) id = t.ctx.focus;
  if (!id) {
    return { reply: reply({ intent: "clarify", text: `Bạn muốn ${verb} file nào? Hãy nêu tên file hoặc chọn từ kết quả tìm kiếm.`, choices: await choicesFor(t.ctx.results, t) }) };
  }
  const doc = (await t.deps.rpc<DocRow>("assistant_get_document", { p_file_id: id }))[0];
  if (!doc) {
    forget(t, [id]);
    return { reply: reply({ intent: "action", text: NOT_FOUND }) };
  }
  return { doc };
}

async function handleAction(intent: Intent, ref: Reference, t: Turn): Promise<AssistantReply> {
  switch (intent.kind) {
    case "refuse":
      return reply({
        intent: "refused",
        text:
          intent.reason === "delete"
            ? "Vì an toàn, tôi không thể xóa file hoặc thư mục. Bạn hãy xóa trực tiếp trong giao diện quản lý file (file vào Thùng rác và có thể khôi phục)."
            : intent.reason === "public"
              ? "Tôi không thực hiện chia sẻ công khai. Bạn có thể tạo liên kết chia sẻ trực tiếp trong mục Chia sẻ của file, nơi hiển thị rõ ai sẽ truy cập được."
              : "Tôi không thay đổi quyền hàng loạt. Hãy chia sẻ từng file hoặc thư mục trực tiếp trong giao diện để kiểm soát quyền truy cập.",
      });
    case "create_folder": {
      const name = cleanName(intent.name);
      if (!name) return reply({ intent: "action", text: "Tên thư mục không hợp lệ (không chứa / \\ : * ? \" < > | và tối đa 200 ký tự)." });
      return propose({ kind: "create_folder", name, parentId: null }, "Tạo thư mục", `Tạo thư mục mới “${name}” trong thư mục gốc của bạn.`, { name }, t);
    }
    case "rename": {
      const found = await oneTarget(ref, intent.terms, t, "đổi tên");
      if ("reply" in found) return found.reply;
      let name = cleanName(intent.name);
      if (!name) return reply({ intent: "action", text: "Tên mới không hợp lệ (không chứa / \\ : * ? \" < > | và tối đa 200 ký tự)." });
      const ext = found.doc.extension;
      if (ext && !normalize(name).endsWith(`.${ext}`)) name = `${name}.${ext}`;
      t.ctx = withFocus(t.ctx, found.doc.file_id);
      return propose(
        { kind: "rename_file", fileId: found.doc.file_id, name },
        "Đổi tên file",
        `Đổi tên “${found.doc.name}” thành “${name}”.`,
        { fileId: found.doc.file_id, from: found.doc.name, name },
        t
      );
    }
    case "move": {
      const found = await oneTarget(ref, intent.terms, t, "di chuyển");
      if ("reply" in found) return found.reply;
      let folder: { id: string; name: string } | null = null;
      if (intent.folder) {
        const folders = t.deps.findFolders ? await t.deps.findFolders(intent.folder) : [];
        const exact = folders.filter((f) => normalize(f.name) === normalize(intent.folder!));
        const pick = exact.length === 1 ? exact : folders;
        if (pick.length !== 1) {
          return reply({
            intent: "clarify",
            text: pick.length
              ? `Có ${pick.length} thư mục khớp “${intent.folder}”: ${pick.slice(0, 5).map((f) => `“${f.name}”`).join(", ")}. Hãy nêu chính xác tên thư mục.`
              : `Tôi không tìm thấy thư mục “${intent.folder}” mà bạn có quyền ghi.`,
          });
        }
        folder = pick[0];
      }
      t.ctx = withFocus(t.ctx, found.doc.file_id);
      return propose(
        { kind: "move_file", fileId: found.doc.file_id, folderId: folder?.id ?? null },
        "Di chuyển file",
        `Di chuyển “${found.doc.name}” vào ${folder ? `thư mục “${folder.name}”` : "thư mục gốc"}.`,
        { fileId: found.doc.file_id, file: found.doc.name, folderId: folder?.id ?? null, folder: folder?.name ?? null },
        t
      );
    }
    case "share": {
      const found = await oneTarget(ref, intent.terms, t, "chia sẻ");
      if ("reply" in found) return found.reply;
      t.ctx = withFocus(t.ctx, found.doc.file_id);
      return propose(
        { kind: "share_file", fileId: found.doc.file_id, email: intent.email, role: intent.role },
        "Chia sẻ file",
        `Chia sẻ “${found.doc.name}” với ${intent.email} (quyền ${intent.role === "editor" ? "chỉnh sửa" : "chỉ xem"}).`,
        { fileId: found.doc.file_id, file: found.doc.name, email: intent.email, role: intent.role },
        t,
        "Người nhận sẽ đọc được toàn bộ nội dung file. Chỉ chia sẻ khi bạn chắc chắn."
      );
    }
    default:
      return helpReply("help");
  }
}

async function exportResult(intent: Extract<Intent, { kind: "export" }>, t: Turn): Promise<AssistantReply> {
  const task = t.ctx.task;
  let source: ExportSource | null = null;
  let title = "Kết quả trợ lý";
  let detail = "";
  if (task?.kind === "compare") {
    source = { kind: "compare", fileIds: task.fileIds, topic: task.topic };
    title = "So sánh tài liệu";
    detail = `bảng so sánh ${task.fileIds.length} tài liệu`;
  } else if (task?.kind === "ask") {
    source = { kind: "ask", question: task.question, fileIds: task.fileIds };
    title = `Trả lời - ${task.question.slice(0, 60)}`;
    detail = "câu trả lời và các trích dẫn";
  } else if (task?.kind === "summarize") {
    source = { kind: "summary", fileId: task.fileId };
    title = "Tóm tắt";
    detail = "bản tóm tắt";
  } else if (t.ctx.lastFind) {
    source = { kind: "find", find: t.ctx.lastFind as SavedFind };
    title = "Danh sách file";
    detail = "danh sách kết quả tìm kiếm";
  }
  if (!source) {
    return reply({ intent: "clarify", text: "Chưa có kết quả nào để xuất. Hãy tìm kiếm, so sánh hoặc tóm tắt trước, rồi yêu cầu “Xuất ra Excel”." });
  }
  const tabular = source.kind === "compare" || source.kind === "find";
  const format = intent.format ?? (tabular ? "xlsx" : "md");
  const label = { xlsx: "Excel (.xlsx)", csv: "CSV", md: "Markdown (.md)", txt: "văn bản (.txt)" }[format];
  return propose(
    { kind: "create_export", format, title, source },
    "Tạo file",
    `Tạo file ${label} chứa ${detail} trong thư mục gốc của bạn. Nội dung được tạo lại từ dữ liệu bạn đang có quyền xem.`,
    { format, title, source: source.kind },
    t
  );
}

// ------------------------------------------------------------------- memory

async function handleMemory(cmd: MemoryCommand, t: Turn): Promise<AssistantReply> {
  const store = t.deps.memory;
  t.method = `memory:${cmd.kind}`;
  if (cmd.kind === "propose") {
    return reply({
      intent: "memory_proposal",
      text: `Tôi hiểu “${cmd.item.key}” nghĩa là “${cmd.item.value}”. Bạn có muốn tôi ghi nhớ để hiểu từ này trong các lần sau không?`,
      memoryProposal: { ...cmd.item, label: describeMemory(cmd.item) },
    });
  }
  if (cmd.kind === "rejected") return reply({ intent: "memory", text: cmd.reason });
  if (!store) return reply({ intent: "memory", text: "Bộ nhớ dài hạn chưa được bật trên máy chủ (cần chạy migration 202608280018)." });

  switch (cmd.kind) {
    case "list": {
      const items = t.memories;
      return reply({
        intent: "memory",
        text: items.length
          ? `Tôi đang ghi nhớ ${items.length} điều về cách bạn làm việc:\n${items.map((m) => `• ${describeMemory(m)}`).join("\n")}\nBạn có thể sửa hoặc xóa trong mục “Bộ nhớ”.`
          : "Tôi chưa ghi nhớ điều gì về bạn. Bạn có thể nói “Hãy nhớ …” hoặc “Từ giờ trả lời ngắn gọn”.",
        memories: items,
      });
    }
    case "forget_all": {
      const removed = await store.remove(t.memories.map((m) => m.id));
      return reply({ intent: "memory", text: removed ? `Đã xóa toàn bộ ${removed} mục trong bộ nhớ.` : "Bộ nhớ đã trống.", memories: [] });
    }
    case "forget": {
      const matches = matchMemories(t.memories, cmd.query);
      if (!matches.length) {
        return reply({ intent: "memory", text: `Tôi không thấy mục nào khớp “${cmd.query}” trong bộ nhớ.`, memories: t.memories });
      }
      const target = matches.length === 1 || matches[0] !== matches[1] ? [matches[0]] : matches;
      await store.remove(target.map((m) => m.id));
      const left = t.memories.filter((m) => !target.includes(m));
      return reply({ intent: "memory", text: `Đã quên: ${target.map((m) => describeMemory(m)).join("; ")}.`, memories: left });
    }
    case "save": {
      if (t.memories.length >= MAX_MEMORIES && !t.memories.some((m) => m.kind === cmd.item.kind && m.key && m.key === cmd.item.key)) {
        return reply({ intent: "memory", text: `Bộ nhớ đã đầy (${MAX_MEMORIES} mục). Hãy xóa bớt trong mục “Bộ nhớ”.` });
      }
      const saved = await store.save({ ...cmd.item, expiresAt: defaultExpiry(cmd.item.kind, t.deps.now) });
      const text =
        saved.kind === "preference"
          ? `Đã ghi nhớ: từ giờ tôi sẽ trả lời ${STYLE_LABEL[saved.value as Profile["style"]] ?? saved.value}.`
          : saved.kind === "glossary"
            ? `Đã ghi nhớ: “${saved.key}” nghĩa là “${saved.value}”. Tôi sẽ dùng khi tìm kiếm cho bạn.`
            : `Đã ghi nhớ: “${saved.value}”. (Ghi chú tự hết hạn sau 180 ngày.)`;
      return reply({ intent: "memory", text, memories: [...t.memories.filter((m) => m.id !== saved.id), saved] });
    }
  }
}

// -------------------------------------------------------------------- misc

async function similarFiles(intent: Extract<Intent, { kind: "similar" }>, ref: Reference, t: Turn): Promise<AssistantReply> {
  const { deps } = t;
  const target = await referencedFiles(ref, t, "tìm tài liệu tương tự với");
  if ("reply" in target) return target.reply;
  let fileId: string | null = target.ids[0] ?? null;
  if (!fileId && intent.terms.length) fileId = (await fileByName(intent.terms, t))?.file_id ?? null;
  if (!fileId && (intent.useContext || !intent.terms.length)) fileId = t.ctx.focus;
  if (!fileId) {
    return reply({
      intent: "similar",
      text: "Bạn muốn tìm tài liệu tương tự với file nào? Hãy nhập tên file hoặc bấm “Tương tự” trên một kết quả.",
    });
  }
  const row = await loadContent(fileId, deps);
  if (!row) {
    forget(t, [fileId]);
    return reply({ intent: "similar", text: NOT_FOUND });
  }
  const problem = contentProblem(row);
  if (problem) return reply({ intent: "similar", text: `“${row.name}”: ${problem}`, contextFileId: row.file_id });

  const keywords = topKeywords(row.content, 6);
  if (keywords.length === 0) {
    return reply({ intent: "similar", text: `“${row.name}” không có đủ nội dung để so sánh.`, contextFileId: row.file_id });
  }
  const rows = await deps.rpc<FileRow>("assistant_search_content", {
    p_query: keywords.join(" or "),
    p_terms: keywords,
    p_exclude_file: row.file_id,
    p_limit: PAGE_SIZE,
  });
  const files = rows.map(toFile);
  t.method = "similar";
  t.ctx = withResults(withFocus(t.ctx, row.file_id), files.map((f) => f.id), null);
  t.ctx.focus = row.file_id;
  return reply({
    intent: "similar",
    text: files.length
      ? `Các tài liệu có nội dung gần với “${row.name}” (dựa trên từ khóa: ${keywords.join(", ")}):`
      : `Không tìm thấy tài liệu nào có nội dung gần với “${row.name}”.`,
    files,
    total: Number(rows[0]?.total_count ?? 0),
    contextFileId: row.file_id,
  });
}

async function stats(t: Turn): Promise<AssistantReply> {
  const { deps } = t;
  const [row] = await deps.rpc<Record<string, unknown>>("assistant_file_stats", {
    p_indexable: INDEXABLE_EXTENSIONS,
  });
  const s: AssistantStats = {
    ownedFiles: Number(row?.owned_files ?? 0),
    ownedBytes: Number(row?.owned_bytes ?? 0),
    ownedFolders: Number(row?.owned_folders ?? 0),
    sharedFiles: Number(row?.shared_files ?? 0),
    publicFiles: Number(row?.public_files ?? 0),
    indexableFiles: Number(row?.indexable_files ?? 0),
    indexedFiles: Number(row?.indexed_files ?? 0),
    lastUpload: (row?.last_upload as string | null) ?? null,
    topExtensions: ((row?.top_extensions as { extension: string; count: number }[]) ?? []).map((e) => ({
      extension: e.extension,
      count: Number(e.count),
    })),
  };
  const pending = Math.max(s.indexableFiles - s.indexedFiles, 0);
  t.method = "stats";
  return reply({
    intent: "stats",
    text:
      `Bạn đang sở hữu ${s.ownedFiles} file (${formatBytes(s.ownedBytes)}) trong ${s.ownedFolders} thư mục, ` +
      `và có quyền xem ${s.sharedFiles} file được chia sẻ.` +
      (s.lastUpload ? ` Lần tải lên gần nhất: ${formatDate(s.lastUpload)}.` : ""),
    stats: s,
    canIndex: pending > 0 && Boolean(deps.indexPending),
    notices: pending > 0 ? [`${pending} file chưa được lập chỉ mục nội dung.`] : undefined,
  });
}

async function myShares(intent: Extract<Intent, { kind: "my_shares" }>, t: Turn): Promise<AssistantReply> {
  const rows = await t.deps.rpc<{
    item_type: "file" | "folder";
    item_id: string;
    name: string;
    folder_id: string | null;
    grantee_email: string;
    role: string;
    shared_at: string;
    total_count: number | string;
  }>("assistant_my_shares", { p_grantee: intent.grantee, p_limit: 20 });

  const shares: AssistantShare[] = rows.map((r) => ({
    type: r.item_type,
    id: r.item_id,
    name: r.name,
    granteeEmail: r.grantee_email,
    role: r.role,
    sharedAt: r.shared_at,
    openUrl:
      r.item_type === "folder" ? `/dashboard?folder=${r.item_id}` : openUrl(r.item_id, r.folder_id),
  }));
  const who = intent.grantee ? ` với “${intent.grantee}”` : "";
  t.method = "shares";
  return reply({
    intent: "my_shares",
    text: shares.length
      ? `Bạn đã chia sẻ ${Number(rows[0].total_count)} mục${who}:`
      : `Không có file hoặc thư mục nào bạn đã chia sẻ${who}.` +
        (intent.grantee ? " Lưu ý: tôi tìm theo e-mail của người nhận." : ""),
    shares,
    total: shares.length ? Number(rows[0].total_count) : 0,
  });
}

// ---------------------------------------------------------------- dispatch

const FILLER = new Set(["chi", "thoi", "con", "thi", "sao", "loc", "rieng", "only", "just", "nua", "them", "lai", "nhe", "ok", "vay", "the", "file", "cac"]);

/** "chỉ file PDF thôi" / "còn tháng trước?": same search, new filters. */
function refineFind(intent: Extract<Intent, { kind: "find" }>, ctx: ConversationContext): Extract<Intent, { kind: "find" }> | null {
  if (!ctx.lastFind) return null;
  const own = intent.terms.filter((w) => !FILLER.has(w));
  const changesFilter = Boolean(intent.filters.extensions || intent.filters.after || intent.filters.scope !== "all");
  if (own.length || !changesFilter) return null;
  const prev = restoreFilters(ctx.lastFind);
  return {
    ...intent,
    mode: ctx.lastFind.mode,
    terms: ctx.lastFind.terms,
    phrase: ctx.lastFind.phrase,
    sort: ctx.lastFind.sort,
    filters: {
      extensions: intent.filters.extensions ?? prev.extensions,
      typeLabel: intent.filters.typeLabel ?? prev.typeLabel,
      scope: intent.filters.scope !== "all" ? intent.filters.scope : prev.scope,
      after: intent.filters.after ?? prev.after,
      before: intent.filters.after ? intent.filters.before : prev.before,
      dateField: intent.filters.after ? intent.filters.dateField : prev.dateField,
      dateLabel: intent.filters.dateLabel ?? prev.dateLabel,
    },
  };
}

/** Repeats the current task on other file(s): "còn file đầu tiên thì sao?" */
async function followUp(ref: Reference, t: Turn, message: string): Promise<AssistantReply | null> {
  if (ref.kind === "none") return null;
  const task = t.ctx.task;
  if (task?.kind === "ask") {
    const target = await referencedFiles(ref, t, "hỏi về");
    if ("reply" in target) return target.reply;
    return answerFromDocuments(task.question, target.ids, t, { mode: "answer", intent: "ask", scopeOnly: true, message });
  }
  if (task?.kind === "compare" && ref.kind !== "pronoun") {
    return compare({ kind: "compare", terms: [], topic: task.topic }, ref, message, t);
  }
  return summarize({ kind: "summarize", terms: [], useContext: true }, ref, message, t);
}

function finish(r: AssistantReply, t: Turn, grounded: boolean | null, resultCount: number): AssistantReply {
  const meta: AssistantMeta = {
    method: t.method,
    resultCount,
    grounded,
    confidence: r.answer?.confidence ?? null,
    llmCalls: t.llmCalls,
    tokensEst: t.tokensEst,
    tuningVersion: t.tuning.version,
  };
  return {
    ...r,
    notices: [...t.notices, ...(r.notices ?? [])].filter(Boolean),
    steps: t.steps.length ? t.steps : undefined,
    context: { ...t.ctx, turn: t.ctx.turn + 1 },
    meta,
  };
}

/** Single entry point used by the chat API route. */
export async function answer(request: AssistantRequest, deps: AssistantDeps): Promise<AssistantReply> {
  const page = Math.min(Math.max(Math.trunc(request.page ?? 1), 1), 50);
  const memories = deps.memory ? await deps.memory.list().catch(() => [] as MemoryItem[]) : [];
  const t: Turn = {
    deps,
    ctx: request.context === undefined ? EMPTY_CONTEXT : sanitizeContext(request.context),
    profile: buildProfile(memories, deps.now),
    memories,
    tuning: deps.tuning ?? DEFAULT_TUNING,
    steps: [],
    notices: [],
    llmCalls: 0,
    tokensEst: 0,
    method: "rules",
  };

  // A context we did not sign may be forged: keep only ids the user can open.
  if (!deps.contextTrusted && (t.ctx.results.length || t.ctx.focus || t.ctx.task)) await verifyContext(t);
  // A file picked in the UI becomes the focus; it is permission-checked when used.
  const picked = sanitizeContext({}, request.contextFileId).focus;
  if (picked) t.ctx = { ...t.ctx, focus: picked };

  const memoryCommand = parseMemoryCommand(request.message);
  if (memoryCommand) return finish(await handleMemory(memoryCommand, t), t, null, 0);

  const { text: message, used } = applyGlossary(request.message, t.profile);
  if (used.length) t.notices.push(`Theo bộ nhớ của bạn: ${used.map((u) => `“${u.term}” = “${u.meaning}”`).join(", ")}.`);
  let intent = parseQuestion(message, { now: deps.now });
  const ref = resolveReference(message, t.ctx);
  step(t, "Phân tích câu hỏi", intentLabel(intent));

  let r: AssistantReply;
  switch (intent.kind) {
    case "greeting":
    case "help":
      return finish(helpReply(intent.kind), t, null, 0);
    case "clarify":
    case "out_of_scope": {
      const follow = await followUp(ref, t, message);
      if (follow) return finish(follow, t, Boolean(follow.answer?.citations.length || follow.summary), 1);
      return finish(
        reply(
          intent.kind === "clarify"
            ? {
                intent: "clarify",
                text: "Bạn muốn tìm theo tiêu chí nào? Ví dụ: tên file, loại file (PDF, Word…), thời gian, hoặc một nội dung cụ thể bên trong tài liệu.",
                suggestions: SUGGESTIONS,
              }
            : {
                intent: "out_of_scope",
                text: "Tôi chỉ hỗ trợ tìm kiếm và tra cứu các file, thư mục bạn có quyền truy cập trên hệ thống này.",
                suggestions: SUGGESTIONS,
              }
        ),
        t,
        null,
        0
      );
    }
    case "stats":
      r = await stats(t);
      return finish(r, t, null, 0);
    case "my_shares":
      r = await myShares(intent, t);
      return finish(r, t, null, r.shares?.length ?? 0);
    case "summarize":
      r = await summarize(intent, ref, message, t);
      return finish(r, t, Boolean(r.summary || r.answer?.citations.length), r.summary ? 1 : (r.answer?.citations.length ?? 0));
    case "similar":
      r = await similarFiles(intent, ref, t);
      return finish(r, t, null, r.files?.length ?? 0);
    case "ask":
      if (ref.kind !== "none" && t.ctx.results.length === 0 && !t.ctx.focus && ref.kind === "pronoun") {
        return finish(reply({ intent: "clarify", text: "Bạn đang hỏi về file nào? Hãy tìm hoặc chọn file trước." }), t, null, 0);
      }
      r = await ask(intent, ref, t);
      return finish(r, t, Boolean(r.answer?.citations.length), r.answer?.citations.length ?? 0);
    case "compare":
      r = await compare(intent, ref, message, t);
      return finish(r, t, Boolean(r.comparison), r.comparison?.files.length ?? 0);
    case "export":
      return finish(await exportResult(intent, t), t, null, 0);
    case "create_folder":
    case "rename":
    case "move":
    case "share":
    case "refuse":
      return finish(await handleAction(intent, ref, t), t, null, 0);
    case "find": {
      const refined = page === 1 ? refineFind(intent, t.ctx) : null;
      if (refined) {
        step(t, "Lọc lại kết quả trước");
        intent = refined;
      } else if (ref.kind === "ordinal" || ref.kind === "pronoun") {
        // "file thứ hai nói gì?" style follow-ups that parse like searches
        const follow = await followUp(ref, t, message);
        if (follow) return finish(follow, t, Boolean(follow.answer?.citations.length || follow.summary), 1);
      }
      r = await findFiles(intent, page, t, message);
      return finish(r, t, null, r.files?.length ?? 0);
    }
  }
}

async function verifyContext(t: Turn) {
  const task = t.ctx.task;
  const ids = [
    ...new Set([
      ...t.ctx.results,
      ...(t.ctx.focus ? [t.ctx.focus] : []),
      ...(task?.kind === "summarize" ? [task.fileId] : task?.kind === "ask" || task?.kind === "compare" ? task.fileIds : []),
    ]),
  ].slice(0, 30);
  const rows = await Promise.all(ids.map((id) => t.deps.rpc<DocRow>("assistant_get_document", { p_file_id: id })));
  forget(t, ids.filter((_, i) => !rows[i][0]));
}

function intentLabel(intent: Intent): string {
  const labels: Record<Intent["kind"], string> = {
    greeting: "chào hỏi",
    help: "hướng dẫn",
    stats: "thống kê",
    find: "tìm file",
    my_shares: "file đã chia sẻ",
    summarize: "tóm tắt",
    similar: "tài liệu tương tự",
    ask: "hỏi đáp nội dung",
    compare: "so sánh",
    export: "xuất file",
    create_folder: "tạo thư mục",
    rename: "đổi tên",
    move: "di chuyển",
    share: "chia sẻ",
    refuse: "thao tác không được phép",
    out_of_scope: "ngoài phạm vi",
    clarify: "cần làm rõ",
  };
  return labels[intent.kind];
}
