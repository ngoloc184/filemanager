// Sticker import helpers for Admin → Stickers: reads a whole pack from a ZIP
// (optional pack.json for names and keywords) and checks single images before
// upload. Pure, runs in the browser; unit-tested.

import { unzipSync, type UnzipFileInfo } from "fflate";
import {
  STICKER_MAX_BYTES,
  normalizeKeywords,
  parsePackManifest,
  sniffImageMime,
  stickerNameFromFile,
  type PackManifest,
  type StickerMime,
} from "./custom.ts";

/** most images one ZIP may bring in */
export const ZIP_MAX_IMAGES = 300;
/** largest ZIP file and largest total it may unpack to (zip-bomb guard) */
export const ZIP_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
/** largest pack.json that is read */
const MANIFEST_MAX_BYTES = 1024 * 1024;

const EXTENSION_MIME: Record<string, StickerMime> = {
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

export const SKIP_REASONS = {
  type: "Not a PNG, WebP, GIF or JPEG image",
  size: "Larger than 2 MB",
  limit: `More than ${ZIP_MAX_IMAGES} images in one ZIP`,
  content: "The file content is not a PNG, WebP, GIF or JPEG image",
  svg: "SVG images are not accepted (they can contain scripts)",
  mismatch: "The file content does not match its extension",
  unpack: "Could not be unpacked",
  duplicate: "Another file in the ZIP has the same path",
} as const;

export type ZipStickerItem = {
  /** path inside the ZIP */
  fileName: string;
  name: string;
  keywords: string[];
  bytes: Uint8Array;
  mime: StickerMime;
};

export type StickerZip = {
  packName?: string;
  items: ZipStickerItem[];
  skipped: { fileName: string; reason: string }[];
};

export type ImageCheck = { ok: true; mime: StickerMime } | { ok: false; reason: string };

/** Size and real type of one image (the name and the browser's type are not trusted). */
export function checkStickerImage(bytes: Uint8Array): ImageCheck {
  if (bytes.length === 0) return { ok: false, reason: SKIP_REASONS.content };
  if (bytes.length > STICKER_MAX_BYTES) return { ok: false, reason: SKIP_REASONS.size };
  const mime = sniffImageMime(bytes);
  if (mime) return { ok: true, mime };
  return { ok: false, reason: looksLikeSvg(bytes) ? SKIP_REASONS.svg : SKIP_REASONS.content };
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
  return head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"));
}

/** A copy of `list` with the item at `index` moved by `delta`; the same list when it cannot move. */
export function moveItem<T>(list: readonly T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length || delta === 0) return [...list];
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}

/** The browser-side check of an image address before the server downloads it (the server checks again); null when fine. */
export function imageUrlProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "Enter a full image address starting with https://";
  }
  if (url.protocol !== "https:") return "Only https:// addresses are accepted";
  if (url.username || url.password) return "Remove the user name or password from the address";
  return null;
}

function extensionOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

/** Folders, macOS resource forks and hidden files (.DS_Store, ._x.png) are not content. */
function isIgnored(path: string): boolean {
  if (!path || path.endsWith("/")) return true;
  const parts = path.split("/");
  return parts[0] === "__MACOSX" || parts.some((p) => p.startsWith("."));
}

/** Bytes an entry unpacks to: stored entries copy their raw size, deflated ones are cut at their declared size. */
function unpackedSize(info: UnzipFileInfo): number {
  return info.compression === 0 ? info.size : info.originalSize;
}

/** A central-directory entry and its position there (names can repeat inside a ZIP). */
type ZipEntry = UnzipFileInfo & { index: number };

/**
 * Unpacks the entries at these positions, picked by position so a second
 * entry with the same name (and an unchecked size) is never unpacked with them.
 */
function unzipAt(bytes: Uint8Array, indexes: readonly number[]): Map<number, Uint8Array> {
  const wanted = new Set(indexes);
  const names = new Map<string, number>();
  let index = -1;
  const files = unzipSync(bytes, {
    filter: (f) => {
      index += 1;
      if (!wanted.has(index)) return false;
      names.set(f.name, index);
      return true;
    },
  });
  const out = new Map<number, Uint8Array>();
  for (const [name, at] of names) if (files[name]) out.set(at, files[name]);
  return out;
}

function unzipOne(bytes: Uint8Array, index: number): Uint8Array | null {
  try {
    return unzipAt(bytes, [index]).get(index) ?? null;
  } catch {
    return null;
  }
}

/**
 * The chosen entries in one pass over the archive; when one of them cannot be
 * unpacked, each is retried alone so the others still come through.
 */
function unzipChosen(bytes: Uint8Array, indexes: readonly number[]): (index: number) => Uint8Array | null {
  try {
    const files = unzipAt(bytes, indexes);
    return (index) => files.get(index) ?? null;
  } catch {
    return (index) => unzipOne(bytes, index);
  }
}

