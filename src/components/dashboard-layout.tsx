"use client";

import { ReactNode, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { Command, LogOut, Menu, Search, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import StorageUsage from "@/components/files/storage-usage";
import { AuroraBackground } from "@/components/brand/aurora-background";
import { Logo } from "@/components/brand/logo";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { CommandPalette, openCommandPalette } from "@/components/command-palette";
import { AssistantWidget, clearAssistantHistory } from "@/components/assistant/assistant-widget";
import { AiSummaryHost } from "@/components/files/ai-summary-dialog";
import { NAV_ITEMS, isActive, type NavItem } from "@/components/navigation";
import { cn } from "@/lib/utils";

interface DashboardLayoutProps {
  children: ReactNode;
  user: { id: string; email?: string };
}

const SECTIONS: { title: string; items: readonly NavItem[] }[] = [
  { title: "Workspace", items: NAV_ITEMS.slice(0, 4) },
  { title: "Library", items: NAV_ITEMS.slice(4) },
];

function ShortcutHint({ className }: { className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md border bg-background/80 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground",
        className
      )}
    >
      <Command className="h-2.5 w-2.5" />K
    </kbd>
  );
}

function SidebarContent({
  pathname,
  email,
  onNavigate,
  onLogout,
  onClose,
  indicatorId,
}: {
  pathname: string;
  email?: string;
  onNavigate: () => void;
  onLogout: () => void;
  onClose?: () => void;
  indicatorId: string;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 items-center justify-between px-5">
        <Logo href="/dashboard" />
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        )}
      </div>

      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={() => {
            onNavigate();
            openCommandPalette();
          }}
          className="flex w-full items-center gap-2.5 rounded-xl border bg-background/60 px-3 py-2 text-sm text-muted-foreground shadow-sm transition-colors hover:border-primary/30 hover:text-foreground"
        >
          <Search className="h-4 w-4" />
          Quick search
          <ShortcutHint className="ml-auto" />
        </button>
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-3">
        {SECTIONS.map((section) => (
          <div key={section.title}>
            <p className="mb-1.5 px-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
              {section.title}
            </p>
            <div className="space-y-0.5">
              {section.items.map(({ href, label, icon: Icon }) => {
                const active = isActive(pathname, href);
                return (
                  <Link
                    key={href}
                    href={href}
                    aria-current={active ? "page" : undefined}
                    onClick={onNavigate}
                    className={cn(
                      "group relative flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition-colors",
                      active
                        ? "font-medium text-foreground"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    )}
                  >
                    {active && (
                      <motion.span
                        layoutId={indicatorId}
                        className="absolute inset-0 rounded-xl border border-primary/15 bg-gradient-to-r from-primary/15 to-primary/5 shadow-sm"
                        transition={{ type: "spring", stiffness: 450, damping: 36 }}
                      >
                        <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-x-[3px] -translate-y-1/2 rounded-full bg-brand" />
                      </motion.span>
                    )}
                    <Icon
                      className={cn(
                        "relative h-4 w-4 transition-transform duration-300 group-hover:scale-110",
                        active && "text-primary"
                      )}
                    />
                    <span className="relative">{label}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="space-y-2 p-3">
        <div className="rounded-2xl border bg-background/50 p-1 shadow-sm">
          <StorageUsage />
        </div>
        <div className="flex items-center gap-3 rounded-xl px-2 py-2">
          <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand text-sm font-semibold text-white shadow-md shadow-primary/25">
            {email?.charAt(0).toUpperCase() || "U"}
            <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-sidebar bg-success" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{email}</p>
            <p className="text-[11px] text-muted-foreground">Personal workspace</p>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 px-1">
          <ThemeToggle layoutId={`${indicatorId}-theme`} />
          <Button
            variant="ghost"
            size="sm"
            className="gap-2 text-muted-foreground"
            onClick={onLogout}
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function DashboardLayout({
  children,
  user,
}: DashboardLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();

  const handleLogout = async () => {
    clearAssistantHistory();
    await createClient().auth.signOut();
    toast.success("Signed out");
    router.push("/login");
    router.refresh();
  };

  const current = NAV_ITEMS.find((item) => isActive(pathname, item.href));

  return (
    <div className="relative flex min-h-screen">
      <AuroraBackground variant="subtle" />
      <CommandPalette onSignOut={handleLogout} />
      <AssistantWidget userId={user.id} />
      <AiSummaryHost />

      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-[17rem] shrink-0 border-r bg-sidebar/60 backdrop-blur-2xl lg:block">
        <SidebarContent
          pathname={pathname}
          email={user.email}
          onNavigate={() => {}}
          onLogout={handleLogout}
          indicatorId="sidebar-active"
        />
      </aside>

      {/* Mobile drawer */}
      <AnimatePresence>
        {sidebarOpen && (
          <>
            <motion.div
              key="overlay"
              className="fixed inset-0 z-40 bg-background/50 backdrop-blur-sm lg:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSidebarOpen(false)}
            />
            <motion.aside
              key="drawer"
              className="fixed inset-y-0 left-0 z-50 w-[17rem] border-r bg-sidebar shadow-2xl lg:hidden"
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", stiffness: 380, damping: 38 }}
            >
              <SidebarContent
                pathname={pathname}
                email={user.email}
                onNavigate={() => setSidebarOpen(false)}
                onLogout={handleLogout}
                onClose={() => setSidebarOpen(false)}
                indicatorId="drawer-active"
              />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b bg-background/50 px-4 backdrop-blur-2xl lg:px-8">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
          >
            <Menu className="h-5 w-5" />
          </button>
          <AnimatePresence mode="wait" initial={false}>
            <motion.h1
              key={current?.label ?? "app"}
              initial={{ opacity: 0, y: 6, filter: "blur(4px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: -6, filter: "blur(4px)" }}
              transition={{ duration: 0.2 }}
              className="text-base font-semibold tracking-tight"
            >
              {current?.label ?? "File Manager"}
            </motion.h1>
          </AnimatePresence>
          <button
            type="button"
            onClick={openCommandPalette}
            className="ml-auto flex items-center gap-2 rounded-xl border bg-background/60 px-3 py-1.5 text-sm text-muted-foreground shadow-sm transition-all hover:border-primary/30 hover:text-foreground sm:w-72"
            aria-label="Search and commands"
          >
            <Search className="h-4 w-4" />
            <span className="hidden sm:inline">Search or run a command…</span>
            <ShortcutHint className="ml-auto hidden sm:inline-flex" />
          </button>
        </header>

        <main className="flex-1 p-4 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
