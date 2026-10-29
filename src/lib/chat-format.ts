// Pure helpers for the chat UI (unit-tested).

export type ChatPreviewInput = {
  last_body: string | null;
  last_file_name: string | null;
  last_sender_id: string | null;
  last_deleted: boolean | null;
  kind?: string;
  last_kind?: string | null;
  last_sender_name?: string | null;
  last_meta?: SystemMeta | null;
};

/** One-line preview of a conversation's last message. */
export function messagePreview(c: ChatPreviewInput, myId: string): string {
  if (!c.last_sender_id) return "No messages yet";
  const mine = c.last_sender_id === myId;
  if (c.last_kind === "system") {
    return systemText(c.last_meta ?? null, c.last_sender_id, (id) => (id === c.last_sender_id ? c.last_sender_name ?? "Someone" : "a member"), myId);
  }
  const who = mine ? "You: " : c.kind === "group" ? `${c.last_sender_name ?? "Someone"}: ` : "";
  if (c.last_deleted) return `${who}Message unsent`;
  if (c.last_body) return `${who}${c.last_body.replace(/\s+/g, " ").trim().slice(0, 120)}`;
  if (c.last_file_name) return `${who}📎 ${c.last_file_name}`;
  return "";
}

// ---------------------------------------------------------------- names

export function personName(p: { email: string | null; display_name?: string | null } | null | undefined): string {
  return p?.display_name || p?.email || "Unknown user";
}

/** Group name, the other person, or "<me> (you)" for notes to self. */
export function chatTitle(
  c: { kind: string; title: string | null; other_id: string | null; other_email: string | null; other_name: string | null },
  myId: string
): string {
  if (c.kind === "group") return c.title ?? "Group";
  const name = personName({ email: c.other_email, display_name: c.other_name });
  return c.other_id === myId ? `${name} (you)` : name;
}

// ---------------------------------------------------------------- system messages

export type SystemMeta = {
  type?: string;
  title?: string;
  user_id?: string;
  user_ids?: string[];
  role?: string;
  value?: boolean;
  message_id?: string;
};

/** "Bob renamed the group to …": what a system message records. */
export function systemText(meta: SystemMeta | null, actorId: string, nameOf: (id: string) => string, myId: string): string {
  const actor = actorId === myId ? "You" : nameOf(actorId);
  const who = (id: string | undefined) => (!id ? "a member" : id === myId ? "you" : nameOf(id));
  switch (meta?.type) {
    case "create":
      return `${actor} created the group "${meta.title ?? ""}"`;
    case "add":
      return `${actor} added ${(meta.user_ids ?? []).map(who).join(", ") || "members"}`;
    case "remove":
      return `${actor} removed ${who(meta.user_id)}`;
    case "leave":
      return `${actor} left the group`;
    case "rename":
      return `${actor} renamed the group to "${meta.title ?? ""}"`;
    case "avatar":
      return `${actor} changed the group picture`;
    case "background":
      return `${actor} changed the background`;
    case "role":
      return meta.role === "admin" ? `${actor} made ${who(meta.user_id)} an admin` : `${actor} removed ${who(meta.user_id)} as admin`;
    case "owner":
      return `${actor} made ${who(meta.user_id)} the group owner`;
    case "admin_only":
      return meta.value
        ? `${actor} allowed only the owner and admins to change the group`
        : `${actor} allowed all members to change the group`;
    case "pin":
      return `${actor} pinned a message`;
    case "unpin":
      return `${actor} unpinned a message`;
    default:
      return `${actor} updated the group`;
  }
}

// ---------------------------------------------------------------- reactions

export const REACTIONS = ["👍", "❤️", "😆", "😮", "😭", "😡"] as const;

export function groupReactions(
  list: { emoji: string; user_id: string }[],
  myId: string
): { emoji: string; count: number; mine: boolean; userIds: string[] }[] {
  return REACTIONS.map((emoji) => {
    const userIds = list.filter((r) => r.emoji === emoji).map((r) => r.user_id);
    return { emoji: emoji as string, count: userIds.length, mine: userIds.includes(myId), userIds };
  }).filter((r) => r.count > 0);
}

