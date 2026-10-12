// "AI tóm tắt" for one file: permission check (in SQL, with the user's own
// session) → current extracted text (indexing it on demand) → structured
// summary. Local extractive summary by default; an optional language model
// is used only when the server injects one. Framework-free for testing.

import { buildDigest, digestToText, findPassages, type Digest, type Passage, type SummaryLength } from "./digest.ts";
import { isIndexable } from "./formats.ts";

export type SummaryRpc = "assistant_get_document";

export type LlmDigest = Pick<Digest, "overview" | "keyPoints" | "details" | "actions" | "conclusion">;

export interface FileSummaryDeps {
  rpc<T>(fn: SummaryRpc, args: Record<string, unknown>): Promise<T[]>;
  indexFile?: (fileId: string) => Promise<void>;
  /** Optional model: structured summary of the full text (chunked inside). */
  llmDigest?: (input: { fileName: string; content: string; length: SummaryLength }) => Promise<LlmDigest | null>;
  /** Optional model: answer a question from the given passages only. */
  llmAnswer?: (input: { fileName: string; question: string; passages: Passage[] }) => Promise<string | null>;
  /** Cache for model output, keyed by file version (never by user). */
  cache?: { get(key: string): LlmDigest | undefined; set(key: string, value: LlmDigest): void };
}

export type SummaryFile = {
  id: string;
  name: string;
  extension: string;
  size: number;
  folderName: string | null;
  updatedAt: string;
  openUrl: string;
};

export type FileSummaryResult =
  | {
      ok: true;
      file: SummaryFile;
      length: SummaryLength;
      engine: "local" | "llm";
      cached: boolean;
      digest: Digest;
      text: string;
      notices: string[];
      answer?: { question: string; passages: Passage[]; text: string | null; engine: "local" | "llm" };
    }
  | {
      ok: false;
      status: 400 | 404 | 422 | 503;
      code: "invalid" | "not_found" | "unsupported" | "needs_ocr" | "empty" | "too_large" | "failed" | "not_indexed";
      message: string;
      file?: SummaryFile;
    };

