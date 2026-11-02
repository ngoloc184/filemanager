"use client";

import { useState } from "react";
import { BadgeCheck, BellRing, Loader2, Mail } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { confirmDigests, reminderKind, type ReminderKind } from "@/lib/workflow/reminders";
import { useWorkflow } from "./context";
import { shortMoment } from "./styles";
import type { RemindResult } from "./use-reminders";

export const KIND_TEXT: Record<ReminderKind | "confirm", { label: string; className: string }> = {
  confirm: { label: "Xác nhận timeline", className: "bg-primary/10 text-primary" },
  upcoming: { label: "Sắp bắt đầu", className: "bg-violet-500/10 text-violet-700 dark:text-violet-300" },
  due: { label: "Đến hạn hôm nay", className: "bg-amber-500/12 text-amber-800 dark:text-amber-300" },
  overdue: { label: "Trễ hạn", className: "bg-rose-500/10 text-rose-700 dark:text-rose-300" },
  progress: { label: "Đang thực hiện", className: "bg-sky-500/10 text-sky-700 dark:text-sky-300" },
};

/** Summarises a "Nhắc ngay" result as a toast. */
export function reportResults(results: RemindResult[]) {
  const sent = results.reduce((n, r) => n + r.sent, 0);
  const noOne = results.filter((r) => r.skipped === "no-recipients").length;
  // a role without addresses is named, so the admin knows whose e-mails to add
  const roles = results.filter((r) => r.skipped === "no-recipients" && r.roleName).map((r) => r.roleName);
  const failed = results.filter((r) => r.skipped === "failed").length;
  if (!results.length) return void toast.info("Không có bước nào cần nhắc lúc này.");
  if (sent) toast.success(`Đã gửi ${sent} email nhắc nhở`);
  if (roles.length) toast.warning(`Chưa có email cho vai trò: ${roles.join(", ")}. Thêm trong mục Vai trò.`);
  else if (noOne) toast.warning(`${noOne} bước chưa có email người nhận: thêm email cho vai trò trong mục Vai trò.`);
  if (failed) toast.error(`${failed} bước không gửi được email. Kiểm tra cấu hình SMTP.`);
}

/** "Nhắc nhở" in the header: what today's reminders are, and sending them all now. */
export function RemindDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { doc, slots, now, reminders } = useWorkflow();
  const [busy, setBusy] = useState<"today" | "confirm" | null>(null);
  if (!reminders) return null;
  const digests = confirmDigests(doc).map((d) => ({ ...d, emails: reminders.emailsFor(d.roleName) }));

  const items = doc.steps.flatMap((s) => {
    const kind = reminderKind(s, slots.get(s.id), now, doc.hours);
    if (!kind) return [];
    const roles = s.picIds.map((id) => doc.roles.find((r) => r.id === id)).filter((r) => r !== undefined);
    const emails = [...new Set(roles.flatMap((r) => reminders.emailsFor(r.name)))];
    return [{ step: s, kind, roles, emails }];
  });

  async function send(which: "today" | "confirm") {
    if (!reminders) return;
    setBusy(which);
    const r = await reminders.remind(which === "confirm" ? { confirm: true } : null);
    setBusy(null);
    if ("error" in r) return void toast.error(r.error);
    reportResults(r.results);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="border-b px-5 pt-5 pb-4">
          <DialogTitle className="flex items-center gap-2">
            <BellRing className="size-4 text-primary" /> Nhắc nhở qua email
          </DialogTitle>
          <DialogDescription>
            Email gửi tới địa chỉ của các vai trò PIC. Hệ thống tự gửi lúc 08:00 mỗi ngày làm việc; nút dưới đây gửi ngay.
          </DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[60vh] gap-5 overflow-y-auto px-5 py-4">
          <section className="grid gap-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Xác nhận timeline</h3>
              <Button size="sm" variant="outline" onClick={() => send("confirm")} disabled={!!busy || !digests.some((d) => d.emails.length)}>
                {busy === "confirm" ? <Loader2 className="animate-spin" /> : <BadgeCheck />} Nhắc xác nhận ({digests.filter((d) => d.emails.length).length} vai trò)
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Mỗi vai trò nhận một email liệt kê các bước của mình chưa chốt timeline. Tự động gửi 08:00 mỗi ngày làm việc cho tới khi chốt xong.</p>
            {digests.length ? (
              <ul className="grid gap-1.5">
                {digests.map((d) => (
                  <li key={d.roleId} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg px-3 py-2 text-xs ring-1 ring-border">
                    <span className="font-medium">{d.roleName}</span>
                    <span className="text-muted-foreground">· {d.stepIds.length} bước chưa chốt</span>
                    <span className={cn("ml-auto flex items-center gap-1", d.emails.length ? "text-muted-foreground" : "text-amber-700 dark:text-amber-300")}>
                      <Mail className="size-3" /> {d.emails.length ? `${d.emails.length} email` : "chưa có email"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-lg border border-dashed px-3 py-3 text-center text-xs text-muted-foreground">Mọi bước đã được chốt timeline.</p>
            )}
          </section>

          <section className="grid gap-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Nhắc việc hôm nay</h3>
              <Button size="sm" onClick={() => send("today")} disabled={!!busy || !items.some((i) => i.emails.length)}>
                {busy === "today" ? <Loader2 className="animate-spin" /> : <BellRing />} Gửi ngay ({items.filter((i) => i.emails.length).length})
              </Button>
            </div>
          {items.length ? (
            <ul className="grid gap-2">
              {items.map(({ step, kind, roles, emails }) => (
                <li key={step.id} className="rounded-lg p-3 ring-1 ring-border">
                  <div className="flex items-start gap-2">
                    <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium", KIND_TEXT[kind].className)}>{KIND_TEXT[kind].label}</span>
                    <p className="min-w-0 flex-1 truncate text-sm font-medium">
                      {doc.steps.indexOf(step) + 1}. {step.title || "Bước chưa đặt tên"}
                    </p>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {roles.map((r) => r.name).join(", ") || "Chưa có PIC"} · {slots.get(step.id) ? `hạn ${shortMoment(slots.get(step.id)!.end)}` : ""}
                  </p>
                  <p className={cn("mt-1 flex items-center gap-1 text-xs", emails.length ? "text-muted-foreground" : "text-amber-700 dark:text-amber-300")}>
                    <Mail className="size-3" /> {emails.length ? `${emails.length} người nhận: ${emails.join(", ")}` : "Chưa có email người nhận"}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-lg border border-dashed px-3 py-3 text-center text-xs text-muted-foreground">Hôm nay không có bước nào sắp bắt đầu, đến hạn hay trễ hạn.</p>
          )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
