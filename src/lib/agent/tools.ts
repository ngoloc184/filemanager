import "server-only";

// File-manager tools for the agent (@ai-pro/agent-core). Each tool declares
// how people ask for it (templates on folded text), what it needs, how it
// finds the file or folder meant, and how it runs. Reads answer directly;
// writes return a confirmation and only run in execute() after the user
// confirmed a signed token — always with the user's own permissions (RLS and
// the existing security-definer RPCs), never with the service role.

import { createHash, randomUUID } from "node:crypto";
import { isReference, type Tool, type ToolOutcome } from "@ai-pro/agent-core";
// relative imports (not "@/"): the tools are unit-tested with node --test
import { openUrl } from "../assistant/engine.ts";
import { cleanName, isEmail } from "../assistant/actions.ts";
import type { AssistantFile, AssistantReply } from "../assistant/types.ts";
import { normalizeUrl, LINK_TITLE_MAX } from "../saved-links.ts";
import { UPLOADS_BUCKET, buildStoragePath } from "../storage.ts";
import { ensureTextFileName, textMimeType } from "../text-files.ts";
import {
  folderPath,
  getFile,
  isBulk,
  isRoot,
  resolveFile,
  resolveFolder,
  type AgentCtx,
  type FileHit,
  type Resolved,
} from "./resolve.ts";

type R = AssistantReply;
type AgentTool = Tool<AgentCtx, R>;
type Outcome = ToolOutcome<R>;

const LIST_LIMIT = 30;
const COMMENT_MAX = 5000;
const TEXT_MAX = 100_000;

// ---------------------------------------------------------------- helpers

function toAssistantFile(f: FileHit, userId: string, folderName: string | null): AssistantFile {
  return {
    id: f.id,
    name: f.name,
    extension: f.extension,
    mimeType: f.mime_type,
    size: Number(f.size),
    folderId: f.folder_id,
    folderName,
    access: f.owner_id === userId ? "owner" : "shared",
    sharedBy: null,
    updatedAt: f.updated_at,
    snippet: null,
    openUrl: openUrl(f.id, f.folder_id),
  };
}

const folderLink = (id: string | null) => (id ? `/dashboard?folder=${id}` : "/dashboard");

/**
 * Turns a resolution result into "ask again / choose / not found" outcomes.
 * With `pass`, a name that matches nothing hands the whole message to the
 * assistant engine instead: "copy link", "lấy lại mật khẩu" or "xem thư mục
 * nào lớn nhất" only look like commands.
 */
function unresolved(
  r: Exclude<Resolved<unknown>, { kind: "one" }>,
  slot: string,
  what: string,
  typed: string | undefined,
  options: { pass?: boolean } = {}
): Outcome {
  if (r.kind === "many") return { type: "choose", slot, text: `Có nhiều ${what} khớp với “${typed}”. Bạn muốn chọn mục nào?`, choices: r.choices };
  if (typed && isReference(typed)) return { type: "ask", slot, text: `Bạn đang nói tới ${what} nào? Hãy cho tôi biết tên.` };
  if (options.pass && typed) return { type: "pass" };
  if (typed && isBulk(typed)) return { type: "error", text: `Tôi chỉ làm việc với từng ${what} một. Hãy nói rõ tên ${what}.` };
  return { type: "ask", slot, text: typed ? `Tôi không tìm thấy ${what} “${typed}” trong những mục bạn có quyền truy cập. Bạn kiểm tra lại tên giúp tôi?` : `Bạn muốn chọn ${what} nào?` };
}

/** Destination folder: a folder, or the root when the user says "gốc". */
async function destination(
  ctx: AgentCtx,
  text: string | undefined,
  picked: string | undefined,
  slot: string,
  options: { pass?: boolean } = {}
): Promise<{ id: string | null; label: string } | Outcome> {
  if (picked === "root" || (!picked && text && isRoot(text))) return { id: null, label: "My Files (thư mục gốc)" };
  const r = await resolveFolder(ctx, { text, picked });
  if (r.kind !== "one") {
    if (r.kind === "many") return { type: "choose", slot, text: `Có nhiều thư mục khớp với “${text}”. Bạn muốn chọn thư mục nào?`, choices: r.choices };
    return unresolved(r, slot, "thư mục", text, options);
  }
  return { id: r.item.id, label: await folderPath(ctx, r.item.id) };
}

const isOutcome = (x: unknown): x is Outcome => !!x && typeof x === "object" && "type" in x;

function rpcError(error: unknown): never {
  throw error instanceof Error ? error : Object.assign(new Error((error as { message?: string })?.message ?? "error"), error as object);
}

async function rpc(ctx: AgentCtx, fn: string, args: Record<string, unknown>) {
  const { data, error } = await ctx.supabase.rpc(fn, args);
  if (error) rpcError(error);
  return data;
}

