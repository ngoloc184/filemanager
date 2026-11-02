"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle,
  BadgeCheck,
  BellRing,
  CalendarClock,
  Check,
  ChevronLeft,
  CircleDashed,
  Clock,
  Copy,
  Download,
  GanttChart,
  Link2,
  Loader2,
  LogIn,
  MoreHorizontal,
  Network,
  Redo2,
  ShieldCheck,
  Trash2,
  Undo2,
  Users,
  Workflow as WorkflowIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { LIMITS, dayMark, isOverdue, nowMinutes, planRange, schedule } from "@/lib/workflow/model";
import type { Loaded } from "@/lib/workflow/payload";
import { WorkflowProvider, type WorkflowContextValue } from "./context";
import { GanttView } from "./gantt-view";
import { StepPanel } from "./step-panel";
import { RolesDialog } from "./roles-dialog";
import { ChangeDialog } from "./change-dialog";
import { CloneDialog } from "./clone-dialog";
import { HoursDialog } from "./hours-dialog";
import { ROLE_STYLE, fullMoment, mark, minutesLabel } from "./styles";
import { useWorkflowSync, type ChangeInput, type SaveStatus } from "./use-workflow-sync";
import { useReminders } from "./use-reminders";
import { RemindDialog, type RemindMode } from "./remind-dialog";
import { MembersDialog } from "./members-dialog";

// React Flow measures the DOM, so the canvas renders in the browser only
const WorkflowCanvas = dynamic(() => import("./workflow-canvas").then((m) => m.WorkflowCanvas), {
  ssr: false,
  loading: () => <div className="h-full animate-pulse bg-muted/30" />,
});

const VIEW_KEY = "workflow-builder:view";
type View = "flow" | "gantt";

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}

const STATUS_TEXT: Record<SaveStatus, { text: string; icon: typeof Check; className: string }> = {
  saved: { text: "Đã lưu", icon: Check, className: "text-muted-foreground" },
  pending: { text: "Chưa lưu", icon: CircleDashed, className: "text-muted-foreground" },
  saving: { text: "Đang lưu…", icon: Loader2, className: "text-muted-foreground [&_svg]:animate-spin" },
  error: { text: "Lỗi lưu · Thử lại", icon: AlertTriangle, className: "text-destructive" },
};

export interface EditorProps {
  id: string;
  initial: Loaded;
  /** owner or admin of the plan */
  canEdit: boolean;
  isOwner: boolean;
  signedIn: boolean;
  /** prefills "Họ tên" in the change form */
  viewerName: string;
}

