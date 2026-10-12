// Answers a chat question using only predefined, permission-scoped,
// read-only database functions. No SQL is ever built from user input and no
// external AI is called unless an optional model is injected for summaries.

import { mentionsFiles, parseQuestion, type Filters, type Intent } from "./intent.ts";
import { isIndexable, INDEXABLE_EXTENSIONS } from "./formats.ts";
import { topKeywords } from "./summarize.ts";
import { buildDigest } from "./digest.ts";
import type {
  AssistantFile,
  AssistantReply,
  AssistantRequest,
  AssistantShare,
  AssistantStats,
  FileAccess,
} from "./types.ts";

/** The only database functions the assistant may call. */
export type AssistantRpc =
  | "assistant_find_files"
  | "assistant_search_content"
  | "assistant_file_stats"
  | "assistant_my_shares"
  | "assistant_index_candidates"
  | "assistant_get_content";

export type IndexResult = { indexed: number; remaining: number };

export interface AssistantDeps {
  rpc<T>(fn: AssistantRpc, args: Record<string, unknown>): Promise<T[]>;
  /** Indexes pending files the user can open (optional; needs server config). */
  indexPending?: (options: { fileId?: string; limit: number; budgetMs: number }) => Promise<IndexResult>;
  /** Optional language model used only for summaries when explicitly enabled. */
  summarizeWithLlm?: (input: { fileName: string; content: string }) => Promise<string[] | null>;
  now?: Date;
}

export const PAGE_SIZE = 8;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function helpReply(intent: string): AssistantReply {
  return reply({
    intent,
    text:
      "Xin chào! Tôi có thể giúp bạn tìm kiếm và tra cứu các tài liệu mà bạn có quyền truy cập: " +
      "tìm theo tên, loại file, thời gian, nội dung bên trong tài liệu, file được chia sẻ, " +
      "thống kê và tóm tắt nhanh một tài liệu.",
    suggestions: SUGGESTIONS,
  });
}

async function findFiles(intent: Extract<Intent, { kind: "find" }>, page: number, deps: AssistantDeps, message: string): Promise<AssistantReply> {
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
    if (pending > 0) {
      notices.push(
        `Còn ${pending >= 20 ? "hơn 20" : pending} file chưa được lập chỉ mục nội dung nên chưa thể tìm bên trong các file đó.`
      );
    }
  }

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

  return reply({
    intent: "find",
    text,
    files,
    total,
    page,
    hasMore,
    notices,
    contextFileId: files[0]?.id ?? null,
    canIndex: pending > 0,
    suggestions:
      total > PAGE_SIZE && !filters.extensions
        ? ["Chỉ file PDF", "Chỉ file được chia sẻ với tôi", "File cập nhật tháng này"]
        : undefined,
  });
}

async function resolveTarget(
  intent: { terms: string[]; useContext: boolean },
  contextFileId: string | null,
  deps: AssistantDeps
): Promise<string | null> {
  if (intent.useContext && contextFileId) return contextFileId;
  if (intent.terms.length === 0) return contextFileId;
  const rows = await deps.rpc<FileRow>("assistant_find_files", {
    p_terms: intent.terms,
    p_sort: "relevance",
    p_limit: 1,
  });
  return rows[0]?.file_id ?? null;
}

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

function contentProblem(row: ContentRow): string | null {
  if (!isIndexable(row.extension)) {
    return `Định dạng .${row.extension || "?"} chưa được hỗ trợ đọc nội dung. Hiện hỗ trợ: văn bản (TXT, MD, CSV, JSON, HTML…), PDF có lớp chữ, DOCX, XLSX, PPTX, ODT/ODS/ODP.`;
  }
  if (row.status === null || row.is_current === false) {
    return "File này chưa được lập chỉ mục nội dung nên chưa thể đọc bên trong. Hãy thử lại sau ít phút.";
  }
  switch (row.status) {
    case "too_large":
      return "File quá lớn để lập chỉ mục nội dung.";
    case "empty":
      return "Không trích xuất được văn bản từ file này (ví dụ PDF dạng ảnh scan).";
    case "failed":
      return "Không đọc được nội dung file này (file có thể bị lỗi hoặc được bảo vệ).";
    case "unsupported":
      return `Định dạng .${row.extension} chưa được hỗ trợ đọc nội dung.`;
    default:
      return null;
  }
}

