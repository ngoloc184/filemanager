import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { createFolder, listFolders } from "@/lib/services/folders";
import { createUploadTasks, uploadOne } from "@/lib/services/uploads";
import { getErrorMessage, type FileRow } from "@/lib/types/database";
import type { SystemMeta } from "@/lib/chat-format";

export type ChatRole = "owner" | "admin" | "member";

export type ChatSummary = {
  id: string;
  kind: "direct" | "group";
  /** group name (groups only) */
  title: string | null;
  avatar_path: string | null;
  background: string | null;
  admin_only: boolean;
  my_role: ChatRole;
  member_count: number;
  /** direct chats: the other person (or me, in notes to self) */
  other_id: string | null;
  other_email: string | null;
  other_name: string | null;
  other_avatar: string | null;
  last_message_at: string;
  last_body: string | null;
  last_file_name: string | null;
  last_sender_id: string | null;
  last_sender_name: string | null;
  last_kind: "message" | "system" | null;
  last_meta: SystemMeta | null;
  last_deleted: boolean | null;
  unread: number;
  /** direct chats: when the other member last read the conversation ("Seen") */
  other_last_read_at: string | null;
};

export type ChatReaction = { emoji: string; user_id: string };

export type ChatMessage = {
  id: string;
  sender_id: string;
  kind: "message" | "system";
  meta: SystemMeta | null;
  body: string | null;
  mentions: string[];
  file_id: string | null;
  file_name: string | null;
  file_size: number | null;
  file_mime: string | null;
  file_folder_id: string | null;
  file_version_id: string | null;
  file_available: boolean;
  reply_to_id: string | null;
  reply_sender_id: string | null;
  reply_body: string | null;
  reply_file_name: string | null;
  reply_deleted: boolean | null;
  reactions: ChatReaction[];
  created_at: string;
  deleted_at: string | null;
  /** client only: shown before the server confirmed it */
  pending?: boolean;
  failed?: boolean;
};

export type ChatMember = {
  user_id: string;
  email: string | null;
  display_name: string | null;
  avatar_path: string | null;
  role: ChatRole;
  last_read_at: string;
  joined_at: string;
};

export type ChatPin = {
  message_id: string;
  pinned_by: string | null;
  pinned_at: string;
  sender_id: string;
  body: string | null;
  file_name: string | null;
  created_at: string;
};

const CHAT_FOLDER = "Chat";

