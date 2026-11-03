"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, Check, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { WorkflowSummary } from "@/lib/workflow/summary";
import { CurrentStage } from "./current-stage";
import { fullMoment } from "./styles";

/** "Đổi workflow" (signed in): every plan in the system, searchable; picking one opens it. */
export function WorkflowSwitcher({ currentId }: { currentId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<WorkflowSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // loaded on every opening, so new plans show up
  useEffect(() => {
    if (!open) return;
    let alive = true;
    /* eslint-disable react-hooks/set-state-in-effect -- reset when the dialog opens */
    setQuery("");
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    fetch("/api/workflows", { cache: "no-store" })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as { workflows?: WorkflowSummary[]; error?: string } | null;
        if (!alive) return;
        if (res.ok && body?.workflows) setList(body.workflows);
        else setError(body?.error ?? "Không tải được danh sách workflow");
      })
      .catch(() => alive && setError("Mất kết nối, hãy thử lại"));
    return () => {
      alive = false;
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const shown = (list ?? []).filter((w) => !q || w.name.toLowerCase().includes(q));

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} className="shrink-0 text-muted-foreground" title="Xem và chuyển sang workflow khác">
        <ArrowLeftRight /> <span className="hidden sm:inline">Đổi workflow</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="gap-0 p-0 sm:max-w-xl">
          <DialogHeader className="border-b px-5 pt-5 pb-4">
            <DialogTitle className="flex items-center gap-2">
              <ArrowLeftRight className="size-4 text-primary" /> Đổi workflow
            </DialogTitle>
            <DialogDescription>Tất cả workflow đang có trong hệ thống. Bấm vào một workflow để xem chi tiết.</DialogDescription>
            <label className="relative mt-2">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Tìm theo tên workflow"
                aria-label="Tìm workflow"
                className="h-9 w-full rounded-lg border border-input bg-background pr-3 pl-8 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              />
            </label>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto p-2">
            {error ? (
              <p className="px-3 py-6 text-center text-sm text-destructive">{error}</p>
            ) : list === null ? (
              <p className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Đang tải…
              </p>
            ) : shown.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">{q ? `Không có workflow nào khớp “${query.trim()}”.` : "Hệ thống chưa có workflow nào."}</p>
            ) : (
              <ul className="grid gap-1">
                {shown.map((w) => {
                  const here = w.id === currentId;
                  const pct = w.steps ? Math.round((w.done / w.steps) * 100) : 0;
                  return (
                    <li key={w.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setOpen(false);
                          if (!here) router.push(`/workflow/${w.id}`);
                        }}
                        aria-current={here ? "page" : undefined}
                        className={cn("grid w-full gap-1 rounded-lg px-3 py-2.5 text-left outline-none hover:bg-muted focus-visible:bg-muted", here && "bg-primary/8 ring-1 ring-primary/25")}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">{w.name}</span>
                          {w.late > 0 && <span className="shrink-0 rounded bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-medium text-rose-700 dark:text-rose-300">{w.late} bước trễ</span>}
                          {here && <Check className="size-4 shrink-0 text-primary" aria-label="Đang xem" />}
                        </span>
                        <CurrentStage current={w.current} />
                        <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground tabular-nums">
                          <span>
                            {w.done}/{w.steps} bước xong · {pct}%
                          </span>
                          {w.start !== null && w.end !== null && (
                            <span>
                              {fullMoment(w.start).slice(0, 10)} → {fullMoment(w.end).slice(0, 10)}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