const NOT_FOUND = "Tôi không tìm thấy file này trong các file bạn có quyền truy cập.";

async function summarizeFile(intent: Extract<Intent, { kind: "summarize" }>, contextFileId: string | null, deps: AssistantDeps): Promise<AssistantReply> {
  const fileId = await resolveTarget(intent, contextFileId, deps);
  if (!fileId) {
    return reply({
      intent: "summarize",
      text: "Bạn muốn tóm tắt file nào? Hãy nhập tên file, ví dụ: “Tóm tắt file báo cáo quý 3”, hoặc bấm “Tóm tắt” trên một kết quả.",
    });
  }
  const row = await loadContent(fileId, deps);
  if (!row) return reply({ intent: "summarize", text: NOT_FOUND });
  const problem = contentProblem(row);
  const url = openUrl(row.file_id, row.folder_id);
  if (problem) return reply({ intent: "summarize", text: `“${row.name}”: ${problem}`, contextFileId: row.file_id });

  let points: string[] | null = null;
  let engine: AssistantReply["engine"] = "local";
  const notices: string[] = [];
  if (deps.summarizeWithLlm) {
    try {
      points = await deps.summarizeWithLlm({ fileName: row.name, content: row.content });
      if (points?.length) engine = "llm";
    } catch {
      notices.push("Mô hình AI tùy chọn không phản hồi, đã dùng tóm tắt cục bộ.");
      points = null;
    }
  }
  const digest = buildDigest(row.content, row.extension, "keypoints");
  const local = {
    points: [...digest.overview.slice(0, 1), ...digest.keyPoints.map((p) => (p.page ? `${p.text} (trang ${p.page})` : p.text))],
    keywords: digest.keywords,
  };
  if (!points?.length) points = local.points;
  if (!points.length) {
    return reply({ intent: "summarize", text: `“${row.name}” không có đủ văn bản để tóm tắt.`, contextFileId: row.file_id });
  }

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
    suggestions: ["Tìm tài liệu tương tự file này"],
  });
}

async function similarFiles(intent: Extract<Intent, { kind: "similar" }>, contextFileId: string | null, deps: AssistantDeps): Promise<AssistantReply> {
  const fileId = await resolveTarget(intent, contextFileId, deps);
  if (!fileId) {
    return reply({
      intent: "similar",
      text: "Bạn muốn tìm tài liệu tương tự với file nào? Hãy nhập tên file hoặc bấm “Tương tự” trên một kết quả.",
    });
  }
  const row = await loadContent(fileId, deps);
  if (!row) return reply({ intent: "similar", text: NOT_FOUND });
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

async function stats(deps: AssistantDeps): Promise<AssistantReply> {
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

async function myShares(intent: Extract<Intent, { kind: "my_shares" }>, deps: AssistantDeps): Promise<AssistantReply> {
  const rows = await deps.rpc<{
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

/** Single entry point used by the chat API route. */
export async function answer(request: AssistantRequest, deps: AssistantDeps): Promise<AssistantReply> {
  const page = Math.min(Math.max(Math.trunc(request.page ?? 1), 1), 50);
  const contextFileId = request.contextFileId && UUID.test(request.contextFileId) ? request.contextFileId : null;
  const intent = parseQuestion(request.message, { now: deps.now });

  switch (intent.kind) {
    case "greeting":
    case "help":
      return helpReply(intent.kind);
    case "clarify":
      return reply({
        intent: "clarify",
        text: "Bạn muốn tìm theo tiêu chí nào? Ví dụ: tên file, loại file (PDF, Word…), thời gian, hoặc một nội dung cụ thể bên trong tài liệu.",
        suggestions: SUGGESTIONS,
      });
    case "out_of_scope":
      return reply({
        intent: "out_of_scope",
        text: "Tôi chỉ hỗ trợ tìm kiếm và tra cứu các file, thư mục bạn có quyền truy cập trên hệ thống này.",
        suggestions: SUGGESTIONS,
      });
    case "stats":
      return stats(deps);
    case "my_shares":
      return myShares(intent, deps);
    case "summarize":
      return summarizeFile(intent, contextFileId, deps);
    case "similar":
      return similarFiles(intent, contextFileId, deps);
    case "find":
      return findFiles(intent, page, deps, request.message);
  }
}
