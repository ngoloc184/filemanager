import {
  Clock,
  History,
  Search,
  Share2,
  Trash2,
  Upload,
  UsersRound,
  type LucideIcon,
} from "lucide-react";

export type NavItem = { href: string; label: string; icon: LucideIcon };

/** Signed-in app sections, shared by the sidebar and the command palette. */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/dashboard", label: "My Files", icon: Upload },
  { href: "/recent", label: "Recent", icon: Clock },
  { href: "/search", label: "Search", icon: Search },
  { href: "/shared", label: "Shared with me", icon: Share2 },
  { href: "/trash", label: "Trash", icon: Trash2 },
  { href: "/activity", label: "Activity", icon: History },
  { href: "/contacts", label: "Related users", icon: UsersRound },
];

export function isActive(pathname: string, href: string): boolean {
  // "My Files" is only active on the root dashboard route
  return href === "/dashboard" ? pathname === href : pathname.startsWith(href);
}

/** Commands the palette can send to the files view. */
export type FilesCommand = "upload" | "new-folder";
export const FILES_COMMAND_EVENT = "fm:files-command";

export function sendFilesCommand(command: FilesCommand): void {
  window.dispatchEvent(new CustomEvent<FilesCommand>(FILES_COMMAND_EVENT, { detail: command }));
}
