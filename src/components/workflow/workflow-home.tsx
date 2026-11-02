"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowRight, CalendarPlus, Copy, FilePlus2, LayoutTemplate, Link2, Loader2, LogIn, MoreHorizontal, Network, Users, Workflow as WorkflowIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { blankDoc, todayDay, type RoleColor, type WorkHours, type WorkflowDoc } from "@/lib/workflow/model";
import { EXAMPLE_NAME, exampleDoc } from "@/lib/workflow/template";
import { readPayload, type Payload } from "@/lib/workflow/payload";
import { CloneDialog } from "./clone-dialog";
import { RoleChip } from "./pic-picker";
import { fullMoment, logTime, minutesLabel } from "./styles";

export interface WorkflowSummary {
  id: string;
  name: string;
  isOwner: boolean;
  updatedAt: string;
  clonedFrom: string | null;
  steps: number;
  done: number;
  late: number;
  extensions: number;
  extraMinutes: number;
  hours: WorkHours;
  start: number | null;
  end: number | null;
  roles: { name: string; color: RoleColor }[];
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-20 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-2.5 px-4">
          <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
            <WorkflowIcon className="size-4" />
          </span>
          <span className="font-semibold">Workflow</span>
          <ThemeToggle className="ml-auto" layoutId="workflow-home-theme" />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}

function OpenLink() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const id = /\/workflow\/([0-9a-f-]{36})/i.exec(value)?.[1] ?? (/^[0-9a-f-]{36}$/i.test(value.trim()) ? value.trim() : null);
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (id) router.push(`/workflow/${id}`);
        else toast.error("Link không đúng dạng …/workflow/<mã>");
      }}
    >
      <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Dán link workflow được chia sẻ" aria-label="Link workflow" className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" />
      <Button type="submit" variant="outline" size="lg" disabled={!value.trim()}>
        Mở <ArrowRight />
      </Button>
    </form>
  );
}

