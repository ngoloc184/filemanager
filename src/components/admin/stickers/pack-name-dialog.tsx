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
import { packNameProblem } from "@/components/admin/stickers/types";
import { createPack } from "@/lib/services/stickers-admin";
import { PACK_NAME_MAX, type StickerPack } from "@/lib/stickers/custom";
import { getErrorMessage } from "@/lib/types/database";

/** Creates an empty pack. */
export function NewPackDialog({
  onOpenChange,
  onCreated,
}: {
  onOpenChange: (open: boolean) => void;
  onCreated: (pack: StickerPack) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const problem = packNameProblem(name);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const pack = await createPack(name.trim());
      toast.success(`Pack “${pack.name}” created`);
      onCreated(pack);
      onOpenChange(false);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !saving && onOpenChange(open)}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New sticker pack</DialogTitle>
          <DialogDescription>Packs show as tabs in everyone&apos;s sticker picker, in the order listed here.</DialogDescription>
        </DialogHeader>
        <form id="pack-form" onSubmit={save} className="space-y-2" noValidate>
          <Label htmlFor="pack-name">Name</Label>
          <Input
            id="pack-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Mèo Vui"
            maxLength={PACK_NAME_MAX}
            autoFocus
            aria-invalid={Boolean(error)}
          />
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
          <Button type="submit" form="pack-form" disabled={saving}>
            {saving && <Loader2 className="animate-spin" aria-hidden />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
