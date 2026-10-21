import Link from "next/link";
import { cn } from "@/lib/utils";

export const APP_NAME = "File Manager";

/** Whale with a folder-tab head (24×24, currentColor). */
const WHALE =
  "M1.08 11.38A3.2 3.2 0 0 1 4.28 8.18H6.98Q7.48 8.18 7.84 8.53L9.73 10.42Q10.08 10.78 10.58 10.78C12.58 10.78 13.95 9.58 14.14 7.99C13.26 6.97 11.74 4.57 11.4 3.22A0.8 0.8 0 0 1 12.3 2.52C14.08 2.74 16.16 3.9 17.04 4.92C18.14 4.15 20.44 3.52 22.22 3.74A0.8 0.8 0 0 1 22.92 4.63C22.26 5.86 20.21 7.83 19.11 8.6C19.54 13.29 19.98 21.48 11.58 21.48H6.08A5 5 0 0 1 1.08 16.48ZM4.48 14.28A1.5 1.5 0 1 0 7.48 14.28A1.5 1.5 0 1 0 4.48 14.28Z";

/** The cut for small sizes (favicon, tiles under ~28px): no eye, bolder tab and fluke. */
const WHALE_SMALL =
  "M1.08 12.18A4 4 0 0 1 5.08 8.18H6.98Q7.48 8.18 7.84 8.53L10.23 10.92Q10.58 11.28 11.08 11.28C13.08 11.28 13.45 9.52 13.65 7.93C12.76 6.91 11.42 4.73 11.08 3.38A1 1 0 0 1 12.2 2.51C13.98 2.73 16.16 3.9 17.04 4.92C18.14 4.15 20.53 3.53 22.32 3.75A1 1 0 0 1 23.19 4.87C22.54 6.1 20.71 7.89 19.6 8.66C20.03 13.35 19.98 21.48 11.58 21.48H6.08A5 5 0 0 1 1.08 16.48Z";

export function WhaleGlyph({ className, small = false }: { className?: string; small?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path fillRule="evenodd" d={small ? WHALE_SMALL : WHALE} />
    </svg>
  );
}

export function LogoMark({ className, small = false }: { className?: string; small?: boolean }) {
  return (
    <span
      className={cn(
        "relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[28%] bg-brand text-white shadow-lg shadow-primary/30 ring-1 ring-white/20",
        className
      )}
    >
      <WhaleGlyph small={small} className="h-[1.2rem] w-[1.2rem]" />
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
