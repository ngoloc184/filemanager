"use client";

import type { ReactNode } from "react";
import { motion } from "motion/react";
import { AuroraBackground } from "@/components/brand/aurora-background";
import { Logo } from "@/components/brand/logo";
import { ThemeToggle } from "@/components/theme/theme-toggle";

/**
 * Full-screen layout for public pages (sign-in, sign-up, shared links):
 * aurora background, brand + theme switcher on top, glass card in the middle.
 */
export function AuthShell({
  icon,
  title,
  description,
  children,
  footer,
}: {
  icon: ReactNode;
  title: ReactNode;
  description: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen flex-col">
      <AuroraBackground />
      <header className="flex items-center justify-between px-4 py-4 sm:px-8">
        <Logo />
        <ThemeToggle layoutId="auth-theme-pill" />
      </header>

      <main className="flex flex-1 items-center justify-center px-4 pb-16">
        <motion.div
          initial={{ opacity: 0, y: 16, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
          className="w-full max-w-md"
        >
          <div className="rounded-3xl border bg-glass p-6 shadow-2xl shadow-primary/10 backdrop-blur-xl sm:p-8">
            <div className="mb-6 space-y-2 text-center">
              <motion.div
                initial={{ scale: 0.6, rotate: -12, opacity: 0 }}
                animate={{ scale: 1, rotate: 0, opacity: 1 }}
                transition={{ type: "spring", stiffness: 260, damping: 18, delay: 0.1 }}
                className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand text-white shadow-lg shadow-primary/30"
              >
                {icon}
              </motion.div>
              <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
              <p className="text-sm text-muted-foreground">{description}</p>
            </div>
            {children}
          </div>
          {footer && (
            <div className="mt-6 text-center text-sm text-muted-foreground">
              {footer}
            </div>
          )}
        </motion.div>
      </main>
    </div>
  );
}
