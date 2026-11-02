"use client";

import { ArrowRight, BadgeCheck, CalendarPlus, Clock3, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { StepLog } from "@/lib/workflow/model";
import { durationLabel, logTime } from "./styles";

/** The log of one step, newest first: extensions and length changes, with who and why. */
export function StepHistory({ logs, onCancel }: { logs: StepLog[]; onCancel?: (id: string) => Promise<boolean> }) {
  if (!logs.length) {
    return <p className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">Chưa có gia hạn hay thay đổi thời lượng nào.</p>;
  }
  return (
    <ol className="relative grid gap-3 before:absolute before:inset-y-2 before:left-[13px] before:w-px before:bg-border">
      {[...logs].reverse().map((l) => {
        const extend = l.kind === "extend";
        const Icon = extend ? CalendarPlus : Clock3;
        return (
          <li key={l.id} className={cn("relative flex gap-3", l.cancelledAt && "opacity-60")}>
            <span
              className={cn(
                "relative z-10 grid size-7 shrink-0 place-items-center rounded-full ring-4 ring-popover",
                extend ? "bg-amber-500/15 text-amber-700 dark:text-amber-300" : "bg-sky-500/15 text-sky-700 dark:text-sky-300"
              )}
            >
              <Icon className="size-3.5" />
            </span>
            <div className="min-w-0 flex-1 rounded-lg bg-muted/50 px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className={cn("font-semibold", l.cancelledAt && "line-through")}>
                  {extend ? (
                    `Gia hạn +${durationLabel({ amount: l.amount, unit: l.unit })}`
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      {l.oldAmount && l.oldUnit ? durationLabel({ amount: l.oldAmount, unit: l.oldUnit }) : "?"}
                      <ArrowRight className="size-3" />
                      {durationLabel({ amount: l.amount, unit: l.unit })}
                    </span>
                  )}
                </span>
                {l.cancelledAt && <span className="rounded bg-muted px-1 text-[10px] font-medium text-muted-foreground">Đã huỷ</span>}
                <span className="ml-auto text-muted-foreground tabular-nums">{logTime(l.createdAt)}</span>
              </div>
              <p className="mt-1 flex items-center gap-1 text-muted-foreground">
                <span className="font-medium text-foreground">{l.requesterName}</span>
                {l.signedIn && <BadgeCheck className="size-3.5 text-primary" aria-label="Đã đăng nhập" />}
                <span>· {l.requesterRole}</span>
              </p>
              {l.reason && <p className="mt-1 whitespace-pre-wrap text-foreground/90">“{l.reason}”</p>}
              {extend && !l.cancelledAt && onCancel && (
                <button
                  type="button"
                  onClick={async () => {
                    if (await onCancel(l.id)) toast.success("Đã huỷ lần gia hạn này");
                    else toast.error("Không huỷ được");
                  }}
                  className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-destructive"
                >
                  <Undo2 className="size-3" /> Huỷ gia hạn
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
