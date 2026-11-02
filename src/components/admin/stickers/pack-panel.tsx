"use client";

import { useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ImagePlus, Link2, MoreHorizontal, Pencil, Star, StarOff, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StickerThumb } from "@/components/admin/stickers/sticker-thumb";
import { packIconId, type AdminPack } from "@/components/admin/stickers/types";
import { UploadList, type UploadJob } from "@/components/admin/stickers/upload-queue";
import { STICKER_MIME, type CustomSticker } from "@/lib/stickers/custom";
import { cn } from "@/lib/utils";

/** The selected pack: its stickers in order, uploads by picker or drag and drop. */
export function PackPanel({
  pack,
  jobs,
  busy,
  onAddFiles,
  onClearUploads,
  onFromUrl,
  onEdit,
  onSetCover,
  onMove,
  onDelete,
}: {
  pack: AdminPack;
  jobs: UploadJob[];
  /** a reorder is being saved */
  busy: boolean;
  onAddFiles: (files: File[]) => void;
  onClearUploads: () => void;
  onFromUrl: () => void;
  onEdit: (sticker: CustomSticker) => void;
  onSetCover: (stickerId: string | null) => void;
  onMove: (index: number, delta: number) => void;
  onDelete: (sticker: CustomSticker) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const iconId = packIconId(pack);

  const takeFiles = (list: FileList | null | undefined) => {
    const files = Array.from(list ?? []);
    if (files.length) onAddFiles(files);
  };

  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

  return (
    <section className="min-w-0 space-y-4" aria-labelledby="pack-panel-title">
      <div className="flex flex-wrap items-center gap-3">
        <StickerThumb id={iconId} alt="" className="size-12 shrink-0 rounded-xl border bg-muted/30 p-1" />
        <div className="min-w-0 flex-1">
          <h3 id="pack-panel-title" className="truncate text-lg font-semibold">
            {pack.name}
          </h3>
          <p className="text-xs text-muted-foreground">
            {pack.stickers.length} sticker{pack.stickers.length === 1 ? "" : "s"} ·{" "}
            {pack.enabled ? "Shown to everyone" : "Off: only admins see it"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={STICKER_MIME.join(",")}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              takeFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <Button onClick={() => inputRef.current?.click()}>
            <ImagePlus aria-hidden />
            Add images
          </Button>
          <Button variant="outline" onClick={onFromUrl}>
            <Link2 aria-hidden />
            From URL
          </Button>
        </div>
      </div>

      <UploadList jobs={jobs} onClear={onClearUploads} />

      <div
        onDragEnter={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          depth.current += 1;
          setDragging(true);
        }}
        onDragOver={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={() => {
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setDragging(false);
        }}
        onDrop={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          depth.current = 0;
          setDragging(false);
          takeFiles(e.dataTransfer.files);
        }}
        className={cn(
          "relative rounded-xl border border-dashed p-2 transition-colors",
          dragging ? "border-primary bg-primary/5" : "border-border"
        )}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-background/70 text-sm font-medium text-primary">
            Drop images to add them to “{pack.name}”
          </div>
        )}
        {pack.stickers.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-12 text-center text-sm text-muted-foreground">
            <ImagePlus className="size-8" aria-hidden />
            <p>Drop PNG, WebP, GIF or JPEG images here (up to 2 MB each), or use Add images.</p>
          </div>
        ) : (
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5 xl:grid-cols-6" aria-label={`Stickers in ${pack.name}`}>
            {pack.stickers.map((sticker, index) => {
              const isCover = sticker.id === pack.cover_sticker_id;
              return (
                <li key={sticker.id} className="group relative flex min-w-0 flex-col rounded-xl border bg-background/60 p-1.5">
                  <button
                    type="button"
                    onClick={() => onEdit(sticker)}
                    className="flex aspect-square items-center justify-center rounded-lg outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
                    aria-label={`Edit ${sticker.name}`}
                    title={sticker.keywords.length ? `${sticker.name} · ${sticker.keywords.join(", ")}` : sticker.name}
                  >
                    <StickerThumb id={sticker.id} alt="" className="size-full p-1" />
                  </button>
                  {isCover && (
                    <Badge className="absolute top-1 left-1 h-4 gap-0.5 px-1.5 text-[10px]">
                      <Star aria-hidden />
                      Cover
                    </Badge>
                  )}
                  <div className="mt-1 flex min-w-0 items-center gap-1">
                    <span className="min-w-0 flex-1 truncate px-0.5 text-xs" title={sticker.name}>
                      {sticker.name}
                    </span>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <button
                            className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                            aria-label={`Actions for ${sticker.name}`}
                          />
                        }
                      >
                        <MoreHorizontal className="size-3.5" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => onEdit(sticker)}>
                          <Pencil aria-hidden />
                          Edit name &amp; keywords
                        </DropdownMenuItem>
                        {isCover ? (
                          <DropdownMenuItem onClick={() => onSetCover(null)}>
                            <StarOff aria-hidden />
                            Remove as cover
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem onClick={() => onSetCover(sticker.id)}>
                            <Star aria-hidden />
                            Set as cover
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem disabled={busy || index === 0} onClick={() => onMove(index, -1)}>
                          <ArrowLeft aria-hidden />
                          Move left
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={busy || index === pack.stickers.length - 1}
                          onClick={() => onMove(index, 1)}
                        >
                          <ArrowRight aria-hidden />
                          Move right
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onClick={() => onDelete(sticker)}>
                          <Trash2 aria-hidden />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