/** Readable errors, including a missing migration. */
function chatError(error: unknown): Error {
  const code = (error as { code?: string } | null)?.code;
  const message = getErrorMessage(error);
  if (code === "PGRST202" || code === "PGRST205" || /could not find the function/i.test(message)) {
    return new Error("Chat is not up to date. Run migrations 202608280025_chat.sql to 202608280027_chat_groups.sql.");
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
  return ((data ?? []) as ChatSummary[]).map((c) => ({ ...c, unread: Number(c.unread), member_count: Number(c.member_count) }));
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
    .map((m) => ({ ...m, file_size: m.file_size === null ? null : Number(m.file_size), reactions: m.reactions ?? [], mentions: m.mentions ?? [] }))
    .reverse();
}

export async function sendMessage(
  conversationId: string,
  body: string | null,
  fileId: string | null = null,
  options: { id?: string; replyTo?: string | null; mentions?: string[] } = {}
): Promise<string> {
  const { data, error } = await createClient().rpc("send_chat_message", {
    p_conversation_id: conversationId,
    p_body: body,
    p_file_id: fileId,
    p_reply_to: options.replyTo ?? null,
    p_mentions: options.mentions?.length ? options.mentions : null,
    p_id: options.id ?? null,
  });
  if (error) throw chatError(error);
  return data as string;
}

export async function deleteMessage(id: string): Promise<void> {
  const { error } = await createClient().rpc("delete_chat_message", { p_id: id });
  if (error) throw chatError(error);
}

/** Toggles my reaction; returns the emoji now set (null when removed). */
export async function reactToMessage(messageId: string, emoji: string): Promise<string | null> {
  const { data, error } = await createClient().rpc("react_chat_message", { p_message_id: messageId, p_emoji: emoji });
  if (error) throw chatError(error);
  return (data as string | null) ?? null;
}

export async function pinMessage(messageId: string): Promise<void> {
  const { error } = await createClient().rpc("pin_chat_message", { p_message_id: messageId });
  if (error) throw chatError(error);
}

export async function unpinMessage(messageId: string): Promise<void> {
  const { error } = await createClient().rpc("unpin_chat_message", { p_message_id: messageId });
  if (error) throw chatError(error);
}

export async function listPins(conversationId: string): Promise<ChatPin[]> {
  const { data, error } = await createClient().rpc("list_chat_pins", { p_conversation_id: conversationId });
  if (error) throw chatError(error);
  return (data ?? []) as ChatPin[];
}

export async function listMembers(conversationId: string): Promise<ChatMember[]> {
  const { data, error } = await createClient().rpc("list_chat_members", { p_conversation_id: conversationId });
  if (error) throw chatError(error);
  return (data ?? []) as ChatMember[];
}

// ---------------------------------------------------------------- groups

async function call(fn: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await createClient().rpc(fn, args);
  if (error) throw chatError(error);
  return data;
}

export const createGroup = async (title: string, emails: string[]) =>
  (await call("create_chat_group", { p_title: title, p_emails: emails })) as string;
export const renameGroup = (id: string, title: string) => call("rename_chat_group", { p_conversation_id: id, p_title: title });
export const setGroupAvatar = (id: string, path: string | null) => call("set_chat_group_avatar", { p_conversation_id: id, p_avatar_path: path });
export const setGroupBackground = (id: string, background: string | null) =>
  call("set_chat_group_background", { p_conversation_id: id, p_background: background });
export const setGroupAdminOnly = (id: string, adminOnly: boolean) =>
  call("set_chat_group_admin_only", { p_conversation_id: id, p_admin_only: adminOnly });
export const addMembers = async (id: string, emails: string[]) =>
  Number(await call("add_chat_members", { p_conversation_id: id, p_emails: emails }));
export const removeMember = (id: string, userId: string) => call("remove_chat_member", { p_conversation_id: id, p_user_id: userId });
export const setMemberRole = (id: string, userId: string, role: "admin" | "member") =>
  call("set_chat_member_role", { p_conversation_id: id, p_user_id: userId, p_role: role });
export const transferOwnership = (id: string, userId: string) =>
  call("transfer_chat_ownership", { p_conversation_id: id, p_user_id: userId });
export const leaveGroup = (id: string) => call("leave_chat_group", { p_conversation_id: id });
export const deleteGroup = (id: string) => call("delete_chat_group", { p_conversation_id: id });

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

/** A change to a chat message, as delivered by Realtime. */
export type ChatMessageEvent = {
  event: "INSERT" | "UPDATE" | "DELETE";
  id: string;
  conversation_id: string;
  sender_id: string;
  kind: "message" | "system";
  meta: SystemMeta | null;
  body: string | null;
  mentions: string[];
  file_id: string | null;
  file_name: string | null;
  reply_to_id: string | null;
  created_at: string;
  deleted_at: string | null;
};

type Row = Record<string, unknown>;
const rowOf = (payload: RealtimePostgresChangesPayload<Row>): Row =>
  (payload.new && Object.keys(payload.new).length ? payload.new : payload.old) as Row;

function messageEvent(payload: RealtimePostgresChangesPayload<Row>): ChatMessageEvent | null {
  const row = rowOf(payload);
  if (!row?.conversation_id) return null;
  return {
    event: payload.eventType,
    id: row.id as string,
    conversation_id: row.conversation_id as string,
    sender_id: row.sender_id as string,
    kind: (row.kind as "message" | "system") ?? "message",
    meta: (row.meta as SystemMeta | null) ?? null,
    body: (row.body as string | null) ?? null,
    mentions: (row.mentions as string[] | null) ?? [],
    file_id: (row.file_id as string | null) ?? null,
    file_name: (row.file_name as string | null) ?? null,
    reply_to_id: (row.reply_to_id as string | null) ?? null,
    created_at: row.created_at as string,
    deleted_at: (row.deleted_at as string | null) ?? null,
  };
}

const suffix = () => Math.random().toString(36).slice(2);

/**
 * Calls `onResync` when the channel connects again after a drop (laptop
 * asleep, network change): events missed meanwhile are never replayed.
 */
function resyncOnReconnect(onResync?: () => void) {
  let connected = false;
  return (status: string) => {
    if (status !== "SUBSCRIBED") return;
    if (connected) onResync?.();
    connected = true;
  };
}

// Only INSERT and UPDATE events are used: Realtime cannot filter DELETE events
// or check row-level security for them, so removals are updates (a reaction's
// emoji becomes null) or arrive as system messages (unpin, remove, leave).

/**
 * Realtime for the chat list and badge: new or changed messages in any of my
 * conversations, and being added to a group (row-level security limits
 * events to conversations the user belongs to).
 */
export function subscribeToChats(
  userId: string,
  handlers: { onMessage: (row: ChatMessageEvent) => void; onListChange: () => void; onResync?: () => void }
) {
  const supabase = createClient();
  const onMessage = (payload: RealtimePostgresChangesPayload<Row>) => {
    const event = messageEvent(payload);
    if (event) handlers.onMessage(event);
  };
  const channel = supabase
    .channel(`chat-all-${suffix()}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages" }, onMessage)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "chat_messages" }, onMessage)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_members", filter: `user_id=eq.${userId}` }, () =>
      handlers.onListChange()
    )
    .subscribe(resyncOnReconnect(handlers.onResync));
  return () => {
    void supabase.removeChannel(channel);
  };
}

/**
 * Realtime for the open conversation, on one channel: messages (including the
 * system messages that announce pins and group changes), reactions, and
 * members' read receipts and roles.
 */
export function subscribeToConversation(
  conversationId: string,
  handlers: {
    onMessage: (row: ChatMessageEvent) => void;
    onReaction: (row: { message_id: string; user_id: string; emoji: string | null }) => void;
    onMember: (row: { user_id: string; last_read_at: string; role: string }) => void;
    onResync?: () => void;
  }
) {
  const supabase = createClient();
  const filter = `conversation_id=eq.${conversationId}`;
  const onMessage = (payload: RealtimePostgresChangesPayload<Row>) => {
    const event = messageEvent(payload);
    if (event) handlers.onMessage(event);
  };
  const onReaction = (payload: RealtimePostgresChangesPayload<Row>) => {
    const row = payload.new as { message_id?: string; user_id?: string; emoji?: string | null };
    if (row?.message_id && row.user_id) handlers.onReaction({ message_id: row.message_id, user_id: row.user_id, emoji: row.emoji ?? null });
  };
  const channel = supabase
    .channel(`chat-${conversationId}-${suffix()}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages", filter }, onMessage)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "chat_messages", filter }, onMessage)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_reactions", filter }, onReaction)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "chat_reactions", filter }, onReaction)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "chat_members", filter }, (payload: RealtimePostgresChangesPayload<Row>) => {
      const row = payload.new as { user_id?: string; last_read_at?: string; role?: string };
      if (row?.user_id && row.last_read_at && row.role) handlers.onMember({ user_id: row.user_id, last_read_at: row.last_read_at, role: row.role });
    })
    .subscribe(resyncOnReconnect(handlers.onResync));
  return () => {
    void supabase.removeChannel(channel);
  };
}

