"use client";

// The header bell: the unread count, a panel of the caller's notifications
// grouped by day, realtime toasts for new ones, and the account switch for
// device push about activity (shares, comments, documents).

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Popover } from "@base-ui/react/popover";
import { Switch } from "@base-ui/react/switch";
import { formatDistanceToNow } from "date-fns";
import { Bell, Building2, CheckCheck, FileText, Loader2, MessageSquare, Share2, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { groupByDay, notificationIcon, safeLink, type NotificationRow } from "@/lib/notifications";
import {
  getActivityPush,
  listNotifications,
  markRead,
  setActivityPush,
  subscribeNotifications,
  unreadCount,
} from "@/lib/services/notifications";
import { getErrorMessage } from "@/lib/types/database";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 20;

// lucide components for the names in NOTIFICATION_KIND_ICONS
const ICONS: Record<string, LucideIcon> = { Share2, MessageSquare, FileText, Building2, Bell };

function KindIcon({ kind, className }: { kind: string; className?: string }) {
  const Icon = ICONS[notificationIcon(kind)] ?? Bell;
  return <Icon className={className} aria-hidden="true" />;
}

function badgeText(count: number): string {
  return count > 99 ? "99+" : String(count);
}

function relativeTime(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : formatDistanceToNow(at, { addSuffix: true });
}

/** Newest first, one row per id; `incoming` replaces rows it already has. */
function mergeRows(current: NotificationRow[], incoming: NotificationRow[]): NotificationRow[] {
  const byId = new Map(current.map((row) => [row.id, row]));
  for (const row of incoming) byId.set(row.id, row);
  const at = (row: NotificationRow) => Date.parse(row.created_at) || 0;
  // the RPC and Realtime may format timestamps differently: compare instants first
  return [...byId.values()].sort(
    (a, b) => at(b) - at(a) || b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)
  );
}

