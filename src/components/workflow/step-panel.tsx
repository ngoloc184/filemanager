"use client";

import { ArrowDownRight, ArrowUpLeft, BadgeCheck, CalendarPlus, CircleDashed, PencilLine, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { LIMITS, STEP_STATUSES, dayMark, isOverdue, removeSteps, updateStep, type WorkflowStep } from "@/lib/workflow/model";
import { useWorkflow } from "./context";
import { DurationField } from "./duration-editor";
import { RoleChip } from "./pic-picker";
import { StepHistory } from "./step-history";
import { StepReminders } from "./step-reminders";
import { ROLE_STYLE, STATUS_META, durationLabel, fullMoment, logTime, mark, minutesLabel } from "./styles";

const FIELD = "w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export function StepPanel({
  open,
  tab,
  onTab,
  onClose,
  onCancelExtension,
}: {
  open: string | null;
  tab: "details" | "history";
  onTab: (tab: "details" | "history") => void;
  onClose: () => void;
  onCancelExtension: (id: string) => Promise<boolean>;
}) {
  const { doc, slots, logs, now, canEdit, edit, openStep, openChange, openRoles } = useWorkflow();
  const step = doc.steps.find((s) => s.id === open) ?? null;
  const index = step ? doc.steps.indexOf(step) : -1;
  const slot = step ? slots.get(step.id) : undefined;
  const history = step ? logs.filter((l) => l.stepId === step.id) : [];
  const patch = (fields: Partial<WorkflowStep>, key: string | null = null) => step && edit((d) => updateStep(d, step.id, fields), key);
  const before = step ? doc.edges.filter((e) => e.target === step.id).map((e) => doc.steps.find((s) => s.id === e.source)!) : [];
  const after = step ? doc.edges.filter((e) => e.source === step.id).map((e) => doc.steps.find((s) => s.id === e.target)!) : [];
  const label = (s: WorkflowStep) => `${doc.steps.indexOf(s) + 1}. ${s.title || "Bước chưa đặt tên"}`;
  const late = step ? isOverdue(step, slot, now) : false;

  return (
    <Sheet open={step !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto p-0 sm:max-w-md" showCloseButton={false}>
        {step && (
          <>
            <SheetHeader className="sticky top-0 z-10 gap-3 border-b bg-popover/95 px-5 pt-4 pb-0 backdrop-blur">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <SheetTitle>Bước {index + 1}</SheetTitle>
                  <SheetDescription className="text-xs">{canEdit ? "Thay đổi được lưu tự động." : "Bạn có thể gia hạn hoặc sửa số ngày; mọi thay đổi đều được ghi lịch sử."}</SheetDescription>
                </div>
                <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Đóng">
                  <X />
                </Button>
              </div>
              <div role="tablist" className="-mb-px flex gap-4 text-sm">
                {(
                  [
                    ["details", "Chi tiết"],
                    ["history", `Lịch sử (${history.length})`],
                  ] as const
                ).map(([key, text]) => (
                  <button key={key} role="tab" aria-selected={tab === key} onClick={() => onTab(key)} className="border-b-2 border-transparent pb-2 font-medium text-muted-foreground aria-selected:border-primary aria-selected:text-foreground">
                    {text}
                  </button>
                ))}
              </div>
            </SheetHeader>

            {tab === "history" ? (
              <div className="px-5 py-4">
                <StepHistory logs={history} onCancel={canEdit ? onCancelExtension : undefined} />
              </div>
            ) : (
              <div className="grid gap-5 px-5 py-4">
                {/* timeline summary */}
                {slot && (
                  <section className={cn("grid gap-2 rounded-xl p-3 ring-1", late ? "bg-rose-500/5 ring-rose-500/30" : "bg-muted/40 ring-border")}>
                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div>
                        <p className="text-muted-foreground">Bắt đầu · {mark(dayMark(doc, slot.start))}</p>
                        <p className="mt-0.5 font-semibold tabular-nums">{fullMoment(slot.start)}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Hạn hoàn thành · {mark(dayMark(doc, slot.end))}</p>
                        <p className={cn("mt-0.5 font-semibold tabular-nums", late && "text-rose-700 dark:text-rose-300")}>{fullMoment(slot.end)}</p>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {durationLabel(step.duration)}
                      {slot.extraMinutes > 0 && (
                        <>
                          {" "}
                          + <span className="font-medium text-amber-700 dark:text-amber-300">gia hạn {minutesLabel(slot.extraMinutes, doc.hours)}</span> (hạn ban đầu {fullMoment(slot.baseEnd)})
                        </>
                      )}
                      {late && <span className="font-medium text-rose-600 dark:text-rose-400"> · Đã trễ hạn</span>}
                    </p>
                    {step.confirmed ? (
                      <p className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
                        <BadgeCheck className="size-3.5 shrink-0" />
                        Đã chốt bởi <b>{step.confirmed.by}</b> ({step.confirmed.role}) · {logTime(step.confirmed.at)}
                        {!canEdit && <span className="text-muted-foreground">· chỉ có thể gia hạn</span>}
                      </p>
                    ) : (
                      <p className="flex items-center gap-1.5 text-xs text-primary">
                        <CircleDashed className="size-3.5 shrink-0" /> Thời gian đang là mặc định, chưa được xác nhận.
                      </p>
                    )}
                    <div className="flex flex-wrap gap-1.5">
                      {!step.confirmed && (
                        <Button size="sm" onClick={() => openChange(step.id, "confirm")}>
                          <BadgeCheck /> Xác nhận timeline
                        </Button>
                      )}
                      <Button size="sm" variant="outline" onClick={() => openChange(step.id, "extend")} className="text-amber-700 dark:text-amber-300">
                        <CalendarPlus /> Gia hạn
                      </Button>
                      {!canEdit && !step.confirmed && (
                        <Button size="sm" variant="outline" onClick={() => openChange(step.id, "duration")}>
                          <PencilLine /> Sửa số ngày
                        </Button>
                      )}
                      {canEdit && step.confirmed && (
                        <Button size="sm" variant="ghost" onClick={() => patch({ confirmed: null })} title="Chỉ admin: mở lại để xác nhận lại">
                          Bỏ chốt
                        </Button>
                      )}
                    </div>
                  </section>
                )}

                {canEdit ? (
                  <>
                    <label className="grid gap-1.5">
                      <span className="text-xs font-medium text-muted-foreground">Nội dung công việc</span>
                      <textarea autoFocus={!step.title} value={step.title} maxLength={LIMITS.title} rows={3} placeholder="VD: QC FPT test, kiểm tra timeline bàn giao" onChange={(e) => patch({ title: e.target.value }, `title:${step.id}`)} className={FIELD} />
                    </label>
                    <DurationField value={step.duration} onChange={(duration) => patch({ duration }, `duration:${step.id}`)} />
                  </>
                ) : (
                  <p className="text-sm leading-relaxed font-medium">{step.title || "Bước chưa đặt tên"}</p>
                )}

                <section className="grid gap-1.5">
                  <h3 className="flex items-center justify-between text-xs font-medium text-muted-foreground">
                    Người phụ trách (PIC)
                    {canEdit && (
                      <button type="button" onClick={openRoles} className="text-primary hover:underline">
                        Quản lý vai trò
                      </button>
                    )}
                  </h3>
                  {canEdit ? (
                    doc.roles.length ? (
                      <div className="flex flex-wrap gap-1.5">
                        {doc.roles.map((r) => {
                          const on = step.picIds.includes(r.id);
                          return (
                            <button
                              key={r.id}
                              type="button"
                              aria-pressed={on}
                              onClick={() => patch({ picIds: on ? step.picIds.filter((x) => x !== r.id) : [...step.picIds, r.id] })}
                              className={cn("inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium ring-1 transition-colors", on ? cn(ROLE_STYLE[r.color].chip, "ring-inset") : "text-muted-foreground ring-border hover:bg-muted hover:text-foreground")}
                            >
                              <span className={cn("size-2 rounded-full", on ? ROLE_STYLE[r.color].dot : "bg-muted-foreground/30")} />
                              {r.name}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <button type="button" onClick={openRoles} className="rounded-lg border border-dashed px-3 py-2.5 text-left text-xs text-muted-foreground hover:bg-muted">
                        Chưa có vai trò nào. Thêm vai trò (VD: DEV FPT, QC HDBank) để giao PIC.
                      </button>
                    )
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {step.picIds.length ? step.picIds.map((id) => doc.roles.find((r) => r.id === id)).filter((r) => r !== undefined).map((r) => <RoleChip key={r.id} name={r.name} color={r.color} />) : <span className="text-xs text-muted-foreground">Chưa có PIC</span>}
                    </div>
                  )}
                </section>

                <section className="grid gap-1.5">
                  <h3 className="text-xs font-medium text-muted-foreground">Trạng thái</h3>
                  {canEdit ? (
                    <div className="grid grid-cols-2 gap-1.5">
                      {STEP_STATUSES.map((s) => {
                        const meta = STATUS_META[s];
                        const Icon = meta.icon;
                        return (
                          <button key={s} type="button" aria-pressed={step.status === s} onClick={() => patch({ status: s })} className={cn("flex h-9 items-center gap-2 rounded-lg px-2.5 text-xs font-medium ring-1 transition-colors", step.status === s ? cn("bg-muted ring-2", meta.ring) : "ring-border hover:bg-muted")}>
                            <Icon className={cn("size-4", meta.text)} />
                            {meta.label}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <p className={cn("flex items-center gap-1.5 text-sm font-medium", STATUS_META[step.status].text)}>
                      {(() => {
                        const Icon = STATUS_META[step.status].icon;
                        return <Icon className="size-4" />;
                      })()}
                      {STATUS_META[step.status].label}
                    </p>
                  )}
                </section>

                {canEdit && <StepReminders step={step} />}

                {(canEdit || step.note) && (
                  <label className="grid gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">Ghi chú</span>
                    {canEdit ? (
                      <textarea value={step.note} maxLength={LIMITS.note} rows={3} placeholder="Link tài liệu, đầu mối liên hệ, điều kiện hoàn thành…" onChange={(e) => patch({ note: e.target.value }, `note:${step.id}`)} className={FIELD} />
                    ) : (
                      <p className="text-sm whitespace-pre-wrap">{step.note}</p>
                    )}
                  </label>
                )}

                {(before.length > 0 || after.length > 0) && (
                  <section className="grid gap-1 text-xs">
                    <h3 className="font-medium text-muted-foreground">Liên kết</h3>
                    {before.map((s) => (
                      <button key={s.id} type="button" onClick={() => openStep(s.id)} className="flex items-center gap-2 truncate rounded-md px-2 py-1.5 text-left hover:bg-muted">
                        <ArrowUpLeft className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="text-muted-foreground">Sau</span>
                        <span className="truncate">{label(s)}</span>
                      </button>
                    ))}
                    {after.map((s) => (
                      <button key={s.id} type="button" onClick={() => openStep(s.id)} className="flex items-center gap-2 truncate rounded-md px-2 py-1.5 text-left hover:bg-muted">
                        <ArrowDownRight className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="text-muted-foreground">Trước</span>
                        <span className="truncate">{label(s)}</span>
                      </button>
                    ))}
                  </section>
                )}

                {canEdit && (
                  <Button
                    variant="destructive"
                    className="justify-self-start"
                    onClick={() => {
                      edit((d) => removeSteps(d, [step.id]));
                      onClose();
                    }}
                  >
                    <Trash2 /> Xoá bước này
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
