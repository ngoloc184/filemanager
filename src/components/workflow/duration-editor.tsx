"use client";

import { useId } from "react";
import { Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { clampAmount, type Duration } from "@/lib/workflow/model";

const QUICK: Record<Duration["unit"], number[]> = { d: [1, 2, 3, 5, 10], h: [1, 2, 4, 6] };

/** Amount stepper with a Giờ / Ngày switch; at least one hour. */
export function DurationField({ value, onChange, label = "Thời lượng" }: { value: Duration; onChange: (d: Duration) => void; label?: string }) {
  const id = useId();
  const set = (amount: number, unit = value.unit) => onChange({ amount: clampAmount(amount), unit });
  return (
    <div className="grid gap-1.5">
      <span id={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-labelledby={id}>
        <div className="flex h-8 items-center rounded-lg border border-input bg-background">
          <button type="button" aria-label="Bớt 1" disabled={value.amount <= 1} onClick={() => set(value.amount - 1)} className="grid h-full w-8 place-items-center rounded-l-lg hover:bg-muted disabled:opacity-40">
            <Minus className="size-3.5" />
          </button>
          <input
            aria-label="Số lượng"
            inputMode="numeric"
            value={value.amount}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(n)) set(n);
            }}
            className="h-full w-11 border-x border-input bg-transparent text-center text-sm font-medium tabular-nums outline-none focus-visible:bg-muted"
          />
          <button type="button" aria-label="Thêm 1" onClick={() => set(value.amount + 1)} className="grid h-full w-8 place-items-center rounded-r-lg hover:bg-muted">
            <Plus className="size-3.5" />
          </button>
        </div>
        <div className="flex h-8 rounded-lg bg-muted p-0.5" role="radiogroup" aria-label="Đơn vị">
          {(["h", "d"] as const).map((u) => (
            <button
              key={u}
              type="button"
              role="radio"
              aria-checked={value.unit === u}
              onClick={() => set(value.amount, u)}
              className="rounded-md px-2.5 text-xs font-medium text-muted-foreground aria-checked:bg-background aria-checked:text-foreground aria-checked:shadow-sm"
            >
              {u === "h" ? "Giờ" : "Ngày"}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {QUICK[value.unit].map((n) => (
            <button
              key={n}
              type="button"
              aria-label={`${n} ${value.unit === "d" ? "ngày" : "giờ"}`}
              aria-pressed={value.amount === n}
              onClick={() => set(n)}
              className={cn(
                "h-7 min-w-7 rounded-md px-1.5 text-xs font-medium tabular-nums text-muted-foreground ring-1 ring-border hover:bg-muted hover:text-foreground",
                "aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:ring-primary"
              )}
            >
              {n}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