// Typing channels are shared and closed a little after the last user leaves:
// the topic must be exact (the Realtime policy checks it), and reopening a
// topic that is still closing would hand back a dead channel.
type TypingChannel = {
  channel: ReturnType<ReturnType<typeof createClient>["channel"]>;
  listeners: Set<(userId: string) => void>;
  refs: number;
  closeTimer: ReturnType<typeof setTimeout> | null;
};
const typingChannels = new Map<string, TypingChannel>();

/**
 * "… is typing": Realtime broadcast on the private topic typing:<id>
 * (members only once the project enforces private channels). Nothing is stored.
 */
export function joinTyping(conversationId: string, userId: string, onTyping: (userId: string) => void) {
  const supabase = createClient();
  let entry = typingChannels.get(conversationId);
  if (!entry) {
    const channel = supabase.channel(`typing:${conversationId}`, { config: { private: true, broadcast: { self: false } } });
    const created: TypingChannel = { channel, listeners: new Set(), refs: 0, closeTimer: null };
    channel.on("broadcast", { event: "typing" }, ({ payload }: { payload: unknown }) => {
      const from = (payload as { user_id?: unknown } | null)?.user_id;
      if (typeof from === "string") created.listeners.forEach((l) => l(from));
    });
    channel.subscribe();
    typingChannels.set(conversationId, created);
    entry = created;
  }
  const shared = entry;
  if (shared.closeTimer) clearTimeout(shared.closeTimer);
  shared.closeTimer = null;
  shared.refs += 1;
  const listener = (from: string) => {
    if (from !== userId) onTyping(from);
  };
  shared.listeners.add(listener);

  let last = 0;
  let left = false;
  return {
    /** at most every 2 seconds while typing */
    typing() {
      const now = Date.now();
      if (left || now - last < 2000) return;
      last = now;
      void shared.channel.send({ type: "broadcast", event: "typing", payload: { user_id: userId } });
    },
    leave() {
      if (left) return;
      left = true;
      shared.listeners.delete(listener);
      shared.refs -= 1;
      if (shared.refs > 0) return;
      shared.closeTimer = setTimeout(() => {
        typingChannels.delete(conversationId);
        void supabase.removeChannel(shared.channel);
      }, 15000);
    },
  };
}