type DocumentRow = {
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
  truncated: boolean;
  char_count: number;
  content: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LENGTHS: SummaryLength[] = ["short", "keypoints", "detailed"];
export const MAX_QUESTION_CHARS = 300;

const LOCAL_LABEL = "Tóm tắt trích xuất tự động từ nội dung file (không dùng mô hình AI).";
const LLM_LABEL = "Tóm tắt do mô hình AI tạo từ nội dung file — hãy đối chiếu với tài liệu gốc.";

function fileOf(row: DocumentRow): SummaryFile {
  const params = new URLSearchParams();
  if (row.folder_id) params.set("folder", row.folder_id);
  params.set("file", row.file_id);
  return {
    id: row.file_id,
    name: row.name,
    extension: row.extension,
    size: Number(row.size),
    folderName: row.folder_name,
    updatedAt: row.updated_at,
    openUrl: `/dashboard?${params.toString()}`,
  };
}

const isCurrent = (row: DocumentRow) =>
  row.status !== null && row.indexed_version_id === row.current_version_id;

export async function summarizeFile(
  request: { fileId?: unknown; length?: unknown; refresh?: unknown; question?: unknown },
  deps: FileSummaryDeps
): Promise<FileSummaryResult> {
  const fileId = typeof request.fileId === "string" && UUID.test(request.fileId) ? request.fileId : null;
  if (!fileId) return { ok: false, status: 400, code: "invalid", message: "Yêu cầu không hợp lệ." };
  const length = LENGTHS.includes(request.length as SummaryLength) ? (request.length as SummaryLength) : "keypoints";
  const refresh = request.refresh === true;
  const question =
    typeof request.question === "string" ? request.question.trim().slice(0, MAX_QUESTION_CHARS) : "";

  const load = async () =>
    (await deps.rpc<DocumentRow>("assistant_get_document", { p_file_id: fileId }))[0] ?? null;

  let row = await load();
  // Same answer whether the file does not exist or the user may not read it.
  if (!row) {
    return { ok: false, status: 404, code: "not_found", message: "Không tìm thấy file hoặc bạn không có quyền đọc file này." };
  }
  const file = fileOf(row);

  if (!isIndexable(row.extension)) {
    return {
      ok: false,
      status: 422,
      code: "unsupported",
      file,
      message: `Chưa hỗ trợ đọc nội dung định dạng .${row.extension || "?"}. Hỗ trợ: TXT, MD, CSV, JSON, HTML, PDF có lớp chữ, DOCX, XLSX, PPTX, ODT/ODS/ODP.`,
    };
  }

  // Read the file only when its current version has not been extracted yet
  // (or the user explicitly asks to re-read it).
  if (!isCurrent(row) || (refresh && row.status !== "indexed")) {
    if (!deps.indexFile) {
      return {
        ok: false,
        status: 503,
        code: "not_indexed",
        file,
        message: "Máy chủ chưa được cấu hình để đọc nội dung file nên chưa thể tóm tắt.",
      };
    }
    await deps.indexFile(fileId);
    row = (await load()) ?? row;
  }

  if (!isCurrent(row)) {
    return { ok: false, status: 503, code: "not_indexed", file, message: "Chưa đọc được nội dung file, vui lòng thử lại." };
  }
  switch (row.status) {
    case "too_large":
      return { ok: false, status: 422, code: "too_large", file, message: "File quá lớn để đọc và tóm tắt." };
    case "unsupported":
      return { ok: false, status: 422, code: "unsupported", file, message: `Chưa hỗ trợ đọc nội dung định dạng .${row.extension}.` };
    case "failed":
      return { ok: false, status: 422, code: "failed", file, message: "Không đọc được nội dung file (file có thể bị lỗi hoặc được đặt mật khẩu)." };
    case "empty":
      return row.error === "needs_ocr"
        ? {
            ok: false,
            status: 422,
            code: "needs_ocr",
            file,
            message: "File PDF này không có lớp chữ (có thể là bản scan/ảnh). Cần nhận dạng ký tự (OCR) trước khi tóm tắt — hệ thống hiện chưa hỗ trợ OCR.",
          }
        : { ok: false, status: 422, code: "empty", file, message: "File không có nội dung văn bản để tóm tắt." };
  }

  const content = row.content;
  const local = buildDigest(content, row.extension, length);
  const notices: string[] = [];
  if (row.truncated) {
    notices.push("Tài liệu rất dài: chỉ phần đầu (khoảng 200.000 ký tự) được đọc và tóm tắt.");
  }
  if (local.coverage.parts > 1) {
    notices.push(`Tài liệu được chia thành ${local.coverage.parts} phần để tóm tắt đều từ đầu đến cuối.`);
  }

  let digest: Digest = local;
  let engine: "local" | "llm" = "local";
  let cached = false;
  if (deps.llmDigest && local.kind === "document") {
    const key = `${row.current_version_id}:${length}`;
    let llm = refresh ? undefined : deps.cache?.get(key);
    cached = Boolean(llm);
    if (!llm) {
      try {
        llm = (await deps.llmDigest({ fileName: row.name, content, length })) ?? undefined;
        if (llm) deps.cache?.set(key, llm);
      } catch {
        notices.push("Mô hình AI tùy chọn không phản hồi, đã dùng tóm tắt trích xuất cục bộ.");
      }
    }
    if (llm && (llm.overview.length || llm.keyPoints.length)) {
      digest = { ...local, ...llm };
      engine = "llm";
    }
  }
  if (!digest.overview.length && !digest.keyPoints.length) {
    return { ok: false, status: 422, code: "empty", file, message: "Không tìm thấy đủ câu văn có nghĩa để tóm tắt file này." };
  }

  let answer: Extract<FileSummaryResult, { ok: true }>["answer"];
  if (question) {
    const passages = findPassages(content, question, 3);
    let text: string | null = null;
    let answerEngine: "local" | "llm" = "local";
    if (passages.length && deps.llmAnswer) {
      try {
        text = await deps.llmAnswer({ fileName: row.name, question, passages });
        if (text) answerEngine = "llm";
      } catch {
        text = null;
      }
    }
    answer = { question, passages, text, engine: answerEngine };
  }

  return {
    ok: true,
    file,
    length,
    engine,
    cached,
    digest,
    text: digestToText(digest, row.name, engine === "llm" ? LLM_LABEL : LOCAL_LABEL),
    notices,
    answer,
  };
}
