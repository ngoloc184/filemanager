"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { readTextFile } from "@/lib/services/files";
import { createTextFile, saveTextFileVersion } from "@/lib/services/uploads";
import {
  TEXT_EDIT_MAX_BYTES,
  caretPosition,
  ensureTextFileName,
  textByteSize,
} from "@/lib/text-files";
import { getErrorMessage, type FileRow } from "@/lib/types/database";
import { formatBytes } from "@/lib/utils";

export type TextEditorTarget =
  | { mode: "create"; folderId: string | null }
  | { mode: "edit"; file: FileRow };

/**
 * Basic notepad: write a new .txt file in the current folder, or edit a small
 * text file. Edits are saved as a new version, so nothing is overwritten.
 */
export default function TextEditorDialog({
  target,
  userId,
  onOpenChange,
  onSaved,
}: {
  target: TextEditorTarget;
  userId: string;
  onOpenChange: (open: boolean) => void;
  onSaved: (file: FileRow | null) => void | Promise<void>;
}) {
  const editing = target.mode === "edit" ? target.file : null;
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [original, setOriginal] = useState<string | null>(editing ? null : "");
  const [bom, setBom] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [caret, setCaret] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) return;
    let cancelled = false;
    readTextFile(editing)
      .then((content) => {
        if (cancelled) return;
        setText(content.text);
        setOriginal(content.text);
        setBom(content.bom);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(getErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [editing]);

  const loading = original === null && !loadError;
  const dirty = original !== null && (text !== original || (!editing && name.trim() !== ""));
  const bytes = textByteSize(text);
  const tooLarge = bytes > TEXT_EDIT_MAX_BYTES;
  const { line, column } = caretPosition(text, caret);
  const canSave = !loading && !loadError && !saving && !tooLarge && (editing ? text !== original : true);

  const requestClose = () => {
    if (saving) return;
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    onOpenChange(false);
  };

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      if (editing) {
        await saveTextFileVersion(userId, editing, text, bom);
        setOriginal(text);
        toast.success("Saved as a new version");
        await onSaved(null);
      } else {
        const created = await createTextFile(userId, target.mode === "create" ? target.folderId : null, ensureTextFileName(name), text);
        toast.success(`Created "${created.name}"`);
        await onSaved(created);
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const trackCaret = () => setCaret(textareaRef.current?.selectionStart ?? 0);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
    >
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="line-clamp-2">
            {editing ? `Edit ${editing.name}` : "New text file"}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? "Saving creates a new version; earlier versions stay in File details."
              : "Write plain text and save it as a file in this folder."}
          </DialogDescription>
        </DialogHeader>
        {!editing && (
          <div className="space-y-2">
            <Label htmlFor="text-file-name">File name</Label>
            <Input
              id="text-file-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`e.g. Meeting notes (saved as ${ensureTextFileName(name || "Meeting notes")})`}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  textareaRef.current?.focus();
                }
              }}
            />
          </div>
        )}
        <div className="relative">
          {loading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-muted/40">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}
          {loadError ? (
            <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-8 text-center text-sm text-destructive">
              {loadError}
            </p>
          ) : (
            <Textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setCaret(e.target.selectionStart);
              }}
              onSelect={trackCaret}
              onKeyUp={trackCaret}
              onClick={trackCaret}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
                  e.preventDefault();
                  void save();
                }
              }}
              disabled={loading || saving}
              autoFocus={!!editing}
              spellCheck={false}
              aria-label="File content"
              placeholder="Start typing…"
              className="h-[55vh] min-h-48 resize-none font-mono text-[13px] leading-relaxed [field-sizing:fixed]"
            />
          )}
        </div>
        <DialogFooter className="sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
            Ln {line}, Col {column} · {text.length.toLocaleString()} chars · {formatBytes(bytes)}
            {tooLarge && (
              <span className="text-destructive"> · over the {formatBytes(TEXT_EDIT_MAX_BYTES)} limit</span>
            )}
            {editing && original !== null && text !== original && " · unsaved"}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={requestClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void save()} disabled={!canSave}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {saving ? "Saving..." : editing ? "Save" : "Create"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
