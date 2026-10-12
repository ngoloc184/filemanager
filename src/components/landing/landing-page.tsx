"use client";

import Link from "next/link";
import { motion, type Variants } from "motion/react";
import {
  ArrowRight,
  CheckCircle2,
  Code2,
  FileImage,
  FileText,
  Folder,
  FolderInput,
  History,
  Link2,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  UploadCloud,
  type LucideIcon,
} from "lucide-react";
import { AuroraBackground } from "@/components/brand/aurora-background";
import { Logo } from "@/components/brand/logo";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Button } from "@/components/ui/button";

const EASE = [0.22, 1, 0.36, 1] as const;

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 24 },
  show: (i: number = 0) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.6, ease: EASE, delay: i * 0.08 },
  }),
};

const FEATURES: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: UploadCloud,
    title: "Drag & drop uploads",
    body: "Drop many files at once and follow each upload live, with one-click retry and duplicate detection.",
  },
  {
    icon: FolderInput,
    title: "Folders & bulk actions",
    body: "Organize with nested folders, then move, copy or delete many items in a single action.",
  },
  {
    icon: History,
    title: "Version history",
    body: "Upload new versions of a file and restore any previous one whenever you need it.",
  },
  {
    icon: ShieldCheck,
    title: "Secure sharing",
    body: "Invite people as viewer, editor or admin, or create public download links you can disable anytime.",
  },
  {
    icon: Search,
    title: "Search & tags",
    body: "Find files instantly by name, type, size, date or tag across everything you can access.",
  },
  {
    icon: Trash2,
    title: "Trash & activity",
    body: "Deleted items wait safely in the trash, and every change is recorded in the activity log.",
  },
];

function HeroPreview() {
  const rows = [
    { icon: Folder, name: "Contracts", meta: "Folder · 12 items", tone: "text-primary" },
    { icon: FileText, name: "Q3-report.pdf", meta: "2.4 MB · PDF", tone: "text-muted-foreground" },
    { icon: FileImage, name: "brand-kit.png", meta: "860 KB · Image", tone: "text-muted-foreground" },
  ];
  return (
    <motion.div
      initial={{ opacity: 0, y: 40, rotateX: 12 }}
      animate={{ opacity: 1, y: 0, rotateX: 0 }}
      transition={{ duration: 0.9, ease: EASE, delay: 0.35 }}
      style={{ transformPerspective: 1200 }}
      className="relative mx-auto mt-16 w-full max-w-3xl"
    >
      <div className="absolute -inset-4 -z-10 rounded-[2rem] bg-brand opacity-20 blur-3xl" />
      <motion.div
        animate={{ y: [0, -8, 0] }}
        transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
        className="overflow-hidden rounded-2xl border bg-glass shadow-2xl backdrop-blur-xl"
      >
        <div className="flex items-center gap-1.5 border-b px-4 py-3">
          <span className="h-2.5 w-2.5 rounded-full bg-destructive/60" />
          <span className="h-2.5 w-2.5 rounded-full bg-warning/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-success/70" />
          <span className="ml-3 text-xs text-muted-foreground">My Files</span>
        </div>
        <div className="divide-y text-left">
          {rows.map(({ icon: Icon, name, meta, tone }, i) => (
            <motion.div
              key={name}
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.7 + i * 0.12, duration: 0.4 }}
              className="flex items-center gap-3 px-4 py-3"
            >
              <Icon className={`h-5 w-5 ${tone}`} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{name}</p>
                <p className="text-xs text-muted-foreground">{meta}</p>
              </div>
            </motion.div>
          ))}
          <div className="flex items-center gap-3 px-4 py-3">
            <UploadCloud className="h-5 w-5 text-primary" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">design-v2.fig</p>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                <motion.div
                  className="h-full rounded-full bg-brand"
                  initial={{ width: "8%" }}
                  animate={{ width: ["8%", "100%"] }}
                  transition={{ duration: 2.6, repeat: Infinity, repeatDelay: 1.2, ease: "easeInOut" }}
                />
              </div>
            </div>
            <span className="text-xs text-muted-foreground">Uploading</span>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

