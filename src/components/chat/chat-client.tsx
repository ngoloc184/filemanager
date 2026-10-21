"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
  NotebookPen,
  Paperclip,
  Plus,
  Search,
  SendHorizontal,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PreviewDialog } from "@/components/files/file-dialogs";
import { FileTile, fileKind } from "@/components/files/file-tile";
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
  type ChatMessage,
  type ChatSummary,
} from "@/lib/services/chat";
import { downloadFile, type PreviewableFile } from "@/lib/services/files";
import { clockTime, groupByDay, listTime, mergeMessages, messagePreview } from "@/lib/chat-format";
import { getErrorMessage, type FileRow } from "@/lib/types/database";
import { cn, formatBytes } from "@/lib/utils";

const PAGE = 50;

function Avatar({ email, className }: { email: string | null; className?: string }) {
  return (
    <span
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand text-sm font-semibold text-white shadow-md shadow-primary/25",
        className
      )}
    >
      {email?.charAt(0).toUpperCase() || "?"}
    </span>
  );
}

function FilePickerDialog({
  userId,
  onOpenChange,
  onPick,
}: {
  userId: string;
  onOpenChange: (open: boolean) => void;
  onPick: (file: FileRow) => Promise<void>;
}) {
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
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Send a file</DialogTitle>
          <DialogDescription>Pick one of your files. The other person gets view access to it.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your files..." className="pl-10" autoFocus />
        </div>
        <div className="-mx-1 min-h-32 flex-1 overflow-y-auto px-1">
          {files === null ? (
            <div className="flex h-32 items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : files.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">No files found.</p>
          ) : (
            <div className="space-y-1">
              {files.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  disabled={busy !== null}
                  onClick={async () => {
                    setBusy(f.id);
                    try {
                      await onPick(f);
                      onOpenChange(false);
                    } catch (err) {
                      toast.error(getErrorMessage(err));
                    } finally {
                      setBusy(null);
                    }
                  }}
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-muted disabled:opacity-60"
                >
                  <FileTile kind={fileKind(f.mime_type, f.name)} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{f.name}</p>
                    <p className="text-xs text-muted-foreground">{formatBytes(f.size)}</p>
                  </div>
                  {busy === f.id && <Loader2 className="h-4 w-4 animate-spin" />}
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FileBubble({
  message,
  mine,
  onPreview,
}: {
  message: ChatMessage;
  mine: boolean;
  onPreview: (file: PreviewableFile) => void;
}) {
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
    <div className={cn("flex w-64 max-w-full items-center gap-3 rounded-xl border p-2.5", mine ? "border-white/20 bg-white/10" : "bg-background/70")}>
      <FileTile kind={fileKind(message.file_mime, message.file_name ?? "")} className={mine ? "bg-white/15 text-white ring-white/25" : undefined} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" title={message.file_name ?? ""}>
          {message.file_name}
        </p>
        <p className={cn("text-xs", mine ? "text-white/70" : "text-muted-foreground")}>
          {file ? formatBytes(file.size) : "File no longer available"}
        </p>
      </div>
      {file && (
        <div className="flex shrink-0 gap-0.5">
          <button
            type="button"
            onClick={() => onPreview(file)}
            className={cn("rounded-md p-1.5", mine ? "hover:bg-white/15" : "hover:bg-muted")}
            aria-label={`Preview ${file.name}`}
          >
            <Eye className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => downloadFile(file).catch((err) => toast.error(getErrorMessage(err)))}
            className={cn("rounded-md p-1.5", mine ? "hover:bg-white/15" : "hover:bg-muted")}
            aria-label={`Download ${file.name}`}
          >
            <Download className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}

export default function ChatClient({ user }: { user: { id: string; email?: string } }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedId = searchParams.get("c");

  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [email, setEmail] = useState(searchParams.get("to") ?? "");
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [previewFile, setPreviewFile] = useState<PreviewableFile | null>(null);

  const uploadRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef(selectedId);
  useEffect(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);

  const selected = chats?.find((c) => c.id === selectedId) ?? null;
  const isSelf = (c: ChatSummary | null) => c?.other_id === user.id;
  const chatName = (c: ChatSummary | null) => (c ? `${c.other_email ?? "Unknown user"}${isSelf(c) ? " (you)" : ""}` : "…");

  const loadChats = useCallback(async () => {
    try {
      setChats(await listChats());
      setChatsError(null);
    } catch (err) {
      setChatsError(getErrorMessage(err));
      setChats((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    // initial list + live updates of every conversation (RLS-filtered)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadChats();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeToMessages(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void loadChats(), 300);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [loadChats]);

  const refreshThread = useCallback(async (conversationId: string) => {
    const latest = await listMessages(conversationId, null, PAGE);
    if (selectedRef.current !== conversationId) return;
    setMessages((prev) => mergeMessages(prev, latest));
  }, []);

  const read = useCallback(async (conversationId: string) => {
    await markRead(conversationId);
    setChats((prev) => prev?.map((c) => (c.id === conversationId ? { ...c, unread: 0 } : c)) ?? prev);
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    // a new conversation on screen: load it, mark it read, follow it live
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
        void read(selectedId);
      })
      .catch((err) => !cancelled && setThreadError(getErrorMessage(err)))
      .finally(() => !cancelled && setThreadLoading(false));

    const offMessages = subscribeToMessages((row) => {
      void refreshThread(selectedId).catch(() => undefined);
      if (row.sender_id !== user.id && document.visibilityState === "visible") void read(selectedId);
    }, selectedId);
    const offReads = subscribeToReads(selectedId, (row) => {
      if (row.user_id !== user.id) setOtherReadAt(row.last_read_at);
    });
    return () => {
      cancelled = true;
      offMessages();
      offReads();
    };
  }, [selectedId, user.id, read, refreshThread]);

  const lastMessageId = messages[messages.length - 1]?.id;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [lastMessageId]);

  const open = (id: string | null) => router.replace(id ? `/chat?c=${id}` : "/chat");

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
      open(id);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setStarting(false);
    }
  };

  const send = async () => {
    const body = draft.trim();
    if (!selectedId || !body || sending) return;
    setSending(true);
    try {
      await sendMessage(selectedId, draft);
      setDraft("");
      await refreshThread(selectedId);
      void loadChats();
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
      const result = await sendUploads(user.id, selectedId, files, (done, total) => setUpload({ done, total }));
      if (result.failed.length) toast.error(`Could not send ${result.failed.length} file(s): ${result.failed[0]}`);
      await refreshThread(selectedId);
      void loadChats();
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
  const lastMine = [...messages].reverse().find((m) => m.sender_id === user.id && !m.deleted_at);
  // the other member's read time: from the list, or newer from realtime
  const fromList = selected?.other_last_read_at ?? null;
  const readAt = otherReadAt && (!fromList || otherReadAt > fromList) ? otherReadAt : fromList;
  const seen = Boolean(lastMine && readAt && readAt >= lastMine.created_at);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold">Chat</h2>
        <p className="text-muted-foreground mt-1">Message other users in real time and send them files.</p>
      </div>

      <div className="flex h-[calc(100dvh-14rem)] min-h-[28rem] overflow-hidden rounded-2xl border bg-card/80 shadow-sm backdrop-blur">
        {/* conversations */}
        <aside className={cn("flex w-full flex-col border-r md:w-80 md:shrink-0", selectedId && "hidden md:flex")}>
          <form
            className="flex gap-2 border-b p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void start();
            }}
          >
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Start a chat: user@example.com"
              aria-label="Email to chat with"
            />
            {/* Base UI buttons default to type="button": start explicitly (Enter submits the form) */}
            <Button variant="brand" size="icon" onClick={() => void start()} disabled={!email.trim() || starting} aria-label="Start chat">
              {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            </Button>
          </form>
          {user.email && (
            <button
              type="button"
              onClick={() => void start(user.email)}
              disabled={starting}
              className="flex items-center gap-1.5 border-b px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            >
              <NotebookPen className="h-3.5 w-3.5" />
              Notes to self — keep messages and files for yourself
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
              <div className="flex flex-col items-center px-6 py-14 text-center">
                <MessagesSquare className="mb-3 h-12 w-12 text-muted-foreground/50" />
                <p className="text-sm font-medium">No conversations yet</p>
                <p className="mt-1 text-xs text-muted-foreground">Enter the email of a registered user above to start chatting.</p>
              </div>
            ) : (
              <div className="divide-y">
                {chats.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => open(c.id)}
                    className={cn(
                      "relative flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-primary/[0.04]",
                      c.id === selectedId && "bg-primary/[0.07]"
                    )}
                  >
                    <Avatar email={c.other_email} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <p className={cn("min-w-0 flex-1 truncate text-sm", c.unread ? "font-semibold" : "font-medium")}>{chatName(c)}</p>
                        <span className="shrink-0 text-[11px] text-muted-foreground">{listTime(c.last_message_at)}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <p className={cn("min-w-0 flex-1 truncate text-xs", c.unread ? "text-foreground" : "text-muted-foreground")}>
                          {messagePreview(c, user.id)}
                        </p>
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
        </aside>

        {/* thread */}
        <section className={cn("min-w-0 flex-1 flex-col", selectedId ? "flex" : "hidden md:flex")}>
          {!selectedId ? (
            <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
              <MessagesSquare className="mb-3 h-14 w-14 text-muted-foreground/40" />
              <p className="font-medium">Select a conversation</p>
              <p className="mt-1 text-sm text-muted-foreground">Or start a new one with an email address.</p>
            </div>
          ) : (
            <>
              <header className="flex items-center gap-3 border-b px-3 py-2.5">
                <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={() => open(null)} aria-label="Back to conversations">
                  <ArrowLeft className="h-4 w-4" />
                </Button>
                <Avatar email={selected?.other_email ?? null} className="h-8 w-8" />
                <p className="min-w-0 flex-1 truncate text-sm font-semibold">{chatName(selected)}</p>
              </header>

              <div className="flex-1 overflow-y-auto px-3 py-4 sm:px-5">
                {threadLoading ? (
                  <div className="flex h-full items-center justify-center">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                ) : threadError ? (
                  <p className="text-center text-sm text-destructive">{threadError}</p>
                ) : messages.length === 0 ? (
                  <p className="pt-10 text-center text-sm text-muted-foreground">Say hello 👋</p>
                ) : (
                  <div className="space-y-4">
                    {hasOlder && (
                      <div className="flex justify-center">
                        <Button variant="outline" size="sm" onClick={() => void loadOlder()} disabled={loadingOlder}>
                          {loadingOlder && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                          Load older messages
                        </Button>
                      </div>
                    )}
                    {groups.map((group) => (
                      <div key={group.label + group.items[0].id} className="space-y-1.5">
                        <p className="py-1 text-center text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">{group.label}</p>
                        {group.items.map((m) => {
                          const mine = m.sender_id === user.id;
                          return (
                            <div key={m.id} className={cn("group/msg flex items-end gap-1.5", mine ? "justify-end" : "justify-start")}>
                              {mine && !m.deleted_at && (
                                <button
                                  type="button"
                                  onClick={() => void unsend(m)}
                                  className="mb-1 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-destructive focus-visible:opacity-100 group-hover/msg:opacity-100"
                                  aria-label="Unsend message"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              )}
                              <div
                                className={cn(
                                  "max-w-[80%] space-y-1.5 rounded-2xl px-3 py-2 text-sm shadow-sm sm:max-w-[70%]",
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
                                <p className={cn("text-right text-[10px]", mine && !m.deleted_at ? "text-white/70" : "text-muted-foreground")}>
                                  {clockTime(m.created_at)}
                                </p>
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

              <footer className="border-t p-3">
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
                <div className="flex items-end gap-2">
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <button
                          type="button"
                          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                          disabled={upload !== null}
                          aria-label="Attach a file"
                        />
                      }
                    >
                      <Paperclip className="h-4 w-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuItem onClick={() => uploadRef.current?.click()}>
                        <Upload className="h-4 w-4 mr-2" />
                        Upload from device
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setPickerOpen(true)}>
                        <FolderOpen className="h-4 w-4 mr-2" />
                        Choose from My Files
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Textarea
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
                    placeholder="Write a message… (Shift+Enter for a new line)"
                    aria-label="Message"
                    // field-sizing grows with the text; min-w-0 keeps it inside narrow screens
                    className="max-h-40 min-h-9 min-w-0 flex-1 resize-none"
                  />
                  <Button variant="brand" size="icon-lg" onClick={() => void send()} disabled={!draft.trim() || sending} aria-label="Send">
                    {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <SendHorizontal className="h-4 w-4" />}
                  </Button>
                </div>
              </footer>
            </>
          )}
        </section>
      </div>

      {pickerOpen && selectedId && (
        <FilePickerDialog
          userId={user.id}
          onOpenChange={setPickerOpen}
          onPick={async (file) => {
            await sendMessage(selectedId, null, file.id);
            await refreshThread(selectedId);
            void loadChats();
            toast.success(`Sent “${file.name}”`);
          }}
        />
      )}
      {previewFile && (
        <PreviewDialog
          open
          onOpenChange={(o) => {
            if (!o) setPreviewFile(null);
          }}
          file={previewFile}
        />
      )}
    </div>
  );
}
