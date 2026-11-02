"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useDropzone } from "react-dropzone";
import { format } from "date-fns";
import { Download, Eye, FileText, History, Loader2, Lock, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PreviewDialog } from "@/components/files/file-dialogs";
import { DOC_FILE_KIND_LABELS, frozenFileLabel } from "@/lib/documents/labels";
import type { DocFileKind, DocumentFileLink, DocumentStatus } from "@/lib/documents/types";
import {
  attachDocumentFile,
  detachDocumentFile,
  ensureDocumentFolder,
  logDocumentAccess,
} from "@/lib/services/documents";
import { downloadFile, listVersions, type PreviewableFile } from "@/lib/services/files";
import { createUploadTasks, uploadOne } from "@/lib/services/uploads";
import { getErrorMessage, type FileVersion } from "@/lib/types/database";
import { cn, formatBytes } from "@/lib/utils";

// Files of one document (tệp văn bản). They are ordinary files in the
// uploader's 'Documents' folder linked through document_files, so preview,
// download and versions reuse the file services; downloads are recorded in
// the document's access log first.

const KIND_SHORT: Record<DocFileKind, string> = {
  main: "Main",
  attachment: "Attachment",
  signed: "Signed copy",
  draft: "Draft",
};

const FALLBACK_MIME = "application/octet-stream";

function isPreviewable(mime: string | null): boolean {
  if (!mime) return false;
  return (
    mime.startsWith("image/") ||
    mime.startsWith("video/") ||
    mime.startsWith("audio/") ||
    mime.startsWith("text/") ||
    mime === "application/pdf" ||
    ["application/json", "application/xml", "application/x-yaml"].includes(mime)
  );
}

function asFile(link: DocumentFileLink): PreviewableFile {
  return {
    id: link.file_id,
    name: link.name,
    current_version_id: link.current_version_id,
    mime_type: link.mime_type || FALLBACK_MIME,
    size: link.size,
  };
}

