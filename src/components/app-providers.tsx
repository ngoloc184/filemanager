"use client";

import type { ReactNode } from "react";
import { MotionConfig } from "motion/react";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { AppToaster } from "@/components/theme/app-toaster";

/** Client-side providers shared by every page. */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      {/* Every motion animation honours the OS "reduce motion" setting. */}
      <MotionConfig reducedMotion="user">
        {children}
        <AppToaster />
      </MotionConfig>
    </ThemeProvider>
  );
}
