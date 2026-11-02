"use client";

import { useState } from "react";
import { Mail, X } from "lucide-react";
import { toast } from "sonner";

const EMAIL_RE = /^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$/;
const MAX = 50;

/** Addresses of one role as chips; type or paste one or more (comma, space or Enter separated). */
export function EmailChips({ roleName, emails, onSave }: { roleName: string; emails: string[]; onSave: (emails: string[]) => Promise<string | null> }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(next: string[]) {
    setBusy(true);
    const error = await onSave(next);
    setBusy(false);
    if (error) toast.error(error);
    return !error;
  }

  async function add() {
    const parts = draft.split(/[\s,;]+/).map((p) => p.trim().toLowerCase()).filter(Boolean);
    if (!parts.length) return;
    const bad = parts.filter((p) => !EMAIL_RE.test(p));
    if (bad.length) return void toast.error(`Email không hợp lệ: ${bad.join(", ")}`);
    const next = [...new Set([...emails, ...parts])];
    if (next.length > MAX) return void toast.error(`Tối đa ${MAX} email cho một vai trò`);
    if (await save(next)) setDraft("");
  }

  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1 rounded-lg border border-input bg-background px-1.5 py-1 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
      {emails.map((e) => (
        <span key={e} className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs">
          <Mail className="size-3 text-muted-foreground" />
          {e}
          <button type="button" aria-label={`Bỏ ${e}`} disabled={busy} onClick={() => void save(emails.filter((x) => x !== e))} className="rounded text-muted-foreground hover:text-destructive">
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            void add();
          } else if (e.key === "Backspace" && !draft && emails.length) void save(emails.slice(0, -1));
        }}
        onBlur={() => draft.trim() && void add()}
        aria-label={`Thêm email cho ${roleName}`}
        placeholder={emails.length ? "Thêm email…" : "Nhập email, Enter để thêm"}
        className="h-6 min-w-36 flex-1 bg-transparent px-1 text-xs outline-none"
        inputMode="email"
      />
    </div>
  );
}