function VersionsDialog({ file, onOpenChange }: { file: DocumentFileLink | null; onOpenChange: (open: boolean) => void }) {
  const [versions, setVersions] = useState<FileVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileId = file?.file_id ?? null;

  useEffect(() => {
    if (!fileId) return;
    let cancelled = false;
    listVersions(fileId)
      .then((rows) => {
        if (!cancelled) setVersions(rows);
      })
      .catch((err) => {
        if (!cancelled) setError(getErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  return (
    <Dialog open={!!file} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Versions</DialogTitle>
          <DialogDescription className="break-all">{file?.name}</DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!error && versions === null && (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading versions" />
          </div>
        )}
        {versions && versions.length === 0 && <p className="text-sm text-muted-foreground">No versions.</p>}
        {versions && versions.length > 0 && (
          <ul className="max-h-80 divide-y overflow-y-auto rounded-lg border">
            {versions.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="font-medium">
                  Version {v.version_no}
                  {v.id === file?.current_version_id && (
                    <Badge variant="secondary" className="ml-2">
                      Current
                    </Badge>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">
                  {formatBytes(v.size)} · {format(new Date(v.created_at), "dd/MM/yyyy HH:mm")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RemoveDialog({
  file,
  onOpenChange,
  onConfirm,
}: {
  file: DocumentFileLink | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (file: DocumentFileLink) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (!file || busy) return;
    setBusy(true);
    try {
      await onConfirm(file);
      onOpenChange(false);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!file} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove file from document</DialogTitle>
          <DialogDescription>
            “{file?.name}” will no longer be part of this document. The file itself stays in your files.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void confirm()} disabled={busy}>
            {busy ? "Removing…" : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DocumentFiles({
  documentId,
  files,
  status,
  canEdit,
  userId,
  onChanged,
}: {
  documentId: string;
  files: DocumentFileLink[];
  status: DocumentStatus;
  canEdit: boolean;
  userId: string;
  onChanged: () => void;
}) {
  const [preview, setPreview] = useState<PreviewableFile | null>(null);
  const [versionsOf, setVersionsOf] = useState<DocumentFileLink | null>(null);
  const [removing, setRemoving] = useState<DocumentFileLink | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // after signing only the clerk adds the signed copy (an action, not this dropzone)
  const canAdd = canEdit && status !== "signed" && status !== "issued";
  const hasMain = useMemo(() => files.some((f) => f.kind === "main"), [files]);

  const upload = useCallback(
    async (accepted: File[]) => {
      if (accepted.length === 0) return;
      setProgress({ done: 0, total: accepted.length });
      let main = hasMain;
      let added = 0;
      try {
        const folderId = await ensureDocumentFolder();
        for (const [index, file] of accepted.entries()) {
          try {
            const [task] = createUploadTasks([file], folderId);
            const row = await uploadOne(userId, task, () => {});
            await attachDocumentFile(documentId, row.id, main ? "attachment" : "main");
            main = true;
            added++;
          } catch (err) {
            toast.error(`${file.name}: ${getErrorMessage(err)}`);
          }
          setProgress({ done: index + 1, total: accepted.length });
        }
      } catch (err) {
        toast.error(getErrorMessage(err));
      } finally {
        setProgress(null);
        if (added > 0) {
          toast.success(added === 1 ? "File added" : `${added} files added`);
          onChanged();
        }
      }
    },
    [documentId, hasMain, onChanged, userId]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: (accepted) => void upload(accepted),
    disabled: !canAdd || progress !== null,
  });

  const download = async (link: DocumentFileLink) => {
    if (downloadingId) return;
    setDownloadingId(link.id);
    try {
      await logDocumentAccess(documentId, "download");
      await downloadFile(asFile(link));
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setDownloadingId(null);
    }
  };

  const remove = async (link: DocumentFileLink) => {
    await detachDocumentFile(documentId, link.file_id);
    toast.success("File removed from the document");
    onChanged();
  };

  if (files.length === 0 && !canAdd) return null;

  return (
    <Card className="print:hidden">
      <CardHeader>
        <h2 className="font-heading text-base font-medium">Files (Tệp đính kèm)</h2>
      </CardHeader>
      <CardContent className="space-y-3">
        {files.length === 0 ? (
          <p className="text-sm text-muted-foreground">No files yet.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {files.map((link) => {
              const canRemove =
                canEdit && !link.frozen && (status !== "signed" || link.kind === "signed");
              return (
                <li key={link.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
                  <div className="flex min-w-0 flex-1 items-start gap-2.5">
                    <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge
                          variant={link.kind === "main" ? "default" : "secondary"}
                          title={DOC_FILE_KIND_LABELS[link.kind]}
                        >
                          {KIND_SHORT[link.kind] ?? link.kind}
                        </Badge>
                        {link.frozen && (
                          <span
                            className="inline-flex items-center text-muted-foreground"
                            title={frozenFileLabel(status)}
                          >
                            <Lock className="size-3.5" aria-hidden="true" />
                            <span className="sr-only">{frozenFileLabel(status)}</span>
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-sm font-medium break-all">{link.name}</p>
                      <p className="text-xs text-muted-foreground">{formatBytes(link.size)}</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5 sm:justify-end">
                    {isPreviewable(link.mime_type) && link.current_version_id && (
                      <Button variant="outline" size="sm" onClick={() => setPreview(asFile(link))}>
                        <Eye aria-hidden="true" />
                        Preview
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void download(link)}
                      disabled={downloadingId !== null || !link.current_version_id}
                    >
                      {downloadingId === link.id ? (
                        <Loader2 className="animate-spin" aria-hidden="true" />
                      ) : (
                        <Download aria-hidden="true" />
                      )}
                      Download
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setVersionsOf(link)}>
                      <History aria-hidden="true" />
                      Versions
                    </Button>
                    {canRemove && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setRemoving(link)}
                      >
                        <Trash2 aria-hidden="true" />
                        Remove
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {canAdd && (
          <div
            {...getRootProps({
              className: cn(
                "flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-4 py-5 text-center text-sm text-muted-foreground transition-colors outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50",
                isDragActive && "border-primary bg-primary/5 text-foreground",
                progress && "cursor-wait opacity-70"
              ),
              "aria-label": "Add file",
            })}
          >
            <input {...getInputProps()} />
            {progress ? (
              <>
                <Loader2 className="size-5 animate-spin" aria-hidden="true" />
                <span role="status">
                  Uploading {Math.min(progress.done + 1, progress.total)} of {progress.total}…
                </span>
              </>
            ) : (
              <>
                <Upload className="size-5" aria-hidden="true" />
                <span className="font-medium text-foreground">Add file</span>
                <span className="text-xs">
                  Drop files here or click to choose. {hasMain ? "They are added as attachments." : "The first one becomes the main file."}
                </span>
              </>
            )}
          </div>
        )}
      </CardContent>

      {preview && (
        <PreviewDialog open onOpenChange={(open) => !open && setPreview(null)} file={preview} hideAiSummary />
      )}
      {/* keyed by file, so each file starts with an empty list */}
      <VersionsDialog key={versionsOf?.id ?? "none"} file={versionsOf} onOpenChange={(open) => !open && setVersionsOf(null)} />
      <RemoveDialog file={removing} onOpenChange={(open) => !open && setRemoving(null)} onConfirm={remove} />
    </Card>
  );
}
