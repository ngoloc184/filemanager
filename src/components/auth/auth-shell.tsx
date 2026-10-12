"use client";

import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { History, ShieldCheck, UploadCloud, Zap } from "lucide-react";
import { AuroraBackground } from "@/components/brand/aurora-background";
import { Logo } from "@/components/brand/logo";
import { FileTile, type FileKind } from "@/components/files/file-tile";
import { BorderBeam } from "@/components/fx/border-beam";
import { ThemeToggle } from "@/components/theme/theme-toggle";

const EASE = [0.22, 1, 0.36, 1] as const;

const HIGHLIGHTS = [
  { icon: UploadCloud, title: "Drag, drop, done", body: "Upload whole folders of work in seconds with live progress." },
  { icon: History, title: "Every version kept", body: "Roll back any file to a previous version in one click." },
  { icon: ShieldCheck, title: "Share with confidence", body: "Role-based access and public links you control." },
  { icon: Zap, title: "Delivered from the edge", body: "Versioned files cached worldwide for instant loads." },
];

const FLOATING: { kind: FileKind; x: string; y: string; delay: number; rotate: number }[] = [
  { kind: "pdf", x: "12%", y: "18%", delay: 0, rotate: -10 },
  { kind: "image", x: "74%", y: "12%", delay: 0.8, rotate: 8 },
  { kind: "video", x: "82%", y: "58%", delay: 1.6, rotate: -6 },
  { kind: "archive", x: "8%", y: "64%", delay: 2.2, rotate: 12 },
  { kind: "code", x: "46%", y: "80%", delay: 1.1, rotate: -4 },
];

function Showcase() {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setIndex((i) => (i + 1) % HIGHLIGHTS.length), 3200);
    return () => clearInterval(id);
  }, []);
  const { icon: Icon, title, body } = HIGHLIGHTS[index];

  return (
    <div className="grain relative hidden overflow-hidden rounded-[2rem] border bg-card/40 backdrop-blur-xl lg:flex lg:flex-col lg:justify-end">
      <BorderBeam duration={12} />
      <div className="hero-beams opacity-80" />
      <div className="dot-pattern pointer-events-none absolute inset-0 opacity-50 [mask-image:radial-gradient(ellipse_at_center,#000,transparent_75%)]" />

      {FLOATING.map(({ kind, x, y, delay, rotate }) => (
        <motion.div
          key={`${kind}-${x}`}
          className="absolute"
          style={{ left: x, top: y }}
          initial={{ opacity: 0, scale: 0.6, rotate: 0 }}
          animate={{ opacity: 1, scale: 1, rotate, y: [0, -14, 0] }}
          transition={{
            opacity: { delay: 0.3 + delay * 0.2, duration: 0.6 },
            scale: { delay: 0.3 + delay * 0.2, type: "spring", stiffness: 200, damping: 14 },
            rotate: { delay: 0.3 + delay * 0.2, type: "spring", stiffness: 200, damping: 14 },
            y: { duration: 5 + delay, repeat: Infinity, ease: "easeInOut", delay },
          }}
        >
          <FileTile kind={kind} size="lg" className="bg-card shadow-2xl" />
        </motion.div>
      ))}

      <div className="relative m-8 rounded-3xl border bg-background/70 p-6 shadow-2xl backdrop-blur-xl">
        <AnimatePresence mode="wait">
          <motion.div
            key={title}
            initial={{ opacity: 0, y: 12, filter: "blur(6px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -12, filter: "blur(6px)" }}
            transition={{ duration: 0.45, ease: EASE }}
            className="flex items-start gap-4"
          >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand text-white shadow-lg shadow-primary/30">
              <Icon className="h-5 w-5" />
            </span>
            <div>
              <p className="text-lg font-semibold tracking-tight">{title}</p>
              <p className="mt-1 text-sm text-muted-foreground">{body}</p>
            </div>
          </motion.div>
        </AnimatePresence>
        <div className="mt-5 flex gap-1.5">
          {HIGHLIGHTS.map((h, i) => (
            <span key={h.title} className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
              {i === index && (
                <motion.span
                  className="block h-full bg-brand"
                  initial={{ width: "0%" }}
                  animate={{ width: "100%" }}
                  transition={{ duration: 3.2, ease: "linear" }}
                />
              )}
              {i < index && <span className="block h-full w-full bg-primary/40" />}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Split-screen layout for public pages (sign-in, sign-up, shared links):
 * form on the left, animated brand showcase on the right (desktop).
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
    <div className="relative min-h-screen">
      <AuroraBackground />
      <div className="mx-auto grid min-h-screen max-w-7xl gap-6 p-4 sm:p-6 lg:grid-cols-[1fr_1.1fr]">
        <div className="flex flex-col">
          <header className="flex items-center justify-between py-2">
            <Logo />
            <ThemeToggle layoutId="auth-theme-pill" />
          </header>

          <main className="flex flex-1 items-center justify-center py-10">
            <motion.div
              initial={{ opacity: 0, y: 24, filter: "blur(10px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              transition={{ duration: 0.7, ease: EASE }}
              className="w-full max-w-sm"
            >
              <motion.div
                initial={{ scale: 0.5, rotate: -20, opacity: 0 }}
                animate={{ scale: 1, rotate: 0, opacity: 1 }}
                transition={{ type: "spring", stiffness: 260, damping: 16, delay: 0.15 }}
                className="mb-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand text-white shadow-xl shadow-primary/30"
              >
                {icon}
              </motion.div>
              <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
              <p className="mt-2 text-muted-foreground">{description}</p>
              <div className="mt-8">{children}</div>
              {footer && <div className="mt-8 text-sm text-muted-foreground">{footer}</div>}
            </motion.div>
          </main>
        </div>
        <Showcase />
      </div>
    </div>
  );
}
