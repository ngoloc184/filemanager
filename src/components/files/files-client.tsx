"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useDropzone } from "react-dropzone";
import { toast } from "react-hot-toast";
import { format } from "date-fns";
import {
  CheckSquare,
  ChevronRight,
  Download,
  Eye,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Folder as FolderIcon,
  FolderOpen,
  FolderPlus,
  Grid3x3,
  Info,
  List,
  Copy,
  FolderInput,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Share2,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
  listFolders,
  moveFolder,
  renameFolder,
  softDeleteFolder,
} from "@/lib/services/folders";
import {
  copyFile,
  downloadFile,
  getFile,
  listFiles,
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
  type Folder,
  type FolderAncestor,
} from "@/lib/types/database";
import { cn, formatBytes } from "@/lib/utils";
import UploadPanel from "@/components/files/upload-panel";
import ShareDialog from "@/components/files/share-dialog";
import {
  DeleteDialog,
  DetailsDialog,
  MoveCopyDialog,
  NewFolderDialog,
  PreviewDialog,
  RenameDialog,
} from "@/components/files/file-dialogs";

type RowTarget = { kind: "folder" | "file"; id: string; name: string };

function FileTypeIcon({
  file,
  className,
}: {
  file: FileRow;
  className?: string;
}) {
  if (file.mime_type.startsWith("image/"))
    return <FileImage className={className} />;
  if (file.mime_type.startsWith("video/"))
    return <FileVideo className={className} />;
  if (file.mime_type.startsWith("audio/"))
    return <FileAudio className={className} />;
  if (
    file.mime_type === "application/pdf" ||
    file.mime_type.startsWith("text/")
  )
    return <FileText className={className} />;
  if (["zip", "rar", "7z", "tar", "gz"].includes(file.extension))
    return <FileArchive className={className} />;
  return <File className={className} />;
}

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

  const load = useCallback(async (fid: string | null, silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [folderList, fileList] = await Promise.all([
        listFolders(fid),
        listFiles(fid),
      ]);
      setFolders(folderList);
      setFiles(fileList);
      if (fid) {
        try {
          setAncestors(await getFolderPath(fid));
        } catch {
          setAncestors([]);
        }
      } else {
        setAncestors([]);
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

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
      if (anySuccess && destFolderId === folderId) {
        void load(folderId, true);
      }
    },
    [user.id, folderId, load]
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
      if (task.folderId === folderId) void load(folderId, true);
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
    if (dest === folderId) await load(folderId, true);
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
      const updated = await toggleFileVisibility(file);
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
    const updated = await getFile(fileId);
    setFiles((prev) =>
      prev.map((item) => (item.id === updated.id ? updated : item))
    );
    setDetailsFile((prev) => (prev && prev.id === updated.id ? updated : prev));
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

  const selectedCount = selectedFolders.size + selectedFiles.size;

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

  const handleBulkMove = async (dest: string | null) => {
    let failures = 0;
    for (const id of Array.from(selectedFolders)) {
      try {
        await moveFolder(id, dest);
      } catch {
        failures += 1;
      }
    }
    for (const id of Array.from(selectedFiles)) {
      try {
        await moveFile(id, dest);
      } catch {
        failures += 1;
      }
    }
    if (failures === 0) toast.success("Moved");
    else toast.error(`Failed to move ${failures} item(s)`);
    clearSelection();
    await load(folderId, true);
  };

  const handleBulkDelete = async () => {
    let failures = 0;
    for (const id of Array.from(selectedFolders)) {
      try {
        await softDeleteFolder(id);
      } catch {
        failures += 1;
      }
    }
    for (const id of Array.from(selectedFiles)) {
      try {
        await softDeleteFile(id);
      } catch {
        failures += 1;
      }
    }
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
    const isOwner = folder.owner_id === user.id;
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
          {isOwner && (
            <>
              <DropdownMenuItem
                onClick={() =>
                  setRenameTarget({ kind: "folder", id: folder.id, name: folder.name })
                }
              >
                <Pencil className="h-4 w-4 mr-2" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  setMoveTarget({ kind: "folder", id: folder.id, name: folder.name })
                }
              >
                <FolderInput className="h-4 w-4 mr-2" />
                Move
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  setShareTarget({ kind: "folder", id: folder.id, name: folder.name })
                }
              >
                <Share2 className="h-4 w-4 mr-2" />
                Share
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive"
                onClick={() =>
                  setDeleteTarget({ kind: "folder", id: folder.id, name: folder.name })
                }
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
    const isOwner = file.owner_id === user.id;
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
          <DropdownMenuItem onClick={() => void handleDownload(file)}>
            <Download className="h-4 w-4 mr-2" />
            Download
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setDetailsFile(file)}>
            <Info className="h-4 w-4 mr-2" />
            Details
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              setCopyTarget(file)
            }
          >
            <Copy className="h-4 w-4 mr-2" />
            Copy to...
          </DropdownMenuItem>
          {isOwner && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() =>
                  setRenameTarget({ kind: "file", id: file.id, name: file.name })
                }
              >
                <Pencil className="h-4 w-4 mr-2" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  setMoveTarget({ kind: "file", id: file.id, name: file.name })
                }
              >
                <FolderInput className="h-4 w-4 mr-2" />
                Move
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  setShareTarget({ kind: "file", id: file.id, name: file.name })
                }
              >
                <Share2 className="h-4 w-4 mr-2" />
                Share
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  versionTargetRef.current = file;
                  versionInputRef.current?.click();
                }}
              >
                <Upload className="h-4 w-4 mr-2" />
                Upload new version
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive"
                onClick={() =>
                  setDeleteTarget({ kind: "file", id: file.id, name: file.name })
                }
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
        isDragActive && "ring-2 ring-primary ring-offset-2 rounded-xl"
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

      {isDragActive && (
        <div className="fixed inset-0 bg-primary/10 z-50 flex items-center justify-center">
          <div className="bg-white rounded-2xl shadow-2xl p-12 text-center">
            <Upload className="h-16 w-16 text-primary mx-auto mb-4 animate-bounce" />
            <p className="text-xl font-semibold text-primary">
              Drop files here to upload
            </p>
            <p className="text-muted-foreground mt-2">
              Files will be uploaded to the current folder
            </p>
          </div>
        </div>
      )}

      <div className="space-y-4">
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
          <div className="flex gap-2 w-full sm:w-auto">
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
              className="flex-1 sm:flex-none"
            >
              <CheckSquare className="h-4 w-4 mr-2" />
              {selectionMode ? "Cancel" : "Select"}
            </Button>
            <Button variant="outline" onClick={() => setNewFolderOpen(true)} className="flex-1 sm:flex-none">
              <FolderPlus className="h-4 w-4 mr-2" />
              New Folder
            </Button>
            <Button variant="outline" onClick={open} className="flex-1 sm:flex-none">
              <Upload className="h-4 w-4 mr-2" />
              Drag & Drop
            </Button>
            <Button onClick={() => fileInputRef.current?.click()} className="flex-1 sm:flex-none">
              <Plus className="h-4 w-4 mr-2" />
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
          <div className="rounded-xl border bg-white flex flex-col items-center justify-center py-16 px-4">
            <FolderOpen className="h-16 w-16 text-muted-foreground/50 mb-4" />
            <h3 className="text-lg font-semibold">
              {query ? "No matches" : "This folder is empty"}
            </h3>
            <p className="text-muted-foreground mt-1 text-center">
              {query
                ? "Try a different filter."
                : "Upload files or create a folder to get started."}
            </p>
            {!query && (
              <div className="flex gap-2 mt-4">
                <Button variant="outline" onClick={() => setNewFolderOpen(true)}>
                  <FolderPlus className="h-4 w-4 mr-2" />
                  New Folder
                </Button>
                <Button onClick={() => fileInputRef.current?.click()}>
                  <Upload className="h-4 w-4 mr-2" />
                  Upload files
                </Button>
              </div>
            )}
          </div>
        ) : view === "list" ? (
          <div className="rounded-xl border bg-white divide-y">
            {visibleFolders.map((folder) => (
              <div
                key={folder.id}
                className={cn(
                  "flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/50",
                  selectionMode && selectedFolders.has(folder.id) && "bg-primary/5"
                )}
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
                <FolderIcon className="h-5 w-5 text-primary shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{folder.name}</p>
                  <p className="text-xs text-muted-foreground">
                    Folder • {format(new Date(folder.created_at), "MMM d, yyyy")}
                    {folder.comment ? ` • ${folder.comment}` : ""}
                  </p>
                </div>
                {folder.owner_id !== user.id && (
                  <Badge variant="outline" className="shrink-0">
                    Shared
                  </Badge>
                )}
                {!selectionMode && folderMenu(folder)}
              </div>
            ))}
            {visibleFiles.map((file) => (
              <div
                key={file.id}
                className={cn(
                  "flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/50",
                  selectionMode && selectedFiles.has(file.id) && "bg-primary/5"
                )}
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
                <FileTypeIcon file={file} className="h-5 w-5 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{file.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatBytes(file.size)} • {file.mime_type} •{" "}
                    {format(new Date(file.updated_at), "MMM d, yyyy")}
                  </p>
                </div>
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
            {visibleFolders.map((folder) => (
              <div
                key={folder.id}
                className={cn(
                  "relative rounded-xl border bg-white p-4 cursor-pointer hover:bg-muted/50 flex flex-col items-center text-center gap-2",
                  selectionMode && selectedFolders.has(folder.id) && "ring-2 ring-primary"
                )}
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
                <FolderIcon className="h-10 w-10 text-primary" />
                <p className="text-sm font-medium truncate w-full">{folder.name}</p>
                <p className="text-xs text-muted-foreground">Folder</p>
                {!selectionMode && folderMenu(folder)}
              </div>
            ))}
            {visibleFiles.map((file) => (
              <div
                key={file.id}
                className={cn(
                  "relative rounded-xl border bg-white p-4 cursor-pointer hover:bg-muted/50 flex flex-col items-center text-center gap-2",
                  selectionMode && selectedFiles.has(file.id) && "ring-2 ring-primary"
                )}
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
                <FileTypeIcon file={file} className="h-10 w-10 text-muted-foreground" />
                <p className="text-sm font-medium truncate w-full">{file.name}</p>
                <p className="text-xs text-muted-foreground">
                  {formatBytes(file.size)}
                </p>
                {!selectionMode && fileMenu(file)}
              </div>
            ))}
          </div>
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
        <DetailsDialog
          open
          onOpenChange={(open) => {
            if (!open) setDetailsFile(null);
          }}
          file={detailsFile}
          isOwner={detailsFile.owner_id === user.id}
          currentUserId={user.id}
          onRefreshFile={handleRefreshFile}
          onToggleVisibility={handleToggleVisibility}
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
