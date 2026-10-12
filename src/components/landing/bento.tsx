"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Check,
  Copy,
  History,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
  UploadCloud,
  type LucideIcon,
} from "lucide-react";
import { FileTile, type FileKind } from "@/components/files/file-tile";
import { SpotlightCard } from "@/components/fx/spotlight-card";
import { cn } from "@/lib/utils";

const EASE = [0.22, 1, 0.36, 1] as const;

function useTicker(length: number, intervalMs: number): number {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setIndex((i) => (i + 1) % length), intervalMs);
    return () => clearInterval(id);
  }, [length, intervalMs]);
  return index;
}

/* ---------- Live demos ---------- */

function DropDemo() {
  const kinds: FileKind[] = ["pdf", "image", "video", "archive"];
  return (
    <div className="relative flex h-44 items-end justify-center">
      {kinds.map((kind, i) => (
        <motion.div
          key={kind}
          className="absolute"
          style={{ left: `${18 + i * 18}%` }}
          initial={{ y: -40, opacity: 0, rotate: -10 + i * 7 }}
          animate={{ y: [-40, 70, 70], opacity: [0, 1, 0], rotate: [-10 + i * 7, 0, 0], scale: [1, 1, 0.6] }}
          transition={{ duration: 2.6, times: [0, 0.6, 1], repeat: Infinity, delay: i * 0.45, ease: EASE }}
        >
          <FileTile kind={kind} />
        </motion.div>
      ))}
      <div className="relative flex h-16 w-3/4 items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-primary/40 bg-primary/5 text-xs font-medium text-primary">
        <UploadCloud className="h-4 w-4" />
        Drop files to upload
        <motion.span
          className="absolute inset-0 rounded-2xl ring-2 ring-primary/40"
          animate={{ opacity: [0, 1, 0], scale: [0.98, 1.03, 1.06] }}
          transition={{ duration: 2.6, repeat: Infinity, ease: "easeOut" }}
        />
      </div>
    </div>
  );
}

function VersionDemo() {
  const versions = ["v1", "v2", "v3", "v4"];
  const active = useTicker(versions.length, 1400);
  return (
    <div className="flex h-44 flex-col justify-center gap-5 px-2">
      <div className="relative flex items-center justify-between">
        <div className="absolute inset-x-3 top-1/2 h-px -translate-y-1/2 bg-border" />
        <motion.div
          className="absolute left-3 top-1/2 h-px -translate-y-1/2 bg-brand"
          animate={{ width: `${(active / (versions.length - 1)) * 92}%` }}
          transition={{ duration: 0.6, ease: EASE }}
        />
        {versions.map((v, i) => (
          <div key={v} className="relative flex flex-col items-center gap-2">
            <motion.span
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-full border text-[10px] font-semibold",
                i <= active ? "border-transparent bg-brand text-white" : "bg-card text-muted-foreground"
              )}
              animate={{ scale: i === active ? 1.15 : 1 }}
              transition={{ type: "spring", stiffness: 400, damping: 20 }}
            >
              {v}
            </motion.span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between rounded-xl border bg-background/60 px-3 py-2 text-xs">
        <span className="font-medium">contract-final.pdf</span>
        <AnimatePresence mode="wait">
          <motion.span
            key={active}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            className="inline-flex items-center gap-1 text-muted-foreground"
          >
            <RotateCcw className="h-3 w-3" />
            {versions[active]} current
          </motion.span>
        </AnimatePresence>
      </div>
    </div>
  );
}

function ShareDemo() {
  const copied = useTicker(2, 1800) === 1;
  const people = ["LN", "MT", "HA"];
  return (
    <div className="flex h-44 flex-col justify-center gap-4">
      <div className="flex items-center gap-3">
        <div className="flex -space-x-2">
          {people.map((p, i) => (
            <motion.span
              key={p}
              initial={{ scale: 0, x: -10 }}
              whileInView={{ scale: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.2 + i * 0.12, type: "spring", stiffness: 300, damping: 18 }}
              className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-card bg-brand text-[10px] font-semibold text-white"
              style={{ filter: `hue-rotate(${i * 50}deg)` }}
            >
              {p}
            </motion.span>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">Viewer · Editor · Admin</span>
      </div>
      <div className="flex items-center gap-2 rounded-xl border bg-background/60 p-1.5 pl-3 text-xs">
        <span className="min-w-0 flex-1 truncate text-muted-foreground">cavoi-it.app/share/9f2c…</span>
        <motion.span
          layout
          className={cn(
            "inline-flex items-center gap-1 rounded-lg px-2.5 py-1 font-medium transition-colors",
            copied ? "bg-success/15 text-success" : "bg-primary text-primary-foreground"
          )}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </motion.span>
      </div>
    </div>
  );
}

function SearchDemo() {
  const query = "report";
  const [typed, setTyped] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTyped((t) => (t >= query.length + 6 ? 0 : t + 1)), 220);
    return () => clearInterval(id);
  }, []);
  const text = query.slice(0, Math.min(typed, query.length));
  const all: { name: string; kind: FileKind }[] = [
    { name: "annual-report.pdf", kind: "pdf" },
    { name: "team-photo.jpg", kind: "image" },
    { name: "report-data.xlsx", kind: "sheet" },
    { name: "intro.mp4", kind: "video" },
  ];
  const results = all.filter((f) => f.name.includes(text));
  return (
    <div className="flex h-44 flex-col gap-2">
      <div className="flex items-center gap-2 rounded-xl border bg-background/60 px-3 py-2 text-xs">
        <Search className="h-3.5 w-3.5 text-muted-foreground" />
        <span>{text}</span>
        <motion.span
          className="-ml-1.5 h-3.5 w-px bg-foreground"
          animate={{ opacity: [1, 0] }}
          transition={{ duration: 0.8, repeat: Infinity }}
        />
        <span className="ml-auto rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">#finance</span>
      </div>
      <motion.div layout className="space-y-1.5">
        <AnimatePresence initial={false}>
          {results.map((f) => (
            <motion.div
              key={f.name}
              layout
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.25 }}
              className="flex items-center gap-2 rounded-lg border bg-background/40 px-2 py-1.5 text-xs"
            >
              <FileTile kind={f.kind} size="sm" className="h-6 w-6 rounded-md" />
              {f.name}
            </motion.div>
          ))}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}

