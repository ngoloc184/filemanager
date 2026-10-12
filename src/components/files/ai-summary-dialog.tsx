"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  FileWarning,
  Loader2,
  MessageCircleQuestion,
  RotateCcw,
  ScanText,
  Send,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { FileTile, fileKind } from "@/components/files/file-tile";
import { cn, formatBytes } from "@/lib/utils";
import type { Digest, Passage, SummaryLength } from "@/lib/assistant/digest";
import type { FileSummaryResult } from "@/lib/assistant/file-summary";

export type SummaryTarget = { id: string; name: string; mimeType?: string | null };

const OPEN_EVENT = "fm:open-ai-summary";
const CLOSE_EVENT = "fm:close-ai-summary";

/** Opens the "AI tóm tắt" dialog for a file from anywhere in the app. */
export function openAiSummary(file: SummaryTarget): void {
  window.dispatchEvent(new CustomEvent<SummaryTarget>(OPEN_EVENT, { detail: file }));
}

/** Lets floating UI (the assistant launcher) step aside while the dialog is open. */
export function onAiSummaryVisibility(listener: (open: boolean) => void): () => void {
  const onOpen = () => listener(true);
  const onClose = () => listener(false);
  window.addEventListener(OPEN_EVENT, onOpen);
  window.addEventListener(CLOSE_EVENT, onClose);
  return () => {
    window.removeEventListener(OPEN_EVENT, onOpen);
    window.removeEventListener(CLOSE_EVENT, onClose);
  };
}

const LENGTHS: { value: SummaryLength; label: string }[] = [
  { value: "short", label: "Ngắn gọn" },
  { value: "keypoints", label: "Ý chính" },
  { value: "detailed", label: "Chi tiết" },
];

const STEPS = ["Kiểm tra quyền truy cập", "Đọc nội dung file", "Phân tích và tóm tắt"];

type Answer = NonNullable<Extract<FileSummaryResult, { ok: true }>["answer"]>;

async function request(body: Record<string, unknown>, signal: AbortSignal): Promise<FileSummaryResult> {
  const response = await fetch("/api/assistant/summarize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const data = (await response.json().catch(() => null)) as FileSummaryResult | { ok: false; message?: string } | null;
  if (data && "ok" in data) return data as FileSummaryResult;
  return { ok: false, status: 503, code: "failed", message: "Không thể tóm tắt file lúc này, vui lòng thử lại." };
}

function PassageText({ passage }: { passage: Passage }) {
  return (
    <>
      {passage.text}
      {passage.page && <span className="ml-1 text-[11px] text-muted-foreground">(trang {passage.page})</span>}
    </>
  );
}

function Section({ title, items }: { title: string; items: Passage[] }) {
  if (!items.length) return null;
  return (
    <section>
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      <ul className="space-y-2">
        {items.map((item, i) => (
          <motion.li
            key={`${title}-${i}`}
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.04 }}
            className="flex gap-2.5 text-sm leading-relaxed"
          >
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
            <span>
              <PassageText passage={item} />
            </span>
          </motion.li>
        ))}
      </ul>
    </section>
  );
}

