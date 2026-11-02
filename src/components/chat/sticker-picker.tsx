"use client";

// Sticker panel above the message box: recent stickers, one tab per custom
// pack (Admin → Stickers), one per visible built-in group, and a search box
// (Vietnamese or English).

import { useMemo, useState } from "react";
import { Clock, ImageOff, Loader2, Search, X } from "lucide-react";
import { recentStickers } from "@/lib/stickers/load";
import { availableRecents, byPopularity, searchStickers, stickerUrl, type StickerSet } from "@/lib/stickers/suggest";
import { cn } from "@/lib/utils";

/**
 * A sticker picture. One that no longer loads (a custom sticker an admin
 * deleted) shows a neutral placeholder instead of a broken image, with
 * `unavailableLabel` beside the icon when given.
 */
export function StickerImage({
  id,
  className,
  alt = "",
  unavailableLabel,
}: {
  id: string;
  className?: string;
  alt?: string;
  unavailableLabel?: string;
}) {
  const src = stickerUrl(id);
  // remembered per address, so another sticker in the same place loads normally
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (failedSrc === src) {
    const label = unavailableLabel ?? "Sticker unavailable";
    return unavailableLabel ? (
      <span role="img" aria-label={label} className="inline-flex items-center gap-1.5 rounded-xl border border-dashed bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        <ImageOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {label}
      </span>
    ) : (
      <span role="img" aria-label={label} className={cn("flex items-center justify-center text-muted-foreground/60", className)}>
        <ImageOff className="h-1/2 max-h-6 w-1/2 max-w-6" aria-hidden />
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailedSrc(src)}
      className={cn("select-none object-contain", className)}
    />
  );
}

const tabButton = "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg";

export function StickerPicker({
  stickers: set,
  onPick,
  onClose,
}: {
  stickers: StickerSet | null;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [recentIds] = useState(recentStickers);
  const [chosenTab, setTab] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // recent ids that were deleted, disabled or hidden since are left out
  const recent = useMemo(() => (set ? availableRecents(recentIds, set.stickers) : []), [set, recentIds]);
  const tabs = useMemo(
    () => [...(recent.length ? ["recent"] : []), ...(set?.packs.map((p) => p.key) ?? []), ...(set?.groups.map((g) => g.key) ?? [])],
    [set, recent.length]
  );
  // the chosen tab, unless it went away (pack disabled, group hidden) since
  const tab = chosenTab && tabs.includes(chosenTab) ? chosenTab : (tabs[0] ?? null);

  const shown = useMemo(() => {
    if (!set) return [];
    if (query.trim()) return searchStickers(query, set.stickers);
    if (tab === "recent") return recent;
    const inTab = set.stickers.filter((s) => s.group === tab);
    // a pack keeps the order the admins gave it
    return set.packs.some((p) => p.key === tab) ? inTab : byPopularity(inTab);
  }, [set, query, tab, recent]);

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
              className={cn(tabButton, tab === "recent" ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted")}
              title="Recent"
              aria-label="Recent"
            >
              <Clock className="h-4 w-4" />
            </button>
          )}
          {set?.packs.map((p) => (
            <button
              key={p.key}
              type="button"
              role="tab"
              aria-selected={tab === p.key}
              onClick={() => setTab(p.key)}
              className={cn(tabButton, tab === p.key ? "bg-primary/15" : "hover:bg-muted")}
              title={p.name}
              aria-label={p.name}
            >
              <StickerImage id={p.icon} className="h-6 w-6" />
            </button>
          ))}
          {set && set.packs.length > 0 && set.groups.length > 0 && <span className="mx-0.5 my-1.5 w-px shrink-0 bg-border" aria-hidden />}
          {set?.groups.map((g) => (
            <button
              key={g.key}
              type="button"
              role="tab"
              aria-selected={tab === g.key}
              onClick={() => setTab(g.key)}
              className={cn(tabButton, tab === g.key ? "bg-primary/15" : "hover:bg-muted")}
              title={g.label}
              aria-label={g.label}
            >
              <StickerImage id={g.icon} className="h-6 w-6" />
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-1.5">
        {!set ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : shown.length === 0 ? (
          <p className="py-10 text-center text-xs text-muted-foreground">{query.trim() ? "No stickers found." : tabs.length ? "No stickers here yet." : "No stickers available."}</p>
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
