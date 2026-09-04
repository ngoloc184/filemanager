"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "react-hot-toast";
import { format } from "date-fns";
import {
  File,
  Folder as FolderIcon,
  Loader2,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  emptyTrash,
  listTrash,
  permanentDeleteItem,
  restoreTrashItem,
  type TrashItem,
} from "@/lib/services/trash";
import { getErrorMessage } from "@/lib/types/database";
import { formatBytes } from "@/lib/utils";

export default function TrashClient() {
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmItem, setConfirmItem] = useState<TrashItem | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [emptying, setEmptying] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await listTrash());
    } catch (err) {
      setError(getErrorMessage(err));
      setItems([]);
    }
  }, []);

  useEffect(() => {
    // initial trash listing
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const handleRestore = async (item: TrashItem) => {
    setBusyId(item.id);
    try {
      await restoreTrashItem(item);
      toast.success(`Restored "${item.name}"`);
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const handlePermanentDelete = async (item: TrashItem) => {
    setBusyId(item.id);
    try {
      await permanentDeleteItem(item);
      toast.success(`Permanently deleted "${item.name}"`);
      setConfirmItem(null);
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleEmpty = async () => {
    setEmptying(true);
    try {
      const result = await emptyTrash();
      toast.success(
        `Trash emptied (${result.files_deleted} file${result.files_deleted === 1 ? "" : "s"}, ${result.folders_deleted} folder${result.folders_deleted === 1 ? "" : "s"})`
      );
      setConfirmEmpty(false);
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setEmptying(false);
    }
  };

  const loading = items === null && !error;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Trash</h2>
          <p className="text-muted-foreground mt-1">
            Items in trash can be restored or permanently deleted.
          </p>
        </div>
        {items !== null && items.length > 0 && (
          <Button variant="destructive" onClick={() => setConfirmEmpty(true)}>
            <Trash2 className="h-4 w-4 mr-2" />
            Empty trash
          </Button>
        )}
      </div>

      {loading ? (
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
        <div className="rounded-xl border bg-white flex flex-col items-center justify-center py-16 px-4">
          <Trash2 className="h-16 w-16 text-muted-foreground/50 mb-4" />
          <h3 className="text-lg font-semibold">Trash is empty</h3>
          <p className="text-muted-foreground mt-1 text-center">
            Deleted files and folders will appear here.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border bg-white divide-y">
          {items?.map((item) => (
            <div key={`${item.item_type}-${item.id}`} className="flex items-center gap-3 px-4 py-3">
              {item.item_type === "folder" ? (
                <FolderIcon className="h-5 w-5 text-primary shrink-0" />
              ) : (
                <File className="h-5 w-5 text-muted-foreground shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{item.name}</p>
                <p className="text-xs text-muted-foreground">
                  {item.item_type === "folder" ? "Folder" : formatBytes(item.size ?? 0)}
                  {" • deleted "}
                  {format(new Date(item.deleted_at), "MMM d, yyyy HH:mm")}
                  {item.location ? ` • from "${item.location}"` : ""}
                </p>
              </div>
              <Badge variant="outline" className="shrink-0 capitalize">
                {item.item_type}
              </Badge>
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleRestore(item)}
                  disabled={busyId === item.id}
                >
                  {busyId === item.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RotateCcw className="h-4 w-4 mr-2" />
                  )}
                  Restore
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={() => setConfirmItem(item)}
                  disabled={busyId === item.id}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {confirmItem && (
        <Dialog open onOpenChange={(open) => !open && setConfirmItem(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete forever</DialogTitle>
              <DialogDescription>
                Permanently delete &quot;{confirmItem.name}&quot;? This cannot be
                undone and the file data will be removed from storage.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmItem(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => void handlePermanentDelete(confirmItem)}
                disabled={busyId === confirmItem.id}
              >
                {busyId === confirmItem.id ? "Deleting..." : "Delete forever"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      <Dialog open={confirmEmpty} onOpenChange={setConfirmEmpty}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Empty trash</DialogTitle>
            <DialogDescription>
              Permanently delete everything in the trash? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmEmpty(false)} disabled={emptying}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void handleEmpty()} disabled={emptying}>
              {emptying ? "Emptying..." : "Empty trash"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
