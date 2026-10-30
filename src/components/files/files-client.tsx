"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ComponentType,
  type ReactNode,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useDropzone } from "react-dropzone";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { format } from "date-fns";
import {
  CheckSquare,
  ChevronRight,
  Download,
  Eye,
  File,
  FilePen,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  Grid3x3,
  Info,
  List,
  Loader2,
  Copy,
  MessageSquare,
  FolderInput,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Share2,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  createFolder,
  getFolderPath,
  moveFolder,
  renameFolder,
  softDeleteFolder,
} from "@/lib/services/folders";
import {
  copyFile,
  deleteVersion,
  downloadFile,
  FOLDER_LISTING_LIMIT,
  getFile,
  listFolderItems,
  moveFile,
  renameFile,
  softDeleteFile,
  toggleFileVisibility,
} from "@/lib/services/files";
import {
  createUploadTasks,
  uploadNewVersion,
  uploadOne,
  type UploadTask,
} from "@/lib/services/uploads";
import {
  getErrorMessage,
  type FileRow,
  type FileVersion,
  type Folder,
  type FolderAncestor,
} from "@/lib/types/database";
import { cn, ENTER_ANIMATION, formatBytes, staggerDelay } from "@/lib/utils";
import UploadPanel from "@/components/files/upload-panel";
import { openAiSummary } from "@/components/files/ai-summary-dialog";
import { FileTile, fileKind } from "@/components/files/file-tile";
import { FILES_COMMAND_EVENT, type FilesCommand } from "@/components/navigation";
import ShareDialog from "@/components/files/share-dialog";
import TextEditorDialog, { type TextEditorTarget } from "@/components/files/text-editor-dialog";
import { isEditableTextFile } from "@/lib/text-files";
import { can, roleOf } from "@/lib/file-permissions";
import CommentsDialog, { type CommentsDialogTarget } from "@/components/files/comments-dialog";
import { countComments } from "@/lib/services/comments";
import {
  DeleteDialog,
  DetailsDialog,
  MoveCopyDialog,
  NewFolderDialog,
  PreviewDialog,
  RenameDialog,
} from "@/components/files/file-dialogs";

type RowTarget = { kind: "folder" | "file"; id: string; name: string };

/** Extra buttons for one row of the versions list in DetailsDialog. */
type VersionActions = (version: FileVersion, reloadVersions: () => Promise<void>) => ReactNode;

/**
 * DetailsDialog with its `versionActions` slot. A component accepts props it
 * does not use, so this is a plain (widening) assignment, not a cast; it keeps
 * this file compiling whether or not file-dialogs.tsx already declares the prop.
 */
const DetailsDialogWithVersionActions: ComponentType<
  ComponentProps<typeof DetailsDialog> & { versionActions?: VersionActions }
> = DetailsDialog;

const TRUNCATED_LIMIT_LABEL = FOLDER_LISTING_LIMIT.toLocaleString("en-US");

