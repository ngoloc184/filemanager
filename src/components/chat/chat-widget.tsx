"use client";

// Floating chat (bottom-right, next to the AI Assistant): a launcher with the
// unread count, the list of people you chatted with, a field to start a chat
// with anyone by e-mail, and the conversation itself — all in one panel.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import {
  ArrowLeft,
  Check,
  CheckCheck,
  Download,
  Eye,
  FolderOpen,
  Loader2,
  MessagesSquare,
  Minus,
  NotebookPen,
  Paperclip,
  Plus,
  Search,
  SendHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { PreviewDialog } from "@/components/files/file-dialogs";
import { FileTile, fileKind } from "@/components/files/file-tile";
import { announceWidget, onOtherWidget } from "@/components/floating-widgets";
import {
  deleteMessage,
  listChats,
  listMessages,
  markRead,
  searchMyFiles,
  sendMessage,
  sendUploads,
  startChat,
  subscribeToMessages,
  subscribeToReads,
  unreadCount,
  type ChatMessage,
  type ChatSummary,
} from "@/lib/services/chat";
import { downloadFile, type PreviewableFile } from "@/lib/services/files";
import { clockTime, groupByDay, listTime, mergeMessages, messagePreview } from "@/lib/chat-format";
import { getErrorMessage, type FileRow } from "@/lib/types/database";
import { cn, formatBytes } from "@/lib/utils";

const PAGE = 50;
const OPEN_EVENT = "fm:open-chat";

/** Opens the chat widget, optionally on a conversation or with an e-mail filled in. */
export function openChat(target: { conversationId?: string; email?: string } = {}): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: target }));
}

function Avatar({ email, size = "md" }: { email: string | null; size?: "sm" | "md" }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-brand font-semibold text-white shadow-md shadow-primary/25",
        size === "sm" ? "h-8 w-8 text-xs" : "h-9 w-9 text-sm"
      )}
    >
      {email?.charAt(0).toUpperCase() || "?"}
    </span>
  );
}

const iconButton = "rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50";

