"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { LIMITS, ROLE_COLORS, newId, type RoleColor } from "@/lib/workflow/model";
import { useWorkflow } from "./context";
import { ROLE_STYLE } from "./styles";

export function RolesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { doc: wf, edit } = useWorkflow();
  const [name, setName] = useState("");
  const count = (id: string) => wf.steps.filter((s) => s.picIds.includes(id)).length;
  const setRole = (id: string, fields: { name?: string; color?: RoleColor }, key: string | null = null) =>
    edit((w) => ({ ...w, roles: w.roles.map((r) => (r.id === id ? { ...r, ...fields } : r)) }), key);

  function add() {
    const trimmed = name.trim().slice(0, LIMITS.roleName);
    if (!trimmed || wf.roles.length >= LIMITS.roles) return;
    const used = new Set(wf.roles.map((r) => r.color));
    const color = ROLE_COLORS.find((c) => !used.has(c)) ?? ROLE_COLORS[wf.roles.length % ROLE_COLORS.length];
    edit((w) => ({ ...w, roles: [...w.roles, { id: newId("r"), name: trimmed, color }] }));
    setName("");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Vai trò (PIC)</DialogTitle>
          <DialogDescription>Mỗi bước có thể giao cho một hoặc nhiều vai trò. Màu vai trò được dùng trên sơ đồ và timeline.</DialogDescription>
        </DialogHeader>

        <ul className="grid max-h-80 gap-1.5 overflow-y-auto">
          {wf.roles.map((r) => (
            <li key={r.id} className="flex items-center gap-2 rounded-lg p-1.5 ring-1 ring-border">
              <div className="flex shrink-0 gap-0.5" role="radiogroup" aria-label={`Màu của ${r.name}`}>
                {ROLE_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={r.color === c}
                    aria-label={ROLE_STYLE[c].label}
                    onClick={() => setRole(r.id, { color: c })}
                    className={cn("size-4 rounded-full ring-offset-1 ring-offset-background transition-transform hover:scale-110", ROLE_STYLE[c].dot, r.color === c && "ring-2 ring-foreground/60")}
                  />
                ))}
              </div>
              <input
                aria-label="Tên vai trò"
                value={r.name}
                maxLength={LIMITS.roleName}
                onChange={(e) => setRole(r.id, { name: e.target.value }, `role:${r.id}`)}
                onBlur={(e) => !e.target.value.trim() && setRole(r.id, { name: "Vai trò" })}
                className="h-8 min-w-0 flex-1 rounded-md bg-transparent px-2 text-sm font-medium outline-none hover:bg-muted focus-visible:bg-muted"
              />
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums" title="Số bước đang giao">
                {count(r.id)} bước
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Xoá vai trò ${r.name}`}
                onClick={() =>
                  edit((w) => ({
                    ...w,
                    roles: w.roles.filter((x) => x.id !== r.id),
                    steps: w.steps.map((s) => (s.picIds.includes(r.id) ? { ...s, picIds: s.picIds.filter((x) => x !== r.id) } : s)),
                  }))
                }
              >
                <Trash2 />
              </Button>
            </li>
          ))}
          {!wf.roles.length && <li className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">Chưa có vai trò nào.</li>}
        </ul>

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input
            aria-label="Tên vai trò mới"
            value={name}
            maxLength={LIMITS.roleName}
            placeholder="VD: DEV FPT, QC HDBank, BA…"
            onChange={(e) => setName(e.target.value)}
            className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          <Button type="submit" disabled={!name.trim() || wf.roles.length >= LIMITS.roles}>
            <Plus /> Thêm
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
