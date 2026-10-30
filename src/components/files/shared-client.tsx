"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { format } from "date-fns";
import { Download, Folder as FolderIcon, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  listSharedWithMe,
  type SharedItem,
} from "@/lib/services/sharing";
import { downloadFile } from "@/lib/services/files";
import { getErrorMessage } from "@/lib/types/database";
import { FileTile, fileKind } from "@/components/files/file-tile";
import { cn, ENTER_ANIMATION, formatBytes, staggerDelay } from "@/lib/utils";
import { PreviewDialog } from "@/components/files/file-dialogs";
import CommentsDialog, { type CommentsDialogTarget } from "@/components/files/comments-dialog";

const roleBadge: Record<string, "default" | "secondary" | "outline"> = {
  viewer: "secondary",
  editor: "default",
  admin: "default",
};

export default function SharedClient({ userId }: { userId: string }) {
  const router = useRouter();
  const [items, setItems] = useState<SharedItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<SharedItem | null>(null);
  const [commentsTarget, setCommentsTarget] = useState<CommentsDialogTarget | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await listSharedWithMe());
    } catch (err) {
      setError(getErrorMessage(err));
      setItems([]);
    }
  }, []);

  useEffect(() => {
    // initial shared-with-me listing
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const handleDownload = async (item: SharedItem) => {
    try {
      await downloadFile({
        id: item.id,
        name: item.name,
        current_version_id: item.current_version_id,
      });
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  const openItem = (item: SharedItem) => {
    if (item.item_type === "folder") {
      router.push(`/dashboard?folder=${item.id}`);
    } else {
      setPreview(item);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold">Shared with me</h2>
        <p className="text-muted-foreground mt-1">
          Files and folders other people have shared with you.
        </p>
      </div>

      {items === null && !error ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-14 rounded-xl border bg-muted/40 animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-8 text-center">
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="outline" className="mt-4" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : items && items.length === 0 ? (
        <div className="rounded-2xl border border-dashed bg-card/70 backdrop-blur flex flex-col items-center justify-center py-16 px-4">
          <FolderIcon className="h-16 w-16 text-muted-foreground/50 mb-4" />
          <h3 className="text-lg font-semibold">Nothing shared with you yet</h3>
          <p className="text-muted-foreground mt-1 text-center">
            When someone shares a file or folder with you, it will appear here.
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border bg-card/80 backdrop-blur shadow-sm divide-y overflow-hidden">
          {items?.map((item, index) => (
            <div
              key={`${item.item_type}-${item.id}`}
              className={cn("flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors hover:bg-muted/50", ENTER_ANIMATION)}
              style={staggerDelay(index)}
              onClick={() => openItem(item)}
            >
              {item.item_type === "folder" ? (
                <FileTile kind="folder" />
              ) : (
                <FileTile kind={fileKind(item.mime_type, item.name)} />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{item.name}</p>
                <p className="text-xs text-muted-foreground">
                  {item.item_type === "folder"
                    ? "Folder"
                    : formatBytes(item.size ?? 0)}
                  {` • from ${item.owner_email} • `}
                  {format(new Date(item.shared_at), "MMM d, yyyy")}
                </p>
              </div>
              <Badge variant={roleBadge[item.role] ?? "outline"} className="shrink-0 capitalize">
                {item.role}
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 shrink-0"
                onClick={(e) => {
                  e.stopPropagation();
                  setCommentsTarget({ kind: item.item_type, id: item.id, name: item.name, role: item.role });
                }}
                aria-label={`Comments on ${item.name}`}
              >
                <MessageSquare className="h-4 w-4" />
              </Button>
              {item.item_type === "file" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 shrink-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleDownload(item);
                  }}
                  aria-label={`Download ${item.name}`}
                >
                  <Download className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {commentsTarget && (
        <CommentsDialog
          key={`${commentsTarget.kind}-${commentsTarget.id}`}
          target={commentsTarget}
          currentUserId={userId}
          onOpenChange={(open) => {
            if (!open) setCommentsTarget(null);
          }}
        />
      )}
      {preview && (
        <PreviewDialog
          open
          onOpenChange={(open) => {
            if (!open) setPreview(null);
          }}
          file={{
            id: preview.id,
            name: preview.name,
            current_version_id: preview.current_version_id,
            mime_type: preview.mime_type ?? "application/octet-stream",
            size: preview.size ?? 0,
          }}
        />
      )}
    </div>
  );
}
