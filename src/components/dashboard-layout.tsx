"use client";

import { ReactNode, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "react-hot-toast";
import {
  Clock,
  History,
  LogOut,
  Menu,
  Search,
  Share2,
  Trash2,
  Upload,
  UsersRound,
  X,
  type LucideIcon,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import StorageUsage from "@/components/files/storage-usage";
import { AuroraBackground } from "@/components/brand/aurora-background";
import { Logo } from "@/components/brand/logo";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { cn } from "@/lib/utils";

interface DashboardLayoutProps {
  children: ReactNode;
  user: { id: string; email?: string };
}

const NAV_ITEMS: ReadonlyArray<{
  href: string;
  label: string;
  icon: LucideIcon;
}> = [
  { href: "/dashboard", label: "My Files", icon: Upload },
  { href: "/recent", label: "Recent", icon: Clock },
  { href: "/search", label: "Search", icon: Search },
  { href: "/shared", label: "Shared with me", icon: Share2 },
  { href: "/trash", label: "Trash", icon: Trash2 },
  { href: "/activity", label: "Activity", icon: History },
  { href: "/contacts", label: "Related users", icon: UsersRound },
];

function isActive(pathname: string, href: string): boolean {
  // "My Files" is only active on the root dashboard route
  return href === "/dashboard" ? pathname === href : pathname.startsWith(href);
}

function SidebarContent({
  pathname,
  email,
  onNavigate,
  onLogout,
  onClose,
}: {
  pathname: string;
  email?: string;
  onNavigate: () => void;
  onLogout: () => void;
  onClose?: () => void;
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
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
          >
            <X className="h-5 w-5" />
          </button>
        )}
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-3">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              onClick={onNavigate}
              className={cn(
                "group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors",
                active
                  ? "font-medium text-primary"
                  : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
              )}
            >
              {active && (
                <motion.span
                  layoutId="sidebar-active"
                  className="absolute inset-0 rounded-xl bg-primary/10 ring-1 ring-primary/15"
                  transition={{ type: "spring", stiffness: 420, damping: 34 }}
                />
              )}
              <Icon
                className={cn(
                  "relative h-4 w-4 transition-transform group-hover:scale-110",
                  active && "text-primary"
                )}
              />
              <span className="relative">{label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="space-y-2 border-t p-3">
        <StorageUsage />
        <div className="flex items-center gap-3 rounded-xl px-3 py-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-sm font-semibold text-white shadow-md shadow-primary/20">
            {email?.charAt(0).toUpperCase() || "U"}
          </div>
          <p className="min-w-0 flex-1 truncate text-sm font-medium">{email}</p>
        </div>
        <div className="flex items-center justify-between gap-2 px-1">
          <ThemeToggle layoutId="sidebar-theme-pill" />
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
    await createClient().auth.signOut();
    toast.success("Signed out");
    router.push("/login");
    router.refresh();
  };

  const current = NAV_ITEMS.find((item) => isActive(pathname, item.href));

  return (
    <div className="relative flex min-h-screen">
      <AuroraBackground variant="subtle" />

      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 border-r bg-sidebar/70 backdrop-blur-xl lg:block">
        <SidebarContent
          pathname={pathname}
          email={user.email}
          onNavigate={() => {}}
          onLogout={handleLogout}
        />
      </aside>

      {/* Mobile drawer */}
      <AnimatePresence>
        {sidebarOpen && (
          <>
            <motion.div
              key="overlay"
              className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm lg:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSidebarOpen(false)}
            />
            <motion.aside
              key="drawer"
              className="fixed inset-y-0 left-0 z-50 w-72 border-r bg-sidebar shadow-2xl lg:hidden"
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
              />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b bg-background/60 px-4 backdrop-blur-xl lg:px-8">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
          >
            <Menu className="h-5 w-5" />
          </button>
          <h1 className="text-base font-semibold tracking-tight">
            {current?.label ?? "File Manager"}
          </h1>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="hidden gap-2 text-muted-foreground sm:inline-flex"
              render={<Link href="/search" />}
            >
              <Search className="h-3.5 w-3.5" />
              Search files
            </Button>
          </div>
        </header>

        <main className="flex-1 p-4 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
