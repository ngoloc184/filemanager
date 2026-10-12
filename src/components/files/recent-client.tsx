"use client";

import { useCallback, useEffect, useState } from "react";
import { format } from "date-fns";
import { toast } from "sonner";
import {
  Clock,
  Download,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PreviewDialog } from "@/components/files/file-dialogs";
import { downloadFile, listRecentFiles } from "@/lib/services/files";
import { getErrorMessage, type FileRow } from "@/lib/types/database";
import { FileTile, fileKind } from "@/components/files/file-tile";
import { cn, ENTER_ANIMATION, formatBytes, staggerDelay } from "@/lib/utils";

export default function RecentClient({
  user,
}: {
  user: { id: string; email?: string };
}) {
  const [files, setFiles] = useState<FileRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<FileRow | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setFiles(await listRecentFiles(30));
    } catch (err) {
      setError(getErrorMessage(err));
      setFiles([]);
    }
  }, []);

  useEffect(() => {
    // initial recent files load
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const handleDownload = async (file: FileRow) => {
    try {
      await downloadFile(file);
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  const loading = files === null && !error;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold">Recent</h2>
        <p className="text-muted-foreground mt-1">
          Files you and collaborators recently updated.
        </p>
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <div
              key={index}
              className="h-14 rounded-xl border bg-muted/40 animate-pulse"
            />
          ))}
        </div>
      ) : error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-8 text-center">
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="outline" className="mt-4" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : files && files.length === 0 ? (
        <div className="rounded-2xl border border-dashed bg-card/70 backdrop-blur flex flex-col items-center justify-center py-16 px-4">
          <Clock className="h-16 w-16 text-muted-foreground/50 mb-4" />
          <h3 className="text-lg font-semibold">No recent files</h3>
          <p className="text-muted-foreground mt-1 text-center">
            Recently updated files will appear here.
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border bg-card/80 backdrop-blur shadow-sm divide-y overflow-hidden">
          {(files ?? []).map((file, index) => (
            <div
              key={file.id}
              className={cn("flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors hover:bg-muted/50", ENTER_ANIMATION)}
              style={staggerDelay(index)}
              onClick={() => setPreviewFile(file)}
            >
              <FileTile kind={fileKind(file.mime_type, file.name)} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{file.name}</p>
                <p className="text-xs text-muted-foreground">
                  {formatBytes(file.size)} • {file.mime_type} •{" "}
                  {format(new Date(file.updated_at), "MMM d, yyyy HH:mm")}
                </p>
              </div>
              {file.owner_id !== user.id && (
                <Badge variant="outline" className="shrink-0">
                  Shared
                </Badge>
              )}
              <div onClick={(e) => e.stopPropagation()}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Download ${file.name}`}
                  onClick={() => void handleDownload(file)}
                >
                  <Download className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {previewFile && (
        <PreviewDialog
          open
          onOpenChange={(open) => {
            if (!open) setPreviewFile(null);
          }}
          file={previewFile}
        />
      )}
    </div>
  );
}
