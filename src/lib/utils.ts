import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1) return "0 B";
  const k = 1024;
  const sizes = BYTE_UNITS;
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(k)),
    sizes.length - 1
  );
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/** Entrance animation for list rows/cards (tw-animate-css, CSS only). */
export const ENTER_ANIMATION =
  "animate-in fade-in-0 slide-in-from-bottom-1 duration-300 fill-mode-both";

/** Staggers entrance animations; capped so long lists still appear quickly. */
export function staggerDelay(index: number, stepMs = 25, maxSteps = 12) {
  return { animationDelay: `${Math.min(index, maxSteps) * stepMs}ms` };
}
