"use client";

import { Popover } from "@base-ui/react/popover";
import { Handle, Position, type Node } from "@xyflow/react";
import { CalendarClock, Flag, PencilLine } from "lucide-react";
import { cn } from "@/lib/utils";
import { dayMark, formatStamp, isDay, isHm, isOverdue, normalizeStart, parseStamp, planRange } from "@/lib/workflow/model";
import { useWorkflow } from "./context";
import { fullMoment, mark, minutesLabel } from "./styles";

export type StartFlowNode = Node<Record<string, never>, "start">;
export type EndFlowNode = Node<Record<string, never>, "end">;

const PILL = "flex items-center gap-2.5 rounded-full bg-card py-1.5 pr-4 pl-1.5 shadow-sm ring-1 ring-border";
const HIDDEN_HANDLE = "!pointer-events-none !opacity-0";
const INPUT = "h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** Start pill: day X of the plan; signed-in editors change it in place. */
export function StartNode() {
  const { doc, canEdit, edit } = useWorkflow();
  const start = normalizeStart(parseStamp(doc.start), doc.hours);
  const [day, time] = [doc.start.slice(0, 10), doc.start.slice(11, 16)];
  const body = (
    <>
      <span className="grid size-8 place-items-center rounded-full bg-primary text-primary-foreground">
        <CalendarClock className="size-4" />
      </span>
      <span className="text-left leading-tight">
        <span className="block text-[11px] font-medium text-muted-foreground">Bắt đầu · T+0</span>
        <span className="block text-sm font-semibold tabular-nums">{fullMoment(start)}</span>
      </span>
      {canEdit && <PencilLine className="size-3.5 text-muted-foreground" />}
    </>
  );
  return (
    <div>
      <Handle type="source" position={Position.Bottom} id="s-b" isConnectable={false} className={HIDDEN_HANDLE} />
      <Handle type="source" position={Position.Right} id="s-r" isConnectable={false} className={HIDDEN_HANDLE} />
      {canEdit ? (
        <Popover.Root>
          <Popover.Trigger aria-label="Sửa ngày bắt đầu" className={cn(PILL, "nodrag nopan outline-none hover:ring-primary/50 focus-visible:ring-3 focus-visible:ring-ring/50")}>
            {body}
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner sideOffset={8} align="start" className="z-50">
              <Popover.Popup className="w-72 origin-(--transform-origin) rounded-xl bg-popover p-3 text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none transition-[transform,opacity] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
                <Popover.Title className="mb-2 text-sm font-medium">Ngày bắt đầu (T+0)</Popover.Title>
                <div className="grid grid-cols-[1fr_auto] gap-2">
                  <input type="date" aria-label="Ngày" value={day} onChange={(e) => isDay(e.target.value) && edit((d) => ({ ...d, start: `${e.target.value}T${time}` }), "start")} className={INPUT} />
                  <input type="time" aria-label="Giờ" step={1800} value={time} onChange={(e) => isHm(e.target.value) && edit((d) => ({ ...d, start: `${day}T${e.target.value}` }), "start")} className={INPUT} />
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Các bước được xếp nối tiếp từ mốc này, trong giờ làm {doc.hours.dayStart}–{doc.hours.dayEnd}
                  {doc.hours.skipWeekends ? ", không tính T7 và CN" : ""}.
                  {formatStamp(start) !== doc.start && " Mốc ngoài giờ làm được tính từ giờ làm kế tiếp."}
                </p>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      ) : (
        <div className={PILL}>{body}</div>
      )}
    </div>
  );
}

/** Finish pill: when the last step ends, with the total extension and how many steps are late. */
export function EndNode() {
  const { doc, slots, now } = useWorkflow();
  const range = planRange(slots);
  let extra = 0;
  let late = 0;
  for (const s of doc.steps) {
    const slot = slots.get(s.id);
    extra += slot?.extraMinutes ?? 0;
    if (isOverdue(s, slot, now)) late++;
  }
  const done = doc.steps.length > 0 && doc.steps.every((s) => s.status === "done");
  return (
    <div className={PILL}>
      <Handle type="target" position={Position.Top} id="t-t" isConnectable={false} className={HIDDEN_HANDLE} />
      <Handle type="target" position={Position.Left} id="t-l" isConnectable={false} className={HIDDEN_HANDLE} />
      <span className={cn("grid size-8 place-items-center rounded-full", done ? "bg-emerald-500 text-white" : "bg-foreground text-background")}>
        <Flag className="size-4" />
      </span>
      <span className="leading-tight">
        <span className="block text-[11px] font-medium text-muted-foreground">
          {done ? "Đã hoàn thành" : "Hoàn thành dự kiến"}
          {range && ` · ${mark(dayMark(doc, range.end))}`}
        </span>
        <span className="block text-sm font-semibold tabular-nums">{range ? fullMoment(range.end) : "—"}</span>
        {(extra > 0 || late > 0) && (
          <span className="mt-0.5 flex gap-2 text-[11px] font-medium">
            {extra > 0 && <span className="text-amber-700 dark:text-amber-300">Gia hạn +{minutesLabel(extra, doc.hours)}</span>}
            {late > 0 && <span className="text-rose-600 dark:text-rose-400">{late} bước trễ</span>}
          </span>
        )}
      </span>
    </div>
  );
}
