"use client";

import { useRef, type HTMLAttributes, type PointerEvent } from "react";
import { cn } from "@/lib/utils";

/**
 * Card whose surface and border light up under the cursor (Linear / Vercel
 * style). Position is written to CSS variables, so moving the mouse never
 * re-renders React.
 */
export function SpotlightCard({
  className,
  children,
  onPointerMove,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);

  const handleMove = (event: PointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      el.style.setProperty("--spot-x", `${event.clientX - rect.left}px`);
      el.style.setProperty("--spot-y", `${event.clientY - rect.top}px`);
    }
    onPointerMove?.(event);
  };

  return (
    <div
      ref={ref}
      onPointerMove={handleMove}
      className={cn("spotlight-card group/spot relative overflow-hidden", className)}
      {...props}
    >
      {children}
    </div>
  );
}