export default function FilesClient({
  user,
}: {
  user: { id: string; email?: string };
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const folderId = searchParams.get("folder");

  const [folders, setFolders] = useState<Folder[]>([]);
  const [files, setFiles] = useState<FileRow[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [ancestors, setAncestors] = useState<FolderAncestor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [view, setView] = useState<"list" | "grid">("list");

  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<RowTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RowTarget | null>(null);
  const [moveTarget, setMoveTarget] = useState<RowTarget | null>(null);
  const [copyTarget, setCopyTarget] = useState<FileRow | null>(null);
  const [shareTarget, setShareTarget] = useState<RowTarget | null>(null);
  const [detailsFile, setDetailsFile] = useState<FileRow | null>(null);
  const [previewFile, setPreviewFile] = useState<FileRow | null>(null);
  const [editorTarget, setEditorTarget] = useState<TextEditorTarget | null>(null);
  const [commentsTarget, setCommentsTarget] = useState<CommentsDialogTarget | null>(null);
  const [commentCounts, setCommentCounts] = useState<Map<string, number>>(new Map());

  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const [panelOpen, setPanelOpen] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const versionInputRef = useRef<HTMLInputElement>(null);
  const versionTargetRef = useRef<FileRow | null>(null);

  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(new Set());
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [bulkMoveOpen, setBulkMoveOpen] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  useEffect(() => {
    // one-time hydration of the persisted view preference (external store)
    const saved = window.localStorage.getItem("fm-view");
    if (saved === "grid" || saved === "list")
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setView(saved);
  }, []);

  const changeView = (next: "list" | "grid") => {
    setView(next);
    window.localStorage.setItem("fm-view", next);
  };

  // Monotonic id of the latest load; responses from older loads are dropped so
  // quick folder navigation never shows another folder's contents.
  const loadRequestId = useRef(0);
  // Tracks the folder currently on screen for callbacks that outlive a render
  // (e.g. uploads that finish after the user navigated elsewhere).
  const currentFolderRef = useRef(folderId);
  useEffect(() => {
    currentFolderRef.current = folderId;
  }, [folderId]);

  const load = useCallback(async (fid: string | null, silent = false) => {
    const requestId = ++loadRequestId.current;
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [listing, ancestorList] = await Promise.all([
        listFolderItems(fid),
        fid
          ? getFolderPath(fid).catch((): FolderAncestor[] => [])
          : Promise.resolve<FolderAncestor[]>([]),
      ]);
      if (requestId !== loadRequestId.current) return;
      const { folders: folderList, files: fileList } = listing;
      setFolders(folderList);
      setFiles(fileList);
      setTruncated(listing.truncated);
      setAncestors(ancestorList);
      // counts are a nice-to-have: load them after the listing, never block it
      void countComments(
        fileList.map((file) => file.id),
        folderList.map((folder) => folder.id)
      ).then((counts) => {
        if (requestId === loadRequestId.current) setCommentCounts(counts);
      });
    } catch (err) {
      if (requestId !== loadRequestId.current) return;
      setError(getErrorMessage(err));
    } finally {
      if (requestId === loadRequestId.current) setLoading(false);
    }
  }, []);

  /** Silently reloads the listing if `destFolderId` is the folder on screen. */
  const reloadIfShowing = useCallback(
    (destFolderId: string | null) => {
      const current = currentFolderRef.current;
      if (destFolderId === current) void load(current, true);
    },
    [load]
  );

  useEffect(() => {
    // data fetching for the current folder (client-side navigation)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(folderId);
  }, [folderId, load]);

  useEffect(() => {
    // clear selection when navigating to another folder
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedFolders(new Set());
    setSelectedFiles(new Set());
  }, [folderId]);

  // Commands from the ⌘K palette (same page) or a ?intent= redirect.
  useEffect(() => {
    const onCommand = (event: Event) => {
      const command = (event as CustomEvent<FilesCommand>).detail;
      if (command === "upload") fileInputRef.current?.click();
      if (command === "new-folder") setNewFolderOpen(true);
      if (command === "new-text-file") setEditorTarget({ mode: "create", folderId: currentFolderRef.current });
    };
    window.addEventListener(FILES_COMMAND_EVENT, onCommand);
    return () => window.removeEventListener(FILES_COMMAND_EVENT, onCommand);
  }, []);

  const intent = searchParams.get("intent");
  useEffect(() => {
    if (!intent) return;
    // one-shot intent from the command palette on another page
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (intent === "new-folder") setNewFolderOpen(true);
    if (intent === "new-text-file") setEditorTarget({ mode: "create", folderId });
    if (intent === "upload") toast("Drop files anywhere, or press Upload to choose files");
    router.replace(folderId ? `/dashboard?folder=${folderId}` : "/dashboard");
  }, [intent, folderId, router]);

  // ?file=<id> (e.g. "Open file" in the assistant): preview that file once.
  // Access is enforced by row-level security when the file is fetched.
  const fileParam = searchParams.get("file");
  useEffect(() => {
    if (!fileParam || loading) return;
    const clearParam = () =>
      router.replace(folderId ? `/dashboard?folder=${folderId}` : "/dashboard");
    const local = files.find((file) => file.id === fileParam);
    if (local) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPreviewFile(local);
      clearParam();
      return;
    }
    let cancelled = false;
    getFile(fileParam)
      .then((file) => {
        if (cancelled) return;
        if (file.deleted_at) toast.error("This file is in the trash.");
        else setPreviewFile(file);
      })
      .catch(() => {
        if (!cancelled) toast.error("This file could not be opened or you no longer have access.");
      })
      .finally(() => {
        if (!cancelled) clearParam();
      });
    return () => {
      cancelled = true;
    };
  }, [fileParam, loading, files, folderId, router]);

  const navigateTo = (fid: string | null) => {
    setFilter("");
    router.replace(fid ? `/dashboard?folder=${fid}` : "/dashboard");
  };

  const updateTask = (localId: string, patch: Partial<UploadTask>) => {
    setTasks((prev) =>
      prev.map((task) => (task.localId === localId ? { ...task, ...patch } : task))
    );
  };

  const startUpload = useCallback(
    async (selected: File[], destFolderId: string | null) => {
      if (selected.length === 0) return;
      const newTasks = createUploadTasks(selected, destFolderId);
      setTasks((prev) => [...prev, ...newTasks]);
      setPanelOpen(true);

      let anySuccess = false;
      for (const task of newTasks) {
        try {
          await uploadOne(
            user.id,
            task,
            (status, taskError) =>
              updateTask(task.localId, { status, error: taskError }),
            (message) => toast(message)
          );
          anySuccess = true;
        } catch {
          // task already marked failed with cleanup
        }
      }
      if (anySuccess) reloadIfShowing(destFolderId);
    },
    [user.id, reloadIfShowing]
  );

  const retryTask = async (localId: string) => {
    const task = tasks.find((item) => item.localId === localId);
    if (!task) return;
    updateTask(localId, { status: "pending", error: undefined });
    try {
      await uploadOne(
        user.id,
        task,
        (status, taskError) =>
          updateTask(localId, { status, error: taskError }),
        (message) => toast(message)
      );
      reloadIfShowing(task.folderId);
    } catch {
      // already marked failed
    }
  };

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop: (accepted) => void startUpload(accepted, folderId),
    noClick: true,
    noKeyboard: true,
  });

  const handleCreateFolder = async (name: string, comment: string | null) => {
    await createFolder(folderId, name, comment);
    toast.success("Folder created");
    await load(folderId, true);
  };

  const handleRename = async (name: string) => {
    if (!renameTarget) return;
    if (renameTarget.kind === "folder") {
      await renameFolder(renameTarget.id, name);
    } else {
      await renameFile(renameTarget.id, name);
    }
    toast.success("Renamed");
    await load(folderId, true);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    if (deleteTarget.kind === "folder") {
      await softDeleteFolder(deleteTarget.id);
    } else {
      await softDeleteFile(deleteTarget.id);
    }
    toast.success("Moved to trash");
    await load(folderId, true);
  };

  const handleMove = async (dest: string | null) => {
    if (!moveTarget) return;
    if (moveTarget.kind === "folder") {
      await moveFolder(moveTarget.id, dest);
    } else {
      await moveFile(moveTarget.id, dest);
    }
    toast.success(dest ? "Moved" : "Moved to My Files");
    await load(folderId, true);
  };

  const handleCopy = async (dest: string | null) => {
    if (!copyTarget) return;
    await copyFile(copyTarget, dest, copyTarget.name, user.id);
    toast.success("Copied");
    reloadIfShowing(dest);
  };

  const handleDownload = async (file: FileRow) => {
    try {
      await downloadFile(file);
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  const handleToggleVisibility = async (file: FileRow) => {
    try {
      const updated = { ...(await toggleFileVisibility(file)), my_role: file.my_role };
      setFiles((prev) =>
        prev.map((item) => (item.id === updated.id ? updated : item))
      );
      setDetailsFile(updated);
      toast.success(updated.is_public ? "File is now public" : "File is now private");
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  const handleRefreshFile = async (fileId: string) => {
    const fresh = await getFile(fileId);
    // a table read has no my_role: keep the role the listing returned
    const withRole = (item: FileRow): FileRow => ({ ...fresh, my_role: item.my_role });
    setFiles((prev) =>
      prev.map((item) => (item.id === fresh.id ? withRole(item) : item))
    );
    setDetailsFile((prev) => (prev && prev.id === fresh.id ? withRole(prev) : prev));
  };

  const handleUploadNewVersion = async (selected: File) => {
    const target = versionTargetRef.current;
    versionTargetRef.current = null;
    if (!target) return;
    try {
      await uploadNewVersion(user.id, target.id, selected);
      toast.success("New version uploaded");
      await load(folderId, true);
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  const openFolderComments = (folder: Folder) =>
    setCommentsTarget({
      kind: "folder",
      id: folder.id,
      name: folder.name,
      role: roleOf(folder, user.id),
      description: folder.comment,
    });

  const openFileComments = (file: FileRow) =>
    setCommentsTarget({
      kind: "file",
      id: file.id,
      name: file.name,
      role: roleOf(file, user.id),
    });

  const commentBadge = (id: string, onOpen: () => void) => {
    const count = commentCounts.get(id) ?? 0;
    if (count === 0) return null;
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
        className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label={`${count} comment${count === 1 ? "" : "s"}`}
      >
        <MessageSquare className="h-3.5 w-3.5" />
        {count}
      </button>
    );
  };

  const selectedCount = selectedFolders.size + selectedFiles.size;
  // only owners may move an item to My Files (move_file / move_folder)
  const ownsItem = (kind: "folder" | "file", id: string) => {
    const item = kind === "folder" ? folders.find((f) => f.id === id) : files.find((f) => f.id === id);
    return item ? roleOf(item, user.id) === "owner" : false;
  };
  const ownsSelection =
    Array.from(selectedFolders).every((id) => ownsItem("folder", id)) &&
    Array.from(selectedFiles).every((id) => ownsItem("file", id));

  const clearSelection = () => {
    setSelectedFolders(new Set());
    setSelectedFiles(new Set());
  };

  const toggleSelectionMode = () => {
    setSelectionMode((prev) => !prev);
    clearSelection();
  };

  const toggleFolderSelection = (id: string) => {
    setSelectedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleFileSelection = (id: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** Runs `action` for every selected item in parallel; returns the failure count. */
  const runOnSelection = async (
    folderAction: (id: string) => Promise<void>,
    fileAction: (id: string) => Promise<void>
  ): Promise<number> => {
    const results = await Promise.allSettled([
      ...Array.from(selectedFolders, (id) => folderAction(id)),
      ...Array.from(selectedFiles, (id) => fileAction(id)),
    ]);
    return results.filter((result) => result.status === "rejected").length;
  };

  const handleBulkMove = async (dest: string | null) => {
    const failures = await runOnSelection(
      (id) => moveFolder(id, dest),
      (id) => moveFile(id, dest)
    );
    if (failures === 0) toast.success("Moved");
    else toast.error(`Failed to move ${failures} item(s)`);
    clearSelection();
    await load(folderId, true);
  };

  const handleBulkDelete = async () => {
    const failures = await runOnSelection(softDeleteFolder, softDeleteFile);
    if (failures === 0) toast.success("Moved to trash");
    else toast.error(`Failed to delete ${failures} item(s)`);
    clearSelection();
    await load(folderId, true);
  };

  const handleBulkDownload = async () => {
    const fileList = files.filter((file) => selectedFiles.has(file.id));
    for (const file of fileList) {
      try {
        await downloadFile(file);
        await new Promise((resolve) => setTimeout(resolve, 300));
      } catch (err) {
        toast.error(getErrorMessage(err));
      }
    }
  };

  const query = filter.trim().toLowerCase();
  const visibleFolders = folders.filter(
    (folder) => !query || folder.name.toLowerCase().includes(query)
  );
  const visibleFiles = files.filter(
    (file) => !query || file.name.toLowerCase().includes(query)
  );
  const isEmpty = visibleFolders.length === 0 && visibleFiles.length === 0;

  const folderMenu = (folder: Folder) => {
    const role = roleOf(folder, user.id);
    const target: RowTarget = { kind: "folder", id: folder.id, name: folder.name };
    return (
      // stop clicks inside the (portaled) menu from bubbling to the row handler
      <div onClick={(e) => e.stopPropagation()}>
        <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              className="inline-flex items-center justify-center h-8 w-8 rounded-md text-sm hover:bg-muted hover:text-foreground"
              onClick={(e) => e.stopPropagation()}
              aria-label={`Actions for ${folder.name}`}
            />
          }
        >
          <MoreHorizontal className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => navigateTo(folder.id)}>
            <FolderOpen className="h-4 w-4 mr-2" />
            Open
          </DropdownMenuItem>
          {can(role, "comment") && (
            <DropdownMenuItem onClick={() => openFolderComments(folder)}>
              <MessageSquare className="h-4 w-4 mr-2" />
              Comments
            </DropdownMenuItem>
          )}
          {can(role, "rename") && (
            <DropdownMenuItem onClick={() => setRenameTarget(target)}>
              <Pencil className="h-4 w-4 mr-2" />
              Rename
            </DropdownMenuItem>
          )}
          {can(role, "move") && (
            <DropdownMenuItem onClick={() => setMoveTarget(target)}>
              <FolderInput className="h-4 w-4 mr-2" />
              Move
            </DropdownMenuItem>
          )}
          {can(role, "share") && (
            <DropdownMenuItem onClick={() => setShareTarget(target)}>
              <Share2 className="h-4 w-4 mr-2" />
              Share
            </DropdownMenuItem>
          )}
          {can(role, "delete") && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => setDeleteTarget(target)}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  };

  const fileMenu = (file: FileRow) => {
    const role = roleOf(file, user.id);
    const target: RowTarget = { kind: "file", id: file.id, name: file.name };
    const canEditText = can(role, "edit_text") && isEditableTextFile(file);
    const hasEditActions =
      can(role, "rename") || can(role, "move") || can(role, "share") ||
      canEditText || can(role, "upload_version");
    return (
      // stop clicks inside the (portaled) menu from bubbling to the row handler
      <div onClick={(e) => e.stopPropagation()}>
        <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              className="inline-flex items-center justify-center h-8 w-8 rounded-md text-sm hover:bg-muted hover:text-foreground"
              onClick={(e) => e.stopPropagation()}
              aria-label={`Actions for ${file.name}`}
            />
          }
        >
          <MoreHorizontal className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setPreviewFile(file)}>
            <Eye className="h-4 w-4 mr-2" />
            Preview
          </DropdownMenuItem>
          {can(role, "download") && (
            <DropdownMenuItem onClick={() => void handleDownload(file)}>
              <Download className="h-4 w-4 mr-2" />
              Download
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onClick={() => openAiSummary({ id: file.id, name: file.name, mimeType: file.mime_type })}
          >
            <Sparkles className="h-4 w-4 mr-2 text-primary" />
            AI tóm tắt
          </DropdownMenuItem>
          {can(role, "details") && (
            <DropdownMenuItem onClick={() => setDetailsFile(file)}>
              <Info className="h-4 w-4 mr-2" />
              Details
            </DropdownMenuItem>
          )}
          {can(role, "comment") && (
            <DropdownMenuItem onClick={() => openFileComments(file)}>
              <MessageSquare className="h-4 w-4 mr-2" />
              Comments
            </DropdownMenuItem>
          )}
          {can(role, "download") && (
            <DropdownMenuItem onClick={() => setCopyTarget(file)}>
              <Copy className="h-4 w-4 mr-2" />
              Copy to...
            </DropdownMenuItem>
          )}
          {hasEditActions && <DropdownMenuSeparator />}
          {can(role, "rename") && (
            <DropdownMenuItem onClick={() => setRenameTarget(target)}>
              <Pencil className="h-4 w-4 mr-2" />
              Rename
            </DropdownMenuItem>
          )}
          {can(role, "move") && (
            <DropdownMenuItem onClick={() => setMoveTarget(target)}>
              <FolderInput className="h-4 w-4 mr-2" />
              Move
            </DropdownMenuItem>
          )}
          {can(role, "share") && (
            <DropdownMenuItem onClick={() => setShareTarget(target)}>
              <Share2 className="h-4 w-4 mr-2" />
              Share
            </DropdownMenuItem>
          )}
          {canEditText && (
            <DropdownMenuItem onClick={() => setEditorTarget({ mode: "edit", file })}>
              <FilePen className="h-4 w-4 mr-2" />
              Edit text
            </DropdownMenuItem>
          )}
          {can(role, "upload_version") && (
            <DropdownMenuItem
              onClick={() => {
                versionTargetRef.current = file;
                versionInputRef.current?.click();
              }}
            >
              <Upload className="h-4 w-4 mr-2" />
              Upload new version
            </DropdownMenuItem>
          )}
          {can(role, "delete") && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => setDeleteTarget(target)}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  };

  return (
    <div
      {...getRootProps()}
      className={cn(
        "relative min-h-[60vh]",
        isDragActive && "rounded-3xl"
      )}
    >
      <input {...getInputProps()} />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const selected = Array.from(e.target.files ?? []);
          if (selected.length > 0) void startUpload(selected, folderId);
          e.target.value = "";
        }}
      />
      <input
        ref={versionInputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const selected = e.target.files?.[0] ?? null;
          e.target.value = "";
          if (selected) void handleUploadNewVersion(selected);
        }}
      />

      <AnimatePresence>
        {isDragActive && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-md"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0 }}
              transition={{ type: "spring", stiffness: 300, damping: 24 }}
              className="relative w-[min(90vw,30rem)] overflow-hidden rounded-[2rem] border-2 border-dashed border-primary/50 bg-card/90 px-10 py-14 text-center shadow-2xl"
            >
              <div className="hero-beams opacity-60" />
              <motion.div
                animate={{ y: [0, -10, 0] }}
                transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
                className="relative mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-3xl bg-brand text-white shadow-2xl shadow-primary/40"
              >
                <Upload className="h-9 w-9" />
              </motion.div>
              <p className="relative text-2xl font-semibold tracking-tight">Drop to upload</p>
              <p className="relative mt-2 text-muted-foreground">
                Files will be added to{" "}
                <span className="font-medium text-foreground">
                  {ancestors[ancestors.length - 1]?.name ?? "My Files"}
                </span>
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-3xl font-semibold tracking-tight">
              {ancestors[ancestors.length - 1]?.name ?? "My Files"}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {loading
                ? "Loading…"
                : `${folders.length} folder${folders.length === 1 ? "" : "s"} · ${files.length} file${files.length === 1 ? "" : "s"}${truncated ? ` (first ${TRUNCATED_LIMIT_LABEL} shown)` : ""}`}
            </p>
          </div>
        </div>
        {folderId && (
        <nav className="flex items-center gap-1 text-sm flex-wrap" aria-label="Breadcrumb">
          <button
            onClick={() => navigateTo(null)}
            className={cn(
              "hover:text-foreground rounded px-1.5 py-0.5 hover:bg-muted",
              !folderId ? "font-medium" : "text-muted-foreground"
            )}
          >
            My Files
          </button>
          {ancestors.map((ancestor, index) => (
            <span key={ancestor.id} className="flex items-center gap-1 min-w-0">
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <button
                onClick={() => navigateTo(ancestor.id)}
                className={cn(
                  "truncate max-w-48 rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground",
                  index === ancestors.length - 1
                    ? "font-medium"
                    : "text-muted-foreground"
                )}
              >
                {ancestor.name}
              </button>
            </span>
          ))}
        </nav>
        )}

        <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
          <div className="relative flex-1 w-full sm:max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Filter this folder..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="pl-10"
            />
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <div className="flex rounded-lg border overflow-hidden">
              <button
                onClick={() => changeView("list")}
                className={cn(
                  "px-2.5 h-8 flex items-center",
                  view === "list" ? "bg-muted" : "hover:bg-muted/50"
                )}
                aria-label="List view"
              >
                <List className="h-4 w-4" />
              </button>
              <button
                onClick={() => changeView("grid")}
                className={cn(
                  "px-2.5 h-8 flex items-center",
                  view === "grid" ? "bg-muted" : "hover:bg-muted/50"
                )}
                aria-label="Grid view"
              >
                <Grid3x3 className="h-4 w-4" />
              </button>
            </div>
            <Button
              variant={selectionMode ? "secondary" : "outline"}
              onClick={toggleSelectionMode}
              aria-label={selectionMode ? "Cancel selection" : "Select items"}
            >
              <CheckSquare className="h-4 w-4 sm:mr-1" />
              <span className="hidden sm:inline">{selectionMode ? "Cancel" : "Select"}</span>
            </Button>
            <Button
              variant="outline"
              onClick={() => setNewFolderOpen(true)}
              aria-label="New folder"
            >
              <FolderPlus className="h-4 w-4 sm:mr-1" />
              <span className="hidden sm:inline">New Folder</span>
            </Button>
            <Button
              variant="outline"
              onClick={() => setEditorTarget({ mode: "create", folderId })}
              aria-label="New text file"
            >
              <FilePlus2 className="h-4 w-4 sm:mr-1" />
              <span className="hidden sm:inline">New File</span>
            </Button>
            <Button
              variant="outline"
              onClick={open}
              className="hidden md:inline-flex"
            >
              <Upload className="h-4 w-4 mr-1" />
              Drag & Drop
            </Button>
            <Button
              variant="brand"
              onClick={() => fileInputRef.current?.click()}
              className="ml-auto sm:ml-0"
            >
              <Plus className="h-4 w-4 mr-1" />
              Upload
            </Button>
          </div>
        </div>

        {selectionMode && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
            <span className="font-medium">{selectedCount} selected</span>
            <Button
              size="sm"
              variant="outline"
              disabled={selectedCount === 0}
              onClick={() => setBulkMoveOpen(true)}
            >
              <FolderInput className="h-3.5 w-3.5 mr-1" />
              Move
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={selectedFiles.size === 0}
              onClick={() => void handleBulkDownload()}
            >
              <Download className="h-3.5 w-3.5 mr-1" />
              Download files
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={selectedCount === 0}
              onClick={() => setBulkDeleteOpen(true)}
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" />
              Delete
            </Button>
            <Button size="sm" variant="ghost" onClick={clearSelection}>
              Clear
            </Button>
          </div>
        )}

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, index) => (
              <div
                key={index}
                className="h-14 rounded-xl border bg-muted/40 animate-pulse"
              />
            ))}
          </div>
        ) : error ? (
          <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-8 text-center">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="outline" className="mt-4" onClick={() => void load(folderId)}>
              Retry
            </Button>
          </div>
        ) : isEmpty ? (
          <div className="relative flex flex-col items-center justify-center overflow-hidden rounded-3xl border border-dashed bg-card/60 px-4 py-20 backdrop-blur">
            <div className="dot-pattern pointer-events-none absolute inset-0 opacity-60 [mask-image:radial-gradient(ellipse_at_center,#000,transparent_70%)]" />
            <div className="relative mb-6 h-24 w-32">
              {(["pdf", "image", "archive"] as const).map((kind, i) => (
                <motion.div
                  key={kind}
                  className="absolute left-1/2 top-1/2"
                  initial={{ opacity: 0, x: "-50%", y: "-50%", rotate: 0 }}
                  animate={{ opacity: 1, x: `${-50 + (i - 1) * 55}%`, y: ["-50%", "-62%", "-50%"], rotate: (i - 1) * 12 }}
                  transition={{
                    opacity: { delay: i * 0.1 },
                    x: { type: "spring", stiffness: 160, damping: 14, delay: i * 0.1 },
                    rotate: { type: "spring", stiffness: 160, damping: 14, delay: i * 0.1 },
                    y: { duration: 3, repeat: Infinity, ease: "easeInOut", delay: i * 0.4 },
                  }}
                >
                  <FileTile kind={kind} size="lg" className="bg-card shadow-xl" />
                </motion.div>
              ))}
            </div>
            <h3 className="relative text-lg font-semibold">
              {query ? "No matches" : "This folder is empty"}
            </h3>
            <p className="relative mt-1 max-w-sm text-center text-muted-foreground">
              {query
                ? "Try a different filter."
                : "Drag files anywhere on this page, or use the buttons below to get started."}
            </p>
            {!query && (
              <div className="relative mt-6 flex gap-2">
                <Button variant="outline" onClick={() => setNewFolderOpen(true)}>
                  <FolderPlus className="h-4 w-4 mr-2" />
                  New Folder
                </Button>
                <Button variant="outline" onClick={() => setEditorTarget({ mode: "create", folderId })}>
                  <FilePlus2 className="h-4 w-4 mr-2" />
                  New File
                </Button>
                <Button variant="brand" onClick={() => fileInputRef.current?.click()}>
                  <Upload className="h-4 w-4 mr-2" />
                  Upload files
                </Button>
              </div>
            )}
          </div>
        ) : view === "list" ? (
          <div className="rounded-2xl border bg-card/80 backdrop-blur shadow-sm divide-y overflow-hidden">
            {visibleFolders.map((folder, index) => (
              <div
                key={folder.id}
                className={cn(
                  "group/row relative flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors hover:bg-primary/[0.04] before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-brand before:opacity-0 before:transition-opacity hover:before:opacity-100",
                  ENTER_ANIMATION,
                  selectionMode && selectedFolders.has(folder.id) && "bg-primary/5"
                )}
                style={staggerDelay(index)}
                onClick={() =>
                  selectionMode
                    ? toggleFolderSelection(folder.id)
                    : navigateTo(folder.id)
                }
              >
                {selectionMode && (
                  <input
                    type="checkbox"
                    checked={selectedFolders.has(folder.id)}
                    onChange={() => toggleFolderSelection(folder.id)}
                    onClick={(e) => e.stopPropagation()}
                    className="h-4 w-4 accent-primary shrink-0"
                    aria-label={`Select ${folder.name}`}
                  />
                )}
                <FileTile kind="folder" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{folder.name}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    Folder • {format(new Date(folder.created_at), "MMM d, yyyy")}
                    {folder.comment ? ` • ${folder.comment}` : ""}
                  </p>
                </div>
                {commentBadge(folder.id, () => openFolderComments(folder))}
                {folder.owner_id !== user.id && (
                  <Badge variant="outline" className="shrink-0">
                    Shared
                  </Badge>
                )}
                {!selectionMode && folderMenu(folder)}
              </div>
            ))}
            {visibleFiles.map((file, fileIndex) => (
              <div
                key={file.id}
                className={cn(
                  "group/row relative flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors hover:bg-primary/[0.04] before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-brand before:opacity-0 before:transition-opacity hover:before:opacity-100",
                  ENTER_ANIMATION,
                  selectionMode && selectedFiles.has(file.id) && "bg-primary/5"
                )}
                style={staggerDelay(visibleFolders.length + fileIndex)}
                onClick={() =>
                  selectionMode ? toggleFileSelection(file.id) : setPreviewFile(file)
                }
              >
                {selectionMode && (
                  <input
                    type="checkbox"
                    checked={selectedFiles.has(file.id)}
                    onChange={() => toggleFileSelection(file.id)}
                    onClick={(e) => e.stopPropagation()}
                    className="h-4 w-4 accent-primary shrink-0"
                    aria-label={`Select ${file.name}`}
                  />
                )}
                <FileTile kind={fileKind(file.mime_type, file.name)} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{file.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatBytes(file.size)} • {file.mime_type} •{" "}
                    {format(new Date(file.updated_at), "MMM d, yyyy")}
                  </p>
                </div>
                {commentBadge(file.id, () => openFileComments(file))}
                {file.is_public && (
                  <Badge variant="secondary" className="shrink-0">
                    Public
                  </Badge>
                )}
                {file.owner_id !== user.id && (
                  <Badge variant="outline" className="shrink-0">
                    Shared
                  </Badge>
                )}
                {!selectionMode && fileMenu(file)}
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {visibleFolders.map((folder, index) => (
              <div
                key={folder.id}
                className={cn(
                  "group/card relative rounded-2xl border bg-card/80 backdrop-blur p-4 pt-5 cursor-pointer flex flex-col items-center text-center gap-2.5 transition-all duration-300 hover:-translate-y-1 hover:border-primary/30 hover:shadow-xl hover:shadow-primary/10",
                  ENTER_ANIMATION,
                  selectionMode && selectedFolders.has(folder.id) && "ring-2 ring-primary"
                )}
                style={staggerDelay(index)}
                onClick={() =>
                  selectionMode
                    ? toggleFolderSelection(folder.id)
                    : navigateTo(folder.id)
                }
              >
                {selectionMode && (
                  <input
                    type="checkbox"
                    checked={selectedFolders.has(folder.id)}
                    onChange={() => toggleFolderSelection(folder.id)}
                    onClick={(e) => e.stopPropagation()}
                    className="absolute top-2 left-2 h-4 w-4 accent-primary"
                    aria-label={`Select ${folder.name}`}
                  />
                )}
                <FileTile kind="folder" size="lg" className="transition-transform duration-300 group-hover/card:scale-110 group-hover/card:-rotate-3" />
                <p className="text-sm font-medium truncate w-full">{folder.name}</p>
                <p className="text-xs text-muted-foreground">Folder</p>
                {commentBadge(folder.id, () => openFolderComments(folder))}
                {!selectionMode && folderMenu(folder)}
              </div>
            ))}
            {visibleFiles.map((file, fileIndex) => (
              <div
                key={file.id}
                className={cn(
                  "group/card relative rounded-2xl border bg-card/80 backdrop-blur p-4 pt-5 cursor-pointer flex flex-col items-center text-center gap-2.5 transition-all duration-300 hover:-translate-y-1 hover:border-primary/30 hover:shadow-xl hover:shadow-primary/10",
                  ENTER_ANIMATION,
                  selectionMode && selectedFiles.has(file.id) && "ring-2 ring-primary"
                )}
                style={staggerDelay(visibleFolders.length + fileIndex)}
                onClick={() =>
                  selectionMode ? toggleFileSelection(file.id) : setPreviewFile(file)
                }
              >
                {selectionMode && (
                  <input
                    type="checkbox"
                    checked={selectedFiles.has(file.id)}
                    onChange={() => toggleFileSelection(file.id)}
                    onClick={(e) => e.stopPropagation()}
                    className="absolute top-2 left-2 h-4 w-4 accent-primary"
                    aria-label={`Select ${file.name}`}
                  />
                )}
                <FileTile kind={fileKind(file.mime_type, file.name)} size="lg" className="transition-transform duration-300 group-hover/card:scale-110 group-hover/card:-rotate-3" />
                <p className="text-sm font-medium truncate w-full">{file.name}</p>
                <p className="text-xs text-muted-foreground">
                  {formatBytes(file.size)}
                </p>
                {commentBadge(file.id, () => openFileComments(file))}
                {!selectionMode && fileMenu(file)}
              </div>
            ))}
          </div>
        )}
        {!loading && !error && truncated && (
          <p className="text-center text-sm text-muted-foreground" role="status">
            Showing the first {TRUNCATED_LIMIT_LABEL} items. Use Search to find the rest.
          </p>
        )}
      </div>

      {newFolderOpen && (
        <NewFolderDialog
          open
          onOpenChange={setNewFolderOpen}
          onSubmit={handleCreateFolder}
        />
      )}
      {renameTarget && (
        <RenameDialog
          open
          onOpenChange={(open) => {
            if (!open) setRenameTarget(null);
          }}
          title={renameTarget.kind === "folder" ? "Rename folder" : "Rename file"}
          initialName={renameTarget.name}
          onSubmit={handleRename}
        />
      )}
      {deleteTarget && (
        <DeleteDialog
          open
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
          name={deleteTarget.name}
          isFolder={deleteTarget.kind === "folder"}
          onConfirm={handleDelete}
        />
      )}
      {moveTarget && (
        <MoveCopyDialog
          open
          onOpenChange={(open) => {
            if (!open) setMoveTarget(null);
          }}
          mode="move"
          itemName={moveTarget.name}
          excludeFolderId={moveTarget.kind === "folder" ? moveTarget.id : null}
          allowRoot={ownsItem(moveTarget.kind, moveTarget.id)}
          onSubmit={handleMove}
        />
      )}
      {copyTarget && (
        <MoveCopyDialog
          open
          onOpenChange={(open) => {
            if (!open) setCopyTarget(null);
          }}
          mode="copy"
          itemName={copyTarget.name}
          onSubmit={handleCopy}
        />
      )}
      {bulkMoveOpen && (
        <MoveCopyDialog
          open
          onOpenChange={(open) => {
            if (!open) setBulkMoveOpen(false);
          }}
          mode="move"
          itemName={`${selectedCount} item${selectedCount === 1 ? "" : "s"}`}
          allowRoot={ownsSelection}
          onSubmit={handleBulkMove}
        />
      )}
      {bulkDeleteOpen && (
        <DeleteDialog
          open
          onOpenChange={(open) => {
            if (!open) setBulkDeleteOpen(false);
          }}
          name={`${selectedCount} item${selectedCount === 1 ? "" : "s"}`}
          isFolder={false}
          onConfirm={handleBulkDelete}
        />
      )}
      {shareTarget && (
        <ShareDialog
          open
          onOpenChange={(open) => {
            if (!open) setShareTarget(null);
          }}
          kind={shareTarget.kind}
          resourceId={shareTarget.id}
          resourceName={shareTarget.name}
        />
      )}
      {detailsFile && (
        <DetailsDialogWithVersionActions
          open
          onOpenChange={(open) => {
            if (!open) setDetailsFile(null);
          }}
          file={detailsFile}
          role={roleOf(detailsFile, user.id)}
          currentUserId={user.id}
          onRefreshFile={handleRefreshFile}
          onToggleVisibility={handleToggleVisibility}
          versionActions={(version, reloadVersions) =>
            // old versions only; deleting needs admin (owner, admin share or folder owner)
            can(roleOf(detailsFile, user.id), "delete") &&
            version.id !== detailsFile.current_version_id ? (
              <DeleteVersionButton version={version} onDeleted={reloadVersions} />
            ) : null
          }
        />
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
      {commentsTarget && (
        <CommentsDialog
          key={`${commentsTarget.kind}-${commentsTarget.id}`}
          target={commentsTarget}
          currentUserId={user.id}
          onOpenChange={(open) => {
            if (!open) setCommentsTarget(null);
          }}
          onCountChange={(count) =>
            setCommentCounts((prev) => new Map(prev).set(commentsTarget.id, count))
          }
          onDescriptionChange={(description) =>
            setFolders((prev) =>
              prev.map((folder) =>
                folder.id === commentsTarget.id ? { ...folder, comment: description } : folder
              )
            )
          }
        />
      )}
      {editorTarget && (
        <TextEditorDialog
          key={editorTarget.mode === "edit" ? editorTarget.file.id : "create"}
          target={editorTarget}
          userId={user.id}
          onOpenChange={(open) => {
            if (!open) setEditorTarget(null);
          }}
          onSaved={() => {
            const dest = editorTarget.mode === "create" ? editorTarget.folderId : editorTarget.file.folder_id;
            reloadIfShowing(dest);
          }}
        />
      )}
      <UploadPanel
        tasks={tasks}
        open={panelOpen}
        onToggle={() => setPanelOpen((prev) => !prev)}
        onClose={() => setTasks([])}
        onRetry={(localId) => void retryTask(localId)}
      />
    </div>
  );
}

/** Trash button for one old version, with its confirmation. */
function DeleteVersionButton({
  version,
  onDeleted,
}: {
  version: FileVersion;
  /** reloads the versions list */
  onDeleted: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const confirm = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      // also refreshes the storage usage meter (notifyQuotaChanged)
      await deleteVersion(version.id);
      setOpen(false);
      toast.success(`Deleted version ${version.version_no}`);
      await onDeleted();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Delete v${version.version_no}`}
        title={`Delete v${version.version_no}`}
        className="text-muted-foreground hover:text-destructive"
        disabled={deleting}
        onClick={() => setOpen(true)}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!deleting) setOpen(next);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete version {version.version_no}?</DialogTitle>
            <DialogDescription>
              This frees {formatBytes(version.size)} and cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirm()} disabled={deleting}>
              {deleting && <Loader2 className="h-4 w-4 animate-spin" />}
              {deleting ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
