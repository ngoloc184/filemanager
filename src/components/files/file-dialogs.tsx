"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2, RotateCcw, Upload, X } from "lucide-react";
import { toast } from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import FolderPicker from "@/components/files/folder-picker";
import {
  downloadVersion,
  getSignedUrl,
  listVersions,
  restoreVersion,
  type PreviewableFile,
} from "@/lib/services/files";
import { uploadNewVersion } from "@/lib/services/uploads";
import { getFileTags, setFileTags, type FileTag } from "@/lib/services/tags";
import {
  getErrorMessage,
  type FileRow,
  type FileVersion,
} from "@/lib/types/database";
import { formatBytes } from "@/lib/utils";
import { format } from "date-fns";

export function NewFolderDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (name: string, comment: string | null) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(name.trim(), comment.trim() || null);
      onOpenChange(false);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New folder</DialogTitle>
          <DialogDescription>
            Create a folder to organize your files.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="folder-name">Name</Label>
            <Input
              id="folder-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Contracts"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="folder-comment">Comment (optional)</Label>
            <Textarea
              id="folder-comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={2}
              placeholder="What is this folder for?"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!name.trim() || submitting}>
            {submitting ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RenameDialog({
  open,
  onOpenChange,
  title,
  initialName,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  initialName: string;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initialName);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(name.trim());
      onOpenChange(false);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Enter a new name.</DialogDescription>
        </DialogHeader>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!name.trim() || submitting}>
            {submitting ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteDialog({
  open,
  onOpenChange,
  name,
  isFolder,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  isFolder: boolean;
  onConfirm: () => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);

  const confirm = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {isFolder ? "folder" : "file"}</DialogTitle>
          <DialogDescription>
            {isFolder
              ? `"${name}" and everything inside it will be moved to trash.`
              : `"${name}" will be moved to trash.`}{" "}
            You can restore it from the trash later.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void confirm()} disabled={deleting}>
            {deleting ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MoveCopyDialog({
  open,
  onOpenChange,
  mode,
  itemName,
  excludeFolderId,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "move" | "copy";
  itemName: string;
  excludeFolderId?: string | null;
  onSubmit: (destFolderId: string | null) => Promise<void>;
}) {
  const [dest, setDest] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(dest);
      onOpenChange(false);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {mode === "move" ? "Move" : "Copy"} &quot;{itemName}&quot;
          </DialogTitle>
          <DialogDescription>Choose a destination folder.</DialogDescription>
        </DialogHeader>
        <FolderPicker
          value={dest}
          onChange={setDest}
          excludeFolderId={excludeFolderId}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={submitting}>
            {submitting
              ? mode === "move"
                ? "Moving..."
                : "Copying..."
              : mode === "move"
                ? "Move here"
                : "Copy here"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DetailsDialog({
  open,
  onOpenChange,
  file,
  isOwner,
  currentUserId,
  onRefreshFile,
  onToggleVisibility,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  file: FileRow;
  isOwner: boolean;
  currentUserId: string;
  onRefreshFile: (fileId: string) => Promise<void>;
  onToggleVisibility: (file: FileRow) => Promise<void>;
}) {
  const [versions, setVersions] = useState<FileVersion[] | null>(null);
  const [toggling, setToggling] = useState(false);
  const [tags, setTags] = useState<FileTag[] | null>(null);
  const [tagInput, setTagInput] = useState("");
  const [savingTags, setSavingTags] = useState(false);
  const [uploadingVersion, setUploadingVersion] = useState(false);
  const [restoringVersionId, setRestoringVersionId] = useState<string | null>(null);
  const versionInputRef = useRef<HTMLInputElement>(null);

  const reloadVersions = useCallback(async () => {
    try {
      const data = await listVersions(file.id);
      setVersions(data);
    } catch {
      setVersions([]);
    }
  }, [file.id]);

  useEffect(() => {
    let cancelled = false;
    listVersions(file.id)
      .then((data) => {
        if (!cancelled) setVersions(data);
      })
      .catch(() => {
        if (!cancelled) setVersions([]);
      });
    getFileTags(file.id)
      .then((data) => {
        if (!cancelled) setTags(data);
      })
      .catch(() => {
        if (!cancelled) setTags([]);
      });
    return () => {
      cancelled = true;
    };
  }, [file.id]);

  const persistTags = async (names: string[]) => {
    setSavingTags(true);
    try {
      const updated = await setFileTags(file.id, names);
      setTags(updated);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSavingTags(false);
    }
  };

  const addTag = () => {
    const name = tagInput.trim().replace(/^#/, "");
    if (!name || !tags) return;
    if (tags.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
      setTagInput("");
      return;
    }
    setTagInput("");
    void persistTags([...tags.map((t) => t.name), name]);
  };

  const removeTag = (name: string) => {
    if (!tags) return;
    void persistTags(tags.filter((t) => t.name !== name).map((t) => t.name));
  };

  const handleUploadVersion = async (selected: File) => {
    if (uploadingVersion) return;
    setUploadingVersion(true);
    try {
      await uploadNewVersion(currentUserId, file.id, selected);
      await onRefreshFile(file.id);
      await reloadVersions();
      toast.success("New version uploaded");
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setUploadingVersion(false);
    }
  };

  const handleDownloadVersion = async (version: FileVersion) => {
    try {
      await downloadVersion(version, file.name);
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  const handleRestoreVersion = async (version: FileVersion) => {
    if (restoringVersionId) return;
    setRestoringVersionId(version.id);
    try {
      await restoreVersion(file.id, version.id);
      await onRefreshFile(file.id);
      await reloadVersions();
      toast.success(`Restored v${version.version_no}`);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setRestoringVersionId(null);
    }
  };

  const rows: Array<[string, string]> = [
    ["Name", file.name],
    ["Original name", file.original_name],
    ["Type", file.mime_type],
    ["Size", formatBytes(file.size)],
    ["Extension", file.extension || "-"],
    ["Created", format(new Date(file.created_at), "MMM d, yyyy HH:mm")],
    ["Modified", format(new Date(file.updated_at), "MMM d, yyyy HH:mm")],
    ["Checksum (SHA-256)", file.checksum ? `${file.checksum.slice(0, 16)}...` : "-"],
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>File details</DialogTitle>
          <DialogDescription className="truncate">{file.name}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {rows.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4 text-sm">
              <span className="text-muted-foreground shrink-0">{label}</span>
              <span className="text-right truncate font-mono text-xs leading-5">{value}</span>
            </div>
          ))}
          <div className="flex justify-between gap-4 text-sm items-center">
            <span className="text-muted-foreground">Visibility</span>
            {isOwner ? (
              <Button
                size="sm"
                variant="outline"
                disabled={toggling}
                onClick={async () => {
                  setToggling(true);
                  try {
                    await onToggleVisibility(file);
                  } finally {
                    setToggling(false);
                  }
                }}
              >
                {file.is_public ? "Public - make private" : "Private - make public"}
              </Button>
            ) : (
              <Badge variant={file.is_public ? "default" : "secondary"}>
                {file.is_public ? "Public" : "Private"}
              </Badge>
            )}
          </div>
        </div>
        <div>
          <h4 className="text-sm font-medium mb-2">
            Tags{" "}
            {tags === null ? (
              <Loader2 className="inline h-3.5 w-3.5 animate-spin" />
            ) : (
              <span className="text-muted-foreground">({tags.length})</span>
            )}
          </h4>
          {tags !== null && (
            <div className="space-y-2">
              {tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {tags.map((tag) => (
                    <Badge key={tag.tag_id} variant="secondary" className="gap-1 pr-1">
                      #{tag.name}
                      {isOwner && (
                        <button
                          type="button"
                          className="ml-0.5 rounded-full hover:bg-muted-foreground/20 p-0.5"
                          onClick={() => removeTag(tag.name)}
                          disabled={savingTags}
                          aria-label={`Remove tag ${tag.name}`}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </Badge>
                  ))}
                </div>
              )}
              {isOwner && (
                <div className="flex gap-2">
                  <Input
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    placeholder="Add a tag (e.g. contract)"
                    className="h-8 text-sm"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addTag();
                      }
                    }}
                    disabled={savingTags}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={addTag}
                    disabled={savingTags || !tagInput.trim()}
                  >
                    Add
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
        <div>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-medium">
              Versions{" "}
              {versions === null ? (
                <Loader2 className="inline h-3.5 w-3.5 animate-spin" />
              ) : (
                <span className="text-muted-foreground">({versions.length})</span>
              )}
            </h4>
            {isOwner && (
              <>
                <input
                  ref={versionInputRef}
                  type="file"
                  className="hidden"
                  onChange={(e) => {
                    const selected = e.target.files?.[0] ?? null;
                    e.target.value = "";
                    if (selected) void handleUploadVersion(selected);
                  }}
                />
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => versionInputRef.current?.click()}
                  disabled={uploadingVersion}
                >
                  {uploadingVersion ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Upload className="h-3 w-3" />
                  )}
                  Upload new version
                </Button>
              </>
            )}
          </div>
          {versions && versions.length === 0 && (
            <p className="text-xs text-muted-foreground">No versions available.</p>
          )}
          {versions && versions.length > 0 && (
            <div className="space-y-1 max-h-40 overflow-auto">
              {versions.map((version) => (
                <div
                  key={version.id}
                  className="flex items-center gap-2 text-xs rounded-md border px-2 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <span className="font-medium">
                      v{version.version_no}
                      {file.current_version_id === version.id && (
                        <Badge variant="secondary" className="ml-2">
                          current
                        </Badge>
                      )}
                    </span>
                    <p className="text-muted-foreground truncate">
                      {formatBytes(version.size)} •{" "}
                      {format(new Date(version.created_at), "MMM d, yyyy HH:mm")}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Download v${version.version_no}`}
                    onClick={() => void handleDownloadVersion(version)}
                  >
                    <Download className="h-3.5 w-3.5" />
                  </Button>
                  {isOwner && version.id !== file.current_version_id && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Restore v${version.version_no}`}
                      disabled={restoringVersionId !== null}
                      onClick={() => void handleRestoreVersion(version)}
                    >
                      {restoringVersionId === version.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RotateCcw className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function PreviewDialog({
  open,
  onOpenChange,
  file,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  file: PreviewableFile;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    getSignedUrl(file, 300)
      .then(async (signedUrl) => {
        if (cancelled) return;
        setUrl(signedUrl);
        const isText =
          file.mime_type.startsWith("text/") ||
          ["application/json", "application/xml", "application/x-yaml"].includes(
            file.mime_type
          );
        if (isText && file.size <= 2 * 1024 * 1024) {
          try {
            const response = await fetch(signedUrl);
            const text = await response.text();
            if (!cancelled) setTextContent(text);
          } catch {
            // preview falls back to download-only
          }
        }
      })
      .catch((err) => {
        if (!cancelled) setLoadError(getErrorMessage(err));
      });

    return () => {
      cancelled = true;
    };
  }, [file]);

  const mime = file.mime_type;
  const canPreview =
    url !== null &&
    (mime.startsWith("image/") ||
      mime === "application/pdf" ||
      mime.startsWith("video/") ||
      mime.startsWith("audio/") ||
      textContent !== null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate">{file.name}</DialogTitle>
          <DialogDescription>
            {formatBytes(file.size)} • {mime}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-64 flex items-center justify-center bg-muted/40 rounded-lg overflow-hidden">
          {loadError && (
            <p className="text-sm text-destructive p-8 text-center">{loadError}</p>
          )}
          {!loadError && url === null && (
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          )}
          {!loadError && url !== null && !canPreview && (
            <p className="text-sm text-muted-foreground p-8 text-center">
              No preview available for this file type. Use Download instead.
            </p>
          )}
          {url !== null && mime.startsWith("image/") && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url} alt={file.name} className="max-h-[60vh] object-contain" />
          )}
          {url !== null && mime === "application/pdf" && (
            <iframe src={url} title={file.name} className="w-full h-[60vh]" />
          )}
          {url !== null && mime.startsWith("video/") && (
            <video src={url} controls className="max-h-[60vh] w-full" />
          )}
          {url !== null && mime.startsWith("audio/") && (
            <audio src={url} controls className="w-full p-8" />
          )}
          {textContent !== null && (
            <pre className="w-full max-h-[60vh] overflow-auto p-4 text-xs whitespace-pre-wrap">
              {textContent}
            </pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
