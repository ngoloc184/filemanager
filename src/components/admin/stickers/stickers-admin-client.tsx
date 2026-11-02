"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileArchive, Loader2, Plus, Sticker } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BuiltinGroupsPanel } from "@/components/admin/stickers/builtin-groups-panel";
import { ConfirmDialog } from "@/components/admin/stickers/confirm-dialog";
import { ImportUrlDialog } from "@/components/admin/stickers/import-url-dialog";
import { ImportZipDialog } from "@/components/admin/stickers/import-zip-dialog";
import { NewPackDialog } from "@/components/admin/stickers/pack-name-dialog";
import { PackList } from "@/components/admin/stickers/pack-list";
import { PackPanel } from "@/components/admin/stickers/pack-panel";
import { StickerEditorDialog } from "@/components/admin/stickers/sticker-editor-dialog";
import type { AdminPack } from "@/components/admin/stickers/types";
import { useUploadQueue, type UploadSource } from "@/components/admin/stickers/upload-queue";
import {
  deletePack,
  deleteSticker,
  listPacksAdmin,
  reorderPacks,
  reorderStickers,
  updatePack,
} from "@/lib/services/stickers-admin";
import type { CustomSticker, StickerPack } from "@/lib/stickers/custom";
import { invalidateStickerCatalog } from "@/lib/stickers/load";
import { moveItem } from "@/lib/stickers/zip-import";
import { getErrorMessage } from "@/lib/types/database";
import { cn } from "@/lib/utils";

type TabId = "packs" | "builtin";
const TABS: { id: TabId; label: string }[] = [
  { id: "packs", label: "Sticker packs" },
  { id: "builtin", label: "Built-in stickers" },
];

type Dialog =
  | { kind: "new-pack" }
  | { kind: "zip" }
  | { kind: "url"; pack: AdminPack }
  | { kind: "edit"; sticker: CustomSticker }
  | { kind: "delete-pack"; pack: AdminPack }
  | { kind: "delete-sticker"; sticker: CustomSticker };

