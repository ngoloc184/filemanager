"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Command } from "cmdk";
import { AnimatePresence, motion } from "motion/react";
import { useTheme } from "next-themes";
import {
  ArrowRight,
  CornerDownLeft,
  FilePlus2,
  FolderPlus,
  Home,
  LogOut,
  Monitor,
  Moon,
  Search,
  Sun,
  UploadCloud,
} from "lucide-react";
import { NAV_ITEMS, sendFilesCommand, type FilesCommand } from "@/components/navigation";

const OPEN_EVENT = "fm:open-command-palette";

/** Opens the palette from anywhere (e.g. a header button). */
export function openCommandPalette(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

function Item({
  children,
  onSelect,
  shortcut,
  value,
}: {
  children: ReactNode;
  onSelect: () => void;
  shortcut?: string;
  value: string;
}) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="group flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-muted-foreground transition-colors data-[selected=true]:bg-primary/10 data-[selected=true]:text-foreground [&_svg]:h-4 [&_svg]:w-4"
    >
      {children}
      {shortcut ? (
        <kbd className="ml-auto rounded-md border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {shortcut}
        </kbd>
      ) : (
        <CornerDownLeft className="ml-auto !h-3.5 !w-3.5 opacity-0 transition-opacity group-data-[selected=true]:opacity-60" />
      )}
    </Command.Item>
  );
}

function Group({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <Command.Group
      heading={heading}
      className="px-2 pb-2 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground/70"
    >
      {children}
    </Command.Group>
  );
}

/**
 * ⌘K / Ctrl+K command palette (Linear / Raycast style): jump between pages,
 * trigger file actions, switch theme and sign out.
 */
export function CommandPalette({ onSignOut }: { onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const { setTheme } = useTheme();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      } else if (event.key === "Escape") {
        setOpen(false);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  const filesCommand = (command: FilesCommand) =>
    run(() => {
      if (pathname === "/dashboard") sendFilesCommand(command);
      else router.push(`/dashboard?intent=${command}`);
    });

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[14vh]">
          <motion.div
            className="absolute inset-0 bg-background/40 backdrop-blur-md"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setOpen(false)}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            initial={{ opacity: 0, scale: 0.94, y: -12, filter: "blur(8px)" }}
            animate={{ opacity: 1, scale: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, scale: 0.96, y: -8, filter: "blur(6px)" }}
            transition={{ type: "spring", stiffness: 420, damping: 32 }}
            className="relative w-full max-w-xl overflow-hidden rounded-2xl border bg-popover/90 shadow-[0_30px_80px_-20px_rgb(0_0_0/0.45)] backdrop-blur-2xl"
          >
            <Command loop label="Command palette">
              <div className="flex items-center gap-3 border-b px-4">
                <Search className="h-4 w-4 text-muted-foreground" />
                <Command.Input
                  autoFocus
                  placeholder="Type a command or search…"
                  className="h-14 w-full bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
                />
                <kbd className="rounded-md border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  ESC
                </kbd>
              </div>
              <Command.List className="max-h-[min(60vh,420px)] overflow-y-auto overscroll-contain py-1">
                <Command.Empty className="py-10 text-center text-sm text-muted-foreground">
                  No results found.
                </Command.Empty>

                <Group heading="Actions">
                  <Item value="upload files" onSelect={() => filesCommand("upload")}>
                    <UploadCloud /> Upload files
                  </Item>
                  <Item value="new folder create" onSelect={() => filesCommand("new-folder")}>
                    <FolderPlus /> New folder
                  </Item>
                  <Item value="new text file notepad create txt" onSelect={() => filesCommand("new-text-file")}>
                    <FilePlus2 /> New text file
                  </Item>
                </Group>

                <Group heading="Go to">
                  {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
                    <Item key={href} value={`go ${label}`} onSelect={() => run(() => router.push(href))}>
                      <Icon /> {label}
                      <ArrowRight className="!h-3 !w-3 opacity-40" />
                    </Item>
                  ))}
                  <Item value="go home landing" onSelect={() => run(() => router.push("/"))}>
                    <Home /> Home page
                  </Item>
                </Group>

                <Group heading="Theme">
                  <Item value="theme light" onSelect={() => run(() => setTheme("light"))}>
                    <Sun /> Light
                  </Item>
                  <Item value="theme dark" onSelect={() => run(() => setTheme("dark"))}>
                    <Moon /> Dark
                  </Item>
                  <Item value="theme system" onSelect={() => run(() => setTheme("system"))}>
                    <Monitor /> System
                  </Item>
                </Group>

                <Group heading="Account">
                  <Item value="sign out logout" onSelect={() => run(onSignOut)}>
                    <LogOut /> Sign out
                  </Item>
                </Group>
              </Command.List>
              <div className="flex items-center justify-between border-t px-4 py-2.5 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <kbd className="rounded border bg-muted px-1 font-mono">↑</kbd>
                  <kbd className="rounded border bg-muted px-1 font-mono">↓</kbd>
                  to navigate
                </span>
                <span className="flex items-center gap-1.5">
                  <kbd className="rounded border bg-muted px-1 font-mono">↵</kbd>
                  to select
                </span>
              </div>
            </Command>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
