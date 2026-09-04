"use client";

import { ReactNode, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { toast } from "react-hot-toast";
import {
  LogOut,
  Upload,
  Menu,
  X,
  FolderOpen,
  UsersRound,
  Search,
  Trash2,
  Share2,
  Clock,
  History,
} from "lucide-react";
import Link from "next/link";
import StorageUsage from "@/components/files/storage-usage";

interface DashboardLayoutProps {
  children: ReactNode;
  user: {
    id: string;
    email?: string;
    user_metadata?: Record<string, unknown>;
  };
}

export default function DashboardLayout({
  children,
  user,
}: DashboardLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const supabase = createClient();

  const handleLogout = async () => {
    await supabase.auth.signOut();
    toast.success("Logged out");
    router.push("/login");
    router.refresh();
  };

  return (
    <div className="min-h-screen bg-gray-50 flex">
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        className={`
          fixed inset-y-0 left-0 z-50 w-64 bg-white border-r border-gray-200 
          transform transition-transform duration-200 ease-in-out
          lg:translate-x-0 lg:static lg:z-auto
          ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}
        `}
      >
        <div className="flex flex-col h-full">
          <div className="flex items-center justify-between h-16 px-6 border-b border-gray-200">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
                <FolderOpen className="h-4 w-4 text-primary-foreground" />
              </div>
              <span className="font-bold text-lg">File Manager</span>
            </div>
            <button
              onClick={() => setSidebarOpen(false)}
              className="lg:hidden text-muted-foreground hover:text-foreground"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <nav className="flex-1 px-4 py-4 space-y-1">
            <Link
              href="/dashboard"
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg ${
                pathname === "/dashboard" || pathname.startsWith("/dashboard?")
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
              onClick={() => setSidebarOpen(false)}
            >
              <Upload className="h-4 w-4" />
              My Files
            </Link>
            <Link
              href="/recent"
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg ${
                pathname.startsWith("/recent")
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
              onClick={() => setSidebarOpen(false)}
            >
              <Clock className="h-4 w-4" />
              Recent
            </Link>
            <Link
              href="/search"
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg ${
                pathname.startsWith("/search")
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
              onClick={() => setSidebarOpen(false)}
            >
              <Search className="h-4 w-4" />
              Search
            </Link>
            <Link
              href="/shared"
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg ${
                pathname.startsWith("/shared")
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
              onClick={() => setSidebarOpen(false)}
            >
              <Share2 className="h-4 w-4" />
              Shared with me
            </Link>
            <Link
              href="/trash"
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg ${
                pathname.startsWith("/trash")
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
              onClick={() => setSidebarOpen(false)}
            >
              <Trash2 className="h-4 w-4" />
              Trash
            </Link>
            <Link
              href="/activity"
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg ${
                pathname.startsWith("/activity")
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
              onClick={() => setSidebarOpen(false)}
            >
              <History className="h-4 w-4" />
              Activity
            </Link>
            <Link
              href="/contacts"
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg ${
                pathname.startsWith("/contacts")
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
              onClick={() => setSidebarOpen(false)}
            >
              <UsersRound className="h-4 w-4" />
              Related users
            </Link>
          </nav>

          <div className="p-4 border-t border-gray-200">
            <div className="mb-2">
              <StorageUsage />
            </div>
            <div className="flex items-center gap-3 px-3 py-2">
              <div className="w-8 h-8 bg-gray-200 rounded-full flex items-center justify-center text-sm font-medium text-gray-600">
                {user.email?.charAt(0).toUpperCase() || "U"}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{user.email}</p>
              </div>
            </div>
            <Button
              variant="ghost"
              className="w-full justify-start gap-3 mt-1 text-muted-foreground"
              onClick={handleLogout}
            >
              <LogOut className="h-4 w-4" />
              Sign Out
            </Button>
          </div>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-16 bg-white border-b border-gray-200 flex items-center px-4 lg:px-6 shrink-0">
          <button
            onClick={() => setSidebarOpen(true)}
            className="lg:hidden text-muted-foreground hover:text-foreground mr-3"
          >
            <Menu className="h-5 w-5" />
          </button>
          <h1 className="text-lg font-semibold">File Manager</h1>
        </header>

        <main className="flex-1 overflow-auto p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}
