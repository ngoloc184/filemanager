"use client";

// Sticker panel above the message box: recent stickers, one tab per group,
// and a search box (Vietnamese or English).

import { useMemo, useState } from "react";
import { Clock, Loader2, Search, X } from "lucide-react";
import { recentStickers } from "@/lib/stickers/load";
import { STICKER_GROUPS, byPopularity, searchStickers, stickerUrl, type Sticker } from "@/lib/stickers/suggest";
import { cn } from "@/lib/utils";

export function StickerImage({ id, className, alt = "" }: { id: string; className?: string; alt?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={stickerUrl(id)} alt={alt} loading="lazy" decoding="async" draggable={false} className={cn("select-none object-contain", className)} />
  );
}

export function StickerPicker({
  stickers,
  onPick,
  onClose,
}: {
  stickers: Sticker[] | null;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [recent] = useState(recentStickers);
  const [tab, setTab] = useState<string>(recent.length ? "recent" : "smileys");
  const [query, setQuery] = useState("");

  const shown = useMemo(() => {
    if (!stickers) return [];
    if (query.trim()) return searchStickers(query, stickers);
    if (tab === "recent") {
      const byId = new Map(stickers.map((s) => [s.id, s]));
      return recent.map((id) => byId.get(id)).filter((s): s is Sticker => Boolean(s));
    }
    return byPopularity(stickers.filter((s) => s.group === tab));
  }, [stickers, query, tab, recent]);

  return (
    <div className="@container absolute bottom-full left-2.5 right-2.5 z-10 mb-1 flex h-80 flex-col overflow-hidden rounded-2xl border bg-popover shadow-xl">
      <div className="flex items-center gap-2 border-b p-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search stickers: vui, buồn, cảm ơn, cat…"
            aria-label="Search stickers"
            autoFocus
            className="h-8 w-full rounded-lg border bg-background/60 pl-8 pr-2 text-xs outline-none focus-visible:border-ring"
          />
        </div>
        <button type="button" onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close stickers">
          <X className="h-4 w-4" />
        </button>
      </div>

      {!query.trim() && (
        <div className="flex gap-0.5 overflow-x-auto border-b px-1.5 py-1" role="tablist" aria-label="Sticker groups">
          {recent.length > 0 && (
            <button
              type="button"
              role="tab"
              aria-selected={tab === "recent"}
              onClick={() => setTab("recent")}
              className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", tab === "recent" ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted")}
              title="Recent"
            >
              <Clock className="h-4 w-4" />
            </button>
          )}
          {STICKER_GROUPS.map((g) => (
            <button
              key={g.key}
              type="button"
              role="tab"
              aria-selected={tab === g.key}
              onClick={() => setTab(g.key)}
              className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", tab === g.key ? "bg-primary/15" : "hover:bg-muted")}
              title={g.label}
            >
              <StickerImage id={g.icon} className="h-6 w-6" alt={g.label} />
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-1.5">
        {!stickers ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : shown.length === 0 ? (
          <p className="py-10 text-center text-xs text-muted-foreground">{query.trim() ? "No stickers found." : "No recent stickers yet."}</p>
        ) : (
          <div className="grid grid-cols-5 gap-1 @md:grid-cols-7">
            {shown.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onPick(s.id)}
                className="flex aspect-square items-center justify-center rounded-xl p-1 transition-transform hover:scale-110 hover:bg-muted/60"
                title={s.name}
                aria-label={`Send sticker ${s.name}`}
              >
                <StickerImage id={s.id} className="h-full w-full" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
