"use client";

import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { clampAmount, dayMark, dayWindow, formatStamp, isOffDay, isOverdue, minutesPerDay, parseStamp, planRange, topoOrder, updateStep, workBetween } from "@/lib/workflow/model";
import { useWorkflow } from "./context";
import { ROLE_STYLE, STATUS_META, durationLabel, fullMoment, mark, minutesLabel, weekdayLabel } from "./styles";

const ROW_H = 56;
const ZOOMS = [24, 36, 52];
const DAY = 1440;

/** Timeline: one row per step in plan order, bars from start to end; extensions are striped. */
export function GanttView() {
  const { doc, slots, now, canEdit, currentIds, focusRoleId, edit, openStep } = useWorkflow();
  const [zoom, setZoom] = useState(1);
  const col = ZOOMS[zoom];
  const drag = useRef<{ id: string; x0: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [winA, winB] = dayWindow(doc.hours);

  const rows = useMemo(() => {
    const index = new Map(doc.steps.map((s, i) => [s.id, i]));
    const byId = new Map(doc.steps.map((s) => [s.id, s]));
    return topoOrder(doc.steps, doc.edges).map((id) => ({ step: byId.get(id)!, n: index.get(id)! + 1 }));
  }, [doc.steps, doc.edges]);

  // whole days shown: a margin around the plan and today
  const { firstDay, days } = useMemo(() => {
    const range = planRange(slots);
    const start = Math.floor((range?.start ?? parseStamp(doc.start)) / DAY);
    const end = Math.floor((range?.end ?? parseStamp(doc.start) + 14 * DAY) / DAY);
    const today = Math.floor(now / DAY);
    const from = Math.min(start, today) - 2;
    const to = Math.min(Math.max(end, today) + 4, from + 800);
    return { firstDay: from, days: Array.from({ length: to - from + 1 }, (_, i) => from + i) };
  }, [slots, doc.start, now]);

  /** Minutes → x: whole days, plus how far into the working window. */
  const x = (t: number) => {
    const day = Math.floor(t / DAY);
    const m = t - day * DAY;
    return (day - firstDay) * col + Math.min(1, Math.max(0, (m - winA) / (winB - winA))) * col;
  };
  const tAt = (px: number) => {
    const day = firstDay + Math.floor(px / col);
    const frac = Math.min(1, Math.max(0, px / col - Math.floor(px / col)));
    return day * DAY + winA + frac * (winB - winA);
  };

  const months = useMemo(() => {
    const out: { label: string; span: number }[] = [];
    for (const d of days) {
      const s = formatStamp(d * DAY);
      const label = `Tháng ${Number(s.slice(5, 7))}/${s.slice(0, 4)}`;
      if (out.at(-1)?.label === label) out.at(-1)!.span++;
      else out.push({ label, span: 1 });
    }
    return out;
  }, [days]);

  const setAmount = (id: string, amount: number) => {
    const step = doc.steps.find((s) => s.id === id);
    if (step && clampAmount(amount) !== step.duration.amount) edit((d) => updateStep(d, id, { duration: { ...step.duration, amount: clampAmount(amount) } }), `duration:${id}`);
  };

  function onResizeDown(e: ReactPointerEvent, id: string) {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { id, x0: e.clientX, moved: false };
    setDragging(id);
  }

  function onPointerMove(e: ReactPointerEvent) {
    const d = drag.current;
    if (!d) return;
    const step = doc.steps.find((s) => s.id === d.id);
    const slot = slots.get(d.id);
    if (!step || !slot) return;
    if (Math.abs(e.clientX - d.x0) > 2) d.moved = true;
    const grid = (e.currentTarget as HTMLElement).querySelector("[data-grid]")?.getBoundingClientRect();
    if (!grid) return;
    const work = workBetween(slot.start, tAt(e.clientX - grid.left), doc.hours);
    setAmount(d.id, step.duration.unit === "d" ? Math.round(work / minutesPerDay(doc.hours)) : Math.round(work / 60));
  }

  function onPointerUp() {
    drag.current = null;
    setDragging(null);
  }

  /** Shift+←/→ shortens or lengthens a step by one of its units; Enter opens it. */
  function onKeyDown(e: KeyboardEvent, id: string) {
    if (e.key === "Enter") return openStep(id);
    const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!dir || !e.shiftKey || !canEdit) return;
    e.preventDefault();
    const step = doc.steps.find((s) => s.id === id);
    if (step) setAmount(id, step.duration.amount + dir);
  }

  if (!doc.steps.length) {
    return <div className="grid h-full place-items-center p-6 text-center text-sm text-muted-foreground">Chưa có bước nào.</div>;
  }

  const gridW = days.length * col;
  const nowX = x(now);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-2 text-xs text-muted-foreground">
        <p className="hidden items-center gap-3 sm:flex">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-5 rounded-sm bg-violet-500" /> Thời lượng
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="gantt-stripes h-2.5 w-5 rounded-sm bg-amber-500" /> Gia hạn
          </span>
          {canEdit && <span>· Kéo mép phải của thanh để đổi thời lượng (Shift + ←/→)</span>}
        </p>
        <div className="ml-auto flex items-center gap-1" role="group" aria-label="Thu phóng">
          <button type="button" aria-label="Thu nhỏ" disabled={zoom === 0} onClick={() => setZoom(zoom - 1)} className="grid size-7 place-items-center rounded-md ring-1 ring-border hover:bg-muted disabled:opacity-40">
            <Minus className="size-3.5" />
          </button>
          <button type="button" aria-label="Phóng to" disabled={zoom === ZOOMS.length - 1} onClick={() => setZoom(zoom + 1)} className="grid size-7 place-items-center rounded-md ring-1 ring-border hover:bg-muted disabled:opacity-40">
            <Plus className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-auto" onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
        {/* the step-name column is narrower on phones: --left is its width */}
        <div className="relative [--left:150px] sm:[--left:320px]" style={{ width: `calc(var(--left) + ${gridW}px)`, minWidth: "100%" }}>
          <div className="sticky top-0 z-20 flex bg-background/95 backdrop-blur">
            <div className="sticky left-0 z-10 flex shrink-0 items-end border-r border-b bg-background px-4 pb-2 text-xs font-medium text-muted-foreground" style={{ width: "var(--left)" }}>
              Bước · PIC
            </div>
            <div className="border-b" style={{ width: gridW }}>
              <div className="flex h-6 text-[11px] font-medium text-muted-foreground">
                {months.map((m, i) => (
                  <div key={i} className="truncate border-l px-1.5 leading-6 first:border-l-0" style={{ width: m.span * col }}>
                    {m.label}
                  </div>
                ))}
              </div>
              <div className="flex h-8">
                {days.map((d) => {
                  const off = isOffDay(d * DAY, doc.hours);
                  const today = d === Math.floor(now / DAY);
                  return (
                    <div
                      key={d}
                      className={cn("grid shrink-0 place-content-center text-center leading-tight tabular-nums", off ? "text-muted-foreground/50" : "text-muted-foreground", today && "rounded-md bg-primary text-primary-foreground")}
                      style={{ width: col }}
                    >
                      <span className="text-[11px] font-medium">{formatStamp(d * DAY).slice(8, 10)}</span>
                      {col >= 36 && <span className="text-[9px]">{weekdayLabel(d * DAY)}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="relative">
            <div aria-hidden className="pointer-events-none absolute inset-y-0 flex" style={{ left: "var(--left)" }}>
              {days.map((d) => (
                <div key={d} className={cn("h-full shrink-0 border-l border-border/40", isOffDay(d * DAY, doc.hours) && "bg-muted/70")} style={{ width: col }} />
              ))}
            </div>
            {nowX >= 0 && nowX <= gridW && <div aria-hidden className="pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-primary/70" style={{ left: `calc(var(--left) + ${nowX}px)` }} />}

            {rows.map(({ step, n }) => {
              const slot = slots.get(step.id);
              const roles = step.picIds.map((id) => doc.roles.find((r) => r.id === id)).filter((r) => r !== undefined);
              const late = isOverdue(step, slot, now);
              const current = currentIds.has(step.id);
              const StatusIcon = STATUS_META[step.status].icon;
              const faded = focusRoleId !== null && !step.picIds.includes(focusRoleId);
              const x1 = slot ? x(slot.start) : 0;
              const xBase = slot ? x(slot.baseEnd) : 0;
              const x2 = slot ? x(slot.end) : 0;
              return (
                <div key={step.id} className={cn("group/row relative flex border-b border-border/60 hover:bg-muted/30", current && "bg-sky-500/6", faded && "opacity-35")} style={{ height: ROW_H }}>
                  <button
                    type="button"
                    onClick={() => openStep(step.id)}
                    className={cn(
                      "sticky left-0 z-10 flex shrink-0 items-center gap-2 border-r bg-background px-2.5 text-left outline-none group-hover/row:bg-muted/30 focus-visible:bg-muted sm:gap-2.5 sm:px-4",
                      current && "shadow-[inset_3px_0_0_var(--color-sky-500)]"
                    )}
                    style={{ width: "var(--left)" }}
                    title={current ? "Đang diễn ra" : undefined}
                  >
                    <span className={cn("w-5 shrink-0 text-xs font-semibold tabular-nums", current ? "text-sky-600 dark:text-sky-400" : "text-muted-foreground")}>{n}</span>
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate text-[13px] font-medium", !step.title && "text-muted-foreground italic")}>{step.title || "Bước chưa đặt tên"}</span>
                      <span className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
                        <span className="font-medium text-foreground/80">{durationLabel(step.duration)}</span>
                        {slot && slot.extraMinutes > 0 && <span className="text-amber-700 dark:text-amber-300">+{minutesLabel(slot.extraMinutes, doc.hours)}</span>}
                        {roles.map((r) => (
                          <span key={r.id} className="inline-flex items-center gap-1">
                            <span className={cn("size-1.5 rounded-full", ROLE_STYLE[r.color].dot)} />
                            {r.name}
                          </span>
                        ))}
                      </span>
                    </span>
                    <StatusIcon className={cn("hidden size-4 shrink-0 sm:block", STATUS_META[step.status].text)} aria-label={STATUS_META[step.status].label} />
                  </button>

                  <div className="relative" style={{ width: gridW }} data-grid>
                    {slot && (
                      <div
                        role="button"
                        tabIndex={0}
                        aria-label={`${step.title || `Bước ${n}`}: ${fullMoment(slot.start)} đến ${fullMoment(slot.end)}`}
                        onClick={() => !drag.current && openStep(step.id)}
                        onKeyDown={(e) => onKeyDown(e, step.id)}
                        className={cn(
                          "absolute top-1/2 flex h-8 -translate-y-1/2 cursor-pointer items-stretch overflow-hidden rounded-lg text-[11px] font-medium text-white shadow-sm outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/60",
                          step.status === "done" && "opacity-55",
                          late && "ring-2 ring-rose-500 ring-offset-1 ring-offset-background",
                          current && "shadow-md shadow-sky-500/30 ring-2 ring-sky-500 ring-offset-1 ring-offset-background",
                          dragging === step.id && "shadow-lg"
                        )}
                        style={{ left: x1, width: Math.max(x2 - x1, 6) }}
                        title={`${fullMoment(slot.start)} → ${fullMoment(slot.end)}`}
                      >
                        <span className={cn("relative flex items-center", roles[0] ? ROLE_STYLE[roles[0].color].bar : "bg-muted-foreground/60")} style={{ width: Math.max(xBase - x1, 4) }}>
                          {step.status === "doing" && <span aria-hidden className="absolute inset-y-0 left-0 w-1/2 bg-white/15" />}
                          <span className="relative truncate px-2 tabular-nums">{xBase - x1 >= 70 ? `${durationLabel(step.duration)} · ${mark(dayMark(doc, slot.end))}` : xBase - x1 >= 40 ? durationLabel(step.duration) : ""}</span>
                          {canEdit && (
                            <span
                              aria-hidden
                              onPointerDown={(e) => onResizeDown(e, step.id)}
                              onClick={(e) => e.stopPropagation()}
                              className="absolute inset-y-0 right-0 w-2.5 cursor-ew-resize touch-none bg-black/15 opacity-0 transition-opacity group-hover/row:opacity-100"
                            />
                          )}
                        </span>
                        {x2 - xBase > 0.5 && <span className="gantt-stripes bg-amber-500" style={{ width: x2 - xBase }} title={`Gia hạn +${minutesLabel(slot.extraMinutes, doc.hours)}`} />}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
