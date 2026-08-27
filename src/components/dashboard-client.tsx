"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useDropzone } from "react-dropzone";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "react-hot-toast";
import { formatBytes, generateBatchTitle } from "@/lib/utils";
import { format } from "date-fns";
import {
  Upload,
  Plus,
  Search,
  MoreHorizontal,
  File,
  Download,
  Trash2,
  MessageSquare,
  FolderOpen,
  ChevronDown,
  ChevronUp,
  Calendar,
  User,
  Edit3,
  Check,
  X,
  Loader2,
} from "lucide-react";

interface UploadedFile {
  id: string;
  batch_id: string;
  original_filename: string;
  storage_path: string;
  file_size: number;
  mime_type: string;
  uploaded_at: string;
}

interface Batch {
  id: string;
  title: string;
  comment: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  uploaded_files: UploadedFile[];
}

interface DashboardClientProps {
  initialBatches: Batch[];
  user: {
    id: string;
    email?: string;
  };
}

export default function DashboardClient({
  initialBatches,
  user,
}: DashboardClientProps) {
  const [batches, setBatches] = useState<Batch[]>(initialBatches);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedBatch, setExpandedBatch] = useState<string | null>(null);
  const [showNewBatchDialog, setShowNewBatchDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showDeleteFileDialog, setShowDeleteFileDialog] = useState(false);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [editingComment, setEditingComment] = useState<string | null>(null);
  const [commentText, setCommentText] = useState("");
  const [newBatchComment, setNewBatchComment] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadTotal, setUploadTotal] = useState(0);
  const [uploadCurrent, setUploadCurrent] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [deletingFile, setDeletingFile] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    setBatches(initialBatches);
  }, [initialBatches]);

  const filteredBatches = batches.filter((batch) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      batch.title.toLowerCase().includes(query) ||
      (batch.comment && batch.comment.toLowerCase().includes(query)) ||
      batch.uploaded_files.some((f) =>
        f.original_filename.toLowerCase().includes(query)
      )
    );
  });

  const handleUpload = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;

      setUploading(true);
      setUploadTotal(files.length);
      setUploadCurrent(0);
      setUploadProgress(0);

      try {
        const { data: batchData, error: batchError } = await supabase
          .from("upload_batches")
          .insert({
            title: generateBatchTitle(),
            comment: newBatchComment || null,
            created_by: user.id,
          })
          .select()
          .single();

        if (batchError) throw batchError;

        let successCount = 0;
        let failCount = 0;
        const uploadedFiles: UploadedFile[] = [];

        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          setUploadCurrent(i + 1);
          setUploadProgress(Math.round(((i + 1) / files.length) * 100));

          const fileExt = file.name.split(".").pop();
          const storagePath = `${batchData.id}/${Date.now()}-${Math.random().toString(36).substring(2)}.${fileExt}`;

          const { error: uploadError } = await supabase.storage
            .from("uploads")
            .upload(storagePath, file);

          if (uploadError) {
            console.error("Upload error:", uploadError);
            failCount++;
            continue;
          }

          const { data: uploadedFile, error: fileError } = await supabase
            .from("uploaded_files")
            .insert({
              batch_id: batchData.id,
              original_filename: file.name,
              storage_path: storagePath,
              file_size: file.size,
              mime_type: file.type || "application/octet-stream",
            })
            .select()
            .single();

          if (fileError) {
            console.error("File record error:", fileError);
            failCount++;
          } else {
            successCount++;
            uploadedFiles.push(uploadedFile);
          }
        }

        if (failCount > 0) {
          toast.error(`Failed to upload ${failCount} file(s)`);
        }
        if (successCount > 0) {
          toast.success(`Successfully uploaded ${successCount} file(s)`);
        }

        setShowNewBatchDialog(false);
        setNewBatchComment("");
        setBatches((previousBatches) => [
          { ...batchData, uploaded_files: uploadedFiles },
          ...previousBatches,
        ]);
        router.refresh();
      } catch (error) {
        toast.error("Failed to create upload batch");
        console.error(error);
      } finally {
        setUploading(false);
        setUploadProgress(0);
        setUploadCurrent(0);
        setUploadTotal(0);
      }
    },
    [newBatchComment, user.id, supabase, router]
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop: handleUpload,
    noClick: true,
    noKeyboard: true,
  });

  const handleSelectFiles = () => {
    fileInputRef.current?.click();
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      handleUpload(files);
    }
    e.target.value = "";
  };

  const handleDeleteBatch = async () => {
    if (!selectedBatchId) return;
    setDeleting(true);

    try {
      const batch = batches.find((b) => b.id === selectedBatchId);
      if (batch) {
        for (const file of batch.uploaded_files) {
          await supabase.storage.from("uploads").remove([file.storage_path]);
        }
      }

      await supabase
        .from("uploaded_files")
        .delete()
        .eq("batch_id", selectedBatchId);

      await supabase
        .from("upload_batches")
        .delete()
        .eq("id", selectedBatchId);

      setBatches((prev) => prev.filter((b) => b.id !== selectedBatchId));
      toast.success("Batch deleted");
      setShowDeleteDialog(false);
      setSelectedBatchId(null);
      router.refresh();
    } catch (error) {
      toast.error("Failed to delete batch");
      console.error(error);
    } finally {
      setDeleting(false);
    }
  };

  const handleDeleteFile = async () => {
    if (!selectedFileId) return;
    setDeletingFile(true);

    try {
      const file = batches
        .flatMap((b) => b.uploaded_files)
        .find((f) => f.id === selectedFileId);

      if (file) {
        await supabase.storage.from("uploads").remove([file.storage_path]);
      }

      await supabase
        .from("uploaded_files")
        .delete()
        .eq("id", selectedFileId);

      setBatches((prev) =>
        prev.map((b) => ({
          ...b,
          uploaded_files: b.uploaded_files.filter(
            (f) => f.id !== selectedFileId
          ),
        }))
      );

      toast.success("File deleted");
      setShowDeleteFileDialog(false);
      setSelectedFileId(null);
      router.refresh();
    } catch (error) {
      toast.error("Failed to delete file");
      console.error(error);
    } finally {
      setDeletingFile(false);
    }
  };

  const handleDownloadFile = async (file: UploadedFile) => {
    const { data, error } = await supabase.storage
      .from("uploads")
      .createSignedUrl(file.storage_path, 60);

    if (error) {
      toast.error("Failed to download file");
      console.error(error);
      return;
    }

    const link = document.createElement("a");
    link.href = data.signedUrl;
    link.download = file.original_filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleSaveComment = async (batchId: string) => {
    try {
      const { error } = await supabase
        .from("upload_batches")
        .update({ comment: commentText || null, updated_at: new Date().toISOString() })
        .eq("id", batchId);

      if (error) throw error;

      setBatches((prev) =>
        prev.map((b) =>
          b.id === batchId ? { ...b, comment: commentText || null } : b
        )
      );
      setEditingComment(null);
      toast.success("Comment updated");
      router.refresh();
    } catch (error) {
      toast.error("Failed to update comment");
      console.error(error);
    }
  };

  const openNewBatchDialog = () => {
    setNewBatchComment("");
    setShowNewBatchDialog(true);
  };

  return (
    <div
      {...getRootProps()}
      className={`relative ${isDragActive ? "ring-2 ring-primary ring-offset-2 rounded-xl" : ""}`}
    >
      <input {...getInputProps()} />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileInputChange}
      />

      {isDragActive && (
        <div className="fixed inset-0 bg-primary/10 z-50 flex items-center justify-center">
          <div className="bg-white rounded-2xl shadow-2xl p-12 text-center">
            <Upload className="h-16 w-16 text-primary mx-auto mb-4 animate-bounce" />
            <p className="text-xl font-semibold text-primary">
              Drop files here to upload
            </p>
            <p className="text-muted-foreground mt-2">
              Files will be added to a new batch
            </p>
          </div>
        </div>
      )}

      {uploading && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
          <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-sm w-full mx-4 text-center">
            <Loader2 className="h-12 w-12 text-primary mx-auto mb-4 animate-spin" />
            <p className="font-semibold text-lg">Uploading files...</p>
            <p className="text-muted-foreground mt-1">
              {uploadCurrent} of {uploadTotal} files
            </p>
            <div className="mt-4 w-full bg-gray-200 rounded-full h-2">
              <div
                className="bg-primary h-2 rounded-full transition-all duration-300"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
            <p className="text-sm text-muted-foreground mt-2">
              {uploadProgress}%
            </p>
          </div>
        </div>
      )}

      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
          <div className="relative flex-1 w-full sm:max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search batches, files, comments..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
          <div className="flex gap-2 w-full sm:w-auto">
            <Button variant="outline" onClick={open} className="flex-1 sm:flex-none">
              <Upload className="h-4 w-4 mr-2" />
              Drag & Drop
            </Button>
            <Button onClick={openNewBatchDialog} className="flex-1 sm:flex-none">
              <Plus className="h-4 w-4 mr-2" />
              New Upload
            </Button>
          </div>
        </div>

        {filteredBatches.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16">
              <FolderOpen className="h-16 w-16 text-muted-foreground/50 mb-4" />
              <h3 className="text-lg font-semibold">No upload batches</h3>
              <p className="text-muted-foreground mt-1 text-center">
                {searchQuery
                  ? "No batches match your search"
                  : "Create your first upload batch to get started"}
              </p>
              {!searchQuery && (
                <Button className="mt-4" onClick={openNewBatchDialog}>
                  <Plus className="h-4 w-4 mr-2" />
                  Create Batch
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {filteredBatches.map((batch) => {
              const isExpanded = expandedBatch === batch.id;
              const totalSize = batch.uploaded_files.reduce(
                (acc, f) => acc + f.file_size,
                0
              );
              const fileCount = batch.uploaded_files.length;

              return (
                <Card key={batch.id} className="overflow-hidden">
                  <CardHeader
                    className="cursor-pointer hover:bg-muted/50 transition-colors"
                    onClick={() =>
                      setExpandedBatch(isExpanded ? null : batch.id)
                    }
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <CardTitle className="text-base">
                            {batch.title}
                          </CardTitle>
                          <Badge variant="secondary">
                            {fileCount} {fileCount === 1 ? "file" : "files"}
                          </Badge>
                          <Badge variant="outline">
                            {formatBytes(totalSize)}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground flex-wrap">
                          <span className="flex items-center gap-1">
                            <Calendar className="h-3.5 w-3.5" />
                            {format(
                              new Date(batch.created_at),
                              "MMM d, yyyy HH:mm"
                            )}
                          </span>
                          <span className="flex items-center gap-1">
                            <User className="h-3.5 w-3.5" />
                            {batch.created_by === user.id ? "You" : batch.created_by.slice(0, 8)}
                          </span>
                        </div>
                        {editingComment === batch.id ? (
                          <div
                            className="mt-2 flex items-center gap-2"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Input
                              value={commentText}
                              onChange={(e) => setCommentText(e.target.value)}
                              placeholder="Add a comment..."
                              className="flex-1"
                              autoFocus
                            />
                            <Button
                              size="sm"
                              onClick={() => handleSaveComment(batch.id)}
                            >
                              <Check className="h-4 w-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setEditingComment(null)}
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        ) : batch.comment ? (
                          <div
                            className="mt-2 flex items-center gap-2 text-sm"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <MessageSquare className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            <span className="text-muted-foreground italic">
                              {batch.comment}
                            </span>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-1.5"
                              onClick={() => {
                                setEditingComment(batch.id);
                                setCommentText(batch.comment || "");
                              }}
                            >
                              <Edit3 className="h-3 w-3" />
                            </Button>
                          </div>
                        ) : (
                          <button
                            className="mt-2 text-sm text-muted-foreground hover:text-foreground flex items-center gap-1"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingComment(batch.id);
                              setCommentText("");
                            }}
                          >
                            <Plus className="h-3 w-3" />
                            Add comment
                          </button>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0 ml-2">
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <button
                                className="inline-flex items-center justify-center h-8 w-8 rounded-md text-sm font-medium hover:bg-muted hover:text-foreground"
                                onClick={(e) => e.stopPropagation()}
                              />
                            }
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() => {
                                setEditingComment(batch.id);
                                setCommentText(batch.comment || "");
                              }}
                            >
                              <Edit3 className="h-4 w-4 mr-2" />
                              Edit Comment
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={() => {
                                setSelectedBatchId(batch.id);
                                setShowDeleteDialog(true);
                              }}
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              Delete Batch
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                        {isExpanded ? (
                          <ChevronUp className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        )}
                      </div>
                    </div>
                  </CardHeader>

                  {isExpanded && (
                    <CardContent className="border-t">
                      {batch.uploaded_files.length === 0 ? (
                        <p className="text-center text-muted-foreground py-8">
                          No files in this batch
                        </p>
                      ) : (
                        <div className="divide-y">
                          {batch.uploaded_files.map((file) => (
                            <div
                              key={file.id}
                              className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
                            >
                              <File className="h-5 w-5 text-muted-foreground shrink-0" />
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium truncate">
                                  {file.original_filename}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {formatBytes(file.file_size)} •{" "}
                                  {file.mime_type}
                                </p>
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-8 w-8 p-0"
                                  onClick={() => handleDownloadFile(file)}
                                >
                                  <Download className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-8 w-8 p-0 text-destructive"
                                  onClick={() => {
                                    setSelectedFileId(file.id);
                                    setShowDeleteFileDialog(true);
                                  }}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </div>

      <Dialog open={showNewBatchDialog} onOpenChange={setShowNewBatchDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Upload Batch</DialogTitle>
            <DialogDescription>
              Select files to upload. They will be grouped into a single batch.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="comment">Comment (optional)</Label>
              <Textarea
                id="comment"
                placeholder="Describe what these files are about..."
                value={newBatchComment}
                onChange={(e) => setNewBatchComment(e.target.value)}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowNewBatchDialog(false)}
            >
              Cancel
            </Button>
            <Button onClick={handleSelectFiles}>
              <Upload className="h-4 w-4 mr-2" />
              Select Files
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Batch</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this batch and all its files? This
              action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDeleteDialog(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteBatch}
              disabled={deleting}
            >
              {deleting ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showDeleteFileDialog} onOpenChange={setShowDeleteFileDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete File</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this file? This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDeleteFileDialog(false)}
              disabled={deletingFile}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteFile}
              disabled={deletingFile}
            >
              {deletingFile ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
