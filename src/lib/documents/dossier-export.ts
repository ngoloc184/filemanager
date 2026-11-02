// Dossier (hồ sơ) ZIP export: safe entry names, the index.csv and
// manifest.json files, and the archive itself. Pure: no Supabase or DOM
// imports, so the dossier page and the tests share it. Fetching the files and
// logging each download stay in the component.

import { strToU8, zipSync, type Zippable } from "fflate";
import {
  buildDossierManifest,
  type DossierDocument,
  type DossierDocumentReadable,
  type DossierManifest,
} from "./dossiers.ts";
import { toCsv, type RegisterColumn } from "./register-export.ts";
import type { DocumentFileLink } from "./types.ts";

/** Files larger than this are left out of the ZIP and reported to the user. */
export const MAX_EXPORT_FILE_BYTES = 200 * 1024 * 1024;

/** Longest file name kept in the ZIP, in characters, extension included. */
export const MAX_FILE_NAME_LENGTH = 120;

// / \ : * ? " < > | are illegal on Windows (and / everywhere); control
// characters (below U+0020, and DEL) break archive tools.
const ILLEGAL_RE = /[/\\:*?"<>|]/g;

function stripControlCharacters(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out;
}
const RESERVED_RE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
const MAX_EXTENSION_LENGTH = 10;

function splitExtension(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || name.length - dot > MAX_EXTENSION_LENGTH + 1) return { base: name, ext: "" };
  return { base: name.slice(0, dot), ext: name.slice(dot) };
}

/** Code-point aware slice, so a Vietnamese letter or emoji is never cut in half. */
function takeChars(text: string, count: number): string {
  return Array.from(text).slice(0, Math.max(0, count)).join("");
}

function charLength(text: string): number {
  return Array.from(text).length;
}

/**
 * A file name that unpacks on Windows, macOS and Linux: the illegal
 * characters / \ : * ? " < > | and control characters become spaces, runs of
 * spaces collapse, leading and trailing dots and spaces go (also before the
 * extension), and Vietnamese
 * letters stay (NFC). Names longer than `maxLength` characters are cut while
 * keeping the extension. Empty or reserved names (CON, NUL…) fall back to
 * `fallback` or get a leading underscore.
 */
export function safeFileName(
  name: string,
  maxLength: number = MAX_FILE_NAME_LENGTH,
  fallback = "file"
): string {
  let clean = stripControlCharacters((name ?? "").normalize("NFC"))
    .replace(ILLEGAL_RE, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "");
  // 'Tờ trình: x?.pdf' would end its base in a space: 'Tờ trình x.pdf'
  const parts = splitExtension(clean);
  if (parts.ext) clean = `${parts.base.replace(/[\s.]+$/, "")}${parts.ext}`;
  if (!clean) clean = fallback;
  if (RESERVED_RE.test(clean)) clean = `_${clean}`;

  if (charLength(clean) > maxLength) {
    const { base, ext } = splitExtension(clean);
    const room = maxLength - charLength(ext);
    clean = room > 0 ? `${takeChars(base, room).replace(/[\s.]+$/, "")}${ext}` : takeChars(clean, maxLength);
  }
  return clean;
}

/** 3 → '003'; numbers past 999 keep all their digits. */
export function pad3(n: number): string {
  return String(Math.max(0, Math.trunc(n))).padStart(3, "0");
}

/** The ZIP entry of a document's file: '003_Quyet dinh.pdf'. */
export function zipEntryName(ordinal: number, name: string): string {
  return `${pad3(ordinal)}_${safeFileName(name)}`;
}

/** '01.HCNS_Hồ sơ hợp đồng 2026.zip' with the same rules as safeFileName. */
export function dossierZipName(code: string, title: string): string {
  return safeFileName(`${code}_${title}.zip`, MAX_FILE_NAME_LENGTH, "dossier.zip");
}

/**
 * Makes every name unique, ignoring case (Windows and macOS unpack
 * case-insensitively): a repeat gets ' (2)', ' (3)'… before its extension.
 * The first occurrence keeps its name; the order is unchanged.
 */
