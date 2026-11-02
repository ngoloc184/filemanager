import Image from "next/image";
import { ImageOff } from "lucide-react";
import { customStickerUrl } from "@/lib/stickers/custom";
import { cn } from "@/lib/utils";

/** A sticker image served as is (animated GIF/WebP keep playing; no optimizer round-trip). */
export function StickerThumb({
  id,
  src,
  alt = "",
  className,
}: {
  /** a custom sticker id (cs-…) */
  id?: string | null;
  /** any other image: a Fluent sticker path or a blob: preview */
  src?: string;
  alt?: string;
  className?: string;
}) {
  const url = src ?? (id ? customStickerUrl(id) : null);
  if (!url) {
    return (
      <span className={cn("flex items-center justify-center text-muted-foreground", className)} role="img" aria-label={alt || "No image"}>
        <ImageOff className="size-1/2" aria-hidden />
      </span>
    );
  }
  return (
    <Image
      src={url}
      alt={alt}
      width={128}
      height={128}
      unoptimized
      draggable={false}
      className={cn("select-none object-contain", className)}
    />
  );
}