function TrashDemo() {
  const restored = useTicker(2, 1700) === 1;
  return (
    <div className="flex h-44 items-center justify-center gap-6">
      <motion.div
        animate={{ x: restored ? 0 : 70, y: restored ? 0 : 18, scale: restored ? 1 : 0.6, opacity: restored ? 1 : 0.4, rotate: restored ? 0 : 12 }}
        transition={{ type: "spring", stiffness: 160, damping: 16 }}
      >
        <FileTile kind="text" size="lg" />
      </motion.div>
      <motion.div
        animate={{ rotate: restored ? 0 : [0, -8, 8, 0] }}
        transition={{ duration: 0.5 }}
        className="flex h-14 w-14 items-center justify-center rounded-2xl border bg-background/60 text-muted-foreground"
      >
        <Trash2 className="h-6 w-6" />
      </motion.div>
    </div>
  );
}

/* ---------- Grid ---------- */

const CELLS: {
  icon: LucideIcon;
  title: string;
  body: string;
  demo: () => React.ReactNode;
  span: string;
}[] = [
  {
    icon: UploadCloud,
    title: "Drag, drop, done",
    body: "Drop dozens of files at once. Each upload is tracked live, retried in one click and checked for duplicates.",
    demo: DropDemo,
    span: "lg:col-span-2",
  },
  {
    icon: History,
    title: "Every version, kept",
    body: "Upload new versions and roll back to any previous one instantly.",
    demo: VersionDemo,
    span: "",
  },
  {
    icon: ShieldCheck,
    title: "Share with confidence",
    body: "Role-based access for people, public links you can switch off anytime.",
    demo: ShareDemo,
    span: "",
  },
  {
    icon: Search,
    title: "Find anything instantly",
    body: "Search by name, type, size, date and tags across everything you can access.",
    demo: SearchDemo,
    span: "",
  },
  {
    icon: Trash2,
    title: "Nothing is ever lost",
    body: "Deleted items wait in the trash, and every action lands in the activity log.",
    demo: TrashDemo,
    span: "",
  },
];

export function Bento() {
  return (
    <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {CELLS.map(({ icon: Icon, title, body, demo: Demo, span }, i) => (
        <motion.div
          key={title}
          className={span}
          initial={{ opacity: 0, y: 40, filter: "blur(8px)" }}
          whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          viewport={{ once: true, margin: "-60px" }}
          transition={{ duration: 0.8, ease: EASE, delay: (i % 3) * 0.1 }}
        >
          <SpotlightCard className="h-full rounded-3xl border bg-card/60 p-6 backdrop-blur-xl transition-shadow duration-500 hover:shadow-2xl hover:shadow-primary/10">
            <div className="relative">
              <Demo />
              <div className="mt-5 flex items-center gap-2">
                <Icon className="h-4 w-4 text-primary" />
                <h3 className="font-semibold tracking-tight">{title}</h3>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
            </div>
          </SpotlightCard>
        </motion.div>
      ))}
    </div>
  );
}
