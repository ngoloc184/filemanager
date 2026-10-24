"use client";

// Files in chat messages: the file card in a bubble and "Send from My Files".

import { useEffect, useState } from "react";
import { ArrowLeft, Download, Eye, Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { FileTile, fileKind } from "@/components/files/file-tile";
import { searchMyFiles, type ChatMessage } from "@/lib/services/chat";
import { downloadFile, type PreviewableFile } from "@/lib/services/files";
import { getErrorMessage, type FileRow } from "@/lib/types/database";
import { cn, formatBytes } from "@/lib/utils";

export const iconButton = "rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50";

export function FileBubble({ message, mine, onPreview }: { message: ChatMessage; mine: boolean; onPreview: (f: PreviewableFile) => void }) {
  const file: PreviewableFile | null =
    message.file_available && message.file_id
      ? {
          id: message.file_id,
          name: message.file_name ?? "file",
          current_version_id: message.file_version_id,
          mime_type: message.file_mime ?? "application/octet-stream",
          size: message.file_size ?? 0,
        }
      : null;
  return (
    <div className={cn("flex w-60 max-w-full items-center gap-2.5 rounded-xl border p-2", mine ? "border-white/20 bg-white/10" : "bg-background/70")}>
      <FileTile kind={fileKind(message.file_mime, message.file_name ?? "")} size="sm" className={mine ? "bg-white/15 text-white ring-white/25" : undefined} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium" title={message.file_name ?? ""}>
          {message.file_name}
        </p>
        <p className={cn("text-[11px]", mine ? "text-white/70" : "text-muted-foreground")}>{file ? formatBytes(file.size) : "No longer available"}</p>
      </div>
      {file && (
        <div className="flex shrink-0">
          <button type="button" onClick={() => onPreview(file)} className={cn("rounded-md p-1", mine ? "hover:bg-white/15" : "hover:bg-muted")} aria-label={`Preview ${file.name}`}>
            <Eye className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => downloadFile(file).catch((err) => toast.error(getErrorMessage(err)))}
            className={cn("rounded-md p-1", mine ? "hover:bg-white/15" : "hover:bg-muted")}
            aria-label={`Download ${file.name}`}
          >
            <Download className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

export function FilePicker({ userId, onPick, onBack }: { userId: string; onPick: (f: FileRow) => Promise<void>; onBack: () => void }) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<FileRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      searchMyFiles(userId, query)
        .then((rows) => !cancelled && setFiles(rows))
        .catch(() => !cancelled && setFiles([]));
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [userId, query]);

  return (
    <>
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <button type="button" onClick={onBack} className={iconButton} aria-label="Back to the conversation">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <p className="text-sm font-semibold">Send a file</p>
      </div>
      <div className="border-b p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your files..."
            autoFocus
            className="h-9 w-full rounded-lg border bg-background/60 pl-9 pr-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">Everyone in the conversation gets view access to the file you send.</p>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {files === null ? (
          <div className="flex h-24 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : files.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">No files found.</p>
        ) : (
          files.map((f) => (
            <button
              key={f.id}
              type="button"
              disabled={busy !== null}
              onClick={async () => {
                setBusy(f.id);
                try {
                  await onPick(f);
                } catch (err) {
                  toast.error(getErrorMessage(err));
                } finally {
                  setBusy(null);
                }
              }}
              className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-muted disabled:opacity-60"
            >
              <FileTile kind={fileKind(f.mime_type, f.name)} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{f.name}</p>
                <p className="text-xs text-muted-foreground">{formatBytes(f.size)}</p>
              </div>
              {busy === f.id && <Loader2 className="h-4 w-4 animate-spin" />}
            </button>
          ))
        )}
      </div>
    </>
  );
}
