"use client";

import { useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Check, Plus, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { LIMITS, ROLE_COLORS, newId, updateStep, type WorkflowStep } from "@/lib/workflow/model";
import { useWorkflow } from "./context";
import { ROLE_STYLE } from "./styles";

export function RoleChip({ name, color, className }: { name: string; color: keyof typeof ROLE_STYLE; className?: string }) {
  return (
    <span className={cn("inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset", ROLE_STYLE[color].chip, className)}>
      <span className={cn("size-1.5 shrink-0 rounded-full", ROLE_STYLE[color].dot)} />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** The PIC chips of a step; signed-in editors click them to pick roles or add a new one in place. */
export function PicPicker({ step }: { step: WorkflowStep }) {
  const { doc, canEdit, edit, openRoles } = useWorkflow();
  const [draft, setDraft] = useState("");
  const roles = step.picIds.map((id) => doc.roles.find((r) => r.id === id)).filter((r) => r !== undefined);

  const chips = roles.length ? (
    roles.map((r) => <RoleChip key={r.id} name={r.name} color={r.color} />)
  ) : (
    <span className="rounded-md border border-dashed px-1.5 py-0.5 text-[11px] text-muted-foreground">{canEdit ? "+ Giao PIC" : "Chưa có PIC"}</span>
  );
  if (!canEdit) return <div className="flex min-h-5 flex-wrap gap-1">{chips}</div>;

  const toggle = (id: string) =>
    edit((d) => updateStep(d, step.id, { picIds: step.picIds.includes(id) ? step.picIds.filter((x) => x !== id) : [...step.picIds, id] }));

  function addRole() {
    const name = draft.trim().slice(0, LIMITS.roleName);
    if (!name || doc.roles.length >= LIMITS.roles) return;
    const existing = doc.roles.find((r) => r.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      if (!step.picIds.includes(existing.id)) toggle(existing.id);
    } else {
      const used = new Set(doc.roles.map((r) => r.color));
      const role = { id: newId("r"), name, color: ROLE_COLORS.find((c) => !used.has(c)) ?? ROLE_COLORS[doc.roles.length % ROLE_COLORS.length] };
      edit((d) => updateStep({ ...d, roles: [...d.roles, role] }, step.id, { picIds: [...step.picIds, role.id] }));
    }
    setDraft("");
  }

  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label="Chọn người phụ trách (PIC)"
        className="nodrag nopan -m-1 flex min-h-5 flex-wrap gap-1 rounded-md p-1 text-left outline-none hover:bg-muted/70 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {chips}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="start" className="z-50">
          <Popover.Popup className="w-64 origin-(--transform-origin) rounded-xl bg-popover p-2 text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none transition-[transform,opacity] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
            <Popover.Title className="px-1.5 pt-1 pb-2 text-xs font-medium text-muted-foreground">Người phụ trách (PIC)</Popover.Title>
            <ul className="grid max-h-56 gap-0.5 overflow-y-auto">
              {doc.roles.map((r) => {
                const on = step.picIds.includes(r.id);
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={on}
                      onClick={() => toggle(r.id)}
                      className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-sm hover:bg-muted"
                    >
                      <span className={cn("grid size-4 place-items-center rounded border", on ? "border-primary bg-primary text-primary-foreground" : "border-input")}>
                        {on && <Check className="size-3" />}
                      </span>
                      <span className={cn("size-2 rounded-full", ROLE_STYLE[r.color].dot)} />
                      <span className="truncate">{r.name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <form
              className="mt-1.5 flex gap-1 border-t pt-2"
              onSubmit={(e) => {
                e.preventDefault();
                addRole();
              }}
            >
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={LIMITS.roleName}
                placeholder="Thêm vai trò mới…"
                aria-label="Tên vai trò mới"
                className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring"
              />
              <button type="submit" aria-label="Thêm vai trò" disabled={!draft.trim()} className="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground disabled:opacity-40">
                <Plus className="size-4" />
              </button>
            </form>
            <button type="button" onClick={openRoles} className="mt-1 flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
              <Settings2 className="size-3.5" /> Đổi tên, màu, xoá vai trò…
            </button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
