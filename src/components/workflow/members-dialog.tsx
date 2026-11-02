"use client";

import { useCallback, useEffect, useState } from "react";
import { Crown, Loader2, ShieldCheck, User } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/admin/stickers/switch";
import { createClient } from "@/lib/supabase/client";
import { logTime } from "./styles";

interface Member {
  user_id: string;
  name: string | null;
  email: string | null;
  role: "owner" | "admin" | "member";
  last_opened_at: string;
}

/** Who has opened the plan; the owner makes members admins (they may then edit everything). */
export function MembersDialog({ workflowId, isOwner, open, onOpenChange }: { workflowId: string; isOwner: boolean; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await createClient().rpc("list_workflow_members", { p_workflow: workflowId });
    setMembers(error ? [] : ((data ?? []) as Member[]));
  }, [workflowId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads when the dialog opens
    if (open) void load();
  }, [open, load]);

  async function setAdmin(m: Member, admin: boolean) {
    setBusy(m.user_id);
    const { error } = await createClient().rpc("set_workflow_admin", { p_workflow: workflowId, p_user: m.user_id, p_admin: admin });
    setBusy(null);
    if (error) return void toast.error("Không đổi được quyền");
    toast.success(admin ? `${m.name ?? m.email} là admin của workflow` : `${m.name ?? m.email} không còn là admin`);
    void load();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Thành viên & admin</DialogTitle>
          <DialogDescription>
            Người đã đăng nhập và mở link workflow. Admin được chỉnh sửa mọi thứ và gửi nhắc nhở; thành viên khác chỉ sửa số ngày khi chưa chốt, xác nhận timeline và gia hạn.
            {isOwner ? " Bạn là người tạo nên có thể cấp hoặc thu quyền admin." : " Chỉ người tạo mới cấp hoặc thu quyền admin."}
          </DialogDescription>
        </DialogHeader>
        {members === null ? (
          <div className="grid place-items-center py-8 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <ul className="grid max-h-[55vh] gap-1 overflow-y-auto">
            {members.map((m) => {
              const Icon = m.role === "owner" ? Crown : m.role === "admin" ? ShieldCheck : User;
              return (
                <li key={m.user_id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted/50">
                  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{m.name ?? m.email}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {m.name ? `${m.email} · ` : ""}
                      {m.role === "owner" ? "Người tạo" : m.role === "admin" ? "Admin" : "Thành viên"} · mở lần cuối {logTime(m.last_opened_at)}
                    </span>
                  </span>
                  {m.role !== "owner" && (
                    <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                      Admin
                      <Switch checked={m.role === "admin"} disabled={!isOwner || busy === m.user_id} onCheckedChange={(on) => void setAdmin(m, on)} aria-label={`Admin: ${m.name ?? m.email}`} />
                    </label>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