function readManifest(bytes: Uint8Array, index: number): PackManifest | null {
  const raw = unzipOne(bytes, index);
  if (!raw) return null;
  try {
    return parsePackManifest(JSON.parse(new TextDecoder().decode(raw)));
  } catch {
    return null;
  }
}

/**
 * Reads a sticker pack ZIP. Images come back sorted by path with a name and
 * keywords from pack.json (matched by path, path next to pack.json, or file
 * name) or from the file name. Throws a clear Error when the file is not a ZIP
 * or unpacks to more than ZIP_MAX_TOTAL_BYTES.
 */
export function readStickerZip(bytes: Uint8Array): StickerZip {
  if (bytes.length > ZIP_MAX_TOTAL_BYTES) throw new Error("The ZIP file is larger than 100 MB");

  // first pass: the central directory only, nothing is unpacked
  const entries: ZipEntry[] = [];
  try {
    unzipSync(bytes, {
      filter: (info) => {
        entries.push({ ...info, index: entries.length });
        return false;
      },
    });
  } catch {
    throw new Error("This file is not a valid ZIP archive");
  }

  const skipped: StickerZip["skipped"] = [];
  const candidates: ZipEntry[] = [];
  const candidateNames = new Set<string>();
  let manifestEntry: ZipEntry | null = null;
  for (const info of entries) {
    if (isIgnored(info.name)) continue;
    if (baseName(info.name).toLowerCase() === "pack.json") {
      const depth = info.name.split("/").length;
      if (
        unpackedSize(info) <= MANIFEST_MAX_BYTES &&
        (!manifestEntry || depth < manifestEntry.name.split("/").length)
      ) {
        manifestEntry = info;
      }
      continue;
    }
    if (!EXTENSION_MIME[extensionOf(info.name)]) skipped.push({ fileName: info.name, reason: SKIP_REASONS.type });
    else if (unpackedSize(info) > STICKER_MAX_BYTES) skipped.push({ fileName: info.name, reason: SKIP_REASONS.size });
    else if (candidateNames.has(info.name)) skipped.push({ fileName: info.name, reason: SKIP_REASONS.duplicate });
    else {
      candidateNames.add(info.name);
      candidates.push(info);
    }
  }

  candidates.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const info of candidates.splice(ZIP_MAX_IMAGES)) skipped.push({ fileName: info.name, reason: SKIP_REASONS.limit });

  const total = candidates.reduce((sum, info) => sum + unpackedSize(info), manifestEntry ? unpackedSize(manifestEntry) : 0);
  if (total > ZIP_MAX_TOTAL_BYTES) {
    throw new Error("The ZIP unpacks to more than 100 MB. Split it into smaller packs.");
  }

  const manifest = manifestEntry ? readManifest(bytes, manifestEntry.index) : null;
  const manifestDir = manifestEntry ? manifestEntry.name.slice(0, manifestEntry.name.length - "pack.json".length) : "";
  const byPath = new Map<string, NonNullable<PackManifest["stickers"]>[number]>();
  const byBase = new Map<string, NonNullable<PackManifest["stickers"]>[number]>();
  for (const entry of manifest?.stickers ?? []) {
    const file = entry.file.replace(/\\/g, "/").replace(/^\.?\//, "");
    if (!byPath.has(file)) byPath.set(file, entry);
    if (!byPath.has(manifestDir + file)) byPath.set(manifestDir + file, entry);
    const base = baseName(file).toLowerCase();
    if (!byBase.has(base)) byBase.set(base, entry);
  }

  const unpack = unzipChosen(
    bytes,
    candidates.map((info) => info.index)
  );
  const items: ZipStickerItem[] = [];
  // pack.json order first (in the order it lists them), then the rest by path
  const manifestOrder = new Map((manifest?.stickers ?? []).map((entry, i) => [entry, i] as const));
  const rank = new Map<ZipStickerItem, number>();
  for (const info of candidates) {
    const data = unpack(info.index);
    if (!data) {
      skipped.push({ fileName: info.name, reason: SKIP_REASONS.unpack });
      continue;
    }
    const check = checkStickerImage(data);
    if (!check.ok) {
      skipped.push({ fileName: info.name, reason: check.reason });
      continue;
    }
    if (check.mime !== EXTENSION_MIME[extensionOf(info.name)]) {
      skipped.push({ fileName: info.name, reason: SKIP_REASONS.mismatch });
      continue;
    }
    const meta = byPath.get(info.name) ?? byBase.get(baseName(info.name).toLowerCase());
    const item: ZipStickerItem = {
      fileName: info.name,
      name: meta?.name ?? stickerNameFromFile(info.name),
      keywords: normalizeKeywords(meta?.keywords ?? []),
      bytes: data,
      mime: check.mime,
    };
    rank.set(item, (meta && manifestOrder.get(meta)) ?? Number.MAX_SAFE_INTEGER);
    items.push(item);
  }
  items.sort((a, b) => rank.get(a)! - rank.get(b)!);

  return { ...(manifest?.name ? { packName: manifest.name } : {}), items, skipped };
}
