"use client";

import { useCallback, useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  File,
  Folder as FolderIcon,
  History,
  Link2,
  Share2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { listActivity, type ActivityEvent } from "@/lib/services/activity";
import { getErrorMessage } from "@/lib/types/database";
import { cn } from "@/lib/utils";

function actionLabel(action: string): string {
  switch (action) {
    case "file.created":
      return "added file";
    case "file.deleted":
      return "moved file to trash";
    case "file.restored":
      return "restored file";
    case "file.moved":
      return "moved file";
    case "file.renamed":
      return "renamed file";
    case "file.visibility_changed":
      return "changed visibility of";
    case "file.hard_deleted":
      return "permanently deleted file";
    case "file.version_added":
      return "uploaded a new version of";
    case "file.version_restored":
      return "restored a version of";
    case "folder.created":
      return "created folder";
    case "folder.deleted":
      return "moved folder to trash";
    case "folder.restored":
      return "restored folder";
    case "folder.moved":
      return "moved folder";
    case "folder.renamed":
      return "renamed folder";
    case "folder.hard_deleted":
      return "permanently deleted folder";
    case "share.granted":
      return "shared";
    case "share.updated":
      return "updated access to";
    case "share.revoked":
      return "removed access to";
    case "link.created":
      return "created a share link for";
    case "link.disabled":
      return "disabled a share link for";
    case "link.enabled":
      return "enabled a share link for";
    case "link.deleted":
      return "deleted a share link for";
    default:
      return action.replace(".", " ");
  }
}

function ActivityIcon({ event }: { event: ActivityEvent }) {
  const className = "h-4 w-4";
  if (event.resource_type === "folder")
    return <FolderIcon className={cn(className, "text-primary")} />;
  if (event.resource_type === "share")
    return <Share2 className={cn(className, "text-emerald-600")} />;
  if (event.resource_type === "link")
    return <Link2 className={cn(className, "text-sky-600")} />;
  return <File className={cn(className, "text-muted-foreground")} />;
}

export default function ActivityClient({
  user,
}: {
  user: { id: string; email?: string };
}) {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setEvents(await listActivity(80));
    } catch (err) {
      setError(getErrorMessage(err));
      setEvents([]);
    }
  }, []);

  useEffect(() => {
    // initial activity load
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const loading = events === null && !error;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold">Activity</h2>
        <p className="text-muted-foreground mt-1">
          Recent actions on your files, folders, and shares.
        </p>
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <div
              key={index}
              className="h-14 rounded-xl border bg-muted/40 animate-pulse"
            />
          ))}
        </div>
      ) : error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-8 text-center">
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="outline" className="mt-4" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : events && events.length === 0 ? (
        <div className="rounded-xl border bg-white flex flex-col items-center justify-center py-16 px-4">
          <History className="h-16 w-16 text-muted-foreground/50 mb-4" />
          <h3 className="text-lg font-semibold">No activity yet</h3>
          <p className="text-muted-foreground mt-1 text-center">
            Upload, move, share, or delete files to see activity here.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border bg-white divide-y">
          {(events ?? []).map((event) => {
            const actor =
              event.actor_id === user.id
                ? "You"
                : event.actor_email || "Someone";
            const metadata = event.metadata as {
              grantee_email?: string;
              role?: string;
              version_no?: number;
              old_name?: string;
            };
            const suffix =
              event.action === "share.granted" && metadata.grantee_email
                ? ` with ${metadata.grantee_email} as ${metadata.role ?? "viewer"}`
                : event.action === "share.updated" && metadata.grantee_email
                  ? ` for ${metadata.grantee_email} to ${metadata.role ?? "viewer"}`
                  : event.action === "file.version_added" && metadata.version_no
                    ? ` (v${metadata.version_no})`
                    : event.action === "file.version_restored" && metadata.version_no
                      ? ` (v${metadata.version_no})`
                      : event.action === "file.renamed" && metadata.old_name
                        ? ` from "${metadata.old_name}"`
                        : "";

            return (
              <div key={event.id} className="flex items-start gap-3 px-4 py-3">
                <div className="mt-0.5">
                  <ActivityIcon event={event} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm">
                    <span className="font-medium">{actor}</span>{" "}
                    {actionLabel(event.action)}
                    {event.resource_name ? (
                      <>
                        {" "}
                        <span className="font-medium">
                          &quot;{event.resource_name}&quot;
                        </span>
                      </>
                    ) : null}
                    {suffix}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {formatDistanceToNow(new Date(event.created_at), {
                      addSuffix: true,
                    })}
                  </p>
                </div>
                {event.actor_id !== user.id && event.actor_email && (
                  <span className="text-xs text-muted-foreground shrink-0">
                    by {event.actor_email}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
