"use client";

// Building blocks of an assistant answer: grounded answer with citations,
// comparison table, action confirmation, memory proposal, reasoning steps
// and feedback.

import { useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  BookmarkPlus,
  Check,
  ChevronDown,
  ExternalLink,
  FileWarning,
  Loader2,
  Quote,
  ShieldAlert,
  ThumbsDown,
  ThumbsUp,
  Wand2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AssistantAnswer, AssistantReply, AssistantStep } from "@/lib/assistant/types";
import type { Comparison } from "@/lib/assistant/compare";
import type { ActionResult, PendingAction } from "@/lib/assistant/actions";

const CONFIDENCE: Record<AssistantAnswer["confidence"], { label: string; className: string }> = {
  high: { label: "Căn cứ rõ", className: "bg-success/15 text-success" },
  medium: { label: "Căn cứ khá", className: "bg-primary/10 text-primary" },
  low: { label: "Chưa đủ căn cứ", className: "bg-warning/15 text-warning" },
  none: { label: "Không có nguồn", className: "bg-destructive/10 text-destructive" },
};

export function AnswerView({ answer }: { answer: AssistantAnswer }) {
  const [open, setOpen] = useState(true);
  const conf = CONFIDENCE[answer.confidence];
  return (
    <div className="space-y-2">
      {answer.inference && (
        <div className="rounded-2xl border border-primary/20 bg-primary/5 p-3">
          <p className="mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-primary">
            <Wand2 className="h-3 w-3" /> Diễn giải bởi mô hình AI · đối chiếu với trích dẫn bên dưới
          </p>
          <p className="whitespace-pre-line text-sm leading-relaxed">{answer.inference}</p>
        </div>
      )}

      {answer.conflicts.map((c, i) => (
        <div key={i} className="flex gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          <span>
            <span className="font-medium">Các nguồn ghi khác nhau: </span>
            {c.values.map((v) => `${v.raw} [${v.citation}]`).join(" · ")}
          </span>
        </div>
      ))}

      <div className="rounded-2xl border bg-background/70">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground"
          aria-expanded={open}
        >
          <Quote className="h-3.5 w-3.5" />
          <span className="font-medium text-foreground">{answer.citations.length} trích dẫn</span>
          <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", conf.className)}>{conf.label}</span>
          <ChevronDown className={cn("ml-auto h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.ol
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="space-y-2 overflow-hidden px-3 pb-3"
            >
              {answer.citations.map((c) => (
                <li key={c.n} className="rounded-xl border-l-2 border-primary/50 bg-muted/40 px-2.5 py-2">
                  <p className="text-xs leading-relaxed">
                    <span className="mr-1 font-semibold text-primary">[{c.n}]</span>“{c.text}”
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                    <Link href={c.openUrl} className="inline-flex max-w-full items-center gap-1 truncate font-medium text-primary hover:underline">
                      <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                      <span className="truncate">{c.fileName}</span>
                    </Link>
                    {c.page && <span>trang {c.page}</span>}
                    {c.heading && <span className="truncate">· {c.heading}</span>}
                    {c.suspicious && (
                      <span className="inline-flex items-center gap-0.5 rounded-full bg-warning/15 px-1.5 text-warning">
                        <ShieldAlert className="h-2.5 w-2.5" /> có đoạn giống chỉ thị AI (đã ẩn)
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </motion.ol>
          )}
        </AnimatePresence>
      </div>
      {(answer.confidence === "low" || answer.citations.length === 0) && (
        <p className="flex items-center gap-1.5 text-[11px] text-warning">
          <FileWarning className="h-3.5 w-3.5" /> Câu trả lời chưa đủ căn cứ, hãy mở tài liệu nguồn để kiểm tra.
        </p>
      )}
    </div>
  );
}

export function ComparisonView({ comparison }: { comparison: Comparison }) {
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-2xl border bg-background/70">
        <table className="w-full min-w-[360px] text-xs">
          <thead>
            <tr className="border-b bg-muted/40 text-left">
              <th className="w-[36%] min-w-[8rem] px-2.5 py-2 font-medium text-muted-foreground">Tiêu chí</th>
              {comparison.files.map((f, i) => (
                <th key={f.id} className="max-w-[9rem] truncate px-2.5 py-2 font-medium" title={f.name}>
                  {i + 1}. {f.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {comparison.rows.map((r, i) => (
              <tr key={i} className={cn("border-b last:border-0 align-top", r.differs && r.kind === "fact" && "bg-warning/5")}>
                <td className="px-2.5 py-1.5 text-muted-foreground" title={r.label}>
                  <span className="line-clamp-3">
                    {r.differs && r.kind === "fact" && <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-warning align-middle" />}
                    {r.label}
                  </span>
                </td>
                {r.values.map((v, j) => (
                  <td key={j} className={cn("px-2.5 py-1.5", r.differs && r.kind === "fact" && "font-medium")}>
                    {v}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {comparison.onlyIn.some((o) => o.points.length) && (
        <div className="space-y-1.5 rounded-2xl border bg-background/70 p-3 text-xs">
          {comparison.onlyIn
            .filter((o) => o.points.length)
            .map((o) => (
              <div key={o.fileId}>
                <p className="font-medium">Chỉ có trong “{o.fileName}”</p>
                <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-muted-foreground">
                  {o.points.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

type ActionState = { status: "idle" | "running" | "done" | "cancelled" | "error"; message?: string; openUrl?: string };

export function ActionCard({ action, onDone }: { action: PendingAction; onDone?: (result: ActionResult) => void }) {
  const [state, setState] = useState<ActionState>({ status: "idle" });
  const confirm = async () => {
    setState({ status: "running" });
    try {
      const response = await fetch("/api/assistant/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: action.token }),
      });
      const result = (await response.json().catch(() => ({ ok: false, message: "Không thực hiện được thao tác." }))) as ActionResult;
      setState(result.ok ? { status: "done", message: result.message, openUrl: result.openUrl } : { status: "error", message: result.message });
      onDone?.(result);
    } catch {
      setState({ status: "error", message: "Mất kết nối, vui lòng thử lại." });
    }
  };
  return (
    <div className="rounded-2xl border border-primary/25 bg-background/80 p-3 shadow-sm">
      <p className="text-[10px] font-medium uppercase tracking-wide text-primary">Cần bạn xác nhận · {action.title}</p>
      <p className="mt-1 text-sm">{action.summary}</p>
      {action.warning && (
        <p className="mt-1.5 flex gap-1.5 text-xs text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {action.warning}
        </p>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {state.status === "idle" || state.status === "running" ? (
          <>
            <button
              type="button"
              disabled={state.status === "running"}
              onClick={() => void confirm()}
              className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-60"
            >
              {state.status === "running" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              Xác nhận
            </button>
            <button
              type="button"
              disabled={state.status === "running"}
              onClick={() => setState({ status: "cancelled" })}
              className="inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" /> Hủy
            </button>
          </>
        ) : (
          <p
            className={cn(
              "flex items-center gap-1.5 text-xs",
              state.status === "done" ? "text-success" : state.status === "error" ? "text-destructive" : "text-muted-foreground"
            )}
          >
            {state.status === "done" ? <Check className="h-3.5 w-3.5" /> : state.status === "error" ? <AlertTriangle className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
            {state.status === "cancelled" ? "Đã hủy, không có thay đổi nào." : state.message}
            {state.openUrl && (
              <Link href={state.openUrl} className="ml-1 font-medium text-primary hover:underline">
                Mở
              </Link>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

export function MemoryProposalCard({ proposal }: { proposal: NonNullable<AssistantReply["memoryProposal"]> }) {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "declined" | "error">("idle");
  const [error, setError] = useState("");
  const save = async () => {
    setState("saving");
    const response = await fetch("/api/assistant/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: proposal.kind, key: proposal.key, value: proposal.value }),
    }).catch(() => null);
    const data = (await response?.json().catch(() => ({}))) as { error?: string } | undefined;
    if (response?.ok) setState("saved");
    else {
      setError(data?.error ?? "Không lưu được.");
      setState("error");
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border bg-background/70 px-3 py-2 text-xs">
      <BookmarkPlus className="h-3.5 w-3.5 text-primary" />
      <span className="flex-1">{proposal.label}</span>
      {state === "idle" || state === "saving" ? (
        <>
          <button type="button" onClick={() => void save()} disabled={state === "saving"} className="rounded-lg bg-primary px-2.5 py-1 font-medium text-primary-foreground">
            Ghi nhớ
          </button>
          <button type="button" onClick={() => setState("declined")} className="rounded-lg border px-2.5 py-1 text-muted-foreground">
            Không
          </button>
        </>
      ) : (
        <span className={state === "error" ? "text-destructive" : "text-muted-foreground"}>
          {state === "saved" ? "Đã ghi nhớ ✓" : state === "declined" ? "Đã bỏ qua" : error}
        </span>
      )}
    </div>
  );
}

export function StepsView({ steps }: { steps: AssistantStep[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-[11px] text-muted-foreground">
      <button type="button" onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1 hover:text-foreground" aria-expanded={open}>
        <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
        Đã thực hiện {steps.length} bước
      </button>
      {open && (
        <ol className="mt-1 space-y-0.5 border-l pl-3">
          {steps.map((s, i) => (
            <li key={i}>
              {s.label}
              {s.detail && <span className="text-muted-foreground/70"> · {s.detail}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

const REASONS: { value: string; label: string }[] = [
  { value: "wrong", label: "Thông tin sai" },
  { value: "not_found", label: "Không tìm đúng file" },
  { value: "irrelevant", label: "Không liên quan" },
  { value: "missing_source", label: "Thiếu nguồn" },
  { value: "incomplete", label: "Chưa đầy đủ" },
  { value: "other", label: "Khác" },
];

export function FeedbackBar({ replyId, question, citedFiles }: { replyId: string; question: string; citedFiles: string[] }) {
  const [rating, setRating] = useState<1 | -1 | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [correction, setCorrection] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [detailsSent, setDetailsSent] = useState(false);
  const [error, setError] = useState("");

  const send = async (value: 1 | -1, withDetails = false) => {
    setState("sending");
    const response = await fetch("/api/assistant/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyId,
        rating: value,
        reason: withDetails ? reason : null,
        correction: withDetails ? correction : null,
        question,
        citedFiles,
      }),
    }).catch(() => null);
    const data = (await response?.json().catch(() => ({}))) as { error?: string } | undefined;
    if (response?.ok) {
      setState("sent");
      if (withDetails) setDetailsSent(true);
    } else {
      setError(data?.error ?? "Không gửi được phản hồi.");
      setState("error");
    }
  };

  if (state === "sent" && (rating === 1 || detailsSent)) {
    return <p className="text-[11px] text-muted-foreground">Cảm ơn phản hồi của bạn, phản hồi sẽ được xem xét để cải thiện trợ lý.</p>;
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <span className="mr-1">Câu trả lời có hữu ích?</span>
        <button
          type="button"
          aria-label="Hữu ích"
          onClick={() => {
            setRating(1);
            void send(1);
          }}
          className={cn("rounded-md p-1 hover:bg-muted hover:text-foreground", rating === 1 && "text-success")}
        >
          <ThumbsUp className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="Không hữu ích"
          onClick={() => {
            setRating(-1);
            void send(-1);
          }}
          className={cn("rounded-md p-1 hover:bg-muted hover:text-foreground", rating === -1 && "text-destructive")}
        >
          <ThumbsDown className="h-3.5 w-3.5" />
        </button>
        {state === "error" && <span className="text-destructive">{error}</span>}
      </div>
      {rating === -1 && (
        <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="space-y-1.5 rounded-xl border bg-background/70 p-2.5">
          <div className="flex flex-wrap gap-1">
            {REASONS.map((r) => (
              <button
                key={r.value}
                type="button"
                onClick={() => setReason(r.value)}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[11px]",
                  reason === r.value ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
          <textarea
            value={correction}
            onChange={(e) => setCorrection(e.target.value.slice(0, 500))}
            rows={2}
            placeholder="Câu trả lời đúng là… (không nhập mật khẩu hay thông tin bảo mật)"
            aria-label="Góp ý câu trả lời đúng"
            className="w-full resize-none rounded-lg border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary/40"
          />
          <button
            type="button"
            disabled={state === "sending"}
            onClick={() => void send(-1, true)}
            className="rounded-lg bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-60"
          >
            Gửi góp ý
          </button>
        </motion.div>
      )}
    </div>
  );
}