export default function LandingPage({ signedIn }: { signedIn: boolean }) {
  const primaryCta = signedIn
    ? { href: "/dashboard", label: "Open your files" }
    : { href: "/register", label: "Get started free" };

  return (
    <div className="relative min-h-screen overflow-x-hidden">
      <AuroraBackground />

      <header className="sticky top-0 z-40 border-b border-transparent bg-background/40 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Logo />
          <nav className="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
            <a href="#features" className="transition-colors hover:text-foreground">
              Features
            </a>
            <a href="#developers" className="transition-colors hover:text-foreground">
              Developers
            </a>
          </nav>
          <div className="flex items-center gap-2">
            <ThemeToggle layoutId="landing-theme-pill" className="hidden sm:inline-flex" />
            {!signedIn && (
              <Button variant="ghost" size="sm" render={<Link href="/login" />}>
                Sign in
              </Button>
            )}
            <Button variant="brand" size="sm" render={<Link href={primaryCta.href} />}>
              {signedIn ? "Dashboard" : "Get started"}
            </Button>
          </div>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="mx-auto max-w-6xl px-4 pb-20 pt-16 text-center sm:px-6 sm:pt-24">
          <motion.div initial="hidden" animate="show" variants={fadeUp} custom={0}>
            <span className="inline-flex items-center gap-2 rounded-full border bg-glass px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              File storage, sharing and delivery in one place
            </span>
          </motion.div>
          <motion.h1
            initial="hidden"
            animate="show"
            variants={fadeUp}
            custom={1}
            className="mx-auto mt-6 max-w-3xl text-4xl font-bold tracking-tight sm:text-6xl"
          >
            Your files, organized and shared{" "}
            <span className="text-brand animate-shimmer">beautifully</span>
          </motion.h1>
          <motion.p
            initial="hidden"
            animate="show"
            variants={fadeUp}
            custom={2}
            className="mx-auto mt-6 max-w-xl text-lg text-muted-foreground"
          >
            Upload in seconds, keep every version, share safely with your team and
            deliver app bundles through a fast, versioned API.
          </motion.p>
          <motion.div
            initial="hidden"
            animate="show"
            variants={fadeUp}
            custom={3}
            className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row"
          >
            <Button
              variant="brand"
              className="h-11 gap-2 px-6 text-base"
              render={<Link href={primaryCta.href} />}
            >
              {primaryCta.label}
              <ArrowRight className="h-4 w-4" />
            </Button>
            {!signedIn && (
              <Button
                variant="outline"
                className="h-11 px-6 text-base"
                render={<Link href="/login" />}
              >
                Sign in
              </Button>
            )}
          </motion.div>
          <HeroPreview />
        </section>

        {/* Features */}
        <section id="features" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-20 sm:px-6">
          <motion.div
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, margin: "-80px" }}
            variants={fadeUp}
            className="mx-auto max-w-2xl text-center"
          >
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
              Everything you need to manage files
            </h2>
            <p className="mt-4 text-muted-foreground">
              Built for teams that want a clean, fast and secure home for their work.
            </p>
          </motion.div>
          <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, body }, i) => (
              <motion.div
                key={title}
                initial="hidden"
                whileInView="show"
                viewport={{ once: true, margin: "-60px" }}
                variants={fadeUp}
                custom={i % 3}
                whileHover={{ y: -4 }}
                className="group rounded-2xl border bg-glass p-6 backdrop-blur transition-shadow hover:shadow-xl hover:shadow-primary/10"
              >
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary transition-colors group-hover:bg-brand group-hover:text-white">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
              </motion.div>
            ))}
          </div>
        </section>

        {/* Developers */}
        <section id="developers" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-20 sm:px-6">
          <div className="grid items-center gap-10 lg:grid-cols-2">
            <motion.div
              initial="hidden"
              whileInView="show"
              viewport={{ once: true, margin: "-80px" }}
              variants={fadeUp}
            >
              <span className="inline-flex items-center gap-2 text-sm font-medium text-primary">
                <Code2 className="h-4 w-4" />
                For developers
              </span>
              <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
                Publish and deliver files with one API call
              </h2>
              <p className="mt-4 text-muted-foreground">
                Upload versioned files over HTTP and serve them from a CDN-friendly URL.
                Each version is an immutable snapshot, so apps always load exactly what you
                released.
              </p>
              <ul className="mt-6 space-y-3 text-sm">
                {[
                  "API-key protected uploads",
                  "Versioned, immutable file URLs with long-lived caching",
                  "Version endpoint so apps know when to update",
                ].map((item) => (
                  <li key={item} className="flex items-start gap-2">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                    {item}
                  </li>
                ))}
              </ul>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, scale: 0.96 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{ duration: 0.6, ease: EASE }}
              className="overflow-hidden rounded-2xl border bg-[oklch(0.17_0.02_278)] text-left shadow-2xl"
            >
              <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3 text-xs text-white/50">
                <Link2 className="h-3.5 w-3.5" />
                terminal
              </div>
              <pre className="overflow-x-auto p-5 text-[13px] leading-relaxed text-white/85">
                <code>
                  <span className="text-[oklch(0.75_0.15_280)]">curl</span> -X POST /api/superapp/files \{"\n"}
                  {"  "}-H <span className="text-[oklch(0.8_0.14_160)]">&quot;Authorization: Bearer $KEY&quot;</span> \{"\n"}
                  {"  "}-F <span className="text-[oklch(0.8_0.14_160)]">&quot;file=@app.bundle&quot;</span> \{"\n"}
                  {"  "}-F <span className="text-[oklch(0.8_0.14_160)]">&quot;version=1.2.0&quot;</span>{"\n\n"}
                  <span className="text-white/40"># → /superapp/app.bundle?v=1.2.0</span>
                </code>
              </pre>
            </motion.div>
          </div>
        </section>

        {/* CTA */}
        <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <motion.div
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, margin: "-80px" }}
            variants={fadeUp}
            className="relative overflow-hidden rounded-3xl bg-brand px-6 py-14 text-center text-white shadow-2xl shadow-primary/30"
          >
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_0%,rgb(255_255_255/0.25),transparent_55%)]" />
            <h2 className="relative text-3xl font-bold tracking-tight sm:text-4xl">
              Ready to organize your files?
            </h2>
            <p className="relative mx-auto mt-3 max-w-md text-white/80">
              Create an account in seconds and start uploading right away.
            </p>
            <Button
              className="relative mt-8 h-11 gap-2 bg-white px-6 text-base text-[oklch(0.3_0.12_285)] hover:bg-white/90"
              render={<Link href={primaryCta.href} />}
            >
              {primaryCta.label}
              <ArrowRight className="h-4 w-4" />
            </Button>
          </motion.div>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:px-6">
          <Logo />
          <p>© {new Date().getFullYear()} File Manager. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
