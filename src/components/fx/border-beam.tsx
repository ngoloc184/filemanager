import { cn } from "@/lib/utils";

/**
 * A light beam that travels around its parent's border. The parent must be
 * `relative` and rounded; the beam inherits the radius.
 */
export function BorderBeam({
  className,
  duration = 8,
}: {
  className?: string;
  duration?: number;
}) {
  return (
    <span
      aria-hidden
      className={cn("border-beam", className)}
      style={{ animationDuration: `${duration}s` }}
    />
  );
}
