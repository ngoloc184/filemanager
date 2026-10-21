// Pure helpers for the chat UI (unit-tested).

export type ChatPreviewInput = {
  last_body: string | null;
  last_file_name: string | null;
  last_sender_id: string | null;
  last_deleted: boolean | null;
};

/** One-line preview of a conversation's last message. */
export function messagePreview(c: ChatPreviewInput, myId: string): string {
  if (!c.last_sender_id) return "No messages yet";
  const who = c.last_sender_id === myId ? "You: " : "";
  if (c.last_deleted) return `${who}Message unsent`;
  if (c.last_body) return `${who}${c.last_body.replace(/\s+/g, " ").trim().slice(0, 120)}`;
  if (c.last_file_name) return `${who}📎 ${c.last_file_name}`;
  return "";
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

/** Merges fetched messages into the list by id (newer data wins), oldest first. */
export function mergeMessages<T extends { id: string; created_at: string }>(current: T[], incoming: T[]): T[] {
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}
