"use client";

import { useEffect, useRef, useState } from "react";
import { format } from "date-fns";
import { Loader2, MessageSquare, Pencil, SendHorizontal, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  COMMENT_MAX_LENGTH,
  addComment,
  deleteComment,
  listComments,
  updateComment,
  type CommentTarget,
  type ItemComment,
} from "@/lib/services/comments";
import { updateFolderComment } from "@/lib/services/folders";
import { can, type ItemRole } from "@/lib/file-permissions";
import { getErrorMessage } from "@/lib/types/database";

export type CommentsDialogTarget = CommentTarget & {
  name: string;
  /**
   * The caller's role on the item (see roleOf). Editors may edit the folder
   * description, admins and the owner may delete anyone's comment (enforced
   * server-side too); everyone may edit and delete their own comments.
   */
  role: ItemRole | null;
  /** Folder description (the folder's original single comment). */
  description?: string | null;
};

function isSendShortcut(e: React.KeyboardEvent) {
  return e.key === "Enter" && (e.metaKey || e.ctrlKey);
}

function CommentEditor({
  initial,
  allowEmpty = false,
  onCancel,
  onSave,
}: {
  initial: string;
  /** Saving an empty value clears it (used for the folder description). */
  allowEmpty?: boolean;
  onCancel: () => void;
  onSave: (body: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const canSave = (allowEmpty || value.trim() !== "") && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await onSave(value);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-1.5 space-y-2">
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        maxLength={COMMENT_MAX_LENGTH}
        rows={3}
        autoFocus
        onKeyDown={(e) => {
          if (isSendShortcut(e)) {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void save()} disabled={!canSave}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}

/** Thread of multi-line comments on a file or folder. */
export default function CommentsDialog({
  target,
  currentUserId,
  onOpenChange,
  onCountChange,
  onDescriptionChange,
}: {
  target: CommentsDialogTarget;
  currentUserId: string;
  onOpenChange: (open: boolean) => void;
  onCountChange?: (count: number) => void;
  onDescriptionChange?: (description: string | null) => void;
}) {
  const [comments, setComments] = useState<ItemComment[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [description, setDescription] = useState(target.description ?? null);
  const [editingDescription, setEditingDescription] = useState(false);
  const listEndRef = useRef<HTMLDivElement>(null);
  const canEditDescription = can(target.role, "rename");
  const canDeleteAny = can(target.role, "delete");

  useEffect(() => {
    let cancelled = false;
    listComments(target)
      .then((data) => {
        if (!cancelled) setComments(data);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(getErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [target]);

  // report the count after every change; functional updates below keep
  // concurrent sends and deletes from overwriting each other
  const count = comments?.length;
  const onCountChangeRef = useRef(onCountChange);
  useEffect(() => {
    onCountChangeRef.current = onCountChange;
  });
  useEffect(() => {
    if (count !== undefined) onCountChangeRef.current?.(count);
  }, [count]);

  const send = async () => {
    if (!draft.trim() || sending || !comments) return;
    setSending(true);
    try {
      const created = await addComment(target, draft);
      setComments((prev) => [...(prev ?? []), created]);
      setDraft("");
      requestAnimationFrame(() => listEndRef.current?.scrollIntoView({ block: "end" }));
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSending(false);
    }
  };

  const saveEdit = async (comment: ItemComment, body: string) => {
    await updateComment(comment.id, body);
    // the server trims surrounding whitespace; reload to show exactly what is stored
    setComments(await listComments(target));
    setEditingId(null);
  };

  const remove = async (comment: ItemComment) => {
    if (deletingId || !comments) return;
    if (!window.confirm("Delete this comment?")) return;
    setDeletingId(comment.id);
    try {
      await deleteComment(comment.id);
      setComments((prev) => (prev ?? []).filter((item) => item.id !== comment.id));
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setDeletingId(null);
    }
  };

  const saveDescription = async (body: string) => {
    const next = body.trim() || null;
    await updateFolderComment(target.id, next);
    setDescription(next);
    setEditingDescription(false);
    onDescriptionChange?.(next);
    toast.success("Description saved");
  };

  const showDescription =
    target.kind === "folder" && (description || (canEditDescription && editingDescription));

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Comments</DialogTitle>
          <DialogDescription className="line-clamp-2" title={target.name}>
            {target.name}
          </DialogDescription>
        </DialogHeader>

        {showDescription && (
          <div className="rounded-lg border bg-muted/40 px-3 py-2.5 text-sm">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted-foreground">Description</span>
              {canEditDescription && !editingDescription && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Edit description"
                  onClick={() => setEditingDescription(true)}
                >
                  <Pencil className="h-3 w-3" />
                </Button>
              )}
            </div>
            {editingDescription ? (
              <CommentEditor
                initial={description ?? ""}
                allowEmpty
                onCancel={() => setEditingDescription(false)}
                onSave={saveDescription}
              />
            ) : (
              <p className="whitespace-pre-wrap break-words">{description}</p>
            )}
          </div>
        )}
        {target.kind === "folder" && canEditDescription && !description && !editingDescription && (
          <button
            type="button"
            className="-mt-2 w-fit text-xs text-muted-foreground hover:text-foreground hover:underline"
            onClick={() => setEditingDescription(true)}
          >
            + Add a description
          </button>
        )}

        <div className="min-h-24 flex-1 overflow-y-auto -mx-1 px-1">
          {loadError ? (
            <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-center text-sm text-destructive">
              {loadError}
            </p>
          ) : comments === null ? (
            <div className="flex h-24 items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : comments.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <MessageSquare className="mb-2 h-10 w-10 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">No comments yet. Start the conversation.</p>
            </div>
          ) : (
            <ul className="space-y-4">
              {comments.map((comment) => {
                const mine = comment.author_id === currentUserId;
                const edited =
                  new Date(comment.updated_at).getTime() - new Date(comment.created_at).getTime() > 1000;
                return (
                  <li key={comment.id} className="group/comment flex gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-semibold text-white shadow-sm shadow-primary/25">
                      {comment.author_email?.charAt(0).toUpperCase() || "?"}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="min-w-0 truncate text-sm font-medium">
                          {mine ? "You" : comment.author_email ?? "Unknown user"}
                        </p>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {format(new Date(comment.created_at), "MMM d, yyyy HH:mm")}
                          {edited && " · edited"}
                        </span>
                        {editingId !== comment.id && (mine || canDeleteAny) && (
                          <div className="ml-auto flex shrink-0 gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover/comment:opacity-100 sm:focus-within:opacity-100">
                            {mine && (
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                aria-label="Edit comment"
                                onClick={() => setEditingId(comment.id)}
                              >
                                <Pencil className="h-3 w-3" />
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              className="text-destructive"
                              aria-label="Delete comment"
                              disabled={deletingId === comment.id}
                              onClick={() => void remove(comment)}
                            >
                              {deletingId === comment.id ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Trash2 className="h-3 w-3" />
                              )}
                            </Button>
                          </div>
                        )}
                      </div>
                      {editingId === comment.id ? (
                        <CommentEditor
                          initial={comment.body}
                          onCancel={() => setEditingId(null)}
                          onSave={(body) => saveEdit(comment, body)}
                        />
                      ) : (
                        <p className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed">
                          {comment.body}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <div ref={listEndRef} />
        </div>

        {!loadError && (
          <div className="space-y-2 border-t pt-3">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={COMMENT_MAX_LENGTH}
              rows={3}
              placeholder="Write a comment… (Enter for a new line)"
              aria-label="New comment"
              disabled={comments === null}
              className="max-h-48"
              onKeyDown={(e) => {
                if (isSendShortcut(e)) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {draft.length > COMMENT_MAX_LENGTH - 500
                  ? `${draft.length}/${COMMENT_MAX_LENGTH}`
                  : "Ctrl/⌘ + Enter to send"}
              </span>
              <Button size="sm" onClick={() => void send()} disabled={!draft.trim() || sending || comments === null}>
                {sending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <SendHorizontal className="h-3.5 w-3.5" />
                )}
                Comment
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
