"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "react-hot-toast";
import { format } from "date-fns";
import { Check, Copy, Link2, Loader2, Trash2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createShareLink,
  deleteShareLink,
  listFileShares,
  listFolderShares,
  listShareLinks,
  removeShare,
  setShareLinkDisabled,
  shareFile,
  shareFolder,
  shareLinkUrl,
  updateShareRole,
  type ShareEntry,
  type ShareLink,
  type ShareRoleInput,
} from "@/lib/services/sharing";
import { getErrorMessage } from "@/lib/types/database";

export default function ShareDialog({
  open,
  onOpenChange,
  kind,
  resourceId,
  resourceName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: "file" | "folder";
  resourceId: string;
  resourceName: string;
}) {
  const [shares, setShares] = useState<ShareEntry[] | null>(null);
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ShareRoleInput>("viewer");
  const [inviting, setInviting] = useState(false);
  const [busyShareId, setBusyShareId] = useState<string | null>(null);

  const [linkPassword, setLinkPassword] = useState("");
  const [linkExpiry, setLinkExpiry] = useState("");
  const [linkAllowDownload, setLinkAllowDownload] = useState(true);
  const [creatingLink, setCreatingLink] = useState(false);
  const [busyLinkId, setBusyLinkId] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const shareList =
        kind === "file"
          ? await listFileShares(resourceId)
          : await listFolderShares(resourceId);
      setShares(shareList);
    } catch (err) {
      setShares([]);
      toast.error(getErrorMessage(err));
    }
    if (kind === "file") {
      try {
        setLinks(await listShareLinks(resourceId));
      } catch {
        setLinks([]);
      }
    }
  }, [kind, resourceId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const shareList =
          kind === "file"
            ? await listFileShares(resourceId)
            : await listFolderShares(resourceId);
        if (!cancelled) setShares(shareList);
      } catch (err) {
        if (!cancelled) {
          setShares([]);
          toast.error(getErrorMessage(err));
        }
      }
      if (kind === "file") {
        try {
          const linkList = await listShareLinks(resourceId);
          if (!cancelled) setLinks(linkList);
        } catch {
          if (!cancelled) setLinks([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, resourceId]);

  const invite = async () => {
    const trimmed = email.trim();
    if (!trimmed || inviting) return;
    setInviting(true);
    try {
      if (kind === "file") {
        await shareFile(resourceId, trimmed, role);
      } else {
        await shareFolder(resourceId, trimmed, role);
      }
      toast.success(`Shared with ${trimmed}`);
      setEmail("");
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setInviting(false);
    }
  };

  const changeRole = async (share: ShareEntry, nextRole: ShareRoleInput) => {
    setBusyShareId(share.share_id);
    try {
      await updateShareRole(kind, share.share_id, nextRole);
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusyShareId(null);
    }
  };

  const unshare = async (share: ShareEntry) => {
    setBusyShareId(share.share_id);
    try {
      await removeShare(kind, share.share_id);
      toast.success(`Removed ${share.grantee_email}`);
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusyShareId(null);
    }
  };

  const createLink = async () => {
    if (kind !== "file" || creatingLink) return;
    setCreatingLink(true);
    try {
      await createShareLink(resourceId, {
        password: linkPassword || null,
        allowDownload: linkAllowDownload,
        expiresAt: linkExpiry
          ? new Date(`${linkExpiry}T23:59:59`).toISOString()
          : null,
      });
      toast.success("Share link created");
      setLinkPassword("");
      setLinkExpiry("");
      setLinkAllowDownload(true);
      setLinks(await listShareLinks(resourceId));
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setCreatingLink(false);
    }
  };

  const toggleLink = async (link: ShareLink) => {
    setBusyLinkId(link.link_id);
    try {
      await setShareLinkDisabled(link.link_id, !link.disabled);
      setLinks(await listShareLinks(resourceId));
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusyLinkId(null);
    }
  };

  const deleteLink = async (link: ShareLink) => {
    setBusyLinkId(link.link_id);
    try {
      await deleteShareLink(link.link_id);
      toast.success("Link deleted");
      setLinks(await listShareLinks(resourceId));
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusyLinkId(null);
    }
  };

  const copyLink = async (link: ShareLink) => {
    try {
      await navigator.clipboard.writeText(shareLinkUrl(link.token));
      setCopiedToken(link.token);
      setTimeout(() => setCopiedToken(null), 2000);
    } catch {
      toast.error("Could not copy link");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Share {kind}</DialogTitle>
          <DialogDescription className="truncate">{resourceName}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-3">
            <h4 className="text-sm font-medium">Share with users</h4>
            <div className="flex gap-2">
              <Input
                type="email"
                placeholder="user@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void invite();
                  }
                }}
                className="flex-1"
              />
              <Select value={role} onValueChange={(v) => v && setRole(v as ShareRoleInput)}>
                <SelectTrigger className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="viewer">Viewer</SelectItem>
                  <SelectItem value="editor">Editor</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
              <Button onClick={() => void invite()} disabled={inviting || !email.trim()}>
                <UserPlus className="h-4 w-4" />
              </Button>
            </div>

            {shares === null ? (
              <div className="flex justify-center py-3">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : shares.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Not shared with anyone yet.
              </p>
            ) : (
              <div className="space-y-1 max-h-40 overflow-auto">
                {shares.map((share) => (
                  <div
                    key={share.share_id}
                    className="flex items-center gap-2 rounded-md border px-2 py-1.5"
                  >
                    <span className="flex-1 text-sm truncate">{share.grantee_email}</span>
                    <Select
                      value={share.role}
                      onValueChange={(v) => v && void changeRole(share, v as ShareRoleInput)}
                    >
                      <SelectTrigger className="w-24 h-7 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="viewer">Viewer</SelectItem>
                        <SelectItem value="editor">Editor</SelectItem>
                        <SelectItem value="admin">Admin</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-destructive"
                      onClick={() => void unshare(share)}
                      disabled={busyShareId === share.share_id}
                      aria-label={`Remove ${share.grantee_email}`}
                    >
                      {busyShareId === share.share_id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {kind === "file" && (
            <div className="space-y-3 border-t pt-4">
              <h4 className="text-sm font-medium flex items-center gap-1.5">
                <Link2 className="h-4 w-4" />
                Share links
              </h4>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">Password (optional)</Label>
                  <Input
                    type="text"
                    placeholder="None"
                    value={linkPassword}
                    onChange={(e) => setLinkPassword(e.target.value)}
                    className="h-8 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Expires (optional)</Label>
                  <Input
                    type="date"
                    value={linkExpiry}
                    min={format(new Date(), "yyyy-MM-dd")}
                    onChange={(e) => setLinkExpiry(e.target.value)}
                    className="h-8 text-sm"
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={linkAllowDownload}
                  onChange={(e) => setLinkAllowDownload(e.target.checked)}
                  className="rounded border-input"
                />
                Allow download
              </label>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void createLink()}
                disabled={creatingLink}
              >
                {creatingLink ? "Creating..." : "Create link"}
              </Button>

              {links === null ? (
                <div className="flex justify-center py-3">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : links.length === 0 ? (
                <p className="text-xs text-muted-foreground">No links created.</p>
              ) : (
                <div className="space-y-1 max-h-40 overflow-auto">
                  {links.map((link) => (
                    <div
                      key={link.link_id}
                      className="flex items-center gap-2 rounded-md border px-2 py-1.5"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-mono truncate">
                          /share/{link.token.slice(0, 12)}...
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          {link.has_password ? "password • " : ""}
                          {link.expires_at
                            ? `expires ${format(new Date(link.expires_at), "MMM d, yyyy")}`
                            : "no expiry"}
                          {link.allow_download ? "" : " • view only"}
                          {` • ${link.view_count} views`}
                        </p>
                      </div>
                      {link.disabled && <Badge variant="secondary">disabled</Badge>}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => void copyLink(link)}
                        aria-label="Copy link"
                      >
                        {copiedToken === link.token ? (
                          <Check className="h-3.5 w-3.5 text-green-600" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-1.5 text-xs"
                        onClick={() => void toggleLink(link)}
                        disabled={busyLinkId === link.link_id}
                      >
                        {link.disabled ? "Enable" : "Disable"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-destructive"
                        onClick={() => void deleteLink(link)}
                        disabled={busyLinkId === link.link_id}
                        aria-label="Delete link"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
