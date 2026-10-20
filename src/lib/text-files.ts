// Pure helpers for the built-in text editor, shared by the UI and unit tests.

/** Largest file the editor opens or saves; bigger files make the textarea sluggish. */
export const TEXT_EDIT_MAX_BYTES = 1024 * 1024;

export const DEFAULT_TEXT_FILE_NAME = "Untitled.txt";

const EDITABLE_EXTENSIONS = ["txt", "md", "markdown", "csv", "log", "json", "xml", "yml", "yaml"];

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Cleans a name typed for a new text file: trims it, replaces characters that
 * are not allowed in file names and adds ".txt" when there is no extension.
 */
export function ensureTextFileName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 200)
    .trim();
  if (!cleaned) return DEFAULT_TEXT_FILE_NAME;
  return extensionOf(cleaned) ? cleaned : `${cleaned}.txt`;
}

/** Whether the editor can open this file (plain text and small enough). */
export function isEditableTextFile(file: {
  name: string;
  mime_type: string;
  size: number;
}): boolean {
  if (file.size > TEXT_EDIT_MAX_BYTES) return false;
  return file.mime_type.startsWith("text/") || EDITABLE_EXTENSIONS.includes(extensionOf(file.name));
}

/** MIME type to store for a text file; keeps a known text type, else text/plain. */
export function textMimeType(name: string, current?: string): string {
  if (current && (current.startsWith("text/") || current === "application/json")) return current;
  switch (extensionOf(name)) {
    case "md":
    case "markdown":
      return "text/markdown";
    case "csv":
      return "text/csv";
    case "json":
      return "application/json";
    default:
      return "text/plain";
  }
}

/** UTF-8 size of the text, i.e. the size of the saved file. */
export function textByteSize(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** 1-based line and column of a caret offset, as shown in the status bar. */
export function caretPosition(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const lines = before.split("\n");
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

const UTF8_BOM = "\uFEFF";

/**
 * Decodes file bytes for editing. Returns null unless the bytes are valid
 * UTF-8, so other encodings (UTF-16, Windows-1258, ...) are never silently
 * rewritten with replacement characters. Remembers a UTF-8 byte-order mark
 * (common in CSVs made for Excel) so saving can write it back.
 */
export function decodeTextFile(bytes: Uint8Array): { text: string; bom: boolean } | null {
  // UTF-16 byte-order marks: valid UTF-8 bytes, but not UTF-8 text
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    return null;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.includes("\u0000")) return null; // binary data, not text
    return text.startsWith(UTF8_BOM) ? { text: text.slice(1), bom: true } : { text, bom: false };
  } catch {
    return null;
  }
}

/** Text to save, with the byte-order mark restored when the file had one. */
export function encodeTextFile(text: string, bom: boolean): string {
  return bom ? UTF8_BOM + text : text;
}
