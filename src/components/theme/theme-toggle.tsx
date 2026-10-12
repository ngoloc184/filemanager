"use client";

import { useSyncExternalStore } from "react";
import { motion } from "motion/react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";

const OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const;

const subscribeNoop = () => () => {};

/** True only after hydration, so the active option never mismatches SSR. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false
  );
}

export function ThemeToggle({
  className,
  layoutId = "theme-toggle-pill",
}: {
  className?: string;
  /** Unique per toggle instance so their pills animate independently. */
  layoutId?: string;
}) {
  const { theme, setTheme } = useTheme();
  const hydrated = useHydrated();

  return (
    <div
      role="radiogroup"
      aria-label="Color theme"
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full border bg-background/60 p-0.5 backdrop-blur",
        className
      )}
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => {
        const active = hydrated && theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => setTheme(value)}
            className={cn(
              "relative flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
              active && "text-foreground"
            )}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                className="absolute inset-0 rounded-full bg-card shadow-sm ring-1 ring-border"
                transition={{ type: "spring", stiffness: 500, damping: 35 }}
              />
            )}
            <Icon className="relative h-3.5 w-3.5" />
          </button>
        );
      })}
    </div>
  );
}
