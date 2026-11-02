"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { createClient } from "@/lib/supabase/client";
import { LIMITS, cloneDoc, defaultStart, isDay, todayDay, type WorkflowDoc } from "@/lib/workflow/model";

const INPUT = "h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** Copies a plan for another feature: the copy gets the feature's name and its own start day. */
export function CloneDialog({ source, open, onOpenChange }: { source: { name: string; doc: WorkflowDoc }; open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [day, setDay] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    /* eslint-disable react-hooks/set-state-in-effect -- reset when the dialog opens */
    setName("");
    setDay(defaultStart(todayDay()).slice(0, 10));
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open]);

  async function clone() {
    const feature = name.trim().slice(0, LIMITS.name);
    if (!feature || !isDay(day) || busy) return;
    setBusy(true);
    const supabase = createClient();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) {
      setBusy(false);
      return void toast.error("Hãy đăng nhập để nhân bản workflow.");
    }
    const doc = cloneDoc(source.doc, { name: source.name }, `${day}T${source.doc.start.slice(11, 16)}`);
    const { data, error } = await supabase.from("workflows").insert({ owner_id: auth.user.id, name: feature, doc }).select("id").single();
    setBusy(false);
    if (error || !data) return void toast.error("Không nhân bản được, hãy thử lại.");
    toast.success(`Đã tạo workflow cho “${feature}”`);
    onOpenChange(false);
    router.push(`/workflow/${data.id}`);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Copy className="size-4 text-primary" /> Nhân bản cho tính năng mới
          </DialogTitle>
          <DialogDescription>
            Bản sao giữ các bước, PIC và thời lượng của “{source.name}”. Trạng thái về “Chưa bắt đầu”, lịch sử gia hạn không được sao chép.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void clone();
          }}
        >
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Tên tính năng <span className="text-destructive">*</span>
            </span>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.name} placeholder="VD: Chuyển tiền nhanh 24/7" className={INPUT} />
          </label>
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Ngày bắt đầu (T+0)</span>
            <input type="date" value={day} onChange={(e) => setDay(e.target.value)} className={INPUT} />
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Huỷ
            </Button>
            <Button type="submit" disabled={!name.trim() || !isDay(day) || busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Copy />} Tạo bản sao
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
