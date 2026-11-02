"use client";

import { useEffect, useState } from "react";
import { invalidateStickerCatalog } from "@/lib/stickers/load";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { StickerThumb } from "@/components/admin/stickers/sticker-thumb";
import { Switch } from "@/components/admin/stickers/switch";
import { listHiddenGroups, setGroupHidden } from "@/lib/services/stickers-admin";
import { STICKER_GROUPS, type Sticker } from "@/lib/stickers/suggest";
import { getErrorMessage } from "@/lib/types/database";

async function loadCounts(): Promise<Record<string, number>> {
  const list = (await import("@/lib/stickers/fluent.json")).default as Sticker[];
  const counts: Record<string, number> = {};
  for (const s of list) counts[s.group] = (counts[s.group] ?? 0) + 1;
  return counts;
}

/** One switch per built-in Fluent group: hidden groups leave everyone's picker. */
export function BuiltinGroupsPanel() {
  const [hidden, setHidden] = useState<Set<string> | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (hidden) invalidateStickerCatalog();
  }, [hidden]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listHiddenGroups(), loadCounts()])
      .then(([groups, byGroup]) => {
        if (cancelled) return;
        setHidden(new Set(groups));
        setCounts(byGroup);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(getErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const toggle = async (key: string, label: string, shown: boolean) => {
    if (!hidden || saving) return;
    setSaving(key);
    try {
      await setGroupHidden(key, !shown);
      setHidden((prev) => {
        const next = new Set(prev);
        if (shown) next.delete(key);
        else next.add(key);
        return next;
      });
      toast.success(shown ? `${label} shown in the picker` : `${label} hidden from the picker`);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const shownCount = hidden ? STICKER_GROUPS.filter((g) => !hidden.has(g.key)).length : 0;

  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-sm text-muted-foreground">
        The built-in Fluent 3D stickers{total ? ` (${total.toLocaleString("en-US")} in ${STICKER_GROUPS.length} groups)` : ""}.
        A hidden group disappears from the picker and suggestions for everyone; stickers already sent stay visible.
      </p>

      {error ? (
        <div className="space-y-2">
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
          <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        </div>
      ) : !hidden ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Loading groups…
        </div>
      ) : (
        <>
          <p className="text-sm" role="status">
            {shownCount} of {STICKER_GROUPS.length} groups shown
          </p>
          <ul className="divide-y rounded-xl border">
            {STICKER_GROUPS.map((g) => {
              const shown = !hidden.has(g.key);
              const id = `group-${g.key}`;
              return (
                <li key={g.key} className="flex items-center gap-3 px-3 py-2.5">
                  <StickerThumb src={`/stickers/fluent/${g.icon}.webp`} className="size-9 shrink-0" />
                  <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
                    <span className="block text-sm font-medium">{g.label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {(counts[g.key] ?? 0).toLocaleString("en-US")} stickers · {shown ? "Shown" : "Hidden"}
                    </span>
                  </label>
                  {saving === g.key && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />}
                  <Switch
                    id={id}
                    checked={shown}
                    aria-label={`Show ${g.label}`}
                    disabled={saving !== null}
                    onCheckedChange={(checked) => void toggle(g.key, g.label, checked)}
                  />
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