export function NotificationBell({ userId }: { userId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  /** null until read from user_preferences */
  const [push, setPush] = useState<boolean | null>(null);
  const [savingPush, setSavingPush] = useState(false);
  // ids already shown: a realtime insert can race the first page
  const seen = useRef(new Set<string>());
  // ids marked read here: a toast keeps the row as it arrived, unread
  const markedRead = useRef(new Set<string>());

  // marks the row read (optimistically) and goes to its link
  const openNotification = useCallback(
    (row: NotificationRow, close = true) => {
      if (close) setOpen(false);
      if (!row.read_at && !markedRead.current.has(row.id)) {
        markedRead.current.add(row.id);
        const readAt = new Date().toISOString();
        setItems((current) => current.map((r) => (r.id === row.id ? { ...r, read_at: readAt } : r)));
        setUnread((count) => Math.max(0, count - 1));
        markRead([row.id]).catch((e) => toast.error(getErrorMessage(e)));
      }
      router.push(safeLink(row.link));
    },
    [router]
  );

  // the first page and the count; merges, so older pages already shown stay
  const refresh = useCallback(
    () =>
      Promise.all([listNotifications({ limit: PAGE_SIZE }), unreadCount()])
        .then(([rows, count]) => {
          for (const row of rows) seen.current.add(row.id);
          setItems((current) => mergeRows(current, rows));
          setUnread(count);
          setHasMore((more) => more || rows.length === PAGE_SIZE);
          setError(null);
        })
        .catch((e) => setError(getErrorMessage(e)))
        .finally(() => setLoading(false)),
    []
  );

  useEffect(() => {
    let active = true;
    void refresh();
    const unsubscribe = subscribeNotifications(userId, (row) => {
      if (!active || seen.current.has(row.id)) return;
      seen.current.add(row.id);
      setItems((current) => mergeRows(current, [row]));
      if (!row.read_at) setUnread((count) => count + 1);
      toast(row.title, {
        description: row.body ?? undefined,
        action: row.link
          ? {
              label: "Open",
              onClick: () => openNotification(row, false),
            }
          : undefined,
      });
    });
    // realtime misses what arrived while the tab slept or was offline
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [userId, refresh, openNotification]);

  async function markAllRead() {
    setMarkingAll(true);
    try {
      await markRead();
      for (const row of items) markedRead.current.add(row.id);
      const readAt = new Date().toISOString();
      setItems((current) => current.map((r) => (r.read_at ? r : { ...r, read_at: readAt })));
      setUnread(0);
    } catch (e) {
      toast.error(getErrorMessage(e));
    } finally {
      setMarkingAll(false);
    }
  }

  async function showOlder() {
    const oldest = items[items.length - 1];
    if (!oldest) return;
    setLoadingMore(true);
    try {
      const rows = await listNotifications({ before: oldest.created_at, limit: PAGE_SIZE });
      for (const row of rows) seen.current.add(row.id);
      setItems((current) => mergeRows(current, rows));
      setHasMore(rows.length === PAGE_SIZE);
    } catch (e) {
      toast.error(getErrorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  }

  async function changePush(on: boolean) {
    const before = push;
    setPush(on);
    setSavingPush(true);
    try {
      await setActivityPush(on);
    } catch (e) {
      setPush(before);
      toast.error(getErrorMessage(e));
    } finally {
      setSavingPush(false);
    }
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next && push === null) {
      getActivityPush()
        .then(setPush)
        .catch(() => setPush(true));
    }
  }

  const label = unread > 0 ? `Notifications, ${unread} unread` : "Notifications";
  const groups = groupByDay(items);

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger
        aria-label={label}
        className="relative inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-popup-open:bg-muted data-popup-open:text-foreground"
      >
        <Bell className="size-5" aria-hidden="true" />
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-destructive px-1 text-[10px] leading-none font-semibold text-white ring-2 ring-background tabular-nums"
          >
            {badgeText(unread)}
          </span>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} collisionPadding={0} className="isolate z-50 outline-none">
          <Popover.Popup
            className="flex max-h-[min(36rem,var(--available-height))] w-screen origin-(--transform-origin) flex-col overflow-hidden border-y bg-popover text-popover-foreground shadow-lg outline-none transition-[scale,opacity] duration-100 ease-out data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0 sm:w-96 sm:rounded-xl sm:border sm:ring-1 sm:ring-foreground/5"
          >
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <Popover.Title className="text-sm font-semibold">Notifications</Popover.Title>
              {unread > 0 && (
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary tabular-nums">
                  {unread} new
                </span>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                onClick={markAllRead}
                disabled={unread === 0 || markingAll}
              >
                {markingAll ? <Loader2 className="animate-spin" aria-hidden="true" /> : <CheckCheck aria-hidden="true" />}
                Mark all as read
              </Button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-busy={loading}>
              {loading && items.length === 0 ? (
                <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  Loading…
                </div>
              ) : error && items.length === 0 ? (
                <div className="flex flex-col items-center gap-3 px-4 py-10 text-center text-sm text-muted-foreground">
                  <p role="alert">{error}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setLoading(true);
                      void refresh();
                    }}
                  >
                    Try again
                  </Button>
                </div>
              ) : items.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground">
                  <CheckCheck className="size-6" aria-hidden="true" />
                  <p>You&apos;re all caught up.</p>
                </div>
              ) : (
                <>
                  {groups.map((group) => (
                    <section key={group.label} aria-label={group.label}>
                      <h3 className="sticky top-0 z-10 bg-popover/95 px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground backdrop-blur">
                        {group.label}
                      </h3>
                      <ul className="px-2 pb-1">
                        {group.items.map((row) => (
                          <li key={row.id}>
                            <button
                              type="button"
                              onClick={() => openNotification(row)}
                              className={cn(
                                "flex w-full items-start gap-3 rounded-lg px-2 py-2.5 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50",
                                !row.read_at && "bg-primary/5"
                              )}
                            >
                              <span
                                className={cn(
                                  "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full",
                                  row.read_at ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary"
                                )}
                              >
                                <KindIcon kind={row.kind} className="size-4" />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className={cn("block text-sm break-words", !row.read_at && "font-medium")}>
                                  {row.title}
                                </span>
                                {row.body && (
                                  <span className="mt-0.5 line-clamp-2 block text-xs break-words text-muted-foreground">
                                    {row.body}
                                  </span>
                                )}
                                <span className="mt-1 block text-xs text-muted-foreground">
                                  {row.actor_name ? `${row.actor_name} · ` : ""}
                                  <time dateTime={row.created_at}>{relativeTime(row.created_at)}</time>
                                </span>
                              </span>
                              {!row.read_at && (
                                <span className="mt-2 size-2 shrink-0 rounded-full bg-primary">
                                  <span className="sr-only">Unread</span>
                                </span>
                              )}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                  {hasMore && (
                    <div className="px-4 pt-1 pb-3">
                      <Button variant="outline" size="sm" className="w-full" onClick={showOlder} disabled={loadingMore}>
                        {loadingMore && <Loader2 className="animate-spin" aria-hidden="true" />}
                        Show older
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>

            <label className="flex items-center gap-3 border-t px-4 py-3 text-sm">
              <span className="min-w-0 flex-1">
                <span className="block font-medium">Push notifications for activity</span>
                <span className="block text-xs text-muted-foreground">
                  Shares, comments and documents, on devices where you allowed notifications.
                </span>
              </span>
              <Switch.Root
                checked={push ?? true}
                onCheckedChange={(checked) => void changePush(checked)}
                disabled={push === null || savingPush}
                className="relative flex h-5 w-9 shrink-0 items-center rounded-full bg-input p-0.5 outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 data-checked:bg-primary data-disabled:opacity-50"
              >
                <Switch.Thumb className="size-4 rounded-full bg-background shadow-sm transition-transform data-checked:translate-x-4" />
              </Switch.Root>
            </label>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
