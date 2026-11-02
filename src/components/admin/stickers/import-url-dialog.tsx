"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
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
import { KeywordsInput } from "@/components/admin/stickers/keywords-input";
import { importStickerFromUrl } from "@/lib/services/stickers-admin";
import { STICKER_NAME_MAX, normalizeKeywords, type CustomSticker } from "@/lib/stickers/custom";
import { imageUrlProblem } from "@/lib/stickers/zip-import";
import { getErrorMessage } from "@/lib/types/database";

/** Adds one sticker that the server downloads from an image address. */
export function ImportUrlDialog({
  packId,
  packName,
  onOpenChange,
  onImported,
}: {
  packId: string;
  packName: string;
  onOpenChange: (open: boolean) => void;
  onImported: (sticker: CustomSticker) => void;
}) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [keywords, setKeywords] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const problem = imageUrlProblem(url);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const sticker = await importStickerFromUrl(packId, url.trim(), {
        ...(name.trim() ? { name: name.trim() } : {}),
        keywords: normalizeKeywords(keywords),
      });
      toast.success(`Added “${sticker.name}”`);
      onImported(sticker);
      onOpenChange(false);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !saving && onOpenChange(open)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a sticker from a URL</DialogTitle>
          <DialogDescription>
            The server downloads the image into “{packName}”. PNG, WebP, GIF or JPEG, up to 2 MB, over https.
          </DialogDescription>
        </DialogHeader>
        <form id="url-form" onSubmit={save} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="url-address">Image URL</Label>
            <Input
              id="url-address"
              type="url"
              inputMode="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/sticker.webp"
              autoFocus
              aria-invalid={Boolean(error)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="url-name">Name (optional)</Label>
            <Input
              id="url-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Mèo cười"
              maxLength={STICKER_NAME_MAX}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="url-keywords">Keywords (từ khoá gợi ý)</Label>
            <KeywordsInput id="url-keywords" value={keywords} onChange={setKeywords} />
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="url-form" disabled={saving}>
            {saving && <Loader2 className="animate-spin" aria-hidden />}
            {saving ? "Downloading…" : "Add sticker"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
