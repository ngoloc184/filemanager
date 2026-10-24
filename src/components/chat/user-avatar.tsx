"use client";

import { Users } from "lucide-react";
import { publicImageUrl } from "@/lib/services/profile";
import { cn } from "@/lib/utils";

const SIZES = {
  xs: "h-5 w-5 text-[9px]",
  sm: "h-8 w-8 text-xs",
  md: "h-9 w-9 text-sm",
  lg: "h-16 w-16 text-xl",
} as const;

/** A person's (or group's) picture, or their initial on the brand gradient. */
export function UserAvatar({
  name,
  path,
  size = "md",
  group = false,
  className,
}: {
  name: string | null;
  path?: string | null;
  size?: keyof typeof SIZES;
  group?: boolean;
  className?: string;
}) {
  const url = publicImageUrl(path);
  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand font-semibold text-white shadow-md shadow-primary/25",
        SIZES[size],
        className
      )}
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
      ) : group ? (
        <Users className="h-1/2 w-1/2" />
      ) : (
        name?.trim().charAt(0).toUpperCase() || "?"
      )}
    </span>
  );
}
