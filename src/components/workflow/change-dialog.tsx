"use client";

import { useEffect, useId, useState } from "react";
import { CalendarPlus, Clock3, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { LIMITS, schedule, type Duration, type StepLog } from "@/lib/workflow/model";
import { useWorkflow } from "./context";
import { DurationField } from "./duration-editor";
import { durationLabel, fullMoment, minutesLabel } from "./styles";
import type { ChangeInput } from "./use-workflow-sync";

const PERSON_KEY = "workflow:person";

function readPerson(): { name: string; role: string } {
  try {
    const p = JSON.parse(localStorage.getItem(PERSON_KEY) ?? "{}") as { name?: unknown; role?: unknown };
    return { name: typeof p.name === "string" ? p.name : "", role: typeof p.role === "string" ? p.role : "" };
  } catch {
    return { name: "", role: "" };
  }
}

const INPUT =
  "h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * The logged form: extend a step (gia hạn) or change its length. Who fills it in gives a name and
 * a role; both, with the reason, show in the step's history.
 */
export function ChangeDialog({
  target,
  onClose,
  submit,
  defaultName,
}: {
  target: { stepId: string; kind: ChangeInput["kind"] } | null;
  onClose: () => void;
  submit: (input: ChangeInput) => Promise<string | null>;
  defaultName: string;
}) {
  const { doc, slots, logs, canEdit } = useWorkflow();
  const id = useId();
  const step = target ? doc.steps.find((s) => s.id === target.stepId) : undefined;
  const kind = target?.kind ?? "extend";
  const [amount, setAmount] = useState<Duration>({ amount: 1, unit: "d" });
  const [reason, setReason] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);

  // a fresh form each time it opens, remembering who filled the last one in
  useEffect(() => {
    if (!target || !step) return;
    const person = readPerson();
    /* eslint-disable react-hooks/set-state-in-effect -- reset when the dialog opens */
    setAmount(target.kind === "duration" ? step.duration : { amount: 1, unit: "d" });
    setReason("");
    setName(person.name || defaultName);
    setRole(person.role);
    setWebsite("");
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when another step or kind opens
  }, [target?.stepId, target?.kind]);

  if (!step) return <Dialog open={false} />;
  const slot = slots.get(step.id);

  // the end after this change, to show before sending
  const preview = (() => {
    if (kind === "duration") return schedule({ ...doc, steps: doc.steps.map((s) => (s.id === step.id ? { ...s, duration: amount } : s)) }, logs).get(step.id);
    const extra: StepLog = { id: "preview", stepId: step.id, kind: "extend", amount: amount.amount, unit: amount.unit, oldAmount: null, oldUnit: null, reason: null, requesterName: "", requesterRole: "", signedIn: false, createdAt: "", cancelledAt: null };
    return schedule(doc, [...logs, extra]).get(step.id);
  })();
  const unchanged = kind === "duration" && amount.amount === step.duration.amount && amount.unit === step.duration.unit;
  const reasonOk = kind === "duration" || reason.trim().length >= 3;
  // a signed-in person is logged under their account name, so they only give a role
  const ready = !busy && !unchanged && reasonOk && (canEdit || name.trim()) && role.trim();

  async function send() {
    if (!ready || !step) return;
    setBusy(true);
    const error = await submit({ kind, stepId: step.id, amount: amount.amount, unit: amount.unit, reason: reason.trim(), name: canEdit ? defaultName || "Thành viên" : name.trim(), role: role.trim(), ...(website ? { website } : {}) });
    setBusy(false);
    if (error) return void toast.error(error);
    try {
      localStorage.setItem(PERSON_KEY, JSON.stringify({ name: name.trim(), role: role.trim() }));
    } catch {}
    toast.success(kind === "extend" ? `Đã gia hạn thêm ${durationLabel(amount)}` : `Đã đổi thời lượng thành ${durationLabel(amount)}`);
    onClose();
  }

  const Icon = kind === "extend" ? CalendarPlus : Clock3;
  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="gap-0 p-0 sm:max-w-md">
        <DialogHeader className="border-b px-5 pt-5 pb-4">
          <DialogTitle className="flex items-center gap-2">
            <Icon className="size-4 text-primary" />
            {kind === "extend" ? "Gia hạn bước" : "Sửa số ngày của bước"}
          </DialogTitle>
          <DialogDescription className="line-clamp-2">
            Bước {doc.steps.indexOf(step) + 1}: {step.title || "Bước chưa đặt tên"}
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-4 px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          {slot && (
            <dl className="grid grid-cols-2 gap-2 rounded-lg bg-muted/60 p-3 text-xs">
              <div>
                <dt className="text-muted-foreground">Hiện tại</dt>
                <dd className="mt-0.5 font-medium">
                  {durationLabel(step.duration)}
                  {slot.extraMinutes > 0 && <span className="text-amber-700 dark:text-amber-300"> + {minutesLabel(slot.extraMinutes, doc.hours)}</span>}
                </dd>
                <dd className="text-muted-foreground tabular-nums">Hạn {fullMoment(slot.end)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Sau thay đổi</dt>
                <dd className={cn("mt-0.5 font-medium tabular-nums", !unchanged && "text-primary")}>{preview ? `Hạn ${fullMoment(preview.end)}` : "—"}</dd>
                <dd className="text-muted-foreground">Các bước sau tự dời theo</dd>
              </div>
            </dl>
          )}

          <DurationField value={amount} onChange={setAmount} label={kind === "extend" ? "Gia hạn thêm" : "Thời lượng mới"} />

          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Lý do {kind === "extend" ? <span className="text-destructive">*</span> : "(không bắt buộc)"}
            </span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={LIMITS.reason}
              rows={3}
              placeholder={kind === "extend" ? "VD: Chờ HDBank cấp data test" : "VD: Phạm vi test tăng thêm"}
              className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </label>

          <div className={cn("grid gap-3", !canEdit && "grid-cols-2")}>
            {!canEdit && (
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Họ tên <span className="text-destructive">*</span>
              </span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.person} autoComplete="name" className={INPUT} placeholder="Nguyễn Văn A" />
            </label>
            )}
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Vai trò <span className="text-destructive">*</span>
              </span>
              <input value={role} onChange={(e) => setRole(e.target.value)} maxLength={LIMITS.person} list={`${id}-roles`} className={INPUT} placeholder="VD: QC HDBank" />
              <datalist id={`${id}-roles`}>
                {doc.roles.map((r) => (
                  <option key={r.id} value={r.name} />
                ))}
              </datalist>
            </label>
          </div>
          {/* left empty by people; bots that fill every field are refused */}
          <input type="text" tabIndex={-1} autoComplete="off" aria-hidden value={website} onChange={(e) => setWebsite(e.target.value)} className="hidden" name="website" />

          <p className="text-[11px] text-muted-foreground">
            {canEdit ? "Thay đổi được ghi vào lịch sử của bước dưới tên tài khoản của bạn, kèm vai trò và thời điểm." : "Thay đổi được ghi vào lịch sử của bước, kèm họ tên, vai trò và thời điểm."}
          </p>

          <DialogFooter className="-mx-5 -mb-4 px-5">
            <Button type="button" variant="outline" onClick={onClose}>
              Huỷ
            </Button>
            <Button type="submit" disabled={!ready}>
              {busy && <Loader2 className="animate-spin" />}
              {kind === "extend" ? `Gia hạn +${durationLabel(amount)}` : "Lưu thời lượng"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