export function WorkflowEditor({ id, initial, canEdit, isOwner, signedIn, viewerName }: EditorProps) {
  const router = useRouter();
  const sync = useWorkflowSync(id, initial, canEdit);
  const reminders = useReminders(id, canEdit);
  const [remindMode, setRemindMode] = useState<RemindMode | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const { doc, name, logs, edit, undo, redo } = sync;
  const [view, setView] = useState<View>("flow");
  const [now, setNow] = useState(() => nowMinutes());
  const [openStep, setOpenStep] = useState<string | null>(null);
  const [tab, setTab] = useState<"details" | "history">("details");
  const [change, setChange] = useState<{ stepId: string; kind: ChangeInput["kind"] } | null>(null);
  const [focusRole, setFocusRole] = useState<string | null>(null);
  const [rolesOpen, setRolesOpen] = useState(false);
  const [hoursOpen, setHoursOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage exists only after hydration
      if (localStorage.getItem(VIEW_KEY) === "gantt") setView("gantt");
    } catch {}
    const t = setInterval(() => setNow(nowMinutes()), 60_000);
    return () => clearInterval(t);
  }, []);
  const changeView = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {}
  };

  // Ctrl/⌘+Z, Ctrl/⌘+Shift+Z, Ctrl+Y — text fields keep their own undo
  useEffect(() => {
    if (!canEdit) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) undo();
      else if ((k === "z" && e.shiftKey) || k === "y") redo();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canEdit, undo, redo]);

  const slots = useMemo(() => schedule(doc, logs), [doc, logs]);
  const openStepPanel = useCallback((stepId: string, which: "details" | "history" = "details") => {
    setTab(which);
    setOpenStep(stepId);
  }, []);
  const openChange = useCallback((stepId: string, kind: ChangeInput["kind"]) => setChange({ stepId, kind }), []);
  const openRoles = useCallback(() => setRolesOpen(true), []);

  const ctx = useMemo<WorkflowContextValue>(
    () => ({ workflowId: id, doc, logs, slots, now, canEdit, signedIn, focusRoleId: focusRole, edit, openStep: openStepPanel, openChange, openRoles, reminders: canEdit ? reminders : null }),
    [id, doc, logs, slots, now, canEdit, signedIn, focusRole, edit, openStepPanel, openChange, openRoles, reminders]
  );

  const range = planRange(slots);
  const done = doc.steps.filter((s) => s.status === "done").length;
  const late = doc.steps.filter((s) => isOverdue(s, slots.get(s.id), now)).length;
  let extra = 0;
  for (const s of slots.values()) extra += s.extraMinutes;
  const pct = doc.steps.length ? Math.round((done / doc.steps.length) * 100) : 0;
  const confirmedCount = doc.steps.filter((s) => s.confirmed).length;
  const status = STATUS_TEXT[sync.status];

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/workflow/${id}`);
      toast.success("Đã sao chép link", { description: "Người nhận chưa đăng nhập vẫn xem, gia hạn và sửa số ngày được." });
    } catch {
      toast.error("Không sao chép được link");
    }
  }

  function downloadJson() {
    const blob = new Blob([JSON.stringify({ name, ...doc }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name.replace(/[\\/:*?"<>|]+/g, "-").trim() || "workflow"}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function remove() {
    const { error } = await createClient().from("workflows").delete().eq("id", id);
    if (error) return void toast.error("Không xoá được workflow");
    toast.success("Đã xoá workflow");
    router.push("/workflow");
  }

  if (sync.gone) {
    return (
      <div className="grid h-dvh place-items-center p-6 text-center">
        <div>
          <h1 className="text-lg font-semibold">Workflow này đã bị xoá</h1>
          <Link href="/workflow" className="mt-3 inline-block text-sm text-primary hover:underline">
            Về danh sách workflow
          </Link>
        </div>
      </div>
    );
  }

  return (
    <WorkflowProvider value={ctx}>
      <div className="flex h-dvh flex-col overflow-hidden bg-background">
        {/* ------------------------------------------------ header */}
        <header className="z-30 flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-background/90 px-3 py-2 backdrop-blur sm:px-4">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {signedIn ? (
              <Link href="/workflow" aria-label="Danh sách workflow" className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground">
                <ChevronLeft className="size-4" />
              </Link>
            ) : (
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
                <WorkflowIcon className="size-4" />
              </span>
            )}
            <div className="min-w-0 flex-1">
              {canEdit ? (
                <input
                  aria-label="Tên workflow"
                  value={name}
                  maxLength={LIMITS.name}
                  onChange={(e) => sync.rename(e.target.value)}
                  className="h-7 w-full truncate rounded-md bg-transparent px-1.5 text-[15px] font-semibold outline-none hover:bg-muted focus-visible:bg-muted sm:max-w-md"
                />
              ) : (
                <h1 className="truncate px-1.5 text-[15px] font-semibold">{name}</h1>
              )}
              {doc.clonedFrom && <p className="truncate px-1.5 text-[11px] text-muted-foreground">Nhân bản từ “{doc.clonedFrom.name}”</p>}
            </div>
          </div>

          <div role="tablist" aria-label="Chế độ xem" className="order-last flex w-full rounded-lg bg-muted p-0.5 sm:order-none sm:w-auto">
            {(
              [
                ["flow", "Sơ đồ", Network],
                ["gantt", "Timeline", GanttChart],
              ] as const
            ).map(([v, label, Icon]) => (
              <button
                key={v}
                role="tab"
                aria-selected={view === v}
                onClick={() => changeView(v)}
                className="flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md px-3 text-xs font-medium text-muted-foreground transition-colors aria-selected:bg-background aria-selected:text-foreground aria-selected:shadow-sm sm:flex-none"
              >
                <Icon className="size-3.5" /> {label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1">
            {canEdit ? (
              <>
                <button
                  type="button"
                  onClick={() => sync.status === "error" && void sync.save()}
                  className={cn("hidden items-center gap-1 rounded-md px-1.5 py-1 text-xs sm:inline-flex", status.className, sync.status === "error" && "hover:bg-destructive/10")}
                  aria-live="polite"
                >
                  <status.icon className="size-3.5" /> {status.text}
                </button>
                <Button variant="ghost" size="icon-sm" onClick={undo} disabled={!sync.canUndo} aria-label="Hoàn tác (Ctrl+Z)" title="Hoàn tác (Ctrl+Z)">
                  <Undo2 />
                </Button>
                <Button variant="ghost" size="icon-sm" onClick={redo} disabled={!sync.canRedo} aria-label="Làm lại (Ctrl+Shift+Z)" title="Làm lại (Ctrl+Shift+Z)">
                  <Redo2 />
                </Button>
                <span className="mx-1 h-5 w-px bg-border" aria-hidden />
                <Button variant="outline" size="sm" onClick={() => setRolesOpen(true)}>
                  <Users /> <span className="hidden md:inline">Vai trò</span>
                </Button>
                <Button variant="outline" size="sm" onClick={() => setCloneOpen(true)}>
                  <Copy /> <span className="hidden md:inline">Nhân bản</span>
                </Button>
                <Button variant="outline" size="sm" onClick={() => setRemindMode("today")} title="Nhắc việc theo timeline: sắp bắt đầu, đến hạn, trễ hạn">
                  <BellRing /> <span className="hidden md:inline">Nhắc việc</span>
                </Button>
                <Button variant="outline" size="sm" onClick={() => setRemindMode("confirm")} title="Gửi email yêu cầu các vai trò xác nhận timeline">
                  <BadgeCheck /> <span className="hidden md:inline">Nhắc xác nhận</span>
                </Button>
              </>
            ) : signedIn ? null : (
              <Button variant="outline" size="sm" render={<Link href={`/login?next=${encodeURIComponent(`/workflow/${id}`)}`} />}>
                <LogIn /> <span className="hidden sm:inline">Đăng nhập</span>
              </Button>
            )}
            <Button size="sm" onClick={copyLink}>
              <Link2 /> <span className="hidden md:inline">Chia sẻ</span>
            </Button>
            {canEdit && (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Thêm thao tác"><MoreHorizontal /></Button>} />
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem onClick={() => setMembersOpen(true)}>
                    <ShieldCheck /> Thành viên & admin
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setHoursOpen(true)}>
                    <Clock /> Giờ làm việc
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={downloadJson}>
                    <Download /> Tải file JSON
                  </DropdownMenuItem>
                  {isOwner && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
                        <Trash2 /> Xoá workflow
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <ThemeToggle className="ml-1 hidden lg:flex" layoutId="workflow-theme" />
          </div>
        </header>

        {!canEdit && (
          <div className="flex items-center gap-2 border-b bg-amber-500/8 px-3 py-1.5 text-xs text-amber-900 sm:px-4 dark:text-amber-200">
            <CalendarClock className="size-3.5 shrink-0" />
            <span>
              {signedIn ? "Bạn là thành viên (không phải admin) của workflow này." : "Bạn đang xem với tư cách khách."} Bạn có thể <b>sửa số ngày</b> và <b>xác nhận timeline</b> của bước chưa chốt, và <b>gia hạn</b> mọi bước. Mọi thay đổi được ghi lịch sử.
            </span>
          </div>
        )}

        {/* ------------------------------------------------ plan summary */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b bg-muted/30 px-3 py-2 text-xs sm:px-4">
          {range && (
            <span className="tabular-nums text-muted-foreground">
              <span className="font-medium text-foreground">{fullMoment(range.start)}</span> → <span className="font-medium text-foreground">{fullMoment(range.end)}</span> · {mark(dayMark(doc, range.end))}
            </span>
          )}
          <span className="text-muted-foreground">
            Giờ làm {doc.hours.dayStart}–{doc.hours.dayEnd}
            {doc.hours.skipWeekends && " · không tính T7, CN"}
          </span>
          <span className="flex items-center gap-2" title={`${done}/${doc.steps.length} bước hoàn thành`}>
            <span className="h-1.5 w-20 overflow-hidden rounded-full bg-muted ring-1 ring-border" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Tiến độ">
              <span className="block h-full rounded-full bg-emerald-500 transition-[width]" style={{ width: `${pct}%` }} />
            </span>
            <span className="tabular-nums text-muted-foreground">
              {done}/{doc.steps.length} xong
            </span>
          </span>
          {canEdit && confirmedCount < doc.steps.length ? (
            <button
              type="button"
              onClick={() => setRemindMode("confirm")}
              className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 font-medium text-primary hover:bg-primary/15"
              title="Gửi email yêu cầu các vai trò xác nhận timeline"
            >
              <BellRing className="size-3" /> {confirmedCount}/{doc.steps.length} bước đã chốt · Nhắc xác nhận
            </button>
          ) : (
            <span className={cn("rounded-md px-1.5 py-0.5 font-medium", confirmedCount === doc.steps.length ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-muted text-muted-foreground")}>
              {confirmedCount}/{doc.steps.length} bước đã chốt timeline
            </span>
          )}
          {extra > 0 && <span className="rounded-md bg-amber-500/12 px-1.5 py-0.5 font-medium text-amber-800 dark:text-amber-300">Gia hạn +{minutesLabel(extra, doc.hours)}</span>}
          {late > 0 && <span className="rounded-md bg-rose-500/10 px-1.5 py-0.5 font-medium text-rose-700 dark:text-rose-300">{late} bước trễ hạn</span>}

          {doc.roles.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 sm:ml-auto" role="group" aria-label="Lọc theo PIC">
              <span className="mr-0.5 text-muted-foreground">PIC:</span>
              {doc.roles.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  aria-pressed={focusRole === r.id}
                  onClick={() => setFocusRole(focusRole === r.id ? null : r.id)}
                  className={cn("inline-flex h-6 items-center gap-1 rounded-md px-1.5 font-medium ring-1 ring-inset transition-opacity", ROLE_STYLE[r.color].chip, focusRole && focusRole !== r.id && "opacity-45")}
                >
                  <span className={cn("size-1.5 rounded-full", ROLE_STYLE[r.color].dot)} />
                  {r.name}
                </button>
              ))}
            </div>
          )}
        </div>

        <main className="relative min-h-0 flex-1">{view === "flow" ? <WorkflowCanvas /> : <GanttView />}</main>

        <StepPanel open={openStep} tab={tab} onTab={setTab} onClose={() => setOpenStep(null)} onCancelExtension={sync.cancelExtension} />
        <ChangeDialog target={change} onClose={() => setChange(null)} submit={sync.submitChange} defaultName={viewerName} />
        {canEdit && (
          <>
            <RolesDialog open={rolesOpen} onOpenChange={setRolesOpen} />
            <HoursDialog open={hoursOpen} onOpenChange={setHoursOpen} />
            <CloneDialog source={{ name, doc }} open={cloneOpen} onOpenChange={setCloneOpen} />
            <RemindDialog mode={remindMode} onClose={() => setRemindMode(null)} />
            <MembersDialog workflowId={id} isOwner={isOwner} open={membersOpen} onOpenChange={setMembersOpen} />
          </>
        )}

        <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Xoá workflow này?</DialogTitle>
              <DialogDescription>“{name}” và toàn bộ lịch sử gia hạn sẽ bị xoá với mọi người. Không thể hoàn tác.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmDelete(false)}>
                Huỷ
              </Button>
              <Button variant="destructive" onClick={remove}>
                <Trash2 /> Xoá
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </WorkflowProvider>
  );
}
