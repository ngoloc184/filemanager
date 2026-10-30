"use client";

import { useEffect, useState } from "react";
import { ChevronRight, Folder, Home, Loader2, Share2 } from "lucide-react";
import { can } from "@/lib/file-permissions";
import { listFolders } from "@/lib/services/folders";
import { listSharedWithMe, type SharedItem } from "@/lib/services/sharing";
import { getErrorMessage, type Folder as FolderType } from "@/lib/types/database";
import { cn } from "@/lib/utils";

interface FolderPickerProps {
  value: string | null;
  onChange: (folderId: string | null) => void;
  excludeFolderId?: string | null;
  /**
   * Offer My Files (root) as a destination. Off when moving an item the
   * caller does not own: move_file / move_folder only let the owner move
   * an item to My Files.
   */
  allowRoot?: boolean;
}

type PickerFolder = Pick<FolderType, "id" | "name">;

/** Shared folders the caller may add items to (move_file / copy_file need editor). */
function writableSharedFolders(items: SharedItem[]): PickerFolder[] {
  return items
    .filter((item) => item.item_type === "folder" && can(item.role, "rename"))
    .map(({ id, name }) => ({ id, name }));
}

function Node({
  folder,
  depth,
  value,
  onChange,
  excludeFolderId,
}: {
  folder: PickerFolder;
  depth: number;
  value: string | null;
  onChange: (folderId: string | null) => void;
  excludeFolderId?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FolderType[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const excluded = folder.id === excludeFolderId;
  const selected = value === folder.id;

  const toggle = async () => {
    if (excluded) return;
    const next = !expanded;
    setExpanded(next);
    if (next && children === null && !loading) {
      setLoading(true);
      setLoadError(null);
      try {
        setChildren(await listFolders(folder.id));
      } catch (err) {
        setLoadError(getErrorMessage(err));
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm cursor-pointer hover:bg-muted",
          selected && "bg-primary/10 text-primary font-medium",
          excluded && "opacity-40 cursor-not-allowed"
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => {
          if (!excluded) onChange(folder.id);
        }}
      >
        <button
          type="button"
          className="shrink-0 h-4 w-4 flex items-center justify-center text-muted-foreground"
          onClick={(e) => {
            e.stopPropagation();
            void toggle();
          }}
          disabled={excluded}
        >
          {loading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <ChevronRight
              className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-90")}
            />
          )}
        </button>
        <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{folder.name}</span>
      </div>
      {loadError && (
        <p className="text-xs text-destructive pl-8">{loadError}</p>
      )}
      {expanded &&
        children?.map((child) => (
          <Node
            key={child.id}
            folder={child}
            depth={depth + 1}
            value={value}
            onChange={onChange}
            excludeFolderId={excludeFolderId}
          />
        ))}
    </div>
  );
}

export default function FolderPicker({
  value,
  onChange,
  excludeFolderId,
  allowRoot = true,
}: FolderPickerProps) {
  const [rootFolders, setRootFolders] = useState<FolderType[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // My Files only lists the caller's own folders; team folders shared with
  // them are destinations too
  const [sharedFolders, setSharedFolders] = useState<PickerFolder[] | null>(null);
  const [sharedError, setSharedError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listFolders(null)
      .then((data) => {
        if (!cancelled) setRootFolders(data);
      })
      .catch((err) => {
        if (!cancelled) setError(getErrorMessage(err));
      });
    listSharedWithMe()
      .then((data) => {
        if (!cancelled) setSharedFolders(writableSharedFolders(data));
      })
      .catch((err) => {
        if (!cancelled) setSharedError(getErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="max-h-64 overflow-auto rounded-lg border p-2 space-y-0.5">
      <div
        className={cn(
          "flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm cursor-pointer hover:bg-muted",
          allowRoot && value === null && "bg-primary/10 text-primary font-medium",
          !allowRoot && "opacity-40 cursor-not-allowed"
        )}
        title={allowRoot ? undefined : "Only the owner can move this item to My Files"}
        onClick={() => {
          if (allowRoot) onChange(null);
        }}
      >
        <span className="w-4" />
        <Home className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span>My Files (root)</span>
      </div>
      {error && <p className="text-xs text-destructive px-2">{error}</p>}
      {rootFolders === null && !error && (
        <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading folders...
        </div>
      )}
      {rootFolders?.map((folder) => (
        <Node
          key={folder.id}
          folder={folder}
          depth={1}
          value={value}
          onChange={onChange}
          excludeFolderId={excludeFolderId}
        />
      ))}
      {(sharedError || (sharedFolders && sharedFolders.length > 0)) && (
        <div className="flex items-center gap-1.5 px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
          <span className="w-4" />
          <Share2 className="h-3.5 w-3.5 shrink-0" />
          <span>Shared with me</span>
        </div>
      )}
      {sharedError && <p className="text-xs text-destructive px-2">{sharedError}</p>}
      {sharedFolders?.map((folder) => (
        <Node
          key={`shared-${folder.id}`}
          folder={folder}
          depth={1}
          value={value}
          onChange={onChange}
          excludeFolderId={excludeFolderId}
        />
      ))}
    </div>
  );
}