/** Uploads bytes as a new file of the user (same path layout as the app). */
async function uploadNewFile(ctx: AgentCtx, name: string, folderId: string | null, bytes: Uint8Array, mime: string) {
  const fileId = randomUUID();
  const versionId = randomUUID();
  const path = buildStoragePath(ctx.userId, fileId, versionId, name);
  const upload = await ctx.supabase.storage.from(UPLOADS_BUCKET).upload(path, bytes, { contentType: mime, upsert: false });
  if (upload.error) rpcError(upload.error);
  const dot = name.lastIndexOf(".");
  const registered = await ctx.supabase.rpc("register_file", {
    p_id: fileId,
    p_folder_id: folderId,
    p_name: name,
    p_original_name: name,
    p_extension: dot > 0 ? name.slice(dot + 1).toLowerCase() : "",
    p_mime_type: mime,
    p_size: bytes.byteLength,
    p_storage_path: path,
    p_checksum: createHash("sha256").update(bytes).digest("hex"),
    p_version_id: versionId,
  });
  if (registered.error) {
    await ctx.supabase.storage.from(UPLOADS_BUCKET).remove([path]);
    rpcError(registered.error);
  }
  await ctx.index?.(fileId).catch(() => undefined);
  return fileId;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const idOrNull = (v: unknown) => (typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v : null);

// ---------------------------------------------------------------- read tools

const listFolder: AgentTool = {
  name: "list_folder",
  title: "Xem nội dung thư mục",
  description: "Liệt kê thư mục con và file trong một thư mục.",
  effect: "read",
  patterns: [
    "(xem|mo|hien thi|liet ke|vao) (noi dung)? (thu muc|folder) {folder}",
    "(trong|ben trong) (thu muc|folder) {folder} co (gi|nhung gi|file gi|nhung file nao|file nao)",
    "(thu muc|folder) {folder} co (gi|nhung gi|file gi|nhung file nao|file nao)",
  ],
  examples: ["Xem thư mục Kế toán", "Trong thư mục Dự án có gì?"],
  slots: { folder: { required: true, ask: "Bạn muốn xem thư mục nào?" } },
  async run({ args, picked, ctx }) {
    const dest = await destination(ctx, args.folder, picked.folder, "folder", { pass: !picked.folder });
    if (isOutcome(dest)) return dest;
    const [folders, files] = await Promise.all([
      (dest.id
        ? ctx.supabase.from("folders").select("id, name").is("deleted_at", null).eq("parent_id", dest.id)
        : ctx.supabase.from("folders").select("id, name").is("deleted_at", null).is("parent_id", null).eq("owner_id", ctx.userId)
      )
        .order("name")
        .limit(LIST_LIMIT),
      (dest.id
        ? ctx.supabase.from("files").select("id, name, folder_id, owner_id, extension, mime_type, size, updated_at, deleted_at").is("deleted_at", null).eq("folder_id", dest.id)
        : ctx.supabase.from("files").select("id, name, folder_id, owner_id, extension, mime_type, size, updated_at, deleted_at").is("deleted_at", null).is("folder_id", null).eq("owner_id", ctx.userId)
      )
        .order("name")
        .limit(LIST_LIMIT),
    ]);
    const subfolders = (folders.data ?? []) as { id: string; name: string }[];
    const fileRows = (files.data ?? []) as FileHit[];
    const label = dest.label.split(" / ").pop() ?? dest.label;
    return {
      type: "done",
      text:
        subfolders.length || fileRows.length
          ? `Thư mục “${label}” có ${subfolders.length} thư mục con và ${fileRows.length} file${fileRows.length >= LIST_LIMIT ? " (hiển thị tối đa " + LIST_LIMIT + ")" : ""}:`
          : `Thư mục “${label}” đang trống.`,
      reply: {
        folders: subfolders.map((f) => ({ id: f.id, name: f.name, openUrl: folderLink(f.id) })),
        files: fileRows.map((f) => toAssistantFile(f, ctx.userId, label)),
      },
      suggestions: [`Tải file lên thư mục ${label}`, `Tạo file ghi chú trong thư mục ${label}`],
      memory: { items: fileRows.map((f) => f.id), focus: fileRows.length === 1 ? fileRows[0].id : null },
    };
  },
};

const listTrash: AgentTool = {
  name: "list_trash",
  title: "Xem thùng rác",
  description: "Liệt kê các mục bạn đã xóa (còn khôi phục được).",
  effect: "read",
  patterns: [
    "(xem|mo|liet ke|kiem tra) thung rac",
    "thung rac (co gi|co nhung gi|co file nao)",
    "trong thung rac co (gi|nhung gi|file nao)",
    "(nhung|cac) (file|muc|thu muc) (da xoa|trong thung rac|bi xoa)",
  ],
  examples: ["Xem thùng rác", "Trong thùng rác có gì?"],
  async run({ ctx }) {
    const rows = ((await rpc(ctx, "list_trash", {})) ?? []) as { item_type: "file" | "folder"; id: string; name: string; deleted_at: string }[];
    return {
      type: "done",
      text: rows.length ? `Thùng rác có ${rows.length} mục. Bạn có thể nói “khôi phục <tên>” để lấy lại.` : "Thùng rác đang trống.",
      reply: {
        folders: rows.filter((r) => r.item_type === "folder").slice(0, LIST_LIMIT).map((r) => ({ id: r.id, name: r.name, openUrl: "/trash" })),
        trash: rows.filter((r) => r.item_type === "file").slice(0, LIST_LIMIT).map((r) => ({ id: r.id, name: r.name, deletedAt: r.deleted_at })),
      },
      suggestions: rows.slice(0, 2).map((r) => `Khôi phục ${r.name}`),
    };
  },
};

const listLinks: AgentTool = {
  name: "list_links",
  title: "Xem link đã lưu",
  description: "Liệt kê các link bạn đã lưu.",
  effect: "read",
  patterns: [
    "(xem|liet ke|mo|hien thi) (cac|nhung|danh sach)? (link|lien ket|duong dan|url) (da luu|cua toi|cua minh|quan trong)?",
    "(link|lien ket|duong dan) (da luu|cua toi|cua minh)",
  ],
  examples: ["Xem các link đã lưu"],
  async run({ ctx }) {
    const { data, error } = await ctx.supabase.from("saved_links").select("id, title, url").order("created_at", { ascending: false }).limit(LIST_LIMIT);
    if (error) return { type: "error", text: "Chức năng lưu link chưa được cài đặt (cần migration 202608280019)." };
    const links = (data ?? []) as { id: string; title: string; url: string }[];
    return {
      type: "done",
      text: links.length ? `Bạn đã lưu ${links.length} link:` : "Bạn chưa lưu link nào. Thử: “Lưu link https://… tiêu đề …”.",
      reply: { links: links.map((l) => ({ id: l.id, title: l.title, url: l.url })) },
    };
  },
};

const listComments: AgentTool = {
  name: "list_comments",
  title: "Xem bình luận",
  description: "Đọc các bình luận trên một file hoặc thư mục.",
  effect: "read",
  patterns: [
    "(xem|doc|liet ke|hien thi) (cac|nhung)? (binh luan|comment|nhan xet) (cua|ve|tren|o|trong)? (thu muc|folder) {folder}",
    "(xem|doc|liet ke|hien thi) (cac|nhung)? (binh luan|comment|nhan xet) (cua|ve|tren|o|trong)? {file}",
  ],
  examples: ["Xem bình luận của file Hợp đồng.docx"],
  slots: { file: { ask: "Bạn muốn xem bình luận của file nào?" } },
  async run({ args, picked, ctx, memory }) {
    let target: { kind: "file" | "folder"; id: string; name: string };
    if (args.folder || picked.folder) {
      const r = await resolveFolder(ctx, { text: args.folder, picked: picked.folder });
      if (r.kind !== "one") return unresolved(r, "folder", "thư mục", args.folder);
      target = { kind: "folder", id: r.item.id, name: r.item.name };
    } else {
      const r = await resolveFile(ctx, { text: args.file, picked: picked.file, memory });
      if (r.kind !== "one") return unresolved(r, "file", "file", args.file, { pass: !picked.file });
      target = { kind: "file", id: r.item.id, name: r.item.name };
    }
    const rows = ((await rpc(ctx, "list_item_comments", {
      p_file_id: target.kind === "file" ? target.id : null,
      p_folder_id: target.kind === "folder" ? target.id : null,
    })) ?? []) as { author_email: string | null; body: string; created_at: string }[];
    const lines = rows.slice(-10).map((c) => `• ${c.author_email ?? "?"}: ${c.body.length > 300 ? `${c.body.slice(0, 300)}…` : c.body}`);
    return {
      type: "done",
      text: rows.length
        ? `“${target.name}” có ${rows.length} bình luận${rows.length > 10 ? " (10 bình luận mới nhất)" : ""}:\n${lines.join("\n")}`
        : `“${target.name}” chưa có bình luận nào.`,
      suggestions: [`Bình luận vào ${target.kind === "folder" ? "thư mục " : ""}${target.name} rằng …`],
      memory: target.kind === "file" ? { focus: target.id } : undefined,
    };
  },
};

const uploadToFolder: AgentTool = {
  name: "upload_to_folder",
  title: "Tải file từ máy lên thư mục",
  description: "Mở hộp chọn file để tải lên đúng thư mục.",
  effect: "read",
  patterns: [
    "(tai len|tai|upload|up|day) (file|tep|tai lieu)? (moi)? (vao|len|toi|vo) (trong)? (thu muc|folder)? {folder}",
    "(them|tai|dua|up|upload|chep) (file|tep|tai lieu)? (moi)? (tu may|tu may tinh|tu thiet bi|tu dien thoai) (vao|len|toi|vo) (trong)? (thu muc|folder)? {folder}",
    "(them|dua|bo) (file|tep|tai lieu) (moi)? (vao|len|toi|vo) (trong)? (thu muc|folder) {folder}",
    "(tai len|upload) (file|tep|tai lieu)?",
  ],
  examples: ["Tải file lên thư mục Kế toán", "Thêm file từ máy vào thư mục Dự án"],
  async run({ args, picked, ctx }) {
    const dest = args.folder || picked.folder ? await destination(ctx, args.folder, picked.folder, "folder") : { id: null, label: "My Files (thư mục gốc)" };
    if (isOutcome(dest)) return dest;
    return {
      type: "done",
      text: `Bấm nút bên dưới để chọn file từ máy, file sẽ được tải vào “${dest.label}”.`,
      clientAction: { kind: "upload", folderId: dest.id, folderName: dest.label },
    };
  },
};

const refusePermanent: AgentTool = {
  name: "refuse_permanent_delete",
  title: "Xóa vĩnh viễn (không hỗ trợ)",
  description: "",
  effect: "read",
  patterns: ["(xoa|huy) (vinh vien|han|luon|sach) {item?}", "(don sach|lam trong|xoa het) thung rac"],
  examples: ["Xóa vĩnh viễn file cũ"],
  async run() {
    return { type: "done", text: "Xóa vĩnh viễn không thể hoàn tác nên tôi không làm qua trợ lý. Bạn hãy vào trang Thùng rác để xóa vĩnh viễn.", reply: {} };
  },
};

// ---------------------------------------------------------------- write tools

const createFolder: AgentTool = {
  name: "create_folder",
  title: "Tạo thư mục",
  description: "Tạo thư mục mới (có thể bên trong một thư mục khác).",
  effect: "write",
  patterns: [
    "(tao|them|lam) (mot|1)? (thu muc|folder) (moi)? (ten la|ten|co ten|la|named)? {name} (trong|ben trong|o trong|tai|vao) (thu muc|folder)? {parent}",
    "(tao|them|lam) (mot|1)? (thu muc|folder) (moi)? (ten la|ten|co ten|la|named)? {name}",
  ],
  examples: ["Tạo thư mục Báo cáo 2027", "Tạo thư mục Hóa đơn trong thư mục Kế toán"],
  slots: { name: { required: true, ask: "Thư mục mới tên là gì?" } },
  async run({ args, picked, ctx }) {
    const name = cleanName(args.name);
    if (!name) return { type: "ask", slot: "name", text: "Tên thư mục không hợp lệ (không chứa / \\ : * ? \" < > |). Bạn đặt tên khác nhé?" };
    let parent: { id: string | null; label: string } = { id: null, label: "My Files" };
    if (args.parent || picked.parent) {
      const dest = await destination(ctx, args.parent, picked.parent, "parent");
      if (isOutcome(dest)) return dest;
      parent = dest;
    }
    return {
      type: "confirm",
      title: "Tạo thư mục",
      summary: `Tạo thư mục “${name}” trong “${parent.label}”.`,
      params: { name, parentId: parent.id },
    };
  },
  async execute(params, ctx) {
    const name = cleanName(str(params.name));
    if (!name) return { ok: false, message: "Tên thư mục không hợp lệ." };
    const { data, error } = await ctx.supabase.rpc("create_folder", { p_parent_id: idOrNull(params.parentId), p_name: name, p_comment: null }).select().single();
    if (error) rpcError(error);
    const id = (data as { id: string }).id;
    return { ok: true, message: `Đã tạo thư mục “${name}”.`, openUrl: folderLink(id) };
  },
};

function moveOrCopy(mode: "move" | "copy"): AgentTool {
  const verb = mode === "move" ? "Chuyển" : "Sao chép";
  return {
    name: mode === "move" ? "move_file" : "copy_file",
    title: mode === "move" ? "Chuyển / thêm file vào thư mục" : "Sao chép file vào thư mục",
    description: "",
    effect: "write",
    patterns:
      mode === "move"
        ? [
            "(chuyen|di chuyen) {file} (vao|sang|toi|den|vo|qua) (trong)? (thu muc|folder)? {folder}",
            // other verbs are common in searches ("thêm ghi chú vào hợp đồng"): they need "thư mục"
            "(dua|them|bo|xep|cat) {file} (vao|sang|toi|den|vo|qua) (trong)? (thu muc|folder) {folder}",
            // a bare "chuyển …" could be a search ("chuyển khoản tháng 9"); only the explicit verb
            "di chuyen (file|tep) {file}",
          ]
        : ["(sao chep|copy|nhan ban|chep) {file} (vao|sang|toi|den|vo|qua) (trong)? (thu muc|folder)? {folder}", "(sao chep|copy|nhan ban) {file}"],
    examples: mode === "move" ? ["Thêm file Hợp đồng.docx vào thư mục Kế toán", "Chuyển file thứ hai vào thư mục gốc"] : ["Sao chép file Báo cáo.pdf vào thư mục Lưu trữ"],
    // the destination is asked for only once the file is known, so a message
    // that merely looks like a command ("copy link") can still pass to the engine
    slots: {
      file: { required: true, ask: `Bạn muốn ${verb.toLowerCase()} file nào?` },
      folder: { ask: "Vào thư mục nào? (hoặc “thư mục gốc”)" },
    },
    async run({ args, picked, ctx, memory }) {
      const file = await resolveFile(ctx, { text: args.file, picked: picked.file, memory });
      if (file.kind !== "one") return unresolved(file, "file", "file", args.file, { pass: !picked.file });
      if (!args.folder && !picked.folder) return { type: "ask", slot: "folder", text: "Vào thư mục nào? (hoặc “thư mục gốc”)" };
      const dest = await destination(ctx, args.folder, picked.folder, "folder");
      if (isOutcome(dest)) return dest;
      if (mode === "move" && file.item.folder_id === dest.id) {
        return { type: "done", text: `“${file.item.name}” đã ở trong “${dest.label}” rồi.`, memory: { focus: file.item.id } };
      }
      return {
        type: "confirm",
        title: mode === "move" ? "Chuyển file" : "Sao chép file",
        summary: `${verb} “${file.item.name}” vào “${dest.label}”.`,
        params: { fileId: file.item.id, folderId: dest.id },
        // "… rồi đổi tên nó": "nó" is the file just moved (a copy gets a new id)
        memory: { focus: mode === "move" ? file.item.id : null },
      };
    },
    async execute(params, ctx) {
      const fileId = idOrNull(params.fileId);
      const folderId = idOrNull(params.folderId);
      if (!fileId) return { ok: false, message: "Yêu cầu không hợp lệ." };
      if (mode === "move") {
        await rpc(ctx, "move_file", { p_id: fileId, p_folder_id: folderId });
        return { ok: true, message: "Đã chuyển file.", openUrl: openUrl(fileId, folderId) };
      }
      const source = await getFile(ctx, fileId);
      if (!source?.current_version_id) return { ok: false, message: "Không tìm thấy file (có thể đã bị xóa hoặc bạn không còn quyền)." };
      const { data: version } = await ctx.supabase.from("file_versions").select("storage_path").eq("id", source.current_version_id).maybeSingle();
      const from = (version as { storage_path: string } | null)?.storage_path;
      if (!from) return { ok: false, message: "File chưa có nội dung để sao chép." };
      const newId = randomUUID();
      const path = buildStoragePath(ctx.userId, newId, randomUUID(), source.name);
      const copied = await ctx.supabase.storage.from(UPLOADS_BUCKET).copy(from, path);
      if (copied.error) rpcError(copied.error);
      const { error } = await ctx.supabase.rpc("copy_file", { p_id: fileId, p_folder_id: folderId, p_name: source.name, p_storage_path: path, p_new_id: newId });
      if (error) {
        await ctx.supabase.storage.from(UPLOADS_BUCKET).remove([path]);
        rpcError(error);
      }
      return { ok: true, message: `Đã sao chép “${source.name}”.`, openUrl: openUrl(newId, folderId) };
    },
  };
}

const moveFolder: AgentTool = {
  name: "move_folder",
  title: "Chuyển thư mục",
  description: "",
  effect: "write",
  patterns: ["(chuyen|di chuyen|dua|bo|xep) (thu muc|folder) {folder} (vao|sang|toi|den|vo|qua) (trong)? (thu muc|folder)? {dest}"],
  examples: ["Chuyển thư mục Hóa đơn vào thư mục Kế toán"],
  slots: { folder: { required: true, ask: "Bạn muốn chuyển thư mục nào?" }, dest: { required: true, ask: "Vào thư mục nào?" } },
  async run({ args, picked, ctx }) {
    const folder = await resolveFolder(ctx, { text: args.folder, picked: picked.folder });
    if (folder.kind !== "one") return unresolved(folder, "folder", "thư mục", args.folder);
    const dest = await destination(ctx, args.dest, picked.dest, "dest");
    if (isOutcome(dest)) return dest;
    if (dest.id === folder.item.id) return { type: "error", text: "Không thể chuyển một thư mục vào chính nó." };
    return {
      type: "confirm",
      title: "Chuyển thư mục",
      summary: `Chuyển thư mục “${folder.item.name}” (và mọi thứ bên trong) vào “${dest.label}”.`,
      params: { folderId: folder.item.id, parentId: dest.id },
    };
  },
  async execute(params, ctx) {
    const id = idOrNull(params.folderId);
    if (!id) return { ok: false, message: "Yêu cầu không hợp lệ." };
    await rpc(ctx, "move_folder", { p_id: id, p_new_parent_id: idOrNull(params.parentId) });
    return { ok: true, message: "Đã chuyển thư mục.", openUrl: folderLink(id) };
  },
};

const renameItem: AgentTool = {
  name: "rename",
  title: "Đổi tên file hoặc thư mục",
  description: "",
  effect: "write",
  patterns: [
    "doi ten (thu muc|folder) {folder} (thanh|sang|la|qua) {name}",
    "doi ten {file} (thanh|sang|la|qua) {name}",
    "(dat lai ten|sua ten) (thu muc|folder) {folder} (thanh|sang|la|qua) {name}",
    "(dat lai ten|sua ten) {file} (thanh|sang|la|qua) {name}",
  ],
  examples: ["Đổi tên file Báo cáo.pdf thành Báo cáo Q3.pdf", "Đổi tên thư mục Cũ thành Lưu trữ"],
  slots: { name: { required: true, ask: "Tên mới là gì?" } },
  async run({ args, picked, ctx, memory }) {
    const raw = cleanName(args.name);
    if (!raw) return { type: "ask", slot: "name", text: "Tên mới không hợp lệ (không chứa / \\ : * ? \" < > |). Bạn chọn tên khác nhé?" };
    if (args.folder || picked.folder) {
      const folder = await resolveFolder(ctx, { text: args.folder, picked: picked.folder });
      if (folder.kind !== "one") return unresolved(folder, "folder", "thư mục", args.folder);
      return { type: "confirm", title: "Đổi tên thư mục", summary: `Đổi tên thư mục “${folder.item.name}” thành “${raw}”.`, params: { kind: "folder", id: folder.item.id, name: raw } };
    }
    const file = await resolveFile(ctx, { text: args.file, picked: picked.file, memory });
    if (file.kind !== "one") return unresolved(file, "file", "file", args.file);
    // keep the extension when the new name has none ("thành Báo cáo Q3")
    const ext = file.item.name.match(/\.[A-Za-z0-9]{1,10}$/)?.[0] ?? "";
    const name = ext && !/\.[A-Za-z0-9]{1,10}$/.test(raw) ? `${raw}${ext}` : raw;
    return {
      type: "confirm",
      title: "Đổi tên file",
      summary: `Đổi tên “${file.item.name}” thành “${name}”.`,
      params: { kind: "file", id: file.item.id, name },
      memory: { focus: file.item.id },
    };
  },
  async execute(params, ctx) {
    const id = idOrNull(params.id);
    const name = cleanName(str(params.name));
    if (!id || !name) return { ok: false, message: "Yêu cầu không hợp lệ." };
    await rpc(ctx, params.kind === "folder" ? "rename_folder" : "rename_file", { p_id: id, p_name: name });
    return { ok: true, message: `Đã đổi tên thành “${name}”.`, openUrl: params.kind === "folder" ? folderLink(id) : undefined };
  },
};

const trashItem: AgentTool = {
  name: "trash",
  title: "Chuyển vào thùng rác",
  description: "Xóa tạm (khôi phục được trong Thùng rác).",
  effect: "write",
  patterns: [
    "(xoa|bo|go) (thu muc|folder) {folder}",
    "(dua|chuyen|cho|bo|nem) (thu muc|folder) {folder} (vao|sang) thung rac",
    "(dua|chuyen|cho|bo|nem) {file} (vao|sang) thung rac",
    "(xoa|go bo) {file}",
  ],
  examples: ["Xóa file Bản nháp.docx", "Đưa thư mục Cũ vào thùng rác"],
  async run({ args, picked, ctx, memory }) {
    if (args.folder || picked.folder) {
      const folder = await resolveFolder(ctx, { text: args.folder, picked: picked.folder });
      if (folder.kind !== "one") return unresolved(folder, "folder", "thư mục", args.folder);
      if (folder.item.owner_id !== ctx.userId) return { type: "error", text: "Chỉ chủ sở hữu mới xóa được thư mục này." };
      return {
        type: "confirm",
        title: "Chuyển thư mục vào thùng rác",
        summary: `Chuyển thư mục “${folder.item.name}” và mọi thứ bên trong vào thùng rác.`,
        params: { kind: "folder", id: folder.item.id },
        warning: "Bạn có thể khôi phục trong Thùng rác.",
      };
    }
    const file = await resolveFile(ctx, { text: args.file, picked: picked.file, memory });
    if (file.kind !== "one") return unresolved(file, "file", "file", args.file);
    if (file.item.owner_id !== ctx.userId) return { type: "error", text: "Chỉ chủ sở hữu mới xóa được file này." };
    return {
      type: "confirm",
      title: "Chuyển file vào thùng rác",
      summary: `Chuyển “${file.item.name}” vào thùng rác.`,
      params: { kind: "file", id: file.item.id },
      warning: "Bạn có thể khôi phục trong Thùng rác.",
    };
  },
  async execute(params, ctx) {
    const id = idOrNull(params.id);
    if (!id) return { ok: false, message: "Yêu cầu không hợp lệ." };
    await rpc(ctx, params.kind === "folder" ? "soft_delete_folder" : "soft_delete_file", { p_id: id });
    return { ok: true, message: "Đã chuyển vào thùng rác.", openUrl: "/trash" };
  },
};

const restoreItem: AgentTool = {
  name: "restore",
  title: "Khôi phục từ thùng rác",
  description: "",
  effect: "write",
  patterns: ["(khoi phuc|phuc hoi|lay lai|restore|hoan tac xoa) (thu muc|folder) {folder}", "(khoi phuc|phuc hoi|lay lai|restore|hoan tac xoa) {file}"],
  examples: ["Khôi phục file Bản nháp.docx"],
  async run({ args, picked, ctx, memory }) {
    if (args.folder || picked.folder) {
      const folder = await resolveFolder(ctx, { text: args.folder, picked: picked.folder, deleted: true });
      if (folder.kind !== "one") return unresolved(folder, "folder", "thư mục trong thùng rác", args.folder, { pass: !picked.folder });
      return { type: "confirm", title: "Khôi phục thư mục", summary: `Khôi phục thư mục “${folder.item.name}”.`, params: { kind: "folder", id: folder.item.id } };
    }
    const file = await resolveFile(ctx, { text: args.file, picked: picked.file, memory, deleted: true });
    if (file.kind !== "one") return unresolved(file, "file", "file trong thùng rác", args.file, { pass: !picked.file });
    return { type: "confirm", title: "Khôi phục file", summary: `Khôi phục “${file.item.name}”.`, params: { kind: "file", id: file.item.id } };
  },
  async execute(params, ctx) {
    const id = idOrNull(params.id);
    if (!id) return { ok: false, message: "Yêu cầu không hợp lệ." };
    await rpc(ctx, params.kind === "folder" ? "restore_folder" : "restore_file", { p_id: id });
    if (params.kind === "folder") return { ok: true, message: "Đã khôi phục thư mục.", openUrl: folderLink(id) };
    const file = await getFile(ctx, id);
    return { ok: true, message: "Đã khôi phục file.", openUrl: file ? openUrl(id, file.folder_id) : undefined };
  },
};

const shareItem: AgentTool = {
  name: "share",
  title: "Chia sẻ file hoặc thư mục",
  description: "Chia sẻ với một người (quyền xem hoặc chỉnh sửa).",
  effect: "write",
  patterns: [
    "(chia se|share|cap quyen) (thu muc|folder) {folder} (voi|cho) {email} (voi)? (quyen)? {role?}",
    "(chia se|share|cap quyen) {file} (voi|cho) {email} (voi)? (quyen)? {role?}",
  ],
  examples: ["Chia sẻ file Hợp đồng.docx với an@example.com quyền xem", "Chia sẻ thư mục Dự án với an@example.com quyền chỉnh sửa"],
  slots: { email: { type: "email", required: true, ask: "Chia sẻ với e-mail nào?" }, role: { type: "role", ask: "Quyền xem hay chỉnh sửa?" } },
  async run({ args, picked, ctx, memory }) {
    const role = args.role === "editor" ? "editor" : "viewer";
    if (!isEmail(args.email)) return { type: "ask", slot: "email", text: "E-mail chưa hợp lệ. Bạn nhập lại giúp tôi?" };
    const roleLabel = role === "editor" ? "chỉnh sửa" : "chỉ xem";
    if (args.folder || picked.folder) {
      const folder = await resolveFolder(ctx, { text: args.folder, picked: picked.folder });
      if (folder.kind !== "one") return unresolved(folder, "folder", "thư mục", args.folder);
      return {
        type: "confirm",
        title: "Chia sẻ thư mục",
        summary: `Chia sẻ thư mục “${folder.item.name}” (cả nội dung bên trong) với ${args.email}, quyền ${roleLabel}.`,
        params: { kind: "folder", id: folder.item.id, email: args.email, role },
        warning: `${args.email} sẽ thấy mọi file trong thư mục này.`,
      };
    }
    const file = await resolveFile(ctx, { text: args.file, picked: picked.file, memory });
    if (file.kind !== "one") return unresolved(file, "file", "file", args.file);
    return {
      type: "confirm",
      title: "Chia sẻ file",
      summary: `Chia sẻ “${file.item.name}” với ${args.email}, quyền ${roleLabel}.`,
      params: { kind: "file", id: file.item.id, email: args.email, role },
    };
  },
  async execute(params, ctx) {
    const id = idOrNull(params.id);
    const email = str(params.email).toLowerCase();
    const role = params.role === "editor" ? "editor" : "viewer";
    if (!id || !isEmail(email)) return { ok: false, message: "Yêu cầu không hợp lệ." };
    if (params.kind === "folder") await rpc(ctx, "share_folder", { p_folder_id: id, p_grantee_email: email, p_role: role });
    else await rpc(ctx, "share_file", { p_file_id: id, p_grantee_email: email, p_role: role });
    return { ok: true, message: `Đã chia sẻ với ${email} (${role === "editor" ? "chỉnh sửa" : "chỉ xem"}).` };
  },
};

const createTextFile: AgentTool = {
  name: "create_text_file",
  title: "Tạo file văn bản",
  description: "Tạo file .txt với nội dung bạn đọc cho tôi.",
  effect: "write",
  patterns: [
    "(tao|viet|soan|lam) (mot|1)? (file|tep) (van ban|text)? (ten la|ten|co ten|la)? {name} (trong|tai|o|vao) (thu muc|folder)? {folder} (voi|co)? (noi dung|nd) (la)? {content}",
    "(tao|viet|soan|lam) (mot|1)? (file|tep) (van ban|text)? (ten la|ten|co ten|la)? {name} (voi|co)? (noi dung|nd) (la)? {content}",
    "(tao|viet|soan|lam) (mot|1)? (file|tep) (van ban|text|txt)? (ten la|ten|co ten|la)? {name} (trong|tai|o|vao) (thu muc|folder) {folder}",
    // without content or folder it must say it is a text file: "tạo file báo
    // cáo tháng 9" is the assistant's export, "tạo file văn bản ghi chú" is ours
    "(tao|viet|soan|lam) (mot|1)? (file|tep) (van ban|text|txt) (ten la|ten|co ten|la)? {name}",
    "(tao|viet|soan|lam) (mot|1)? (file|tep) {name} txt",
  ],
  examples: ["Tạo file ghi chú họp.txt trong thư mục Dự án nội dung Họp lúc 9h", "Tạo file todo.txt nội dung Gọi khách hàng"],
  slots: {
    name: { required: true, ask: "File mới tên là gì?" },
    content: { required: true, multiline: true, ask: "Nội dung của file là gì? (có thể viết nhiều dòng)" },
  },
  async run({ args, picked, ctx }) {
    const name = ensureTextFileName(args.name);
    let dest: { id: string | null; label: string } = { id: null, label: "My Files (thư mục gốc)" };
    if (args.folder || picked.folder) {
      const d = await destination(ctx, args.folder, picked.folder, "folder");
      if (isOutcome(d)) return d;
      dest = d;
    }
    const content = args.content.slice(0, TEXT_MAX);
    const preview = content.length > 120 ? `${content.slice(0, 120)}…` : content;
    return {
      type: "confirm",
      title: "Tạo file văn bản",
      summary: `Tạo “${name}” trong “${dest.label}” với nội dung: “${preview}”`,
      params: { name, folderId: dest.id, content },
      // the new file has no id yet: "… rồi xóa nó" must not hit another file
      memory: { focus: null, items: [] },
    };
  },
  async execute(params, ctx) {
    const name = ensureTextFileName(str(params.name));
    const content = str(params.content).slice(0, TEXT_MAX);
    const folderId = idOrNull(params.folderId);
    const fileId = await uploadNewFile(ctx, name, folderId, new TextEncoder().encode(content), textMimeType(name));
    return { ok: true, message: `Đã tạo file “${name}”.`, openUrl: openUrl(fileId, folderId) };
  },
};

const addComment: AgentTool = {
  name: "add_comment",
  title: "Bình luận vào file hoặc thư mục",
  description: "",
  effect: "write",
  patterns: [
    "(binh luan|comment|nhan xet|gop y) (vao|cho|tren|len|o|ve) (thu muc|folder) {folder} (rang|noi dung|voi noi dung|la|nhu sau) {body}",
    "(binh luan|comment|nhan xet|gop y) (vao|cho|tren|len|o|ve) {file} (rang|noi dung|voi noi dung|la|nhu sau) {body}",
    "(binh luan|comment|nhan xet|gop y) (vao|cho|tren|len|o|ve) (thu muc|folder) {folder}",
    "(binh luan|comment|nhan xet|gop y) (vao|cho|tren|len|o|ve) {file}",
  ],
  examples: ["Bình luận vào file Hợp đồng.docx rằng đã duyệt", "Bình luận vào thư mục Dự án rằng cần cập nhật tuần này"],
  slots: { body: { required: true, multiline: true, ask: "Bạn muốn bình luận gì? (có thể viết nhiều dòng)" } },
  async run({ args, picked, ctx, memory }) {
    const body = args.body.trim().slice(0, COMMENT_MAX);
    let target: { kind: "file" | "folder"; id: string; name: string };
    if (args.folder || picked.folder) {
      const r = await resolveFolder(ctx, { text: args.folder, picked: picked.folder });
      if (r.kind !== "one") return unresolved(r, "folder", "thư mục", args.folder);
      target = { kind: "folder", id: r.item.id, name: r.item.name };
    } else {
      const r = await resolveFile(ctx, { text: args.file, picked: picked.file, memory });
      if (r.kind !== "one") return unresolved(r, "file", "file", args.file);
      target = { kind: "file", id: r.item.id, name: r.item.name };
    }
    return {
      type: "confirm",
      title: "Thêm bình luận",
      summary: `Bình luận vào ${target.kind === "folder" ? "thư mục" : "file"} “${target.name}”: “${body.length > 160 ? `${body.slice(0, 160)}…` : body}”`,
      params: { kind: target.kind, id: target.id, body },
    };
  },
  async execute(params, ctx) {
    const id = idOrNull(params.id);
    const body = str(params.body).slice(0, COMMENT_MAX);
    if (!id || !body.trim()) return { ok: false, message: "Yêu cầu không hợp lệ." };
    await rpc(ctx, "add_item_comment", {
      p_file_id: params.kind === "folder" ? null : id,
      p_folder_id: params.kind === "folder" ? id : null,
      p_body: body,
    });
    return { ok: true, message: "Đã thêm bình luận." };
  },
};

const saveLink: AgentTool = {
  name: "save_link",
  title: "Lưu link",
  description: "Lưu một URL kèm tiêu đề vào danh sách link.",
  effect: "write",
  patterns: [
    "(luu|them|ghi|ghi lai) (link|lien ket|duong dan|url) {url} (voi)? (tieu de|ten|title|ten la) {title}",
    "(luu|them|ghi|ghi lai) (link|lien ket|duong dan|url) (voi)? (tieu de|ten|title) {title} (la|url|link|dia chi) {url}",
    "(luu|them|ghi|ghi lai) (link|lien ket|duong dan|url) {url}",
  ],
  examples: ["Lưu link https://example.com/tien-do tiêu đề Link cập nhật tiến độ mỗi ngày"],
  slots: {
    url: { type: "url", required: true, ask: "URL là gì?" },
    title: { required: true, ask: "Đặt tiêu đề cho link này là gì?" },
  },
  async run({ args }) {
    const url = normalizeUrl(args.url);
    if (!url) return { type: "ask", slot: "url", text: "URL chưa hợp lệ (chỉ nhận http:// hoặc https://). Bạn nhập lại nhé?" };
    const title = args.title.trim().slice(0, LINK_TITLE_MAX);
    return { type: "confirm", title: "Lưu link", summary: `Lưu “${title}” → ${url}`, params: { url, title } };
  },
  async execute(params, ctx) {
    const url = normalizeUrl(str(params.url));
    const title = str(params.title).trim().slice(0, LINK_TITLE_MAX);
    if (!url || !title) return { ok: false, message: "Yêu cầu không hợp lệ." };
    const { error } = await ctx.supabase.from("saved_links").insert({ title, url });
    if (error) rpcError(error);
    return { ok: true, message: `Đã lưu link “${title}”.`, openUrl: "/links" };
  },
};

export const FILE_MANAGER_TOOLS: AgentTool[] = [
  listFolder,
  listTrash,
  listLinks,
  listComments,
  uploadToFolder,
  refusePermanent,
  createFolder,
  moveOrCopy("move"),
  moveOrCopy("copy"),
  moveFolder,
  renameItem,
  trashItem,
  restoreItem,
  shareItem,
  createTextFile,
  addComment,
  saveLink,
];

