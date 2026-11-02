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
import { StickerThumb } from "@/components/admin/stickers/sticker-thumb";
import { updateSticker } from "@/lib/services/stickers-admin";
import { STICKER_NAME_MAX, normalizeKeywords, type CustomSticker } from "@/lib/stickers/custom";
import { formatBytes } from "@/lib/utils";
import { getErrorMessage } from "@/lib/types/database";

/** Name and suggestion keywords of one sticker. */
export function StickerEditorDialog({
  sticker,
  onOpenChange,
  onSaved,
}: {
  sticker: CustomSticker;
  onOpenChange: (open: boolean) => void;
  onSaved: (sticker: CustomSticker) => void;
}) {
  const [name, setName] = useState(sticker.name);
  const [keywords, setKeywords] = useState(sticker.keywords.join(", "));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Enter a name");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const saved = await updateSticker(sticker.id, { name: trimmed, keywords: normalizeKeywords(keywords) });
      toast.success("Sticker saved");
      onSaved(saved);
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
          <DialogTitle>Edit sticker</DialogTitle>
          <DialogDescription>The name shows on hover and in search; keywords drive suggestions while typing.</DialogDescription>
        </DialogHeader>
        <form id="sticker-form" onSubmit={save} className="space-y-4" noValidate>
          <div className="flex items-center gap-3">
            <StickerThumb id={sticker.id} alt={sticker.name} className="size-20 shrink-0 rounded-lg border bg-muted/30 p-1" />
            <p className="text-xs text-muted-foreground">
              {sticker.mime.replace("image/", "").toUpperCase()} · {formatBytes(sticker.size_bytes)}
              <span className="mt-0.5 block font-mono">{sticker.id}</span>
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="sticker-name">Name</Label>
            <Input
              id="sticker-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={STICKER_NAME_MAX}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sticker-keywords">Keywords (từ khoá gợi ý)</Label>
            <KeywordsInput id="sticker-keywords" value={keywords} onChange={setKeywords} />
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
          <Button type="submit" form="sticker-form" disabled={saving}>
            {saving && <Loader2 className="animate-spin" aria-hidden />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
