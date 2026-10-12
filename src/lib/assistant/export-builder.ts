// Rebuilds the content of an export at confirmation time, from the same
// permission-scoped functions the chat uses. Nothing produced earlier is
// trusted: if access was revoked in between, that file is simply missing.

import { compareDocuments, comparisonTable } from "./compare.ts";
import { buildDigest } from "./digest.ts";
import { retrieve } from "./retrieval.ts";
import { restoreFilters } from "./context.ts";
import { isIndexable } from "./formats.ts";
import type { ExportSource } from "./actions.ts";
import type { ExportDocument } from "./export.ts";

type Rpc = <T>(fn: "assistant_get_document" | "assistant_find_files" | "assistant_search_content", args: Record<string, unknown>) => Promise<T[]>;

type Doc = {
  file_id: string;
  name: string;
  extension: string;
  size: number | string;
  updated_at: string;
  folder_name: string | null;
  status: string | null;
  indexed_version_id: string | null;
  current_version_id: string | null;
  content: string;
};

type ListRow = { file_id: string; name: string; extension: string; size: number | string; updated_at: string; folder_name: string | null; access: string; owner_email: string | null };

const readable = (d: Doc) => isIndexable(d.extension) && d.status === "indexed" && d.indexed_version_id === d.current_version_id && d.content;

async function docs(ids: string[], rpc: Rpc): Promise<Doc[]> {
  const rows = await Promise.all(ids.map((id) => rpc<Doc>("assistant_get_document", { p_file_id: id })));
  return rows.map((r) => r[0]).filter((d): d is Doc => Boolean(d && readable(d)));
}

const date = (iso: string) =>
  new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(iso));

export async function buildExportDocument(title: string, source: ExportSource, rpc: Rpc): Promise<ExportDocument | null> {
  switch (source.kind) {
    case "compare": {
      const list = await docs(source.fileIds, rpc);
      if (list.length < 2) return null;
      const c = compareDocuments(
        list.map((d) => ({ fileId: d.file_id, name: d.name, extension: d.extension, size: Number(d.size), updatedAt: d.updated_at, folderName: d.folder_name, content: d.content })),
        source.topic
      );
      return {
        title,
        table: { title, ...comparisonTable(c) },
        sections: c.onlyIn.filter((o) => o.points.length).map((o) => ({ heading: `Chỉ có trong ${o.fileName}`, lines: o.points })),
      };
    }
    case "summary": {
      const [d] = await docs([source.fileId], rpc);
      if (!d) return null;
      const g = buildDigest(d.content, d.extension, "detailed");
      const withPage = (p: { text: string; page: number | null }) => (p.page ? `${p.text} (trang ${p.page})` : p.text);
      return {
        title: `${title}: ${d.name}`,
        sections: [
          { heading: "Tổng quan", lines: g.overview },
          { heading: g.kind === "table" ? "Cấu trúc dữ liệu" : "Các ý chính", lines: g.keyPoints.map(withPage) },
          { heading: g.kind === "table" ? "Số liệu" : "Thông tin chi tiết", lines: g.details.map(withPage) },
          { heading: "Việc cần thực hiện", lines: g.actions.map(withPage) },
          { heading: "Kết luận", lines: g.conclusion ? [withPage(g.conclusion)] : [] },
          { heading: "Nguồn", lines: [`${d.name} — trích xuất tự động, không dùng mô hình AI`] },
        ],
      };
    }
    case "ask": {
      const list = await docs(source.fileIds, rpc);
      if (!list.length) return null;
      const r = retrieve(
        list.map((d) => ({ fileId: d.file_id, name: d.name, extension: d.extension, content: d.content })),
        source.question,
        { limit: 6 }
      );
      if (!r.citations.length) return null;
      return {
        title,
        sections: [
          { heading: "Câu hỏi", lines: [source.question] },
          { heading: "Trích dẫn từ tài liệu", lines: r.citations.map((c) => `[${c.n}] ${c.text} — ${c.fileName}${c.page ? `, trang ${c.page}` : ""}`) },
          ...(r.conflicts.length
            ? [{ heading: "Các nguồn ghi khác nhau", lines: r.conflicts.map((c) => c.values.map((v) => `${v.raw} [${v.citation}]`).join(" · ")) }]
            : []),
        ],
      };
    }
    case "find": {
      const f = source.find;
      const filters = restoreFilters(f);
      const byName = f.mode !== "content"
        ? await rpc<ListRow>("assistant_find_files", {
            p_terms: f.terms.length ? f.terms : null,
            p_extensions: filters.extensions,
            p_scope: filters.scope,
            p_after: filters.after?.toISOString() ?? null,
            p_before: filters.before?.toISOString() ?? null,
            p_date_field: filters.dateField,
            p_sort: f.sort,
            p_limit: 50,
          })
        : [];
      const byContent = f.mode !== "name" && f.phrase
        ? await rpc<ListRow>("assistant_search_content", { p_query: f.phrase, p_terms: f.terms, p_extensions: filters.extensions, p_scope: filters.scope, p_limit: 50 })
        : [];
      const seen = new Set<string>();
      const rows = [...byName, ...byContent].filter((r) => !seen.has(r.file_id) && Boolean(seen.add(r.file_id)));
      return {
        title,
        table: {
          title,
          columns: ["Tên file", "Loại", "Dung lượng (byte)", "Cập nhật", "Thư mục", "Quyền"],
          rows: rows.map((r) => [
            r.name,
            r.extension.toUpperCase(),
            String(Number(r.size)),
            date(r.updated_at),
            r.folder_name ?? "",
            r.access === "owner" ? "Của tôi" : r.owner_email ? `Chia sẻ bởi ${r.owner_email}` : r.access,
          ]),
        },
      };
    }
  }
}