export function WorkflowHome({ signedIn, workflows }: { signedIn: boolean; workflows: WorkflowSummary[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [cloneSource, setCloneSource] = useState<{ name: string; doc: WorkflowDoc } | null>(null);

  if (!signedIn) {
    return (
      <Shell>
        <section className="mx-auto max-w-xl py-10 text-center">
          <span className="mx-auto mb-4 grid size-12 place-items-center rounded-2xl bg-primary/10 text-primary">
            <Network className="size-6" />
          </span>
          <h1 className="text-2xl font-semibold tracking-tight">Quy trình rõ ràng, timeline tự tính</h1>
          <p className="mt-2 text-muted-foreground">Vẽ các bước, giao PIC, đặt số ngày cho từng bước. Hạn của mỗi bước được tính từ ngày bắt đầu, không tính T7 và CN.</p>
          <ul className="mx-auto mt-6 grid max-w-md gap-2 text-left text-sm">
            {[
              [Users, "Đăng nhập để tạo, chỉnh sửa và nhân bản quy trình cho từng tính năng."],
              [CalendarPlus, "Không cần đăng nhập để gia hạn hoặc sửa số ngày của một bước; mọi thay đổi đều có lịch sử."],
              [Link2, "Chia sẻ bằng link: ai có link đều xem được tiến độ."],
            ].map(([Icon, text], i) => {
              const I = Icon as typeof Users;
              return (
                <li key={i} className="flex gap-3 rounded-lg bg-muted/50 px-3 py-2.5">
                  <I className="mt-0.5 size-4 shrink-0 text-primary" />
                  {text as string}
                </li>
              );
            })}
          </ul>
          <div className="mt-6 flex justify-center">
            <Button size="lg" render={<Link href="/login?next=%2Fworkflow" />}>
              <LogIn /> Đăng nhập để tạo workflow
            </Button>
          </div>
          <div className="mx-auto mt-8 max-w-md text-left">
            <p className="mb-2 text-xs font-medium text-muted-foreground">Đã có link?</p>
            <OpenLink />
          </div>
        </section>
      </Shell>
    );
  }

  async function create(kind: "blank" | "example") {
    if (busy) return;
    setBusy(kind);
    const supabase = createClient();
    const { data: auth } = await supabase.auth.getUser();
    const today = todayDay();
    const doc = kind === "blank" ? blankDoc(today) : exampleDoc(today);
    const { data, error } = auth.user
      ? await supabase.from("workflows").insert({ owner_id: auth.user.id, name: kind === "blank" ? "Workflow mới" : EXAMPLE_NAME, doc }).select("id").single()
      : { data: null, error: true };
    setBusy(null);
    if (error || !data) return void toast.error("Không tạo được workflow, hãy thử lại.");
    router.push(`/workflow/${data.id}`);
  }

  async function startClone(w: WorkflowSummary) {
    setBusy(w.id);
    const res = await fetch(`/api/workflows/${w.id}`, { cache: "no-store" }).catch(() => null);
    const loaded = res?.ok ? readPayload((await res.json()) as Payload) : null;
    setBusy(null);
    if (!loaded) return void toast.error("Không tải được workflow");
    setCloneSource({ name: loaded.snap.name, doc: loaded.snap.doc });
  }

  const createButtons = (
    <>
      <Button variant="outline" onClick={() => create("example")} disabled={!!busy}>
        {busy === "example" ? <Loader2 className="animate-spin" /> : <LayoutTemplate />} Từ mẫu UAT → Go-live
      </Button>
      <Button onClick={() => create("blank")} disabled={!!busy}>
        {busy === "blank" ? <Loader2 className="animate-spin" /> : <FilePlus2 />} Tạo workflow
      </Button>
    </>
  );

  return (
    <Shell>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Workflow của bạn</h1>
          <p className="mt-1 text-sm text-muted-foreground">Quy trình bạn đã tạo hoặc đã mở bằng link.</p>
        </div>
        <div className="flex flex-wrap gap-2">{createButtons}</div>
      </div>

      {workflows.length === 0 ? (
        <div className="mt-8 rounded-2xl border border-dashed p-10 text-center">
          <Network className="mx-auto size-8 text-muted-foreground" />
          <h2 className="mt-3 font-medium">Chưa có workflow nào</h2>
          <p className="mt-1 text-sm text-muted-foreground">Bắt đầu từ mẫu quy trình UAT → Pre-pilot → Go-live, hoặc tạo trống.</p>
          <div className="mt-4 flex justify-center gap-2">{createButtons}</div>
        </div>
      ) : (
        <ul className="mt-6 grid gap-3">
          {workflows.map((w) => {
            const pct = w.steps ? Math.round((w.done / w.steps) * 100) : 0;
            return (
              <li key={w.id} className="group relative rounded-xl bg-card ring-1 ring-border transition-shadow hover:shadow-md">
                <Link href={`/workflow/${w.id}`} className="absolute inset-0 rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50" aria-label={`Mở ${w.name}`} />
                <div className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate font-semibold group-hover:text-primary">{w.name}</h2>
                      {!w.isOwner && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">Được chia sẻ</span>}
                      {w.late > 0 && <span className="rounded bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-medium text-rose-700 dark:text-rose-300">{w.late} bước trễ</span>}
                      {w.extensions > 0 && (
                        <span className="rounded bg-amber-500/12 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:text-amber-300">
                          Gia hạn {w.extensions} lần · +{minutesLabel(w.extraMinutes, w.hours)}
                        </span>
                      )}
                    </div>
                    {w.clonedFrom && <p className="mt-0.5 truncate text-xs text-muted-foreground">Nhân bản từ “{w.clonedFrom}”</p>}
                    <div className="mt-2 flex flex-wrap gap-1">
                      {w.roles.slice(0, 5).map((r, i) => (
                        <RoleChip key={i} name={r.name} color={r.color} />
                      ))}
                      {w.roles.length > 5 && <span className="text-[11px] text-muted-foreground">+{w.roles.length - 5}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-5 text-xs sm:justify-end">
                    <div className="min-w-0">
                      <p className="text-muted-foreground">Timeline</p>
                      <p className="font-medium tabular-nums">{w.start !== null && w.end !== null ? `${fullMoment(w.start).slice(0, 5)} → ${fullMoment(w.end).slice(0, 10)}` : "—"}</p>
                    </div>
                    <div className="w-28">
                      <p className="text-muted-foreground">
                        {w.done}/{w.steps} bước xong
                      </p>
                      <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-muted ring-1 ring-border">
                        <span className={cn("block h-full rounded-full bg-emerald-500")} style={{ width: `${pct}%` }} />
                      </span>
                    </div>
                    <p className="hidden text-muted-foreground lg:block">Sửa {logTime(w.updatedAt)}</p>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button variant="ghost" size="icon-sm" aria-label={`Thao tác với ${w.name}`} className="relative z-10">
                            {busy === w.id ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
                          </Button>
                        }
                      />
                      <DropdownMenuContent align="end" className="w-60">
                        <DropdownMenuItem onClick={() => router.push(`/workflow/${w.id}`)}>
                          <ArrowRight /> Mở
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => void startClone(w)}>
                          <Copy /> Nhân bản cho tính năng mới
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(`${window.location.origin}/workflow/${w.id}`);
                              toast.success("Đã sao chép link");
                            } catch {
                              toast.error("Không sao chép được link");
                            }
                          }}
                        >
                          <Link2 /> Sao chép link
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-10 max-w-md">
        <p className="mb-2 text-xs font-medium text-muted-foreground">Mở workflow từ link</p>
        <OpenLink />
      </div>

      {cloneSource && <CloneDialog source={cloneSource} open onOpenChange={(o) => !o && setCloneSource(null)} />}
    </Shell>
  );
}
