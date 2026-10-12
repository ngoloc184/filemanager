import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Infinite horizontal ticker with faded edges (pure CSS). */
export function Marquee({
  children,
  className,
  duration = 30,
}: {
  children: ReactNode;
  className?: string;
  duration?: number;
}) {
  return (
    <div
      className={cn(
        "group/marquee flex overflow-hidden [mask-image:linear-gradient(to_right,transparent,#000_12%,#000_88%,transparent)]",
        className
      )}
    >
      {[0, 1].map((copy) => (
        <div
          key={copy}
          aria-hidden={copy === 1}
          className="marquee-track flex shrink-0 items-center gap-4 pr-4 group-hover/marquee:[animation-play-state:paused]"
          style={{ animationDuration: `${duration}s` }}
        >
          {children}
        </div>
      ))}
    </div>
  );
}
