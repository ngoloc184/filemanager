"use client";

import { Toaster } from "react-hot-toast";

/** Toasts styled with the theme tokens so they follow light/dark mode. */
export function AppToaster() {
  return (
    <Toaster
      position="top-right"
      toastOptions={{
        duration: 3000,
        style: {
          background: "var(--popover)",
          color: "var(--popover-foreground)",
          border: "1px solid var(--border)",
          borderRadius: "calc(var(--radius) * 1.2)",
          boxShadow: "0 12px 32px -12px rgb(0 0 0 / 0.25)",
          fontSize: "0.875rem",
        },
        success: { iconTheme: { primary: "var(--success)", secondary: "var(--card)" } },
        error: { iconTheme: { primary: "var(--destructive)", secondary: "var(--card)" } },
      }}
    />
  );
}
