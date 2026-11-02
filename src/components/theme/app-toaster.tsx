"use client";

import { Toaster } from "sonner";
import { useTheme } from "next-themes";

// Toasts sit just below the sticky 64px (h-16) header so they never cover its
// search box and bell; the bottom-right corner belongs to the chat and
// assistant buttons.
const HEADER_GAP = "calc(4rem + 12px)";

/** Stacked, swipeable toasts that follow the active light/dark theme. */
export function AppToaster() {
  const { resolvedTheme } = useTheme();
  return (
    <Toaster
      position="top-right"
      offset={{ top: HEADER_GAP }}
      mobileOffset={{ top: HEADER_GAP }}
      theme={resolvedTheme === "dark" ? "dark" : "light"}
      richColors
      closeButton
      toastOptions={{
        duration: 3500,
        classNames: {
          toast: "!rounded-2xl !border !shadow-2xl backdrop-blur-xl",
        },
      }}
    />
  );
}
