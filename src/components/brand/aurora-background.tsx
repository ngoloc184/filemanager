import { cn } from "@/lib/utils";

/**
 * Animated aurora backdrop (blurred brand-colored blobs over a fading grid).
 * Pure CSS: no JavaScript cost, and it stops moving for reduced-motion users.
 */
export function AuroraBackground({
  variant = "vivid",
  className,
}: {
  variant?: "vivid" | "subtle";
  className?: string;
}) {
  return (
    <div aria-hidden className={cn("aurora", className)} data-variant={variant}>
      <div
        className="aurora-blob"
        style={{
          top: "-18%",
          left: "-10%",
          width: "55vmax",
          height: "55vmax",
          background: "var(--brand-from)",
        }}
      />
      <div
        className="aurora-blob"
        style={{
          top: "-25%",
          right: "-15%",
          width: "50vmax",
          height: "50vmax",
          background: "var(--brand-via)",
          animationDelay: "-7s",
          animationDuration: "26s",
        }}
      />
      <div
        className="aurora-blob"
        style={{
          bottom: "-30%",
          left: "25%",
          width: "45vmax",
          height: "45vmax",
          background: "var(--brand-to)",
          animationDelay: "-13s",
          animationDuration: "30s",
        }}
      />
    </div>
  );
}
