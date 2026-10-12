// Formats whose text the indexer can extract.

export const TEXT_EXTENSIONS = [
  "txt", "md", "markdown", "csv", "tsv", "json", "xml", "html", "htm", "yml", "yaml",
  "log", "ini", "sql", "js", "ts", "tsx", "jsx", "css", "py", "go", "java", "sh", "rtf",
];
export const OFFICE_EXTENSIONS = ["docx", "xlsx", "pptx", "odt", "ods", "odp"];
export const PDF_EXTENSIONS = ["pdf"];

export const INDEXABLE_EXTENSIONS: readonly string[] = [
  ...TEXT_EXTENSIONS,
  ...OFFICE_EXTENSIONS,
  ...PDF_EXTENSIONS,
];

export function isIndexable(extension: string | null | undefined): boolean {
  return INDEXABLE_EXTENSIONS.includes((extension ?? "").toLowerCase());
}

/** Largest file the indexer downloads (bytes); bigger files are skipped. */
export const MAX_INDEX_BYTES = Number(process.env.ASSISTANT_MAX_INDEX_MB ?? 15) * 1024 * 1024;
/** Text kept per file in the index. */
export const MAX_INDEX_CHARS = 200_000;