function SheetTables({ digest }: { digest: Digest }) {
  if (digest.kind !== "table") return null;
  return (
    <div className="space-y-3">
      {digest.sheets.slice(0, 4).map((sheet) => (
        <div key={sheet.name} className="overflow-hidden rounded-xl border">
          <p className="border-b bg-muted/40 px-3 py-1.5 text-xs font-medium">
            {sheet.name} · {sheet.rows} dòng
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  {sheet.columns.slice(0, 8).map((c) => (
                    <th key={c.name} className="whitespace-nowrap px-3 py-1.5 font-medium">
                      {c.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sheet.sample.map((row, r) => (
                  <tr key={r} className="border-t">
                    {sheet.columns.slice(0, 8).map((c, i) => (
                      <td key={c.name} className="max-w-[10rem] truncate whitespace-nowrap px-3 py-1.5">
                        {row[i] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

function ErrorState({ result }: { result: Extract<FileSummaryResult, { ok: false }> }) {
  const Icon = result.code === "needs_ocr" ? ScanText : result.code === "not_found" ? AlertTriangle : FileWarning;
  return (
    <div className="flex flex-col items-center px-4 py-10 text-center">
      <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-warning/15 text-warning">
        <Icon className="h-6 w-6" />
      </span>
      <p className="max-w-md text-sm">{result.message}</p>
    </div>
  );
}

/** Dialog host: mounted once in the app shell, opened via openAiSummary(). */
export function AiSummaryHost() {
  const [target, setTarget] = useState<SummaryTarget | null>(null);
  useEffect(() => {
    const onOpen = (event: Event) => setTarget((event as CustomEvent<SummaryTarget>).detail);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);
  if (!target) return null;
  const close = () => {
    setTarget(null);
    window.dispatchEvent(new Event(CLOSE_EVENT));
  };
  return <AiSummaryDialog key={target.id} file={target} onClose={close} />;
}

function AiSummaryDialog({ file, onClose }: { file: SummaryTarget; onClose: () => void }) {
  const [length, setLength] = useState<SummaryLength>("keypoints");
  const [result, setResult] = useState<FileSummaryResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState(0);
  const [copied, setCopied] = useState(false);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (nextLength: SummaryLength, refresh = false) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setStep(0);
      try {
        const data = await request({ fileId: file.id, length: nextLength, refresh }, controller.signal);
        if (!controller.signal.aborted) setResult(data);
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setResult({ ok: false, status: 503, code: "failed", message: "Mất kết nối, vui lòng thử lại." });
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [file.id]
  );

  useEffect(() => {
    // initial summary when the dialog opens
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void run("keypoints");
    return () => abortRef.current?.abort();
  }, [run]);

  // Progress indicator for the pipeline while the request runs.
  useEffect(() => {
    if (!loading) return;
    const timers = [setTimeout(() => setStep(1), 500), setTimeout(() => setStep(2), 1600)];
    return () => timers.forEach(clearTimeout);
  }, [loading]);

  const changeLength = (value: SummaryLength) => {
    if (value === length || loading) return;
    setLength(value);
    void run(value);
  };

  const copy = async () => {
    if (!result?.ok) return;
    try {
      await navigator.clipboard.writeText(result.text);
      setCopied(true);
      toast.success("Đã sao chép bản tóm tắt");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Không sao chép được, hãy chọn và sao chép thủ công.");
    }
  };

  const ask = async (event: FormEvent) => {
    event.preventDefault();
    const q = question.trim();
    if (!q || asking) return;
    setAsking(true);
    try {
      const data = await request({ fileId: file.id, length, question: q }, new AbortController().signal);
      if (data.ok && data.answer) {
        setAnswers((prev) => [...prev, data.answer!]);
        setQuestion("");
      } else if (!data.ok) {
        toast.error(data.message);
      }
    } finally {
      setAsking(false);
    }
  };

  const digest = result?.ok ? result.digest : null;
  const meta = result ? (result.ok ? result.file : (result.file ?? null)) : null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[92vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b p-4 pr-12 text-left">
          <div className="flex items-center gap-3">
            <FileTile kind={fileKind(file.mimeType, file.name)} />
            <div className="min-w-0 flex-1">
              <DialogTitle className="flex items-center gap-1.5 text-base">
                <Sparkles className="h-4 w-4 shrink-0 text-primary" />
                AI tóm tắt
              </DialogTitle>
              <DialogDescription className="truncate" title={file.name}>
                {file.name}
                {meta ? ` · ${formatBytes(meta.size)}${meta.folderName ? ` · ${meta.folderName}` : ""}` : ""}
              </DialogDescription>
            </div>
          </div>
          <div className="mt-3 inline-flex w-full rounded-xl border bg-muted/40 p-0.5 sm:w-auto" role="radiogroup" aria-label="Độ dài bản tóm tắt">
            {LENGTHS.map((l) => (
              <button
                key={l.value}
                type="button"
                role="radio"
                aria-checked={length === l.value}
                disabled={loading && length !== l.value}
                onClick={() => changeLength(l.value)}
                className={cn(
                  "relative flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors sm:flex-none",
                  length === l.value ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {length === l.value && (
                  <motion.span layoutId="summary-length" className="absolute inset-0 rounded-lg bg-card shadow-sm ring-1 ring-border" />
                )}
                <span className="relative">{l.label}</span>
              </button>
            ))}
          </div>
        </DialogHeader>

        <div className="flex-1 space-y-5 overflow-y-auto p-4 sm:p-5">
          <AnimatePresence mode="wait">
            {loading ? (
              <motion.div
                key="loading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="space-y-3 py-6"
                aria-live="polite"
              >
                {STEPS.map((label, i) => (
                  <div key={label} className={cn("flex items-center gap-3 text-sm", i > step && "text-muted-foreground/60")}>
                    {i < step ? (
                      <CheckCircle2 className="h-4 w-4 text-success" />
                    ) : i === step ? (
                      <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    ) : (
                      <span className="h-4 w-4 rounded-full border" />
                    )}
                    {label}
                    {i === 1 && <span className="text-xs text-muted-foreground">({file.name})</span>}
                  </div>
                ))}
                <div className="space-y-2 pt-3">
                  {[90, 75, 82, 60].map((w, i) => (
                    <div key={i} className="h-3 animate-pulse rounded bg-muted" style={{ width: `${w}%` }} />
                  ))}
                </div>
              </motion.div>
            ) : result && !result.ok ? (
              <motion.div key="error" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <ErrorState result={result} />
              </motion.div>
            ) : digest && result?.ok ? (
              <motion.div key={`result-${length}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 font-medium",
                      result.engine === "llm" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                    )}
                  >
                    {result.engine === "llm" ? "Tạo bởi mô hình AI" : "Trích xuất tự động · không dùng AI bên ngoài"}
                  </span>
                  <span className="text-muted-foreground">
                    Đã đọc {new Intl.NumberFormat("vi-VN").format(digest.coverage.chars)} ký tự
                    {digest.coverage.pages ? ` · ${digest.coverage.pages} trang` : ""}
                    {result.cached ? " · kết quả đã lưu" : ""}
                  </span>
                </div>

                {result.notices.map((n) => (
                  <p key={n} className="rounded-xl bg-warning/10 px-3 py-2 text-xs">
                    {n}
                  </p>
                ))}

                {digest.overview.length > 0 && (
                  <section className="rounded-2xl border bg-primary/5 p-4">
                    <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-primary">Tổng quan</h4>
                    {digest.overview.map((o) => (
                      <p key={o} className="text-sm leading-relaxed">
                        {o}
                      </p>
                    ))}
                  </section>
                )}

                <Section title={digest.kind === "table" ? "Cấu trúc dữ liệu" : "Các ý chính"} items={digest.keyPoints} />
                <SheetTables digest={digest} />
                <Section title={digest.kind === "table" ? "Số liệu (tính từ dữ liệu)" : "Thông tin chi tiết"} items={digest.details} />
                <Section title="Việc cần thực hiện" items={digest.actions} />
                {digest.conclusion && <Section title="Kết luận" items={[digest.conclusion]} />}

                {digest.keywords.length >= 3 && (
                  <div className="flex flex-wrap gap-1.5">
                    {digest.keywords.map((k) => (
                      <span key={k} className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                        #{k}
                      </span>
                    ))}
                  </div>
                )}

                {/* Q&A about this file */}
                <section className="rounded-2xl border p-3">
                  <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <MessageCircleQuestion className="h-3.5 w-3.5" />
                    Hỏi về nội dung file
                  </h4>
                  {answers.map((a, i) => (
                    <div key={i} className="mb-3 space-y-1.5 text-sm">
                      <p className="font-medium">{a.question}</p>
                      {a.text && <p className="leading-relaxed">{a.text}</p>}
                      {a.passages.length ? (
                        <ul className="space-y-1">
                          {a.passages.map((p, j) => (
                            <li key={j} className="rounded-lg border-l-2 border-primary/50 bg-muted/40 px-2.5 py-1.5 text-xs italic text-muted-foreground">
                              “<PassageText passage={p} />”
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-xs text-muted-foreground">Không tìm thấy đoạn nào trong tài liệu đề cập đến nội dung này.</p>
                      )}
                    </div>
                  ))}
                  <form onSubmit={ask} className="flex gap-2">
                    <input
                      value={question}
                      onChange={(e) => setQuestion(e.target.value.slice(0, 300))}
                      placeholder="Ví dụ: doanh thu tháng 9 là bao nhiêu?"
                      aria-label="Câu hỏi về file"
                      className="h-9 min-w-0 flex-1 rounded-lg border bg-background/70 px-3 text-sm outline-none focus:border-primary/40 focus:ring-2 focus:ring-primary/15"
                    />
                    <Button type="submit" size="icon-lg" variant="outline" disabled={!question.trim() || asking} aria-label="Hỏi">
                      {asking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    </Button>
                  </form>
                </section>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t p-3">
          {meta?.openUrl && (
            <Button variant="ghost" size="sm" className="mr-auto gap-1.5" render={<Link href={meta.openUrl} onClick={onClose} />}>
              <ExternalLink className="h-3.5 w-3.5" />
              Mở file
            </Button>
          )}
          <Button variant="outline" size="sm" className="gap-1.5" disabled={loading} onClick={() => void run(length, true)}>
            <RotateCcw className="h-3.5 w-3.5" />
            Tóm tắt lại
          </Button>
          <Button variant="brand" size="sm" className="gap-1.5" disabled={!result?.ok || loading} onClick={() => void copy()}>
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Đã sao chép" : "Sao chép"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
