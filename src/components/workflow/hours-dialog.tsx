"use client";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/admin/stickers/switch";
import { isHm, minutesPerDay, parseHours, type WorkHours } from "@/lib/workflow/model";
import { useWorkflow } from "./context";

const INPUT = "h-8 w-full rounded-md border border-input bg-background px-2 text-sm tabular-nums outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** Working hours of the plan: what one "ngày" means, and whether Saturday and Sunday count. */
export function HoursDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { doc, edit } = useWorkflow();
  const h = doc.hours;
  // only valid hours are kept: parseHours would fall back to the defaults, so such input is ignored
  const set = (fields: Partial<WorkHours>) => {
    const next = { ...h, ...fields };
    if (JSON.stringify(parseHours(next)) === JSON.stringify(next)) edit((d) => ({ ...d, hours: next }), "hours");
  };
  const time = (key: keyof WorkHours, label: string) => (
    <label className="grid gap-1 text-xs text-muted-foreground">
      {label}
      <input type="time" step={1800} value={(h[key] as string | null) ?? ""} onChange={(e) => isHm(e.target.value) && set({ [key]: e.target.value })} className={INPUT} />
    </label>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Giờ làm việc</DialogTitle>
          <DialogDescription>1 ngày của bước = {Math.round((minutesPerDay(h) / 60) * 10) / 10} giờ làm việc. Lịch các bước được tính lại ngay.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          {time("dayStart", "Bắt đầu ngày")}
          {time("dayEnd", "Kết thúc ngày")}
        </div>
        <label className="flex items-center justify-between gap-3 text-sm">
          Nghỉ trưa
          <Switch checked={!!h.breakStart} onCheckedChange={(on) => set(on ? { breakStart: "12:00", breakEnd: "13:00" } : { breakStart: null, breakEnd: null })} aria-label="Nghỉ trưa" />
        </label>
        {h.breakStart && (
          <div className="grid grid-cols-2 gap-3">
            {time("breakStart", "Nghỉ từ")}
            {time("breakEnd", "Đến")}
          </div>
        )}
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>
            Không tính thứ 7, chủ nhật
            <span className="block text-xs text-muted-foreground">Bật theo mặc định.</span>
          </span>
          <Switch checked={h.skipWeekends} onCheckedChange={(on) => set({ skipWeekends: on })} aria-label="Không tính thứ 7, chủ nhật" />
        </label>
      </DialogContent>
    </Dialog>
  );
}
