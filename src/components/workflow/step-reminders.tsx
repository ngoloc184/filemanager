"use client";

import { useState } from "react";
import { BadgeCheck, BellRing, Loader2, Mail } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { WorkflowStep } from "@/lib/workflow/model";
import { useWorkflow } from "./context";
import { KIND_TEXT, reportResults } from "./remind-dialog";
import { logTime } from "./styles";

/** In the step panel (signed-in members): who gets this step's e-mails, "Nhắc ngay", and what was sent. */
export function StepReminders({ step }: { step: WorkflowStep }) {
  const { doc, reminders, openRoles } = useWorkflow();
  const [busy, setBusy] = useState<"remind" | "confirm" | null>(null);
  if (!reminders) return null;
  const roles = step.picIds.map((id) => doc.roles.find((r) => r.id === id)).filter((r) => r !== undefined);
  const emails = [...new Set(roles.flatMap((r) => reminders.emailsFor(r.name)))];
  const roleNames = new Set(roles.map((r) => r.name.trim().toLowerCase()));
  const sent = reminders.sent.filter((r) => r.stepId === step.id || (r.kind === "confirm" && r.roleName && roleNames.has(r.roleName.trim().toLowerCase()))).slice(0, 10);

  async function remind(which: "remind" | "confirm") {
    if (!reminders) return;
    setBusy(which);
    const r = await reminders.remind(which === "confirm" ? { confirm: true, stepId: step.id } : { stepId: step.id });
    setBusy(null);
    if ("error" in r) return void toast.error(r.error);
    reportResults(r.results);
  }

  return (
    <section className="grid gap-2">
      <h3 className="flex items-center justify-between text-xs font-medium text-muted-foreground">
        Nhắc nhở qua email
        <button type="button" onClick={openRoles} className="text-primary hover:underline">
          Sửa email vai trò
        </button>
      </h3>
      <div className="grid gap-2 rounded-xl p-3 ring-1 ring-border">
        <p className={cn("flex items-start gap-1.5 text-xs", emails.length ? "text-muted-foreground" : "text-amber-700 dark:text-amber-300")}>
          <Mail className="mt-0.5 size-3.5 shrink-0" />
          {emails.length ? <span className="break-all">{emails.join(", ")}</span> : roles.length ? "Vai trò PIC chưa có email. Thêm email để gửi được nhắc nhở." : "Bước chưa có PIC."}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => remind("remind")} disabled={!!busy || !emails.length || step.status === "done"}>
            {busy === "remind" ? <Loader2 className="animate-spin" /> : <BellRing />} Nhắc việc
          </Button>
          {!step.confirmed && (
            <Button size="sm" onClick={() => remind("confirm")} disabled={!!busy || !emails.length || step.status === "done"}>
              {busy === "confirm" ? <Loader2 className="animate-spin" /> : <BadgeCheck />} Nhắc xác nhận
            </Button>
          )}
          <span className="w-full text-[11px] text-muted-foreground">
            {step.status === "done"
              ? "Bước đã hoàn thành."
              : step.duration.unit === "h"
                ? "Tự động (kiểm tra mỗi giờ làm việc): nhắc lúc bắt đầu, trong giờ cuối trước hạn và mỗi ngày khi trễ hạn; nhắc xác nhận khi timeline chưa chốt."
                : "Tự động trong giờ làm việc: nhắc vào ngày bắt đầu, ngày đến hạn (nếu dài hơn 1 ngày) và mỗi ngày khi trễ hạn; nhắc xác nhận khi timeline chưa chốt."}
          </span>
        </div>
        {sent.length > 0 && (
          <ul className="grid gap-1 border-t pt-2 text-[11px] text-muted-foreground">
            {sent.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-1.5">
                <span className={cn("rounded px-1 font-medium", KIND_TEXT[r.kind].className)}>{KIND_TEXT[r.kind].label}</span>
                <span>{r.manual ? "gửi thủ công" : "tự động"}</span>
                <span>· {r.recipients.length} người nhận</span>
                <span className="ml-auto tabular-nums">{logTime(r.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
