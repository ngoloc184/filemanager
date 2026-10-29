"use client";

// Loads the sticker list (≈200 KB) on first use, and remembers the stickers
// this browser sent recently.

import { useEffect, useState } from "react";
import type { Sticker } from "@/lib/stickers/suggest";

let loading: Promise<Sticker[]> | null = null;

export function loadStickers(): Promise<Sticker[]> {
  loading ??= import("@/lib/stickers/fluent.json").then((m) => m.default as Sticker[]);
  return loading;
}

/** The sticker list once `active` (null until loaded). */
export function useStickers(active: boolean): Sticker[] | null {
  const [stickers, setStickers] = useState<Sticker[] | null>(null);
  useEffect(() => {
    if (!active || stickers) return;
    let cancelled = false;
    void loadStickers().then((list) => !cancelled && setStickers(list));
    return () => {
      cancelled = true;
    };
  }, [active, stickers]);
  return stickers;
}

const RECENT_KEY = "fm:recent-stickers";
const RECENT_MAX = 24;

export function recentStickers(): string[] {
  try {
    const list = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function rememberSticker(id: string): void {
  try {
    const next = [id, ...recentStickers().filter((x) => x !== id)].slice(0, RECENT_MAX);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // not remembered
  }
}
