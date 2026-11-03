import { cn } from "@/lib/utils";
import type { WorkflowSummary } from "@/lib/workflow/summary";

/** "Bước 3 · Go-live", or "Bước 3, 4" for steps running side by side. */
export function currentLabel(current: WorkflowSummary["current"]): string {
  if (current.length === 1) return `Bước ${current[0].n} · ${current[0].title.trim() || "Bước chưa đặt tên"}`;
  return `Bước ${current.map((c) => c.n).join(", ")}`;
}

/** The pulsing "Đang diễn ra" mark of a plan's current stage. */
export function CurrentStage({ current, className }: { current: WorkflowSummary["current"]; className?: string }) {
  if (!current.length) return null;
  return (
    <p className={cn("flex min-w-0 items-center gap-1.5 text-xs font-medium text-sky-700 dark:text-sky-300", className)}>
      <span className="relative flex size-2 shrink-0">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-sky-500 opacity-60 motion-reduce:animate-none" />
        <span className="relative inline-flex size-2 rounded-full bg-sky-500" />
      </span>
      <span className="truncate">Đang diễn ra: {currentLabel(current)}</span>
    </p>
  );
}
