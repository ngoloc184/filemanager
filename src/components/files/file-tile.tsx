import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type FileKind =
  | "folder"
  | "pdf"
  | "image"
  | "video"
  | "audio"
  | "archive"
  | "code"
  | "sheet"
  | "text"
  | "other";

const KIND_STYLE: Record<FileKind, { icon: LucideIcon; tile: string }> = {
  folder: { icon: Folder, tile: "bg-primary/12 text-primary ring-primary/20" },
  pdf: { icon: FileText, tile: "bg-[oklch(0.63_0.22_25/0.12)] text-[oklch(0.6_0.22_25)] ring-[oklch(0.63_0.22_25/0.25)]" },
  image: { icon: FileImage, tile: "bg-[oklch(0.65_0.22_350/0.12)] text-[oklch(0.62_0.22_350)] ring-[oklch(0.65_0.22_350/0.25)]" },
  video: { icon: FileVideo, tile: "bg-[oklch(0.6_0.22_300/0.12)] text-[oklch(0.6_0.22_300)] ring-[oklch(0.6_0.22_300/0.25)]" },
  audio: { icon: FileAudio, tile: "bg-[oklch(0.7_0.17_55/0.14)] text-[oklch(0.65_0.17_55)] ring-[oklch(0.7_0.17_55/0.28)]" },
  archive: { icon: FileArchive, tile: "bg-[oklch(0.78_0.15_85/0.16)] text-[oklch(0.62_0.14_80)] ring-[oklch(0.78_0.15_85/0.3)]" },
  code: { icon: FileCode, tile: "bg-[oklch(0.7_0.13_190/0.14)] text-[oklch(0.6_0.12_190)] ring-[oklch(0.7_0.13_190/0.28)]" },
  sheet: { icon: FileSpreadsheet, tile: "bg-[oklch(0.65_0.15_155/0.14)] text-[oklch(0.58_0.15_155)] ring-[oklch(0.65_0.15_155/0.28)]" },
  text: { icon: FileText, tile: "bg-[oklch(0.62_0.17_250/0.12)] text-[oklch(0.58_0.17_250)] ring-[oklch(0.62_0.17_250/0.25)]" },
  other: { icon: File, tile: "bg-muted text-muted-foreground ring-border" },
};

const ARCHIVES = ["zip", "rar", "7z", "tar", "gz"];
const CODE = ["js", "ts", "tsx", "jsx", "json", "bundle", "html", "css", "py", "go", "sql", "yml", "yaml", "xml"];
const SHEETS = ["xls", "xlsx", "csv", "numbers"];

export function fileKind(mimeType: string | null | undefined, name = ""): FileKind {
  const mime = mimeType ?? "";
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (ARCHIVES.includes(ext)) return "archive";
  if (SHEETS.includes(ext)) return "sheet";
  if (CODE.includes(ext) || mime.includes("javascript") || mime === "application/json") return "code";
  if (mime.startsWith("text/") || ["doc", "docx", "md", "txt", "rtf"].includes(ext)) return "text";
  return "other";
}

/** Rounded, color-coded icon tile for a file or folder. */
export function FileTile({
  kind,
  size = "md",
  className,
}: {
  kind: FileKind;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const { icon: Icon, tile } = KIND_STYLE[kind];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center ring-1 ring-inset",
        size === "sm" && "h-7 w-7 rounded-lg",
        size === "md" && "h-9 w-9 rounded-xl",
        size === "lg" && "h-14 w-14 rounded-2xl",
        tile,
        className
      )}
    >
      <Icon className={cn(size === "lg" ? "h-7 w-7" : size === "md" ? "h-[18px] w-[18px]" : "h-4 w-4")} />
    </span>
  );
}
