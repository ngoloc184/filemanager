import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { createFolder, listFolders } from "@/lib/services/folders";
import { createUploadTasks, uploadOne } from "@/lib/services/uploads";
import { getErrorMessage, type FileRow } from "@/lib/types/database";

export type ChatSummary = {
  id: string;
  other_id: string;
  other_email: string | null;
  last_message_at: string;
  last_body: string | null;
  last_file_name: string | null;
  last_sender_id: string | null;
  last_deleted: boolean | null;
  unread: number;
  /** when the other member last read the conversation ("Seen") */
  other_last_read_at: string | null;
};

export type ChatMessage = {
  id: string;
  sender_id: string;
  body: string | null;
  file_id: string | null;
  file_name: string | null;
  file_size: number | null;
  file_mime: string | null;
  file_folder_id: string | null;
  file_version_id: string | null;
  file_available: boolean;
  created_at: string;
  deleted_at: string | null;
};

const CHAT_FOLDER = "Chat";

/** Readable errors, including a missing migration. */
function chatError(error: unknown): Error {
  const code = (error as { code?: string } | null)?.code;
  const message = getErrorMessage(error);
  if (code === "PGRST202" || code === "PGRST205" || /could not find the function/i.test(message)) {
    return new Error("Chat is not set up yet. Run migration 202608280025_chat.sql.");
  }
  if (/no registered user/i.test(message)) return new Error("No registered user found for this e-mail address.");
  if (/too quickly/i.test(message)) return new Error("You are sending messages too quickly. Please wait a moment.");
  if (/own or manage/i.test(message)) return new Error("You can only send files you own or manage.");
  return new Error(message);
}

export async function startChat(email: string): Promise<string> {
  const { data, error } = await createClient().rpc("start_chat", { p_email: email.trim() });
  if (error) throw chatError(error);
  return data as string;
}

export async function listChats(): Promise<ChatSummary[]> {
  const { data, error } = await createClient().rpc("list_chats");
  if (error) throw chatError(error);
  return ((data ?? []) as ChatSummary[]).map((c) => ({ ...c, unread: Number(c.unread) }));
}

/** Newest first from the database; returned oldest first for display. */
export async function listMessages(conversationId: string, before?: string | null, limit = 50): Promise<ChatMessage[]> {
  const { data, error } = await createClient().rpc("list_chat_messages", {
    p_conversation_id: conversationId,
    p_before: before ?? null,
    p_limit: limit,
  });
  if (error) throw chatError(error);
  return ((data ?? []) as ChatMessage[])
    .map((m) => ({ ...m, file_size: m.file_size === null ? null : Number(m.file_size) }))
    .reverse();
}

export async function sendMessage(conversationId: string, body: string | null, fileId: string | null = null): Promise<string> {
  const { data, error } = await createClient().rpc("send_chat_message", {
    p_conversation_id: conversationId,
    p_body: body,
    p_file_id: fileId,
  });
  if (error) throw chatError(error);
  return data as string;
}

export async function deleteMessage(id: string): Promise<void> {
  const { error } = await createClient().rpc("delete_chat_message", { p_id: id });
  if (error) throw chatError(error);
}

export async function markRead(conversationId: string): Promise<void> {
  await createClient().rpc("mark_chat_read", { p_conversation_id: conversationId });
}

export async function unreadCount(): Promise<number> {
  const { data, error } = await createClient().rpc("chat_unread_count");
  return error ? 0 : Number(data ?? 0);
}

/** The sender's "Chat" folder, created on first use. */
async function chatFolderId(): Promise<string> {
  const existing = (await listFolders(null)).find((f) => f.name === CHAT_FOLDER);
  if (existing) return existing.id;
  try {
    return (await createFolder(null, CHAT_FOLDER, "Files sent in chats")).id;
  } catch {
    // created meanwhile (e.g. another tab)
    const again = (await listFolders(null)).find((f) => f.name === CHAT_FOLDER);
    if (again) return again.id;
    throw new Error("Could not create the Chat folder.");
  }
}

/** Uploads files from the device into the "Chat" folder, then sends each one. */
export async function sendUploads(
  userId: string,
  conversationId: string,
  files: File[],
  onProgress?: (done: number, total: number) => void
): Promise<{ sent: number; failed: string[] }> {
  const folderId = await chatFolderId();
  const failed: string[] = [];
  let sent = 0;
  for (const task of createUploadTasks(files, folderId)) {
    try {
      const row: FileRow = await uploadOne(userId, task, () => {});
      await sendMessage(conversationId, null, row.id);
      sent++;
    } catch (err) {
      failed.push(`${task.file.name}: ${getErrorMessage(err)}`);
    }
    onProgress?.(sent + failed.length, files.length);
  }
  return { sent, failed };
}

/** The user's own files for "send from My Files". */
export async function searchMyFiles(userId: string, query: string): Promise<FileRow[]> {
  const supabase = createClient();
  let q = supabase.from("files").select("*").is("deleted_at", null).eq("owner_id", userId);
  const term = query.trim();
  if (term) q = q.ilike("name", `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
  const { data, error } = await q.order("updated_at", { ascending: false }).limit(30);
  if (error) throw error;
  return (data ?? []) as FileRow[];
}

/**
 * Realtime: calls `onChange` when messages of the user's conversations change
 * (row-level security limits events to conversations the user belongs to).
 * Pass a conversation id to listen to one conversation only.
 */
export function subscribeToMessages(onChange: (row: { conversation_id: string; sender_id: string }) => void, conversationId?: string) {
  const supabase = createClient();
  const channel = supabase
    .channel(`chat-messages-${conversationId ?? "all"}-${Math.random().toString(36).slice(2)}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "chat_messages",
        ...(conversationId ? { filter: `conversation_id=eq.${conversationId}` } : {}),
      },
      (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
        const row = (payload.new && Object.keys(payload.new).length ? payload.new : payload.old) as {
          conversation_id: string;
          sender_id: string;
        };
        if (row?.conversation_id) onChange(row);
      }
    )
    .subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}

/** Realtime read receipts: the other member's last_read_at changes. */
export function subscribeToReads(conversationId: string, onRead: (row: { user_id: string; last_read_at: string }) => void) {
  const supabase = createClient();
  const channel = supabase
    .channel(`chat-reads-${conversationId}-${Math.random().toString(36).slice(2)}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "chat_members", filter: `conversation_id=eq.${conversationId}` },
      (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) =>
        onRead(payload.new as { user_id: string; last_read_at: string })
    )
    .subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}
