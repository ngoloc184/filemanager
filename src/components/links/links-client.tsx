"use client";

import { useCallback, useEffect, useState } from "react";
import { format } from "date-fns";
import { toast } from "sonner";
import {
  Copy,
  ExternalLink,
  Link2,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  createSavedLink,
  deleteSavedLink,
  listSavedLinks,
  updateSavedLink,
} from "@/lib/services/links";
import {
  LINK_TITLE_MAX,
  displayUrl,
  validateLink,
  type LinkInput,
} from "@/lib/saved-links";
import { getErrorMessage, type SavedLink } from "@/lib/types/database";
import { cn, ENTER_ANIMATION, staggerDelay } from "@/lib/utils";

function LinkTile() {
  return (
    <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary ring-1 ring-inset ring-primary/20">
      <Link2 className="h-[18px] w-[18px]" />
    </span>
  );
}

async function copyUrl(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    toast.success("Link copied");
  } catch {
    toast.error("Could not copy the link");
  }
}

function LinkDialog({
  open,
  onOpenChange,
  initial,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: LinkInput | null;
  onSubmit: (input: LinkInput) => Promise<void>;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [fieldError, setFieldError] = useState<{ field: "title" | "url"; message: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (submitting) return;
    const result = validateLink({ title, url });
    if (!result.ok) {
      setFieldError({ field: result.field, message: result.message });
      return;
    }
    setFieldError(null);
    setSubmitting(true);
    try {
      await onSubmit(result.value);
      onOpenChange(false);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") void submit();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{initial ? "Edit link" : "New link"}</DialogTitle>
          <DialogDescription>
            Save a URL you need often, with a title to recognise it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="link-title">Title</Label>
            <Input
              id="link-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Daily progress update"
              maxLength={LINK_TITLE_MAX}
              autoFocus
              aria-invalid={fieldError?.field === "title" || undefined}
              onKeyDown={onEnter}
            />
            {fieldError?.field === "title" && (
              <p className="text-xs text-destructive">{fieldError.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="link-url">URL</Label>
            <Input
              id="link-url"
              type="url"
              inputMode="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/..."
              aria-invalid={fieldError?.field === "url" || undefined}
              onKeyDown={onEnter}
            />
            {fieldError?.field === "url" && (
              <p className="text-xs text-destructive">{fieldError.message}</p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!title.trim() || !url.trim() || submitting}
          >
            {submitting ? "Saving..." : initial ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteLinkDialog({
  link,
  onOpenChange,
  onConfirm,
}: {
  link: SavedLink;
  onOpenChange: (open: boolean) => void;
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
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete link</DialogTitle>
          <DialogDescription>
            Delete &quot;{link.title}&quot;? This cannot be undone.
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

export default function LinksClient() {
  const [links, setLinks] = useState<SavedLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [editTarget, setEditTarget] = useState<SavedLink | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SavedLink | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setLinks(await listSavedLinks());
    } catch (err) {
      setError(getErrorMessage(err));
      setLinks([]);
    }
  }, []);

  useEffect(() => {
    // initial saved links load
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const handleCreate = async (input: LinkInput) => {
    const created = await createSavedLink(input);
    setLinks((prev) => [created, ...(prev ?? [])]);
    toast.success("Link saved");
  };

  const handleUpdate = async (input: LinkInput) => {
    if (!editTarget) return;
    const updated = await updateSavedLink(editTarget.id, input);
    setLinks((prev) => (prev ?? []).map((link) => (link.id === updated.id ? updated : link)));
    toast.success("Link updated");
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await deleteSavedLink(deleteTarget.id);
    setLinks((prev) => (prev ?? []).filter((link) => link.id !== deleteTarget.id));
    toast.success("Link deleted");
  };

  const query = filter.trim().toLowerCase();
  const visible = (links ?? []).filter(
    (link) =>
      !query ||
      link.title.toLowerCase().includes(query) ||
      link.url.toLowerCase().includes(query)
  );
  const loading = links === null && !error;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold">Saved links</h2>
        <p className="text-muted-foreground mt-1">
          Keep the URLs you open often in one place. Only you can see them.
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <div className="relative flex-1 w-full sm:max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Filter links..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="pl-10"
          />
        </div>
        <Button variant="brand" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4 mr-1" />
          New link
        </Button>
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
      ) : visible.length === 0 ? (
        <div className="rounded-2xl border border-dashed bg-card/70 backdrop-blur flex flex-col items-center justify-center py-16 px-4">
          <Link2 className="h-16 w-16 text-muted-foreground/50 mb-4" />
          <h3 className="text-lg font-semibold">{query ? "No matches" : "No saved links yet"}</h3>
          <p className="text-muted-foreground mt-1 text-center">
            {query
              ? "Try a different filter."
              : "Save a link with a title, e.g. “Daily progress update”."}
          </p>
          {!query && (
            <Button variant="brand" className="mt-6" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4 mr-2" />
              New link
            </Button>
          )}
        </div>
      ) : (
        <div className="rounded-2xl border bg-card/80 backdrop-blur shadow-sm divide-y overflow-hidden">
          {visible.map((link, index) => (
            <div
              key={link.id}
              className={cn(
                "group/row relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-primary/[0.04] before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-brand before:opacity-0 before:transition-opacity hover:before:opacity-100",
                ENTER_ANIMATION
              )}
              style={staggerDelay(index)}
            >
              <LinkTile />
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 min-w-0 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <p className="text-sm font-medium truncate">{link.title}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {displayUrl(link.url)} • {format(new Date(link.created_at), "MMM d, yyyy")}
                </p>
              </a>
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                aria-label={`Copy ${link.title}`}
                onClick={() => void copyUrl(link.url)}
              >
                <Copy className="h-4 w-4" />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <button
                      className="inline-flex items-center justify-center h-8 w-8 rounded-md text-sm hover:bg-muted hover:text-foreground"
                      aria-label={`Actions for ${link.title}`}
                    />
                  }
                >
                  <MoreHorizontal className="h-4 w-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() => window.open(link.url, "_blank", "noopener,noreferrer")}
                  >
                    <ExternalLink className="h-4 w-4 mr-2" />
                    Open
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void copyUrl(link.url)}>
                    <Copy className="h-4 w-4 mr-2" />
                    Copy URL
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setEditTarget(link)}>
                    <Pencil className="h-4 w-4 mr-2" />
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive" onClick={() => setDeleteTarget(link)}>
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
        </div>
      )}

      {creating && (
        <LinkDialog open onOpenChange={setCreating} initial={null} onSubmit={handleCreate} />
      )}
      {editTarget && (
        <LinkDialog
          open
          onOpenChange={(open) => {
            if (!open) setEditTarget(null);
          }}
          initial={{ title: editTarget.title, url: editTarget.url }}
          onSubmit={handleUpdate}
        />
      )}
      {deleteTarget && (
        <DeleteLinkDialog
          link={deleteTarget}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
          onConfirm={handleDelete}
        />
      )}
    </div>
  );
}