export function dedupeNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    let candidate = name;
    if (used.has(candidate.toLowerCase())) {
      const { base, ext } = splitExtension(name);
      let n = 2;
      do {
        candidate = `${base} (${n})${ext}`;
        n += 1;
      } while (used.has(candidate.toLowerCase()));
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

export const INDEX_CSV_COLUMNS: readonly RegisterColumn[] = [
  { key: "ordinal", header: "ordinal" },
  { key: "number", header: "number" },
  { key: "date", header: "date" },
  { key: "subject", header: "subject" },
  { key: "type", header: "type" },
];

/**
 * index.csv: one row per manifest entry (ordinal, number, date, subject,
 * type), UTF-8 with a BOM so Excel shows Vietnamese text, CRLF line ends and
 * formula-looking cells neutralised. Dates stay yyyy-mm-dd.
 */
export function indexCsv(manifest: Pick<DossierManifest, "documents">): string {
  return toCsv(
    INDEX_CSV_COLUMNS,
    manifest.documents.map((entry) => ({
      ordinal: entry.ordinal,
      number: entry.notation ?? "",
      date: entry.date ?? "",
      subject: entry.subject,
      type: entry.type ?? "",
    }))
  );
}

// ---------------------------------------------------------------- export plan

/** A readable document and its position in the manifest. */
export type ExportItem = { ordinal: number; document: DossierDocumentReadable };

export type DossierExportPlan = {
  manifest: DossierManifest;
  /** readable documents in manifest order; restricted ones have no file */
  items: ExportItem[];
};

type PlanDossier = Parameters<typeof buildDossierManifest>[0];

/**
 * The manifest plus which document sits at which manifest ordinal, so the
 * file prefixes match index.csv. The order is buildDossierManifest's:
 * readable first, then by date (issued, else arrival; undated last), then by
 * place in the dossier. A test keeps the two in step.
 */
export function planDossierExport(
  dossier: PlanDossier,
  documents: readonly DossierDocument[]
): DossierExportPlan {
  const manifest = buildDossierManifest(dossier, documents);
  const readable = documents
    .filter((doc): doc is DossierDocumentReadable => doc.readable)
    .map((doc) => ({ doc, date: doc.issued_date ?? doc.arrival_date ?? null }))
    .sort((a, b) => {
      if (a.date !== b.date) {
        if (a.date === null) return 1;
        if (b.date === null) return -1;
        return a.date < b.date ? -1 : 1;
      }
      return a.doc.ordinal - b.doc.ordinal;
    });
  return {
    manifest,
    items: readable.map(({ doc }, index) => ({ ordinal: index + 1, document: doc })),
  };
}

/** The file to export for a document: its main file, else the first one. */
export function pickExportFile<T extends Pick<DocumentFileLink, "kind">>(files: readonly T[]): T | null {
  return files.find((f) => f.kind === "main") ?? files[0] ?? null;
}

/** Why a document has no file in the ZIP. */
export type SkippedFile = { ordinal: number; name: string; reason: string };

/** Toast text for skipped files: '003 Name.pdf: Over 200 MB', at most `limit` lines. */
export function skippedSummary(skipped: readonly SkippedFile[], limit = 5): string {
  const lines = skipped.slice(0, limit).map((s) => `${pad3(s.ordinal)} ${s.name}: ${s.reason}`);
  if (skipped.length > limit) lines.push(`and ${skipped.length - limit} more`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- archive

/** A packed document file. */
export type PackedFile = { ordinal: number; name: string; bytes: Uint8Array };

/** manifest.json: the manifest with each entry's file in the ZIP (or null). */
export function manifestJson(
  manifest: DossierManifest,
  fileByOrdinal: ReadonlyMap<number, string>,
  exportedAt: string
): string {
  return `${JSON.stringify(
    {
      ...manifest,
      exported_at: exportedAt,
      documents: manifest.documents.map((entry) => ({
        ...entry,
        file: fileByOrdinal.get(entry.ordinal) ?? null,
      })),
    },
    null,
    2
  )}\n`;
}

/**
 * The ZIP: manifest.json, index.csv and the files as '003_<name>' (made
 * unique). Files are stored without recompression (PDF and Office files are
 * already compressed); the two text files are deflated.
 */
export function packDossierZip(
  manifest: DossierManifest,
  files: readonly PackedFile[],
  exportedAt: string = new Date().toISOString()
): Uint8Array {
  const ordered = [...files].sort((a, b) => a.ordinal - b.ordinal);
  const names = dedupeNames([
    "manifest.json",
    "index.csv",
    ...ordered.map((f) => zipEntryName(f.ordinal, f.name)),
  ]).slice(2);

  const fileByOrdinal = new Map<number, string>();
  const zippable: Zippable = {};
  ordered.forEach((file, i) => {
    fileByOrdinal.set(file.ordinal, names[i]);
    zippable[names[i]] = [file.bytes, { level: 0 }];
  });
  return zipSync({
    "manifest.json": [strToU8(manifestJson(manifest, fileByOrdinal, exportedAt)), { level: 6 }],
    "index.csv": [strToU8(indexCsv(manifest)), { level: 6 }],
    ...zippable,
  });
}
