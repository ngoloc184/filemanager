"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  ArrowUp,
  Brain,
  Database,
  ExternalLink,
  FileSearch,
  Folder,
  Info,
  Layers,
  Loader2,
  Minus,
  RotateCcw,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { FileTile, fileKind } from "@/components/files/file-tile";
import { onAiSummaryVisibility, openAiSummary } from "@/components/files/ai-summary-dialog";
import { cn, formatBytes } from "@/lib/utils";
import type { AssistantFile, AssistantReply } from "@/lib/assistant/types";
import { ActionCard, AgentListsView, AnswerView, ComparisonView, FeedbackBar, MemoryProposalCard, StepsView, UploadCard } from "./assistant-parts";
import { MemoryPanel } from "./memory-panel";

type Message =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; reply: AssistantReply; request: { message: string; page: number; contextFileId: string | null } }
  | { id: string; role: "error"; text: string; request: { message: string; page: number; contextFileId: string | null } };

const STORAGE_ROOT = "fm-assistant:";
const STORAGE_PREFIX = `${STORAGE_ROOT}v2:`;
const MAX_LENGTH = 500;
const WELCOME =
  "Xin chào! Tôi trả lời dựa trên các tài liệu bạn có quyền truy cập, luôn kèm nguồn trích dẫn. Bạn có thể hỏi tiếp mà không cần nhắc lại tên file.";
const STARTERS = [
  "Tìm file gần đây",
  "Tìm tài liệu theo tên",
  "Hỏi về nội dung tài liệu",
  "So sánh hai tài liệu",
  "Bạn nhớ gì về tôi?",
];
const PROGRESS = ["Đang phân tích câu hỏi…", "Đang tìm trong tài liệu…", "Đang đọc và đối chiếu nguồn…", "Đang tổng hợp câu trả lời…"];

/** Removes every saved conversation in this tab (called on sign-out). */
export function clearAssistantHistory(): void {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(STORAGE_ROOT)) sessionStorage.removeItem(key);
    }
  } catch {
    // storage unavailable
  }
}

function loadHistory(userId: string): Message[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_PREFIX + userId);
    return raw ? (JSON.parse(raw) as Message[]).slice(-40) : [];
  } catch {
    return [];
  }
}

const uid = () => Math.random().toString(36).slice(2);

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(iso));
}

function accessLabel(file: AssistantFile): string {
  switch (file.access) {
    case "owner":
      return "Của bạn";
    case "shared":
      return file.sharedBy ? `Chia sẻ bởi ${file.sharedBy}` : "Được chia sẻ";
    case "public":
      return "Công khai";
    default:
      return "Qua liên kết";
  }
}

function FileCard({
  file,
  onAsk,
}: {
  file: AssistantFile;
  onAsk: (message: string, contextFileId: string) => void;
}) {
  return (
    <div className="group rounded-2xl border bg-background/70 p-3 transition-colors hover:border-primary/30">
      <div className="flex items-start gap-3">
        <FileTile kind={fileKind(file.mimeType, file.name)} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={file.name}>
            {file.name}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
            {file.folderName && (
              <span className="inline-flex max-w-[9rem] items-center gap-1 truncate">
                <Folder className="h-3 w-3 shrink-0" />
                {file.folderName}
              </span>
            )}
            <span>{formatDate(file.updatedAt)}</span>
            <span>· {formatBytes(file.size)}</span>
          </p>
          <span className="mt-1 inline-block rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
            {accessLabel(file)}
          </span>
        </div>
      </div>
      {file.snippet && (
        <div className="mt-2 rounded-lg border-l-2 border-primary/50 bg-primary/5 px-2.5 py-1.5">
          <p className="line-clamp-3 text-xs italic text-muted-foreground">“{file.snippet}”</p>
        </div>
      )}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <Link
          href={file.openUrl}
          className="inline-flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          <ExternalLink className="h-3 w-3" />
          Mở file
        </Link>
        <button
          type="button"
          onClick={() => onAsk("Tóm tắt file này", file.id)}
          className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <Sparkles className="h-3 w-3" />
          Tóm tắt
        </button>
        <button
          type="button"
          onClick={() => onAsk("Tìm tài liệu tương tự file này", file.id)}
          className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <Layers className="h-3 w-3" />
          Tương tự
        </button>
      </div>
    </div>
  );
}

