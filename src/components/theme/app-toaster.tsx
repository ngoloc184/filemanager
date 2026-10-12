"use client";

import { Toaster } from "sonner";
import { useTheme } from "next-themes";

/** Stacked, swipeable toasts that follow the active light/dark theme. */
export function AppToaster() {
  const { resolvedTheme } = useTheme();
  return (
    <Toaster
      position="bottom-right"
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
