"use client";

import { useEffect, useRef, useState } from "react";
import { FileArchive, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StickerThumb } from "@/components/admin/stickers/sticker-thumb";
import { packNameProblem } from "@/components/admin/stickers/types";
import type { UploadSource } from "@/components/admin/stickers/upload-queue";
import { createPack } from "@/lib/services/stickers-admin";
import { PACK_NAME_MAX, stickerNameFromFile, type StickerPack } from "@/lib/stickers/custom";
import { ZIP_MAX_IMAGES, ZIP_MAX_TOTAL_BYTES, readStickerZip, type StickerZip } from "@/lib/stickers/zip-import";
import { getErrorMessage } from "@/lib/types/database";
import { formatBytes } from "@/lib/utils";

const PREVIEW_MAX = 30;

type Preview = { fileName: string; zip: StickerZip; urls: string[] };

/**
 * Imports a whole pack from a ZIP: shows what will come in (and what is
 * skipped, with the reason), then creates the pack and hands the images to the
 * upload queue, which shows per-file progress in the pack.
 */
export function ImportZipDialog({
  onOpenChange,
  onImport,
}: {
  onOpenChange: (open: boolean) => void;
  /** called with the new pack and its images to upload */
  onImport: (pack: StickerPack, sources: UploadSource[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [packName, setPackName] = useState("");
  const [reading, setReading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // object URLs of the preview images live as long as the preview
  useEffect(() => {
    const urls = preview?.urls ?? [];
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [preview]);

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setPreview(null);
    if (file.size > ZIP_MAX_TOTAL_BYTES) {
      setError(`The ZIP is ${formatBytes(file.size)}; the limit is ${formatBytes(ZIP_MAX_TOTAL_BYTES)}.`);
      return;
    }
    setReading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // let the "Reading…" state paint before the synchronous unzip
      await new Promise((resolve) => setTimeout(resolve, 0));
      const zip = readStickerZip(bytes);
      const urls = zip.items
        .slice(0, PREVIEW_MAX)
        .map((item) => URL.createObjectURL(new Blob([item.bytes.slice()], { type: item.mime })));
      setPreview({ fileName: file.name, zip, urls });
      setPackName(zip.packName ?? stickerNameFromFile(file.name));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setReading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const start = async () => {
    if (!preview || creating) return;
    const problem = packNameProblem(packName);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setCreating(true);
    try {
      const pack = await createPack(packName.trim());
      const sources = preview.zip.items.map(({ fileName, name, keywords, bytes }) => ({
        name,
        keywords,
        bytes,
        label: fileName,
      }));
      onImport(pack, sources);
      toast.success(`Importing ${sources.length} sticker${sources.length === 1 ? "" : "s"} into “${pack.name}”`);
      onOpenChange(false);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const items = preview?.zip.items ?? [];
  const skipped = preview?.zip.skipped ?? [];

  return (
    <Dialog open onOpenChange={(open) => !creating && onOpenChange(open)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import a pack from ZIP</DialogTitle>
          <DialogDescription>
            PNG, WebP, GIF or JPEG images up to 2 MB each, at most {ZIP_MAX_IMAGES} per ZIP. An optional{" "}
            <code className="rounded bg-muted px-1 font-mono text-xs">pack.json</code> sets the pack name and each
            sticker&apos;s name and keywords.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <input
            ref={inputRef}
            id="zip-file"
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => void choose(e.target.files?.[0])}
          />
          <Button variant="outline" onClick={() => inputRef.current?.click()} disabled={reading || creating}>
            {reading ? <Loader2 className="animate-spin" aria-hidden /> : <FileArchive aria-hidden />}
            {reading ? "Reading…" : preview ? "Choose another ZIP" : "Choose a ZIP file"}
          </Button>

          {preview && (
            <>
              <p className="text-sm [overflow-wrap:anywhere]" role="status">
                <span className="font-medium">{preview.fileName}</span>: {items.length} sticker
                {items.length === 1 ? "" : "s"} to import
                {skipped.length > 0 && `, ${skipped.length} skipped`}.
              </p>
              <div className="space-y-2">
                <Label htmlFor="zip-pack-name">Pack name</Label>
                <Input
                  id="zip-pack-name"
                  value={packName}
                  onChange={(e) => setPackName(e.target.value)}
                  maxLength={PACK_NAME_MAX}
                />
              </div>
              {items.length > 0 && (
                <ul className="grid max-h-56 grid-cols-5 gap-1.5 overflow-y-auto rounded-lg border bg-muted/20 p-2 sm:grid-cols-6" aria-label="Stickers in the ZIP">
                  {preview.urls.map((url, i) => (
                    <li key={url} title={`${items[i].name}${items[i].keywords.length ? ` · ${items[i].keywords.join(", ")}` : ""}`}>
                      <StickerThumb src={url} alt={items[i].name} className="aspect-square w-full" />
                    </li>
                  ))}
                  {items.length > PREVIEW_MAX && (
                    <li className="flex aspect-square items-center justify-center text-xs text-muted-foreground">
                      +{items.length - PREVIEW_MAX}
                    </li>
                  )}
                </ul>
              )}
              {skipped.length > 0 && (
                <details className="rounded-lg border px-3 py-2 text-sm">
                  <summary className="cursor-pointer text-muted-foreground">
                    {skipped.length} file{skipped.length === 1 ? "" : "s"} skipped
                  </summary>
                  <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-xs">
                    {skipped.map((s, i) => (
                      <li key={`${s.fileName}-${i}`} className="[overflow-wrap:anywhere]">
                        <span className="font-mono">{s.fileName}</span>
                        <span className="text-muted-foreground"> · {s.reason}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={creating}>
            Cancel
          </Button>
          <Button onClick={() => void start()} disabled={!preview || items.length === 0 || creating || reading}>
            {creating ? <Loader2 className="animate-spin" aria-hidden /> : <Upload aria-hidden />}
            Import {items.length > 0 ? `${items.length} sticker${items.length === 1 ? "" : "s"}` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