function ReplyView({
  reply,
  question,
  userId,
  onAsk,
  onChoose,
  onMore,
  onIndex,
  indexing,
}: {
  reply: AssistantReply;
  userId: string;
  question: string;
  onAsk: (message: string, contextFileId?: string | null) => void;
  onChoose: (fileId: string, label: string) => void;
  onMore?: () => void;
  onIndex: () => void;
  indexing: boolean;
}) {
  return (
    <div className="space-y-2.5">
      <p className="whitespace-pre-line text-sm leading-relaxed">{reply.text}</p>

      {reply.answer && reply.answer.citations.length > 0 && <AnswerView answer={reply.answer} />}
      {reply.comparison && <ComparisonView comparison={reply.comparison} />}
      {reply.action && <ActionCard action={reply.action} />}
      {reply.upload && <UploadCard upload={reply.upload} userId={userId} />}
      <AgentListsView reply={reply} />
      {reply.memoryProposal && <MemoryProposalCard proposal={reply.memoryProposal} />}

      {reply.choices && reply.choices.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {reply.choices.map((c) => (
            <button
              key={c.fileId}
              type="button"
              onClick={() => onChoose(c.fileId, c.label)}
              className="truncate rounded-xl border bg-background/70 px-3 py-2 text-left text-sm transition-colors hover:border-primary/30"
            >
              {c.label}
            </button>
          ))}
        </div>
      )}

      {reply.notices?.map((notice) => (
        <p key={notice} className="flex items-start gap-1.5 rounded-xl bg-warning/10 px-3 py-2 text-xs text-foreground/80">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          {notice}
        </p>
      ))}

      {reply.summary && (
        <div className="rounded-2xl border bg-background/70 p-3">
          <ul className="space-y-1.5 text-sm">
            {reply.summary.points.map((point, i) => (
              <li key={i} className="flex gap-2">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                <span>{point}</span>
              </li>
            ))}
          </ul>
          {reply.summary.keywords.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1">
              {reply.summary.keywords.map((k) => (
                <span key={k} className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                  #{k}
                </span>
              ))}
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Link
              href={reply.summary.openUrl}
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              Nguồn: {reply.summary.fileName}
            </Link>
            <button
              type="button"
              onClick={() => openAiSummary({ id: reply.summary!.fileId, name: reply.summary!.fileName })}
              className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <Sparkles className="h-3 w-3" />
              Tóm tắt chi tiết
            </button>
          </div>
        </div>
      )}

      {reply.stats && (
        <div className="grid grid-cols-2 gap-2">
          {[
            ["File của bạn", reply.stats.ownedFiles],
            ["Dung lượng", formatBytes(reply.stats.ownedBytes)],
            ["Thư mục", reply.stats.ownedFolders],
            ["Được chia sẻ", reply.stats.sharedFiles],
            ["Đã lập chỉ mục", `${reply.stats.indexedFiles}/${reply.stats.indexableFiles}`],
            ["Công khai (xem được)", reply.stats.publicFiles],
          ].map(([label, value]) => (
            <div key={label as string} className="rounded-xl border bg-background/70 px-3 py-2">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
              <p className="text-sm font-semibold">{value}</p>
            </div>
          ))}
          {reply.stats.topExtensions.length > 0 && (
            <div className="col-span-2 flex flex-wrap gap-1">
              {reply.stats.topExtensions.map((e) => (
                <span key={e.extension} className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                  .{e.extension} · {e.count}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {reply.shares && reply.shares.length > 0 && (
        <div className="space-y-1.5">
          {reply.shares.map((share) => (
            <Link
              key={`${share.type}-${share.id}-${share.granteeEmail}`}
              href={share.openUrl}
              className="flex items-center gap-2.5 rounded-xl border bg-background/70 px-3 py-2 text-sm transition-colors hover:border-primary/30"
            >
              <FileTile kind={share.type === "folder" ? "folder" : fileKind(null, share.name)} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{share.name}</p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {share.granteeEmail} · {share.role} · {formatDate(share.sharedAt)}
                </p>
              </div>
            </Link>
          ))}
        </div>
      )}

      {reply.files && reply.files.length > 0 && (
        <div className="space-y-2">
          {reply.files.map((file) => (
            <FileCard key={file.id} file={file} onAsk={onAsk} />
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {reply.hasMore && onMore && (
          <button
            type="button"
            onClick={onMore}
            className="rounded-full border border-primary/30 bg-primary/5 px-3 py-1 text-xs font-medium text-primary hover:bg-primary/10"
          >
            Xem thêm kết quả
          </button>
        )}
        {reply.canIndex && (
          <button
            type="button"
            disabled={indexing}
            onClick={onIndex}
            className="inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-60"
          >
            {indexing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Database className="h-3 w-3" />}
            Lập chỉ mục nội dung ngay
          </button>
        )}
        {reply.suggestions?.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onAsk(s)}
            className="rounded-full border bg-background/60 px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground"
          >
            {s}
          </button>
        ))}
      </div>

      {reply.steps && reply.steps.length > 1 && <StepsView steps={reply.steps} />}

      {reply.replyId && !reply.action && !["greeting", "help", "memory"].includes(reply.intent) && (
        <FeedbackBar
          replyId={reply.replyId}
          question={question}
          citedFiles={[...new Set([...(reply.answer?.citations.map((c) => c.fileId) ?? []), ...(reply.files?.map((f) => f.id) ?? [])])].slice(0, 10)}
          lessons={reply.lessonIds}
        />
      )}

      <p className="text-[10px] text-muted-foreground/70">
        {reply.engine === "llm" ? "Có dùng mô hình AI tùy chọn (chỉ với các đoạn trích bạn được xem)" : "Xử lý cục bộ · không dùng AI bên ngoài · 0 token"}
      </p>
    </div>
  );
}

/**
 * Floating AI assistant for searching the signed-in user's accessible files.
 * The conversation is kept per account in this tab only (sessionStorage).
 */
export function AssistantWidget({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [view, setView] = useState<"chat" | "memory">("chat");
  const [progress, setProgress] = useState(0);
  const reopenRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Step aside while the "AI tóm tắt" dialog is open so nothing covers its
  // footer (on mobile the launcher sits on top of the copy button), then
  // come back the way the user left it.
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(
    () =>
      onAiSummaryVisibility((visible) => {
        setSummaryOpen(visible);
        if (visible) {
          reopenRef.current = reopenRef.current || openRef.current;
          setOpen(false);
        } else if (reopenRef.current) {
          reopenRef.current = false;
          setOpen(true);
        }
      }),
    []
  );

  // Restore this account's conversation (never another account's).
  useEffect(() => {
    setMessages(loadHistory(userId));
    setHydrated(true);
  }, [userId]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      sessionStorage.setItem(STORAGE_PREFIX + userId, JSON.stringify(messages.slice(-40)));
    } catch {
      // storage full or unavailable
    }
  }, [messages, userId, hydrated]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, pending, open]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
        event.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 150);
  }, [open]);

  useEffect(() => {
    if (!pending) return;
    setProgress(0);
    const timer = setInterval(() => setProgress((p) => Math.min(p + 1, PROGRESS.length - 1)), 1400);
    return () => clearInterval(timer);
  }, [pending]);

  /** Conversation state returned with the newest answer (signed by the server). */
  const lastContext = useCallback((): unknown => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.role === "assistant" && m.reply.context) return m.reply.context;
    }
    return undefined;
  }, [messages]);

  const send = useCallback(
    async (
      message: string,
      options: { page?: number; contextFileId?: string | null; echo?: boolean; echoText?: string } = {}
    ) => {
      const text = message.trim().slice(0, MAX_LENGTH);
      if (!text || pending) return;
      const request = {
        message: text,
        page: options.page ?? 1,
        contextFileId: options.contextFileId ?? null,
      };
      if (options.echo !== false || options.echoText) {
        setMessages((prev) => [...prev, { id: uid(), role: "user", text: options.echoText ?? text }]);
      }
      setInput("");
      setPending(true);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const response = await fetch("/api/assistant/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...request, context: lastContext() }),
          signal: controller.signal,
        });
        const data = (await response.json().catch(() => ({}))) as AssistantReply & { error?: string };
        if (!response.ok) throw new Error(data.error || "Không thể xử lý câu hỏi lúc này.");
        setMessages((prev) => [...prev, { id: uid(), role: "assistant", reply: data, request }]);
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          setMessages((prev) => [
            ...prev,
            { id: uid(), role: "error", text: "Đã dừng tìm kiếm.", request },
          ]);
        } else {
          setMessages((prev) => [
            ...prev,
            {
              id: uid(),
              role: "error",
              text: err instanceof Error && err.message !== "Failed to fetch" ? err.message : "Mất kết nối, vui lòng thử lại.",
              request,
            },
          ]);
        }
      } finally {
        setPending(false);
        abortRef.current = null;
      }
    },
    [pending, lastContext]
  );

  const runIndex = async () => {
    setIndexing(true);
    try {
      const response = await fetch("/api/assistant/index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = (await response.json().catch(() => ({}))) as { indexed?: number; remaining?: number; error?: string };
      setMessages((prev) => [
        ...prev,
        response.ok
          ? {
              id: uid(),
              role: "assistant",
              request: { message: "", page: 1, contextFileId: null },
              reply: {
                intent: "index",
                engine: "local",
                text: `Đã lập chỉ mục ${data.indexed ?? 0} file.${data.remaining ? ` Còn ${data.remaining >= 12 ? "nhiều" : data.remaining} file đang chờ.` : " Tất cả file hỗ trợ đã sẵn sàng để tìm theo nội dung."}`,
                canIndex: Boolean(data.remaining),
              },
            }
          : {
              id: uid(),
              role: "error",
              text: data.error === "Content indexing is not configured on this server."
                ? "Máy chủ chưa được cấu hình lập chỉ mục nội dung."
                : "Không lập chỉ mục được lúc này.",
              request: { message: "", page: 1, contextFileId: null },
            },
      ]);
    } finally {
      setIndexing(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void send(input);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send(input);
    }
  };

  const ask = (message: string, contextFileId?: string | null) =>
    void send(message, contextFileId === undefined ? {} : { contextFileId });

  // Starters that need a keyword pre-fill the input instead of sending.
  const pickStarter = (starter: string) => {
    const prefill: Record<string, string> = {
      "Tìm tài liệu theo tên": "Tìm file ",
      "Hỏi về nội dung tài liệu": "Theo tài liệu, ",
      "So sánh hai tài liệu": "So sánh ",
    };
    if (prefill[starter]) {
      setInput(prefill[starter]);
      inputRef.current?.focus();
    } else {
      ask(starter);
    }
  };

  const newChat = () => {
    abortRef.current?.abort();
    setMessages([]);
    setView("chat");
  };

  return (
    <>
      {/* Launcher */}
      <AnimatePresence>
        {!open && !summaryOpen && (
          <motion.button
            type="button"
            onClick={() => setOpen(true)}
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            whileHover={{ scale: 1.06 }}
            whileTap={{ scale: 0.94 }}
            transition={{ type: "spring", stiffness: 400, damping: 22 }}
            aria-label="Mở AI Assistant (Ctrl+J)"
            title="AI Assistant (Ctrl/⌘ + J)"
            className="fixed bottom-5 right-5 z-[60] flex h-14 w-14 items-center justify-center rounded-full bg-brand text-white shadow-2xl shadow-primary/40"
          >
            <span className="absolute inset-0 animate-ping rounded-full bg-primary/30 [animation-duration:2.5s]" />
            <Sparkles className="relative h-6 w-6" />
          </motion.button>
        )}
      </AnimatePresence>

      {/* Panel */}
      <AnimatePresence>
        {open && (
          <motion.section
            role="dialog"
            aria-label="AI Assistant"
            initial={{ opacity: 0, scale: 0.9, y: 24 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: 24 }}
            transition={{ type: "spring", stiffness: 380, damping: 32 }}
            style={{ transformOrigin: "bottom right" }}
            className="fixed inset-0 z-[60] flex flex-col overflow-hidden bg-popover/95 backdrop-blur-2xl sm:inset-auto sm:bottom-5 sm:right-5 sm:h-[min(640px,calc(100vh-7rem))] sm:w-[440px] sm:rounded-3xl sm:border sm:shadow-[0_30px_80px_-20px_rgb(0_0_0/0.45)]"
          >
            {/* Header */}
            <header className="flex items-center gap-3 border-b px-4 py-3">
              <span className="relative flex h-9 w-9 items-center justify-center rounded-2xl bg-brand text-white shadow-lg shadow-primary/30">
                <Sparkles className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">AI Assistant</p>
                <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="h-1.5 w-1.5 rounded-full bg-success" />
                  Ghi nhớ ngữ cảnh · chỉ trong file bạn được phép xem
                </p>
              </div>
              <button
                type="button"
                onClick={() => setView((v) => (v === "memory" ? "chat" : "memory"))}
                title="Bộ nhớ của trợ lý"
                aria-label="Bộ nhớ của trợ lý"
                aria-pressed={view === "memory"}
                className={cn(
                  "rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground",
                  view === "memory" && "bg-primary/10 text-primary"
                )}
              >
                <Brain className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={newChat}
                title="Xóa lịch sử, bắt đầu cuộc trò chuyện mới"
                aria-label="Xóa lịch sử trò chuyện"
                className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <RotateCcw className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                title="Thu nhỏ"
                aria-label="Thu nhỏ"
                className="hidden rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground sm:block"
              >
                <Minus className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => {
                  abortRef.current?.abort();
                  setOpen(false);
                }}
                title="Đóng"
                aria-label="Đóng"
                className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            {view === "memory" ? (
              <MemoryPanel onBack={() => setView("chat")} />
            ) : (
            <>
            {/* Messages */}
            <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4">
              <div className="flex gap-2.5">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-brand text-white">
                  <Sparkles className="h-3.5 w-3.5" />
                </span>
                <div className="space-y-3">
                  <p className="text-sm leading-relaxed">{WELCOME}</p>
                  {messages.length === 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {STARTERS.map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => pickStarter(s)}
                          className="rounded-full border bg-background/60 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground"
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {messages.map((m, index) => {
                const last = index === messages.length - 1;
                if (m.role === "user") {
                  return (
                    <motion.div
                      key={m.id}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="flex justify-end"
                    >
                      <p className="max-w-[85%] whitespace-pre-line rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm text-primary-foreground">
                        {m.text}
                      </p>
                    </motion.div>
                  );
                }
                if (m.role === "error") {
                  return (
                    <motion.div key={m.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex gap-2.5">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
                        <AlertTriangle className="h-3.5 w-3.5" />
                      </span>
                      <div className="space-y-2">
                        <p className="text-sm text-destructive">{m.text}</p>
                        {m.request.message && last && (
                          <button
                            type="button"
                            onClick={() => void send(m.request.message, { ...m.request, echo: false })}
                            className="rounded-full border px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
                          >
                            Thử lại
                          </button>
                        )}
                      </div>
                    </motion.div>
                  );
                }
                return (
                  <motion.div key={m.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex gap-2.5">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-brand text-white">
                      <FileSearch className="h-3.5 w-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <ReplyView
                        reply={m.reply}
                        question={m.request.message}
                        userId={userId}
                        onAsk={ask}
                        onChoose={(fileId, label) => void send(m.request.message, { contextFileId: fileId, echo: false, echoText: `→ ${label}` })}
                        indexing={indexing}
                        onIndex={() => void runIndex()}
                        onMore={
                          last && m.reply.hasMore
                            ? () =>
                                void send(m.request.message, {
                                  page: (m.reply.page ?? 1) + 1,
                                  contextFileId: m.request.contextFileId,
                                  echo: false,
                                })
                            : undefined
                        }
                      />
                    </div>
                  </motion.div>
                );
              })}

              {pending && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-2.5">
                  <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-brand text-white">
                    <Sparkles className="h-3.5 w-3.5" />
                  </span>
                  <span className="flex items-center gap-1 rounded-2xl bg-muted px-3 py-2">
                    {[0, 1, 2].map((i) => (
                      <motion.span
                        key={i}
                        className="h-1.5 w-1.5 rounded-full bg-muted-foreground"
                        animate={{ y: [0, -4, 0], opacity: [0.5, 1, 0.5] }}
                        transition={{ duration: 0.8, repeat: Infinity, delay: i * 0.15 }}
                      />
                    ))}
                    <span className="ml-1.5 text-xs text-muted-foreground">{PROGRESS[progress]}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => abortRef.current?.abort()}
                    className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    <Square className="h-3 w-3" />
                    Dừng
                  </button>
                </motion.div>
              )}
            </div>

            {/* Composer */}
            <form onSubmit={submit} className="border-t p-3">
              <div className="flex items-end gap-2 rounded-2xl border bg-background/70 p-1.5 pl-3 focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/15">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value.slice(0, MAX_LENGTH))}
                  onKeyDown={onKeyDown}
                  rows={1}
                  placeholder="Hỏi về file của bạn, hoặc hỏi tiếp…"
                  aria-label="Câu hỏi"
                  className="max-h-32 min-h-[2.25rem] flex-1 resize-none bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground [field-sizing:content]"
                />
                <button
                  type="submit"
                  disabled={!input.trim() || pending}
                  aria-label="Gửi"
                  className={cn(
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-white transition-all",
                    input.trim() && !pending ? "bg-brand shadow-lg shadow-primary/30" : "bg-muted text-muted-foreground"
                  )}
                >
                  {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
                </button>
              </div>
              <p className="mt-1.5 flex justify-between px-1 text-[10px] text-muted-foreground/70">
                <span>Enter để gửi · Shift+Enter xuống dòng</span>
                {input.length > 400 && <span>{input.length}/{MAX_LENGTH}</span>}
              </p>
            </form>
            </>
            )}
          </motion.section>
        )}
      </AnimatePresence>
    </>
  );
}
