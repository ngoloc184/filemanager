"use client";

// "Bộ nhớ" view inside the assistant: what the assistant remembers about the
// signed-in user, with add / edit / delete / forget everything.

import { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";
import { ArrowLeft, BookOpen, Loader2, Pencil, Plus, Settings2, StickyNote, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { MemoryItem } from "@/lib/assistant/memory";

const KIND = {
  preference: { label: "Cách trả lời", icon: Settings2 },
  glossary: { label: "Thuật ngữ", icon: BookOpen },
  note: { label: "Ghi chú", icon: StickyNote },
} as const;

const STYLE: Record<string, string> = { short: "Ngắn gọn", normal: "Bình thường", detailed: "Chi tiết" };

async function call(method: string, body?: unknown) {
  const response = await fetch("/api/assistant/memory", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string; memories?: MemoryItem[] };
  if (!response.ok) throw new Error(data.error ?? "Không thực hiện được.");
  return data;
}

export function MemoryPanel({ onBack }: { onBack: () => void }) {
  const [items, setItems] = useState<MemoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [version, setVersion] = useState(0);
  const load = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let alive = true;
    call("GET")
      .then((data) => {
        if (!alive) return;
        setItems(data.memories ?? []);
        setError(null);
      })
      .catch((e: Error) => {
        if (!alive) return;
        setError(e.message);
        setItems([]);
      });
    return () => {
      alive = false;
    };
  }, [version]);

  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await work();
      toast.success(done);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <button type="button" onClick={onBack} aria-label="Quay lại trò chuyện" className="rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <p className="text-sm font-semibold">Bộ nhớ của trợ lý</p>
        {items && items.length > 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (window.confirm("Xóa toàn bộ những gì trợ lý đang ghi nhớ về bạn?")) void run(() => call("DELETE", { all: true }), "Đã xóa toàn bộ bộ nhớ");
            }}
            className="ml-auto text-xs text-destructive hover:underline"
          >
            Quên tất cả
          </button>
        )}
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        <p className="rounded-xl bg-muted/50 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          Chỉ bạn xem được bộ nhớ này. Trợ lý chỉ ghi nhớ khi bạn yêu cầu (“Hãy nhớ…”, “Từ giờ trả lời ngắn gọn”) hoặc khi bạn xác nhận,
          không bao giờ lưu mật khẩu, mã hay số giấy tờ, và không lưu nội dung file. Ghi chú tự hết hạn sau 180 ngày.
        </p>

        {items === null ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <p className="text-xs text-destructive">{error}</p>
        ) : items.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">Trợ lý chưa ghi nhớ điều gì về bạn.</p>
        ) : (
          <ul className="space-y-1.5">
            {items.map((m) => {
              const Icon = KIND[m.kind].icon;
              const isEditing = editing?.id === m.id;
              return (
                <li key={m.id} className="group rounded-xl border bg-background/70 px-3 py-2">
                  <div className="flex items-start gap-2">
                    <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        {KIND[m.kind].label}
                        {m.kind === "glossary" && m.key ? ` · ${m.key}` : ""}
                      </p>
                      {isEditing ? (
                        m.kind === "preference" ? (
                          <select
                            value={editing.value}
                            onChange={(e) => setEditing({ id: m.id, value: e.target.value })}
                            className="mt-1 w-full rounded-lg border bg-background px-2 py-1 text-xs"
                          >
                            {Object.entries(STYLE).map(([v, l]) => (
                              <option key={v} value={v}>
                                Trả lời {l.toLowerCase()}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            value={editing.value}
                            onChange={(e) => setEditing({ id: m.id, value: e.target.value.slice(0, 300) })}
                            className="mt-1 w-full rounded-lg border bg-background px-2 py-1 text-xs outline-none focus:border-primary/40"
                            aria-label="Sửa nội dung ghi nhớ"
                          />
                        )
                      ) : (
                        <p className="break-words text-sm">{m.kind === "preference" ? `Trả lời ${(STYLE[m.value] ?? m.value).toLowerCase()}` : m.value}</p>
                      )}
                      {m.expiresAt && !isEditing && (
                        <p className="text-[10px] text-muted-foreground">Hết hạn {new Date(m.expiresAt).toLocaleDateString("vi-VN")}</p>
                      )}
                    </div>
                    {isEditing ? (
                      <div className="flex gap-1">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void run(() => call("PATCH", editing), "Đã cập nhật").then(() => setEditing(null))}
                          className="rounded-lg bg-primary px-2 py-1 text-[11px] text-primary-foreground"
                        >
                          Lưu
                        </button>
                        <button type="button" onClick={() => setEditing(null)} className="rounded-lg border px-2 py-1 text-[11px]">
                          Hủy
                        </button>
                      </div>
                    ) : (
                      <div className="flex gap-0.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100">
                        <button
                          type="button"
                          aria-label="Sửa"
                          onClick={() => setEditing({ id: m.id, value: m.value })}
                          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label="Quên mục này"
                          disabled={busy}
                          onClick={() => void run(() => call("DELETE", { id: m.id }), "Đã quên")}
                          className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <form
        className="border-t p-3"
        onSubmit={(e) => {
          e.preventDefault();
          const text = draft.trim();
          if (!text) return;
          void run(() => call("POST", { text }), "Đã ghi nhớ").then(() => setDraft(""));
        }}
      >
        <div className="flex items-center gap-2 rounded-2xl border bg-background/70 p-1.5 pl-3 focus-within:border-primary/40">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value.slice(0, 300))}
            placeholder="VD: HĐ nghĩa là hợp đồng · Trả lời ngắn gọn"
            aria-label="Thêm điều cần ghi nhớ"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <button
            type="submit"
            disabled={!draft.trim() || busy}
            aria-label="Ghi nhớ"
            className={cn("flex h-8 w-8 items-center justify-center rounded-xl text-white", draft.trim() ? "bg-brand" : "bg-muted text-muted-foreground")}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          </button>
        </div>
      </form>
    </motion.div>
  );
}
