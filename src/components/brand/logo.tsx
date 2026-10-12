import Link from "next/link";
import { FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";

export const APP_NAME = "File Manager";

export function LogoMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-brand text-white shadow-lg shadow-primary/30 ring-1 ring-white/20",
        className
      )}
    >
      <FolderOpen className="h-4 w-4" />
    </span>
  );
}

export function Logo({
  href = "/",
  className,
}: {
  href?: string;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn("inline-flex items-center gap-2.5 font-semibold tracking-tight", className)}
    >
      <LogoMark />
      <span className="text-lg">{APP_NAME}</span>
    </Link>
  );
}
