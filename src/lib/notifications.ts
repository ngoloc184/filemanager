// Notification center helpers shared by the bell, the notifications page and
// the push route. Pure: no React, no Supabase, so node:test can run them.

/** A row of list_notifications (202608280035_notifications.sql). */
export type NotificationRow = {
  id: string;
  kind: string;
  entity_type: "file" | "folder" | "document" | "chat" | "org" | "dossier" | null;
  entity_id: string | null;
  title: string;
  body: string | null;
  link: string | null;
  created_at: string;
  read_at: string | null;
  actor_id: string | null;
  actor_name: string | null;
};

/** lucide icon name by the first segment of the kind ("share.file" → "share"). */
export const NOTIFICATION_KIND_ICONS: Record<string, string> = {
  share: "Share2",
  comment: "MessageSquare",
  document: "FileText",
  org: "Building2",
};

export const DEFAULT_NOTIFICATION_ICON = "Bell";

export function notificationIcon(kind: string): string {
  const prefix = kind.split(".")[0] ?? "";
  return Object.hasOwn(NOTIFICATION_KIND_ICONS, prefix) ? NOTIFICATION_KIND_ICONS[prefix] : DEFAULT_NOTIFICATION_ICON;
}

export type DayLabel = "Today" | "Yesterday" | "Earlier";

/**
 * Splits rows (newest first) into Today / Yesterday / Earlier by the local
 * calendar day of `now`; empty groups are left out and the order is kept.
 */
export function groupByDay<T extends { created_at: string }>(rows: T[], now: Date = new Date()): { label: DayLabel; items: T[] }[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  const groups: Record<DayLabel, T[]> = { Today: [], Yesterday: [], Earlier: [] };
  for (const row of rows) {
    const at = Date.parse(row.created_at);
    const label: DayLabel = Number.isNaN(at) || at < yesterday ? "Earlier" : at < today ? "Yesterday" : "Today";
    groups[label].push(row);
  }
  return (["Today", "Yesterday", "Earlier"] as const)
    .filter((label) => groups[label].length > 0)
    .map((label) => ({ label, items: groups[label] }));
}

/**
 * An in-app path to open, or "/dashboard". Only paths on this site are kept:
 * "//host" and "/\host" are other sites to a browser, and so are full URLs.
 */
export function safeLink(link: string | null | undefined): string {
  if (typeof link !== "string" || !link.startsWith("/")) return "/dashboard";
  if (link.startsWith("//") || link.startsWith("/\\")) return "/dashboard";
  // browsers drop tabs and line breaks from URLs: "/\t/host" would become "//host"
  for (let i = 0; i < link.length; i++) {
    if (link.charCodeAt(i) < 0x20 || link.charCodeAt(i) === 0x7f) return "/dashboard";
  }
  return link;
}