/** Admin → Stickers: custom packs every user gets in chat, and the built-in groups. */
export default function StickersAdminClient() {
  const [packs, setPacks] = useState<AdminPack[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("packs");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [reordering, setReordering] = useState(false);
  // every change shows up in this admin's own chat picker at once
  useEffect(() => {
    if (packs) invalidateStickerCatalog();
  }, [packs]);

  const updatePackState = useCallback((id: string, change: (pack: AdminPack) => AdminPack) => {
    setPacks((list) => list?.map((p) => (p.id === id ? change(p) : p)) ?? list);
  }, []);

  const onUploaded = useCallback(
    (sticker: CustomSticker) => {
      updatePackState(sticker.pack_id, (p) =>
        p.stickers.some((s) => s.id === sticker.id) ? p : { ...p, stickers: [...p.stickers, sticker] }
      );
    },
    [updatePackState]
  );
  const uploads = useUploadQueue(onUploaded);

  const load = useCallback(async () => {
    try {
      setPacks(await listPacksAdmin());
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    listPacksAdmin()
      .then((list) => {
        if (!cancelled) setPacks(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(getErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = packs?.find((p) => p.id === selectedId) ?? packs?.[0] ?? null;

  const addPack = (pack: StickerPack) => {
    setPacks((list) => [...(list ?? []), { ...pack, stickers: [] }]);
    setSelectedId(pack.id);
    setTab("packs");
  };

  const importZip = (pack: StickerPack, sources: UploadSource[]) => {
    addPack(pack);
    uploads.enqueue(pack.id, sources);
  };

  const rename = async (id: string, name: string) => {
    const saved = await updatePack(id, { name });
    updatePackState(id, (p) => ({ ...p, ...saved }));
    toast.success("Pack renamed");
  };

  const toggle = async (id: string, enabled: boolean) => {
    try {
      const saved = await updatePack(id, { enabled });
      updatePackState(id, (p) => ({ ...p, ...saved }));
      toast.success(enabled ? `“${saved.name}” is shown to everyone` : `“${saved.name}” is off`);
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  const setCover = async (packId: string, stickerId: string | null) => {
    try {
      const saved = await updatePack(packId, { cover_sticker_id: stickerId });
      updatePackState(packId, (p) => ({ ...p, ...saved }));
      toast.success(stickerId ? "Cover updated" : "Cover removed: the first sticker is used");
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  // reorders show at once; a failed save reloads the real order
  const reorderLock = useRef(false);
  const reorder = async (apply: () => Promise<void>) => {
    if (reorderLock.current) return;
    reorderLock.current = true;
    setReordering(true);
    try {
      await apply();
    } catch (err) {
      toast.error(getErrorMessage(err));
      await load();
    } finally {
      reorderLock.current = false;
      setReordering(false);
    }
  };

  const movePack = (index: number, delta: number) => {
    if (!packs) return;
    const next = moveItem(packs, index, delta);
    setPacks(next);
    void reorder(() => reorderPacks(next.map((p) => p.id)));
  };

  const moveSticker = (pack: AdminPack, index: number, delta: number) => {
    const stickers = moveItem(pack.stickers, index, delta);
    updatePackState(pack.id, (p) => ({ ...p, stickers }));
    void reorder(() => reorderStickers(pack.id, stickers.map((s) => s.id)));
  };

  const removePack = async (pack: AdminPack) => {
    await uploads.cancelPack(pack.id);
    await deletePack(pack.id);
    setPacks((list) => list?.filter((p) => p.id !== pack.id) ?? list);
    if (selectedId === pack.id) setSelectedId(null);
    toast.success(`Deleted “${pack.name}”`);
  };

  const removeSticker = async (sticker: CustomSticker) => {
    try {
      await deleteSticker(sticker.id);
    } catch (err) {
      // the row may be gone even when its image was not removed
      await load();
      throw err;
    }
    updatePackState(sticker.pack_id, (p) => ({
      ...p,
      cover_sticker_id: p.cover_sticker_id === sticker.id ? null : p.cover_sticker_id,
      stickers: p.stickers.filter((s) => s.id !== sticker.id),
    }));
    toast.success(`Deleted “${sticker.name}”`);
  };

  const replaceSticker = (sticker: CustomSticker) => {
    updatePackState(sticker.pack_id, (p) => ({
      ...p,
      stickers: p.stickers.map((s) => (s.id === sticker.id ? sticker : s)),
    }));
  };

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Sticker className="size-7 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="text-2xl font-bold">Chat stickers</h2>
          <p className="text-sm text-muted-foreground">
            Packs you add here appear in every user&apos;s sticker picker and in suggestions while typing.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setDialog({ kind: "zip" })}>
            <FileArchive aria-hidden />
            Import ZIP
          </Button>
          <Button onClick={() => setDialog({ kind: "new-pack" })}>
            <Plus aria-hidden />
            New pack
          </Button>
        </div>
      </div>

      <Tabs active={tab} onChange={setTab} />

      <div role="tabpanel" id={`stickers-panel-${tab}`} aria-labelledby={`stickers-tab-${tab}`}>
        {tab === "builtin" ? (
          <BuiltinGroupsPanel />
        ) : error && !packs ? (
          <Card className="max-w-xl">
            <CardHeader>
              <CardTitle>Could not load sticker packs</CardTitle>
              <CardDescription className="text-destructive">{error}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" onClick={() => void load()}>
                Try again
              </Button>
            </CardContent>
          </Card>
        ) : !packs ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Loading sticker packs…
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[19rem_minmax(0,1fr)]">
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Order here is the order of the picker tabs. A pack that is off is hidden from everyone but admins.
              </p>
              <PackList
                packs={packs}
                selectedId={selected?.id ?? null}
                busy={reordering}
                onSelect={setSelectedId}
                onRename={rename}
                onToggle={toggle}
                onMove={movePack}
                onDelete={(pack) => setDialog({ kind: "delete-pack", pack })}
              />
            </div>
            {selected ? (
              <PackPanel
                key={selected.id}
                pack={selected}
                jobs={uploads.jobs.filter((j) => j.packId === selected.id)}
                busy={reordering}
                onAddFiles={(files) => uploads.enqueue(selected.id, files)}
                onClearUploads={() => uploads.clearFinished(selected.id)}
                onFromUrl={() => setDialog({ kind: "url", pack: selected })}
                onEdit={(sticker) => setDialog({ kind: "edit", sticker })}
                onSetCover={(id) => void setCover(selected.id, id)}
                onMove={(index, delta) => moveSticker(selected, index, delta)}
                onDelete={(sticker) => setDialog({ kind: "delete-sticker", sticker })}
              />
            ) : (
              <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
                <Sticker className="size-8" aria-hidden />
                <p>Create a pack, then add images, a ZIP or an image URL.</p>
              </div>
            )}
          </div>
        )}
      </div>

      {dialog?.kind === "new-pack" && <NewPackDialog onOpenChange={() => setDialog(null)} onCreated={addPack} />}
      {dialog?.kind === "zip" && <ImportZipDialog onOpenChange={() => setDialog(null)} onImport={importZip} />}
      {dialog?.kind === "url" && (
        <ImportUrlDialog
          packId={dialog.pack.id}
          packName={dialog.pack.name}
          onOpenChange={() => setDialog(null)}
          onImported={onUploaded}
        />
      )}
      {dialog?.kind === "edit" && (
        <StickerEditorDialog sticker={dialog.sticker} onOpenChange={() => setDialog(null)} onSaved={replaceSticker} />
      )}
      {dialog?.kind === "delete-pack" && (
        <ConfirmDialog
          title={`Delete “${dialog.pack.name}”?`}
          description={
            <>
              <p>
                {dialog.pack.stickers.length === 0
                  ? "The pack is empty."
                  : `Its ${dialog.pack.stickers.length} sticker${dialog.pack.stickers.length === 1 ? "" : "s"} will be deleted too.`}{" "}
                This cannot be undone.
              </p>
              <p className="mt-2">Messages that already used these stickers will show a placeholder instead.</p>
            </>
          }
          confirmLabel="Delete pack"
          onConfirm={() => removePack(dialog.pack)}
          onOpenChange={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "delete-sticker" && (
        <ConfirmDialog
          title={`Delete “${dialog.sticker.name}”?`}
          description="Messages that already used this sticker will show a placeholder instead. This cannot be undone."
          confirmLabel="Delete sticker"
          onConfirm={() => removeSticker(dialog.sticker)}
          onOpenChange={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function Tabs({ active, onChange }: { active: TabId; onChange: (id: TabId) => void }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const onKeyDown = (e: React.KeyboardEvent) => {
    const index = TABS.findIndex((t) => t.id === active);
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(TABS[next].id);
    refs.current[TABS[next].id]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Sticker sections"
      className="-mx-1 flex gap-1 overflow-x-auto border-b px-1"
      onKeyDown={onKeyDown}
    >
      {TABS.map((t) => {
        const selected = t.id === active;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`stickers-tab-${t.id}`}
            aria-selected={selected}
            aria-controls={selected ? `stickers-panel-${t.id}` : undefined}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={cn(
              "-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              selected
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