function FileBubble({ message, mine, onPreview }: { message: ChatMessage; mine: boolean; onPreview: (f: PreviewableFile) => void }) {
  const file: PreviewableFile | null =
    message.file_available && message.file_id
      ? {
          id: message.file_id,
          name: message.file_name ?? "file",
          current_version_id: message.file_version_id,
          mime_type: message.file_mime ?? "application/octet-stream",
          size: message.file_size ?? 0,
        }
      : null;
  return (
    <div className={cn("flex w-60 max-w-full items-center gap-2.5 rounded-xl border p-2", mine ? "border-white/20 bg-white/10" : "bg-background/70")}>
      <FileTile kind={fileKind(message.file_mime, message.file_name ?? "")} size="sm" className={mine ? "bg-white/15 text-white ring-white/25" : undefined} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium" title={message.file_name ?? ""}>
          {message.file_name}
        </p>
        <p className={cn("text-[11px]", mine ? "text-white/70" : "text-muted-foreground")}>{file ? formatBytes(file.size) : "No longer available"}</p>
      </div>
      {file && (
        <div className="flex shrink-0">
          <button type="button" onClick={() => onPreview(file)} className={cn("rounded-md p-1", mine ? "hover:bg-white/15" : "hover:bg-muted")} aria-label={`Preview ${file.name}`}>
            <Eye className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => downloadFile(file).catch((err) => toast.error(getErrorMessage(err)))}
            className={cn("rounded-md p-1", mine ? "hover:bg-white/15" : "hover:bg-muted")}
            aria-label={`Download ${file.name}`}
          >
            <Download className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

function FilePicker({ userId, onPick, onBack }: { userId: string; onPick: (f: FileRow) => Promise<void>; onBack: () => void }) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<FileRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      searchMyFiles(userId, query)
        .then((rows) => !cancelled && setFiles(rows))
        .catch(() => !cancelled && setFiles([]));
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [userId, query]);

  return (
    <>
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <button type="button" onClick={onBack} className={iconButton} aria-label="Back to the conversation">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <p className="text-sm font-semibold">Send a file</p>
      </div>
      <div className="border-b p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your files..."
            autoFocus
            className="h-9 w-full rounded-lg border bg-background/60 pl-9 pr-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">The other person gets view access to the file you send.</p>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {files === null ? (
          <div className="flex h-24 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : files.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">No files found.</p>
        ) : (
          files.map((f) => (
            <button
              key={f.id}
              type="button"
              disabled={busy !== null}
              onClick={async () => {
                setBusy(f.id);
                try {
                  await onPick(f);
                } catch (err) {
                  toast.error(getErrorMessage(err));
                } finally {
                  setBusy(null);
                }
              }}
              className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-muted disabled:opacity-60"
            >
              <FileTile kind={fileKind(f.mime_type, f.name)} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{f.name}</p>
                <p className="text-xs text-muted-foreground">{formatBytes(f.size)}</p>
              </div>
              {busy === f.id && <Loader2 className="h-4 w-4 animate-spin" />}
            </button>
          ))
        )}
      </div>
    </>
  );
}

export function ChatWidget({ userId, email: myEmail }: { userId: string; email?: string }) {
  const [open, setOpen] = useState(false);
  const [otherOpen, setOtherOpen] = useState(false);
  const [view, setView] = useState<"list" | "thread" | "picker">("list");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);

  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [starting, setStarting] = useState(false);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [otherReadAt, setOtherReadAt] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [upload, setUpload] = useState<{ done: number; total: number } | null>(null);
  const [previewFile, setPreviewFile] = useState<PreviewableFile | null>(null);

  const uploadRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // values read by realtime callbacks that outlive a render
  const live = useRef({ open, view, selectedId });
  useEffect(() => {
    live.current = { open, view, selectedId };
  }, [open, view, selectedId]);

  const threadVisible = open && view !== "list" && selectedId !== null;
  const selected = chats?.find((c) => c.id === selectedId) ?? null;
  const isSelf = (c: ChatSummary | null) => c?.other_id === userId;
  const chatName = (c: ChatSummary | null) => (c ? `${c.other_email ?? "Unknown user"}${isSelf(c) ? " (you)" : ""}` : "…");

  // ---------------------------------------------------------------- data
  const refreshUnread = useCallback(async () => setUnread(await unreadCount()), []);

  const loadChats = useCallback(async () => {
    try {
      setChats(await listChats());
      setChatsError(null);
    } catch (err) {
      setChatsError(getErrorMessage(err));
      setChats((prev) => prev ?? []);
    }
  }, []);

  const refreshThread = useCallback(async (conversationId: string) => {
    const latest = await listMessages(conversationId, null, PAGE);
    if (live.current.selectedId !== conversationId) return;
    setMessages((prev) => mergeMessages(prev, latest));
  }, []);

  const read = useCallback(
    async (conversationId: string) => {
      await markRead(conversationId);
      setChats((prev) => prev?.map((c) => (c.id === conversationId ? { ...c, unread: 0 } : c)) ?? prev);
      void refreshUnread();
    },
    [refreshUnread]
  );

  // ---------------------------------------------------------------- widgets & opening
  useEffect(() => {
    announceWidget("chat", open);
  }, [open]);

  useEffect(
    () =>
      onOtherWidget("chat", (otherIsOpen) => {
        setOtherOpen(otherIsOpen);
        if (otherIsOpen) setOpen(false);
      }),
    []
  );

  const openConversation = useCallback((id: string) => {
    setSelectedId(id);
    setView("thread");
    setOpen(true);
  }, []);

  useEffect(() => {
    const onOpen = (event: Event) => {
      const { conversationId, email: to } = (event as CustomEvent<{ conversationId?: string; email?: string }>).detail ?? {};
      if (conversationId) openConversation(conversationId);
      else {
        if (to) setEmail(to);
        setView("list");
        setOpen(true);
      }
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, [openConversation]);

  // ---------------------------------------------------------------- realtime: every conversation
  useEffect(() => {
    // initial unread count, then live: new messages anywhere update the badge
    // and the list; a message from someone else not on screen shows a toast
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshUnread();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeToMessages((row) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void refreshUnread();
        if (live.current.open) void loadChats();
      }, 300);
      const onScreen = live.current.open && live.current.view !== "list" && live.current.selectedId === row.conversation_id;
      if (row.sender_id !== userId && !onScreen) {
        toast("New chat message", {
          action: { label: "Open", onClick: () => openConversation(row.conversation_id) },
        });
      }
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [userId, refreshUnread, loadChats, openConversation]);

  useEffect(() => {
    // the list is loaded when the panel opens
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) void loadChats();
  }, [open, loadChats]);

  // ---------------------------------------------------------------- realtime: the open conversation
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMessages([]);
    setOtherReadAt(null);
    setThreadError(null);
    setThreadLoading(true);
    listMessages(selectedId, null, PAGE)
      .then((rows) => {
        if (cancelled) return;
        setMessages(rows);
        setHasOlder(rows.length === PAGE);
      })
      .catch((err) => !cancelled && setThreadError(getErrorMessage(err)))
      .finally(() => !cancelled && setThreadLoading(false));

    const offMessages = subscribeToMessages((row) => {
      void refreshThread(selectedId).catch(() => undefined);
      const visible = live.current.open && live.current.view !== "list" && document.visibilityState === "visible";
      if (row.sender_id !== userId && visible) void read(selectedId);
    }, selectedId);
    const offReads = subscribeToReads(selectedId, (row) => {
      if (row.user_id !== userId) setOtherReadAt(row.last_read_at);
    });
    return () => {
      cancelled = true;
      offMessages();
      offReads();
    };
  }, [selectedId, userId, read, refreshThread]);

  // opening a conversation (or coming back to it) marks it read on the server
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (threadVisible && selectedId) void read(selectedId);
  }, [threadVisible, selectedId, read]);

  const lastMessageId = messages[messages.length - 1]?.id;
  useEffect(() => {
    if (view === "thread") bottomRef.current?.scrollIntoView({ block: "end" });
  }, [lastMessageId, view]);

  // ---------------------------------------------------------------- actions
  const start = async (address = email) => {
    const value = address.trim();
    if (!value || starting) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      toast.error("Invalid email format");
      return;
    }
    setStarting(true);
    try {
      const id = await startChat(value);
      setEmail("");
      await loadChats();
      openConversation(id);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setStarting(false);
    }
  };

  const send = async () => {
    if (!selectedId || !draft.trim() || sending) return;
    setSending(true);
    try {
      await sendMessage(selectedId, draft);
      setDraft("");
      await refreshThread(selectedId);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSending(false);
    }
  };

  const sendFiles = async (files: File[]) => {
    if (!selectedId || !files.length) return;
    setUpload({ done: 0, total: files.length });
    try {
      const result = await sendUploads(userId, selectedId, files, (done, total) => setUpload({ done, total }));
      if (result.failed.length) toast.error(`Could not send ${result.failed.length} file(s): ${result.failed[0]}`);
      await refreshThread(selectedId);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setUpload(null);
    }
  };

  const unsend = async (m: ChatMessage) => {
    if (!window.confirm("Unsend this message? It will be removed for both of you.")) return;
    try {
      await deleteMessage(m.id);
      if (selectedId) await refreshThread(selectedId);
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  const loadOlder = async () => {
    if (!selectedId || !messages.length || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const older = await listMessages(selectedId, messages[0].created_at, PAGE);
      setMessages((prev) => mergeMessages(older, prev));
      setHasOlder(older.length === PAGE);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setLoadingOlder(false);
    }
  };

  const groups = useMemo(() => groupByDay(messages), [messages]);
  const lastMine = [...messages].reverse().find((m) => m.sender_id === userId && !m.deleted_at);
  const fromList = selected?.other_last_read_at ?? null;
  const readAt = otherReadAt && (!fromList || otherReadAt > fromList) ? otherReadAt : fromList;
  const seen = Boolean(lastMine && readAt && readAt >= lastMine.created_at);

  // ---------------------------------------------------------------- render
  return (
    <>
      {/* Launcher, left of the AI Assistant's */}
      <AnimatePresence>
        {!open && !otherOpen && (
          <motion.button
            type="button"
            onClick={() => {
              setView(selectedId ? "thread" : "list");
              setOpen(true);
            }}
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            whileHover={{ scale: 1.06 }}
            whileTap={{ scale: 0.94 }}
            transition={{ type: "spring", stiffness: 400, damping: 22 }}
            aria-label={unread ? `Open chat (${unread} unread)` : "Open chat"}
            title="Chat"
            className="fixed bottom-5 right-[5.5rem] z-[60] flex h-14 w-14 items-center justify-center rounded-full border bg-card/90 text-primary shadow-2xl shadow-primary/20 backdrop-blur"
          >
            <MessagesSquare className="h-6 w-6" />
            {unread > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-white shadow">
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </motion.button>
        )}
      </AnimatePresence>

      {/* Panel */}
      <AnimatePresence>
        {open && (
          <motion.section
            role="dialog"
            aria-label="Chat"
            initial={{ opacity: 0, scale: 0.9, y: 24 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: 24 }}
            transition={{ type: "spring", stiffness: 380, damping: 32 }}
            style={{ transformOrigin: "bottom right" }}
            className="fixed inset-0 z-[60] flex flex-col overflow-hidden bg-popover/95 backdrop-blur-2xl sm:inset-auto sm:bottom-5 sm:right-5 sm:h-[min(640px,calc(100vh-7rem))] sm:w-[400px] sm:rounded-3xl sm:border sm:shadow-[0_30px_80px_-20px_rgb(0_0_0/0.45)]"
          >
            {view === "picker" && selectedId ? (
              <FilePicker
                userId={userId}
                onBack={() => setView("thread")}
                onPick={async (file) => {
                  await sendMessage(selectedId, null, file.id);
                  await refreshThread(selectedId);
                  setView("thread");
                }}
              />
            ) : view === "thread" && selectedId ? (
              <>
                <header className="flex items-center gap-2 border-b px-3 py-2.5">
                  <button type="button" onClick={() => setView("list")} className={iconButton} aria-label="Back to chats">
                    <ArrowLeft className="h-4 w-4" />
                  </button>
                  <Avatar email={selected?.other_email ?? null} size="sm" />
                  <p className="min-w-0 flex-1 truncate text-sm font-semibold">{chatName(selected)}</p>
                  <button type="button" onClick={() => setOpen(false)} className={cn(iconButton, "hidden sm:block")} aria-label="Minimize">
                    <Minus className="h-4 w-4" />
                  </button>
                  <button type="button" onClick={() => setOpen(false)} className={iconButton} aria-label="Close">
                    <X className="h-4 w-4" />
                  </button>
                </header>

                <div className="flex-1 overflow-y-auto px-3 py-3">
                  {threadLoading ? (
                    <div className="flex h-full items-center justify-center">
                      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    </div>
                  ) : threadError ? (
                    <p className="text-center text-sm text-destructive">{threadError}</p>
                  ) : messages.length === 0 ? (
                    <p className="pt-10 text-center text-sm text-muted-foreground">{isSelf(selected) ? "Keep notes and files for yourself here." : "Say hello 👋"}</p>
                  ) : (
                    <div className="space-y-3">
                      {hasOlder && (
                        <div className="flex justify-center">
                          <button
                            type="button"
                            onClick={() => void loadOlder()}
                            disabled={loadingOlder}
                            className="inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
                          >
                            {loadingOlder && <Loader2 className="h-3 w-3 animate-spin" />}
                            Load older messages
                          </button>
                        </div>
                      )}
                      {groups.map((group) => (
                        <div key={group.label + group.items[0].id} className="space-y-1.5">
                          <p className="py-1 text-center text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">{group.label}</p>
                          {group.items.map((m) => {
                            const mine = m.sender_id === userId;
                            return (
                              <div key={m.id} className={cn("group/msg flex items-end gap-1", mine ? "justify-end" : "justify-start")}>
                                {mine && !m.deleted_at && (
                                  <button
                                    type="button"
                                    onClick={() => void unsend(m)}
                                    className="mb-1 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-destructive focus-visible:opacity-100 group-hover/msg:opacity-100"
                                    aria-label="Unsend message"
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </button>
                                )}
                                <div
                                  className={cn(
                                    "max-w-[82%] space-y-1 rounded-2xl px-3 py-2 text-sm shadow-sm",
                                    m.deleted_at
                                      ? "border border-dashed bg-transparent italic text-muted-foreground shadow-none"
                                      : mine
                                        ? "rounded-br-md bg-brand text-white"
                                        : "rounded-bl-md bg-muted"
                                  )}
                                >
                                  {m.deleted_at ? (
                                    <p>Message unsent</p>
                                  ) : (
                                    <>
                                      {m.file_name && <FileBubble message={m} mine={mine} onPreview={setPreviewFile} />}
                                      {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
                                    </>
                                  )}
                                  <p className={cn("text-right text-[10px]", mine && !m.deleted_at ? "text-white/70" : "text-muted-foreground")}>{clockTime(m.created_at)}</p>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ))}
                      {lastMine && !isSelf(selected) && (
                        <p className="flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
                          {seen ? <CheckCheck className="h-3.5 w-3.5 text-primary" /> : <Check className="h-3.5 w-3.5" />}
                          {seen ? "Seen" : "Sent"}
                        </p>
                      )}
                    </div>
                  )}
                  <div ref={bottomRef} />
                </div>

                <footer className="border-t p-2.5">
                  {upload && (
                    <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Sending files {upload.done}/{upload.total}…
                    </p>
                  )}
                  <input
                    ref={uploadRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      const files = Array.from(e.target.files ?? []);
                      e.target.value = "";
                      void sendFiles(files);
                    }}
                  />
                  <div className="flex items-end gap-1.5 rounded-2xl border bg-background/60 p-1.5 focus-within:border-primary/40">
                    <button type="button" onClick={() => uploadRef.current?.click()} disabled={upload !== null} className={iconButton} title="Upload from device" aria-label="Upload from device">
                      <Paperclip className="h-4 w-4" />
                    </button>
                    <button type="button" onClick={() => setView("picker")} disabled={upload !== null} className={iconButton} title="Send from My Files" aria-label="Send from My Files">
                      <FolderOpen className="h-4 w-4" />
                    </button>
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          void send();
                        }
                      }}
                      rows={1}
                      maxLength={4000}
                      placeholder="Message…"
                      aria-label="Message"
                      autoFocus
                      className="max-h-32 min-h-[2rem] min-w-0 flex-1 resize-none bg-transparent py-1.5 text-sm outline-none placeholder:text-muted-foreground [field-sizing:content]"
                    />
                    <button
                      type="button"
                      onClick={() => void send()}
                      disabled={!draft.trim() || sending}
                      aria-label="Send"
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-brand text-white disabled:opacity-40"
                    >
                      {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <SendHorizontal className="h-4 w-4" />}
                    </button>
                  </div>
                </footer>
              </>
            ) : (
              <>
                <header className="flex items-center gap-3 border-b px-4 py-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-2xl bg-brand text-white shadow-lg shadow-primary/30">
                    <MessagesSquare className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">Chat</p>
                    <p className="text-[11px] text-muted-foreground">Messages and files, in real time</p>
                  </div>
                  <button type="button" onClick={() => setOpen(false)} className={cn(iconButton, "hidden sm:block")} aria-label="Minimize">
                    <Minus className="h-4 w-4" />
                  </button>
                  <button type="button" onClick={() => setOpen(false)} className={iconButton} aria-label="Close">
                    <X className="h-4 w-4" />
                  </button>
                </header>

                <form
                  className="flex gap-2 border-b p-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void start();
                  }}
                >
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="Add someone: user@example.com"
                    aria-label="Email to chat with"
                    className="h-9 min-w-0 flex-1 rounded-lg border bg-background/60 px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  />
                  <button
                    type="submit"
                    disabled={!email.trim() || starting}
                    aria-label="Start chat"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand text-white disabled:opacity-40"
                  >
                    {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  </button>
                </form>
                {myEmail && (
                  <button
                    type="button"
                    onClick={() => void start(myEmail)}
                    disabled={starting}
                    className="flex items-center gap-1.5 border-b px-4 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                  >
                    <NotebookPen className="h-3.5 w-3.5" />
                    Notes to self
                  </button>
                )}

                <div className="flex-1 overflow-y-auto">
                  {chats === null ? (
                    <div className="space-y-2 p-3">
                      {Array.from({ length: 4 }).map((_, i) => (
                        <div key={i} className="h-14 animate-pulse rounded-xl bg-muted/40" />
                      ))}
                    </div>
                  ) : chatsError ? (
                    <p className="p-4 text-sm text-destructive">{chatsError}</p>
                  ) : chats.length === 0 ? (
                    <div className="flex flex-col items-center px-6 py-12 text-center">
                      <MessagesSquare className="mb-3 h-12 w-12 text-muted-foreground/50" />
                      <p className="text-sm font-medium">No conversations yet</p>
                      <p className="mt-1 text-xs text-muted-foreground">Add someone by e-mail above to start chatting.</p>
                    </div>
                  ) : (
                    <div className="divide-y">
                      {chats.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => openConversation(c.id)}
                          className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-primary/[0.04]"
                        >
                          <Avatar email={c.other_email} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline gap-2">
                              <p className={cn("min-w-0 flex-1 truncate text-sm", c.unread ? "font-semibold" : "font-medium")}>{chatName(c)}</p>
                              <span className="shrink-0 text-[11px] text-muted-foreground">{listTime(c.last_message_at)}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <p className={cn("min-w-0 flex-1 truncate text-xs", c.unread ? "text-foreground" : "text-muted-foreground")}>{messagePreview(c, userId)}</p>
                              {c.unread > 0 && (
                                <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-brand px-1.5 text-[10px] font-semibold text-white">
                                  {c.unread > 99 ? "99+" : c.unread}
                                </span>
                              )}
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </motion.section>
        )}
      </AnimatePresence>

      {previewFile && (
        <PreviewDialog
          open
          className="z-[70]"
          onOpenChange={(o) => {
            if (!o) setPreviewFile(null);
          }}
          file={previewFile}
        />
      )}
    </>
  );
}