// ---------------------------------------------------------------- mentions

/** The "@query" being typed at the caret, if any. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf("@");
  if (start < 0 || (start > 0 && !/\s/.test(before[start - 1]))) return null;
  const query = before.slice(start + 1);
  if (query.length > 30 || /[\n@]/.test(query)) return null;
  return { start, query };
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();

export function filterMembers<T extends { name: string; email: string | null }>(members: T[], query: string): T[] {
  const q = fold(query.trim());
  if (!q) return members;
  return members.filter((m) => fold(m.name).includes(q) || fold(m.email ?? "").includes(q));
}

/** Mentioned people whose "@Name" is still in the text. */
export function activeMentions(body: string, picked: { id: string; name: string }[]): string[] {
  return [...new Set(picked.filter((p) => body.includes(`@${p.name}`)).map((p) => p.id))];
}

/** Text split into plain parts and "@Name" mentions, for highlighting. */
export function mentionSegments(body: string, people: { id: string; name: string }[]): { text: string; userId?: string }[] {
  const names = [...people].filter((p) => p.name).sort((a, b) => b.name.length - a.name.length);
  const segments: { text: string; userId?: string }[] = [];
  let plain = "";
  let i = 0;
  while (i < body.length) {
    const hit = body[i] === "@" ? names.find((p) => body.startsWith(`@${p.name}`, i)) : undefined;
    if (hit) {
      if (plain) segments.push({ text: plain });
      plain = "";
      segments.push({ text: `@${hit.name}`, userId: hit.id });
      i += hit.name.length + 1;
    } else {
      plain += body[i];
      i += 1;
    }
  }
  if (plain) segments.push({ text: plain });
  return segments;
}

// ---------------------------------------------------------------- images

const INLINE_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/svg+xml", "image/bmp"];
export const INLINE_IMAGE_MAX = 10 * 1024 * 1024;

/** Shown in the message itself (no preview click): images browsers draw, up to 10 MB. */
export function isInlineImage(mime: string | null | undefined, size: number | null | undefined): boolean {
  return Boolean(mime && INLINE_IMAGE_TYPES.includes(mime) && size !== null && size !== undefined && size <= INLINE_IMAGE_MAX);
}

// ---------------------------------------------------------------- permissions

/** Name, picture, background and pins: everyone, unless restricted to owner/admins. */
export function canEditGroup(role: string | null | undefined, adminOnly: boolean): boolean {
  if (!role) return false;
  return !adminOnly || role === "owner" || role === "admin";
}

/** Adding and removing members: owner ("trưởng nhóm") and admins ("phó nhóm"). */
export function canManageMembers(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "Today", "Yesterday" or "Oct 1, 2026", for the separators between days. */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (sameDay(d, now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return "Yesterday";
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** Time of a message: "14:05". */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Time in a conversation list: "14:05" today, else "Oct 20". */
export function listTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  return sameDay(d, now) ? clockTime(iso) : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** Messages (oldest first) grouped by day for rendering. */
export function groupByDay<T extends { created_at: string }>(messages: T[], now: Date = new Date()): { label: string; items: T[] }[] {
  const groups: { label: string; items: T[] }[] = [];
  for (const m of messages) {
    const label = dayLabel(m.created_at, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(m);
    else groups.push({ label, items: [m] });
  }
  return groups;
}

/**
 * Milliseconds of a timestamp. Postgres ("…123456+00:00"), Realtime and the
 * browser ("…123Z") write them differently, so they are never compared as text;
 * a timestamp without a zone is UTC.
 */
export function toTime(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(/(?:[zZ]|[+-]\d\d(?::?\d\d)?)$/.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(t) ? 0 : t;
}

/** Merges fetched messages into the list by id (newer data wins), oldest first. */
export function mergeMessages<T extends { id: string; created_at: string }>(current: T[], incoming: T[]): T[] {
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => toTime(a.created_at) - toTime(b.created_at) || a.id.localeCompare(b.id));
}
