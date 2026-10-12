"use client";

import { useRef } from "react";
import {
  motion,
  useMotionValue,
  useScroll,
  useSpring,
  useTransform,
} from "motion/react";
import {
  CheckCircle2,
  Clock,
  Command,
  History,
  Link2,
  Search,
  Share2,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { FileTile, type FileKind } from "@/components/files/file-tile";
import { BorderBeam } from "@/components/fx/border-beam";
import { LogoMark } from "@/components/brand/logo";
import { cn } from "@/lib/utils";

const NAV = [
  { icon: UploadCloud, label: "My Files", active: true },
  { icon: Clock, label: "Recent" },
  { icon: Share2, label: "Shared" },
  { icon: History, label: "Activity" },
  { icon: Trash2, label: "Trash" },
];

const FILES: { name: string; meta: string; kind: FileKind; badge?: string }[] = [
  { name: "Brand guidelines", meta: "Folder · 24 items", kind: "folder" },
  { name: "Q4-board-deck.pdf", meta: "4.8 MB · 2m ago", kind: "pdf", badge: "Shared" },
  { name: "hero-shot@2x.png", meta: "2.1 MB · 10m ago", kind: "image", badge: "Public" },
  { name: "launch-teaser.mp4", meta: "84 MB · 1h ago", kind: "video" },
  { name: "app-release-1.4.zip", meta: "32 MB · Yesterday", kind: "archive" },
];

/**
 * Interactive product preview: tilts toward the cursor and straightens out
 * as the page scrolls (Apple / Linear style), with live micro-animations.
 */
export function ProductMock() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "center center"],
  });
  const scrollRotate = useTransform(scrollYProgress, [0, 1], [18, 0]);
  const scale = useTransform(scrollYProgress, [0, 1], [0.9, 1]);

  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const tiltX = useSpring(useTransform(my, [-0.5, 0.5], [5, -5]), { stiffness: 120, damping: 18 });
  const tiltY = useSpring(useTransform(mx, [-0.5, 0.5], [-7, 7]), { stiffness: 120, damping: 18 });
  const rotateX = useTransform(() => scrollRotate.get() + tiltX.get());

  return (
    <div
      ref={ref}
      className="relative mx-auto mt-16 w-full max-w-5xl [perspective:1600px]"
      onPointerMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        mx.set((event.clientX - rect.left) / rect.width - 0.5);
        my.set((event.clientY - rect.top) / rect.height - 0.5);
      }}
      onPointerLeave={() => {
        mx.set(0);
        my.set(0);
      }}
    >
      <div className="absolute inset-x-10 -top-10 bottom-0 -z-10 rounded-[3rem] bg-brand opacity-30 blur-[90px]" />
      <motion.div
        initial={{ opacity: 0, y: 60 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1], delay: 0.6 }}
        style={{ rotateX, rotateY: tiltY, scale, transformStyle: "preserve-3d" }}
        className="relative rounded-2xl border bg-card/80 shadow-[0_40px_120px_-30px_rgb(0_0_0/0.45)] backdrop-blur-2xl"
      >
        <BorderBeam duration={10} />
        {/* Window chrome */}
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
          <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
          <span className="h-3 w-3 rounded-full bg-[#28c840]" />
          <div className="mx-auto hidden items-center gap-2 rounded-lg border bg-background/60 px-3 py-1 text-xs text-muted-foreground sm:flex">
            <Search className="h-3 w-3" />
            Search files, folders and actions
            <kbd className="ml-6 inline-flex items-center gap-0.5 rounded border bg-muted px-1 text-[10px]">
              <Command className="h-2.5 w-2.5" />K
            </kbd>
          </div>
        </div>

        <div className="flex text-left">
          {/* Sidebar */}
          <div className="hidden w-48 shrink-0 border-r p-3 md:block">
            <div className="mb-4 flex items-center gap-2 px-2">
              <LogoMark className="h-6 w-6 rounded-lg [&_svg]:h-3 [&_svg]:w-3" />
              <span className="text-sm font-semibold">File Manager</span>
            </div>
            {NAV.map(({ icon: Icon, label, active }) => (
              <div
                key={label}
                className={cn(
                  "mb-0.5 flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-xs",
                  active ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground"
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </div>
            ))}
            <div className="mt-6 rounded-xl border bg-background/50 p-2.5">
              <div className="mb-1.5 flex justify-between text-[10px] text-muted-foreground">
                <span>Storage</span>
                <span>62%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <motion.div
                  className="h-full rounded-full bg-brand"
                  initial={{ width: 0 }}
                  animate={{ width: "62%" }}
                  transition={{ delay: 1.4, duration: 1.4, ease: [0.22, 1, 0.36, 1] }}
                />
              </div>
            </div>
          </div>

          {/* Content */}
          <div className="min-w-0 flex-1 p-4 sm:p-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold">My Files</p>
                <p className="text-[11px] text-muted-foreground">1 folder · 4 files</p>
              </div>
              <span className="shine inline-flex items-center gap-1.5 rounded-lg bg-brand px-2.5 py-1.5 text-[11px] font-medium text-white shadow-lg shadow-primary/30">
                <UploadCloud className="h-3.5 w-3.5" />
                Upload
              </span>
            </div>
            <div className="divide-y overflow-hidden rounded-xl border bg-background/40">
              {FILES.map((file, i) => (
                <motion.div
                  key={file.name}
                  initial={{ opacity: 0, x: -16 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 1 + i * 0.09, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                  className="flex items-center gap-3 px-3 py-2.5"
                >
                  <FileTile kind={file.kind} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{file.name}</p>
                    <p className="text-[10px] text-muted-foreground">{file.meta}</p>
                  </div>
                  {file.badge && (
                    <span className="rounded-full border bg-background/70 px-2 py-0.5 text-[10px] text-muted-foreground">
                      {file.badge}
                    </span>
                  )}
                </motion.div>
              ))}
              {/* Live upload row */}
              <div className="flex items-center gap-3 px-3 py-2.5">
                <FileTile kind="code" size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">transfer.bundle</p>
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                    <motion.div
                      className="h-full rounded-full bg-brand"
                      animate={{ width: ["0%", "100%", "100%"] }}
                      transition={{ duration: 3.2, times: [0, 0.75, 1], repeat: Infinity, ease: "easeInOut" }}
                    />
                  </div>
                </div>
                <span className="text-[10px] text-muted-foreground">Uploading</span>
              </div>
            </div>
          </div>
        </div>

        {/* Floating toast */}
        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.9 }}
          animate={{ opacity: [0, 1, 1, 0], y: [20, 0, 0, -10], scale: [0.9, 1, 1, 0.95] }}
          transition={{ duration: 4.5, times: [0, 0.12, 0.8, 1], repeat: Infinity, repeatDelay: 1.5, delay: 2.2 }}
          style={{ translateZ: 60 }}
          className="absolute -right-3 bottom-8 hidden items-center gap-2.5 rounded-xl border bg-popover px-3.5 py-2.5 text-xs shadow-2xl sm:flex"
        >
          <CheckCircle2 className="h-4 w-4 text-success" />
          <div>
            <p className="font-medium">Link copied</p>
            <p className="text-[10px] text-muted-foreground">Anyone with the link can download</p>
          </div>
          <Link2 className="ml-1 h-3.5 w-3.5 text-muted-foreground" />
        </motion.div>
      </motion.div>
    </div>
  );
}
