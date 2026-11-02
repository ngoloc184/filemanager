"use client";

import { memo } from "react";
import { Popover } from "@base-ui/react/popover";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { BadgeCheck, CalendarPlus, Clock3, History, Lock, PencilLine } from "lucide-react";
import { cn } from "@/lib/utils";
import { dayMark, isOverdue, updateStep } from "@/lib/workflow/model";
import { useWorkflow } from "./context";
import { DurationField } from "./duration-editor";
import { PicPicker } from "./pic-picker";
import { ROLE_STYLE, STATUS_META, durationLabel, mark, minutesLabel, shortMoment } from "./styles";

export type StepFlowNode = Node<{ stepId: string; index: number }, "step">;

const HANDLE = "!size-3 !border-2 !border-background !bg-muted-foreground/60 transition-[opacity,background-color] hover:!bg-primary";

// Four sides each have a target and a source handle; the canvas picks the pair facing the other
// step. Side handles sit level with the title so arrows between cards of one row stay straight.
const SIDES = [
  [Position.Left, "l"],
  [Position.Right, "r"],
  [Position.Top, "t"],
  [Position.Bottom, "b"],
] as const;
const SIDE_TOP: Record<string, { top: number } | undefined> = { l: { top: 26 }, r: { top: 26 } };

function StepNodeView({ data, selected }: NodeProps<StepFlowNode>) {
  const { doc, slots, logs, now, canEdit, focusRoleId, edit, openStep, openChange } = useWorkflow();
  const step = doc.steps.find((s) => s.id === data.stepId);
  if (!step) return null;
  const slot = slots.get(step.id);
  const late = isOverdue(step, slot, now);
  const status = STATUS_META[step.status];
  const StatusIcon = status.icon;
  const lead = doc.roles.find((r) => r.id === step.picIds[0]);
  const historyCount = logs.filter((l) => l.stepId === step.id).length;
  const extended = !!slot && slot.extraMinutes > 0;
  const faded = focusRoleId !== null && !step.picIds.includes(focusRoleId);
  const confirmed = step.confirmed;

  const durationText = (
    <>
      <Clock3 className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="font-semibold">{durationLabel(step.duration)}</span>
      {extended && <span className="font-medium text-amber-700 dark:text-amber-300">+{minutesLabel(slot.extraMinutes, doc.hours)}</span>}
      {canEdit || !confirmed ? (
        <PencilLine className="size-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      ) : (
        <Lock className="size-3 text-muted-foreground" aria-label="Đã chốt" />
      )}
    </>
  );
  const durationClass = "nodrag nopan -mx-1 flex items-center gap-1.5 rounded px-1 outline-none hover:bg-background focus-visible:ring-2 focus-visible:ring-ring/50";

  return (
    <div
      className={cn(
        "group relative w-[288px] rounded-xl bg-card text-card-foreground shadow-sm ring-1 transition-[box-shadow,opacity] duration-200",
        selected ? "shadow-md ring-2 ring-primary" : late ? "ring-rose-500/50" : "ring-border hover:shadow-md hover:ring-foreground/15",
        faded && "opacity-35"
      )}
      onDoubleClick={() => openStep(step.id)}
    >
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1 rounded-l-xl", lead ? ROLE_STYLE[lead.color].bar : "bg-muted-foreground/30")} />
      {SIDES.map(([pos, key]) => (
        <Handle key={`t${key}`} id={`t-${key}`} type="target" position={pos} style={SIDE_TOP[key]} isConnectable={canEdit} className={cn(HANDLE, "opacity-0", canEdit && "group-hover:opacity-100")} />
      ))}
      {SIDES.map(([pos, key]) => (
        <Handle key={`s${key}`} id={`s-${key}`} type="source" position={pos} style={SIDE_TOP[key]} isConnectable={canEdit} className={cn(HANDLE, "opacity-0", canEdit && "group-hover:opacity-100")} />
      ))}

      <div className="grid gap-2.5 pt-3 pr-3 pb-2 pl-4">
        <div className="flex items-start gap-2">
          <span className="mt-px grid size-6 shrink-0 place-items-center rounded-md bg-foreground/[0.06] text-[11px] font-semibold tabular-nums text-muted-foreground">{data.index + 1}</span>
          <button
            type="button"
            onClick={() => openStep(step.id)}
            className="nodrag min-w-0 flex-1 text-left text-[13px] leading-snug font-medium outline-none hover:text-primary focus-visible:underline"
            title={step.title || "Bước chưa đặt tên"}
          >
            <span className={cn("line-clamp-2", !step.title && "text-muted-foreground italic", step.status === "done" && "text-muted-foreground")}>{step.title || "Bước chưa đặt tên"}</span>
          </button>
          <span className={cn("mt-0.5 shrink-0", status.text)} title={status.label}>
            <StatusIcon className="size-4" aria-label={status.label} />
          </span>
        </div>

        <PicPicker step={step} />

        <div className={cn("grid gap-1 rounded-lg px-2 py-1.5 text-xs", late ? "bg-rose-500/8" : "bg-muted/60", !confirmed && !late && "outline-1 outline-dashed outline-primary/35")}>
          <div className="flex items-center gap-1.5">
            {canEdit ? (
              <Popover.Root>
                <Popover.Trigger aria-label="Sửa thời lượng" className={durationClass}>
                  {durationText}
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Positioner sideOffset={6} align="start" className="z-50">
                    <Popover.Popup className="w-[19rem] origin-(--transform-origin) rounded-xl bg-popover p-3 text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none transition-[transform,opacity] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
                      <DurationField value={step.duration} onChange={(duration) => edit((d) => updateStep(d, step.id, { duration }), `duration:${step.id}`)} />
                      <p className="mt-2.5 text-[11px] text-muted-foreground">Thay đổi được ghi vào lịch sử của bước. Các bước sau tự dời theo.</p>
                    </Popover.Popup>
                  </Popover.Positioner>
                </Popover.Portal>
              </Popover.Root>
            ) : confirmed ? (
              <span className="-mx-1 flex items-center gap-1.5 px-1" title="Timeline đã chốt: chỉ có thể gia hạn">
                {durationText}
              </span>
            ) : (
              <button type="button" onClick={() => openChange(step.id, "duration")} aria-label="Sửa số ngày" className={durationClass}>
                {durationText}
              </button>
            )}
            {slot && (
              <span className="ml-auto shrink-0 rounded bg-background/80 px-1 font-mono text-[10px] text-muted-foreground ring-1 ring-border tabular-nums">
                {mark(dayMark(doc, slot.start))}→{mark(dayMark(doc, slot.end))}
              </span>
            )}
          </div>
          {slot && (
            <p className="truncate tabular-nums text-muted-foreground">
              {shortMoment(slot.start)} → <span className={cn("font-medium", late ? "text-rose-700 dark:text-rose-300" : "text-foreground")}>{shortMoment(slot.end)}</span>
            </p>
          )}
        </div>

        <div className="-mx-1 flex items-center gap-0.5">
          {confirmed ? (
            <span className="inline-flex h-7 items-center gap-1 px-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400" title={`Chốt bởi ${confirmed.by} (${confirmed.role})`}>
              <BadgeCheck className="size-3.5" /> Đã chốt
            </span>
          ) : (
            <button type="button" onClick={() => openChange(step.id, "confirm")} className="nodrag nopan inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-primary hover:bg-primary/10" title="Timeline đang là mặc định, chưa được xác nhận">
              <BadgeCheck className="size-3.5" /> Xác nhận
            </button>
          )}
          <button type="button" onClick={() => openChange(step.id, "extend")} className="nodrag nopan inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-amber-700 hover:bg-amber-500/10 dark:text-amber-300">
            <CalendarPlus className="size-3.5" /> Gia hạn
          </button>
          <button
            type="button"
            onClick={() => openStep(step.id, "history")}
            className={cn("nodrag nopan ml-auto inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs hover:bg-muted", historyCount ? "font-medium text-foreground" : "text-muted-foreground")}
            aria-label={`Lịch sử: ${historyCount} mục`}
            title="Lịch sử gia hạn và thay đổi"
          >
            <History className="size-3.5" /> {historyCount}
          </button>
        </div>
      </div>
    </div>
  );
}

export const StepNode = memo(StepNodeView);
