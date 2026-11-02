"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Check, Loader2, MoreHorizontal, Pencil, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { StickerThumb } from "@/components/admin/stickers/sticker-thumb";
import { Switch } from "@/components/admin/stickers/switch";
import { packIconId, packNameProblem, type AdminPack } from "@/components/admin/stickers/types";
import { PACK_NAME_MAX } from "@/lib/stickers/custom";
import { getErrorMessage } from "@/lib/types/database";
import { cn } from "@/lib/utils";

/** Packs in picker order: select, rename inline, switch on/off, move, delete. */
export function PackList({
  packs,
  selectedId,
  busy,
  onSelect,
  onRename,
  onToggle,
  onMove,
  onDelete,
}: {
  packs: AdminPack[];
  selectedId: string | null;
  /** a reorder is being saved */
  busy: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, name: string) => Promise<void>;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
  onMove: (index: number, delta: number) => void;
  onDelete: (pack: AdminPack) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  if (packs.length === 0) {
    return (
      <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
        No packs yet. Create one or import a ZIP.
      </p>
    );
  }

  return (
    <ul className="space-y-1.5" aria-label="Sticker packs">
      {packs.map((pack, index) => {
        const selected = pack.id === selectedId;
        const iconId = packIconId(pack);
        if (renaming === pack.id) {
          return (
            <li key={pack.id}>
              <RenameRow
                pack={pack}
                onCancel={() => setRenaming(null)}
                onSave={async (name) => {
                  await onRename(pack.id, name);
                  setRenaming(null);
                }}
              />
            </li>
          );
        }
        return (
          <li
            key={pack.id}
            className={cn(
              "flex items-center gap-2 rounded-xl border p-1.5 pr-2 transition-colors",
              selected ? "border-primary/40 bg-primary/5" : "bg-background/60 hover:bg-muted/40"
            )}
          >
            <button
              type="button"
              onClick={() => onSelect(pack.id)}
              aria-current={selected ? "true" : undefined}
              className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg p-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <StickerThumb id={iconId} alt="" className="size-10 shrink-0 rounded-lg bg-muted/40 p-0.5" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{pack.name}</span>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {pack.stickers.length} sticker{pack.stickers.length === 1 ? "" : "s"}
                  {!pack.enabled && (
                    <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                      Off
                    </Badge>
                  )}
                </span>
              </span>
            </button>
            {toggling === pack.id && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />}
            <Switch
              checked={pack.enabled}
              disabled={toggling !== null}
              aria-label={`Show ${pack.name} to everyone`}
              onCheckedChange={async (checked) => {
                setToggling(pack.id);
                try {
                  await onToggle(pack.id, checked);
                } finally {
                  setToggling(null);
                }
              }}
            />
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label={`Actions for ${pack.name}`}
                  />
                }
              >
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setRenaming(pack.id)}>
                  <Pencil aria-hidden />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem disabled={busy || index === 0} onClick={() => onMove(index, -1)}>
                  <ArrowUp aria-hidden />
                  Move up
                </DropdownMenuItem>
                <DropdownMenuItem disabled={busy || index === packs.length - 1} onClick={() => onMove(index, 1)}>
                  <ArrowDown aria-hidden />
                  Move down
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => onDelete(pack)}>
                  <Trash2 aria-hidden />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        );
      })}
    </ul>
  );
}

function RenameRow({
  pack,
  onSave,
  onCancel,
}: {
  pack: AdminPack;
  onSave: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(pack.name);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputId = `rename-${pack.id}`;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const problem = packNameProblem(name);
    if (problem) {
      setError(problem);
      return;
    }
    if (name.trim() === pack.name) {
      onCancel();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(name.trim());
    } catch (err) {
      setError(getErrorMessage(err));
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} className="space-y-1 rounded-xl border border-primary/40 p-1.5" noValidate>
      <div className="flex items-center gap-1">
        <label htmlFor={inputId} className="sr-only">
          Pack name
        </label>
        <Input
          id={inputId}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          maxLength={PACK_NAME_MAX}
          autoFocus
          aria-invalid={Boolean(error)}
          className="h-8"
        />
        <Button type="submit" size="icon" variant="ghost" aria-label="Save name" disabled={saving}>
          {saving ? <Loader2 className="animate-spin" aria-hidden /> : <Check aria-hidden />}
        </Button>
        <Button type="button" size="icon" variant="ghost" aria-label="Cancel renaming" onClick={onCancel} disabled={saving}>
          <X aria-hidden />
        </Button>
      </div>
      {error && (
        <p className="px-1 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
