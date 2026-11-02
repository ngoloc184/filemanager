"use client";

// Loads the stickers on first use: the built-in Fluent list (≈200 KB, once)
// and the packs site admins manage (re-read when the picker opens and the
// copy is more than 5 minutes old). Also remembers the stickers this browser
// sent recently.

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { getStickerCatalog, type StickerCatalog } from "@/lib/services/stickers";
import { buildStickerSet, type Sticker, type StickerSet } from "@/lib/stickers/suggest";

const CATALOG_MAX_AGE_MS = 5 * 60 * 1000;
/** after a failed read, try again this soon */
const CATALOG_RETRY_MS = 30 * 1000;
const EMPTY_CATALOG: StickerCatalog = { packs: [], hiddenGroups: [] };

let fluentLoading: Promise<Sticker[]> | null = null;

function loadFluent(): Promise<Sticker[]> {
  fluentLoading ??= import("@/lib/stickers/fluent.json").then(
    (m) => m.default as Sticker[],
    (error: unknown) => {
      fluentLoading = null; // a failed chunk load is retried next time
      throw error;
    }
  );
  return fluentLoading;
}

// one cached set per signed-in user, so switching accounts never shows the
// previous person's view
type CacheEntry = { user: string; until: number; set: Promise<StickerSet> };
let cached: CacheEntry | null = null;

async function currentUserId(): Promise<string> {
  try {
    const { data } = await createClient().auth.getSession();
    return data.session?.user.id ?? "";
  } catch {
    return "";
  }
}

// the last catalog read without error, so a failed refresh keeps the packs on screen
let lastGood: { user: string; catalog: StickerCatalog } | null = null;

function readSet(user: string, onCatalogError: () => void): Promise<StickerSet> {
  const catalog = getStickerCatalog().then(
    (c) => {
      lastGood = { user, catalog: c };
      return c;
    },
    (): StickerCatalog => {
      // chat keeps working: the packs read last time, or the built-in stickers only
      onCatalogError();
      return lastGood?.user === user ? lastGood.catalog : EMPTY_CATALOG;
    }
  );
  return Promise.all([loadFluent(), catalog]).then(([fluent, c]) => buildStickerSet(fluent, c));
}

/** The stickers to offer; a fresh copy of the custom catalog when the cached one is older than 5 minutes. */
export async function loadStickerSet(): Promise<StickerSet> {
  const user = await currentUserId();
  const now = Date.now();
  if (cached && cached.user === user && cached.until > now) return cached.set;
  const entry: CacheEntry = {
    user,
    until: now + CATALOG_MAX_AGE_MS,
    set: readSet(user, () => {
      entry.until = Date.now() + CATALOG_RETRY_MS;
    }),
  };
  entry.set.catch(() => {
    if (cached === entry) cached = null;
  });
  cached = entry;
  return entry.set;
}

/** Drops the cached set, so the next load reads the packs again (after an admin changes them). */
export function invalidateStickerCatalog(): void {
  cached = null;
}

/**
 * The stickers once `active` (null until loaded). Each time `refresh` turns
 * true (the picker opens) a stale catalog is read again; the current list
 * stays on screen meanwhile.
 */
export function useStickers(active: boolean, refresh = false): StickerSet | null {
  const [set, setSet] = useState<StickerSet | null>(null);
  useEffect(() => {
    if (!active && !refresh) return;
    let cancelled = false;
    loadStickerSet().then(
      (next) => {
        if (!cancelled) setSet(next);
      },
      () => {
        // the built-in list failed to load (offline): try again on the next open
      }
    );
    return () => {
      cancelled = true;
    };
  }, [active, refresh]);
  return set;
}

const RECENT_KEY = "fm:recent-stickers";
const RECENT_MAX = 24;

/** Ids this browser sent, most recent first (some may no longer be available: see availableRecents). */
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
