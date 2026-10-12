"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  motion,
  useMotionValueEvent,
  useScroll,
  useTransform,
} from "motion/react";
import {
  ArrowRight,
  CheckCircle2,
  Code2,
  FolderTree,
  Share2,
  Sparkles,
  UploadCloud,
} from "lucide-react";
import { AuroraBackground } from "@/components/brand/aurora-background";
import { Logo } from "@/components/brand/logo";
import { FileTile, type FileKind } from "@/components/files/file-tile";
import { BorderBeam } from "@/components/fx/border-beam";
import { Magnetic } from "@/components/fx/magnetic";
import { Marquee } from "@/components/fx/marquee";
import { SmoothScroll } from "@/components/fx/smooth-scroll";
import { TextReveal } from "@/components/fx/text-reveal";
import { Bento } from "@/components/landing/bento";
import { ProductMock } from "@/components/landing/product-mock";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const EASE = [0.22, 1, 0.36, 1] as const;

const FORMATS: { label: string; kind: FileKind }[] = [
  { label: "PDF", kind: "pdf" },
  { label: "PNG", kind: "image" },
  { label: "MP4", kind: "video" },
  { label: "ZIP", kind: "archive" },
  { label: "MP3", kind: "audio" },
  { label: "XLSX", kind: "sheet" },
  { label: "DOCX", kind: "text" },
  { label: "JSON", kind: "code" },
  { label: "JPG", kind: "image" },
  { label: "BUNDLE", kind: "code" },
  { label: "MOV", kind: "video" },
  { label: "CSV", kind: "sheet" },
];

const STEPS = [
  {
    icon: UploadCloud,
    title: "Upload",
    body: "Drag files anywhere on the page. Big batches, live progress, automatic duplicate checks.",
  },
  {
    icon: FolderTree,
    title: "Organize",
    body: "Folders, tags and version history keep every project tidy, with bulk actions when you need speed.",
  },
  {
    icon: Share2,
    title: "Share & deliver",
    body: "Invite your team with roles, send public links, or deliver versioned bundles to apps over the API.",
  },
];

const TERMINAL_LINES = [
  { text: "$ curl -X POST https://cavoi-it.vercel.app/api/superapp/files \\", tone: "text-white/90" },
  { text: '    -H "Authorization: Bearer $KEY" \\', tone: "text-[oklch(0.82_0.13_160)]" },
  { text: '    -F "file=@transfer.bundle" -F "version=1.2.0"', tone: "text-[oklch(0.82_0.13_160)]" },
  { text: "", tone: "" },
  { text: '{ "url": ".../superapp/transfer.bundle?v=1.2.0" }', tone: "text-[oklch(0.8_0.12_280)]" },
  { text: "# served from the edge · cached immutably · 200 OK", tone: "text-white/40" },
];

/** Character offset where each terminal line starts in the typed text. */
const LINE_STARTS = TERMINAL_LINES.reduce<number[]>(
  (starts, line, i) => [...starts, i === 0 ? 0 : starts[i - 1] + TERMINAL_LINES[i - 1].text.length + 1],
  []
);
const TERMINAL_TEXT_LENGTH = TERMINAL_LINES.map((l) => l.text).join("\n").length;

function Nav({ signedIn, ctaHref }: { signedIn: boolean; ctaHref: string }) {
  const { scrollY } = useScroll();
  const [scrolled, setScrolled] = useState(false);
  useMotionValueEvent(scrollY, "change", (y) => setScrolled(y > 24));

  return (
    <motion.header
      initial={{ y: -40, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.7, ease: EASE }}
      className="fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-3"
    >
      <div
        className={cn(
          "flex w-full max-w-6xl items-center justify-between rounded-2xl border px-4 py-2.5 transition-all duration-500",
          scrolled
            ? "max-w-4xl border-border bg-background/70 shadow-lg shadow-black/5 backdrop-blur-xl"
            : "border-transparent bg-transparent"
        )}
      >
        <Logo />
        <nav className="hidden items-center gap-1 text-sm text-muted-foreground md:flex">
          {[
            ["Features", "#features"],
            ["How it works", "#how"],
            ["Developers", "#developers"],
          ].map(([label, href]) => (
            <a
              key={href}
              href={href}
              className="rounded-lg px-3 py-1.5 transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              {label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <ThemeToggle layoutId="landing-theme-pill" className="hidden sm:inline-flex" />
          {!signedIn && (
            <Button variant="ghost" size="sm" className="hidden sm:inline-flex" render={<Link href="/login" />}>
              Sign in
            </Button>
          )}
          <Button variant="brand" size="sm" render={<Link href={ctaHref} />}>
            {signedIn ? "Dashboard" : "Get started"}
          </Button>
        </div>
      </div>
    </motion.header>
  );
}

function SectionHeading({
  eyebrow,
  title,
  body,
}: {
  eyebrow: string;
  title: string;
  body: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 30, filter: "blur(8px)" }}
      whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.8, ease: EASE }}
      className="mx-auto max-w-2xl text-center"
    >
      <span className="text-sm font-medium text-primary">{eyebrow}</span>
      <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-5xl">
        {title}
      </h2>
      <p className="mt-4 text-balance text-muted-foreground sm:text-lg">{body}</p>
    </motion.div>
  );
}

function Steps() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start 75%", "end 55%"],
  });
  const lineScale = useTransform(scrollYProgress, [0, 1], [0, 1]);

  return (
    <div ref={ref} className="relative mx-auto mt-16 max-w-3xl">
      <div className="absolute bottom-6 left-6 top-6 w-px bg-border sm:left-1/2" />
      <motion.div
        style={{ scaleY: lineScale }}
        className="absolute bottom-6 left-6 top-6 w-px origin-top bg-brand sm:left-1/2"
      />
      <div className="space-y-14">
        {STEPS.map(({ icon: Icon, title, body }, i) => (
          <motion.div
            key={title}
            initial={{ opacity: 0, x: i % 2 ? 40 : -40 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-120px" }}
            transition={{ duration: 0.8, ease: EASE }}
            className={cn(
              "relative flex gap-6 pl-16 sm:w-1/2 sm:pl-0",
              i % 2 ? "sm:ml-auto sm:pl-14" : "sm:pr-14 sm:text-right"
            )}
          >
            <span
              className={cn(
                "absolute left-0 top-0 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand text-white shadow-lg shadow-primary/30",
                i % 2 ? "sm:-left-6" : "sm:left-auto sm:-right-6"
              )}
            >
              <Icon className="h-5 w-5" />
            </span>
            <div>
              <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                Step {i + 1}
              </p>
              <h3 className="mt-1 text-xl font-semibold tracking-tight">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

function Terminal() {
  const ref = useRef<HTMLDivElement>(null);
  const [chars, setChars] = useState(0);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => entry.isIntersecting && setStarted(true),
      { threshold: 0.4 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!started || chars >= TERMINAL_TEXT_LENGTH) return;
    const id = setTimeout(() => setChars((c) => c + 2), 18);
    return () => clearTimeout(id);
  }, [started, chars]);

  return (
    <div
      ref={ref}
      className="relative overflow-hidden rounded-2xl border border-white/10 bg-[oklch(0.15_0.02_278)] text-left shadow-2xl"
    >
      <BorderBeam duration={7} />
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        <span className="ml-3 text-xs text-white/40">publish.sh</span>
      </div>
      <pre className="min-h-[13rem] overflow-x-auto p-5 font-mono text-[12.5px] leading-relaxed">
        {TERMINAL_LINES.map((line, i) => {
          const visible = line.text.slice(0, Math.max(0, chars - LINE_STARTS[i]));
          return (
            <div key={i} className={line.tone}>
              {visible || " "}
            </div>
          );
        })}
        <motion.span
          className="inline-block h-4 w-2 translate-y-0.5 bg-white/70"
          animate={{ opacity: [1, 0] }}
          transition={{ duration: 0.9, repeat: Infinity }}
        />
      </pre>
    </div>
  );
}

export default function LandingPage({ signedIn }: { signedIn: boolean }) {
  const cta = signedIn
    ? { href: "/dashboard", label: "Open your files" }
    : { href: "/register", label: "Start for free" };

  return (
    <div className="relative min-h-screen overflow-x-clip">
      <SmoothScroll />
      <AuroraBackground />
      <Nav signedIn={signedIn} ctaHref={cta.href} />

      <main>
        {/* ---------- Hero ---------- */}
        <section className="grain relative overflow-hidden px-4 pb-24 pt-36 text-center sm:px-6 sm:pt-44">
          <div className="hero-beams" />
          <div className="dot-pattern pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_60%_50%_at_50%_30%,#000,transparent)]" />

          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.6, ease: EASE }}
            className="relative"
          >
            <Link
              href={cta.href}
              className="group relative inline-flex items-center gap-2 overflow-hidden rounded-full border bg-background/60 py-1 pl-1 pr-3 text-xs font-medium backdrop-blur"
            >
              <BorderBeam duration={5} />
              <span className="rounded-full bg-brand px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                New
              </span>
              <span className="text-muted-foreground">Versioned delivery API for mobile super apps</span>
              <ArrowRight className="h-3 w-3 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </Link>
          </motion.div>

          <h1 className="relative mx-auto mt-8 max-w-4xl text-balance text-5xl font-semibold leading-[1.02] tracking-[-0.04em] sm:text-7xl">
            <TextReveal
              text="The beautiful home for every file you ship"
              highlight={["beautiful", "ship"]}
              delay={0.15}
            />
          </h1>

          <motion.p
            initial={{ opacity: 0, y: 16, filter: "blur(6px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ duration: 0.8, ease: EASE, delay: 0.75 }}
            className="relative mx-auto mt-6 max-w-xl text-balance text-lg text-muted-foreground"
          >
            Upload, organize, version and share files with a workspace that feels
            instant, and deliver app bundles worldwide through one API.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: EASE, delay: 0.95 }}
            className="relative mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row"
          >
            <Magnetic>
              <Button
                variant="brand"
                className="h-12 gap-2 rounded-xl px-7 text-base"
                render={<Link href={cta.href} />}
              >
                {cta.label}
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Magnetic>
            <Magnetic strength={0.2}>
              <Button
                variant="outline"
                className="h-12 rounded-xl bg-background/50 px-7 text-base backdrop-blur"
                render={<a href="#features" />}
              >
                See how it works
              </Button>
            </Magnetic>
          </motion.div>

          <ProductMock />
        </section>

        {/* ---------- Formats marquee ---------- */}
        <section className="py-10">
          <p className="mb-6 text-center text-sm text-muted-foreground">
            Every format your team works with, previewed and versioned
          </p>
          <Marquee duration={40}>
            {FORMATS.map(({ label, kind }) => (
              <div
                key={label}
                className="flex items-center gap-2.5 rounded-2xl border bg-card/50 px-4 py-2.5 backdrop-blur"
              >
                <FileTile kind={kind} size="sm" />
                <span className="text-sm font-medium tracking-wide">{label}</span>
              </div>
            ))}
          </Marquee>
        </section>

        {/* ---------- Features ---------- */}
        <section id="features" className="mx-auto max-w-6xl scroll-mt-24 px-4 py-24 sm:px-6">
          <SectionHeading
            eyebrow="Features"
            title="Everything you need. Nothing you don't."
            body="A focused toolset that makes file work feel effortless, from the first upload to the last share."
          />
          <Bento />
        </section>

        {/* ---------- How it works ---------- */}
        <section id="how" className="mx-auto max-w-6xl scroll-mt-24 px-4 py-24 sm:px-6">
          <SectionHeading
            eyebrow="How it works"
            title="From upload to delivery in three steps"
            body="No setup, no learning curve. Your team is productive in minutes."
          />
          <Steps />
        </section>

        {/* ---------- Developers ---------- */}
        <section id="developers" className="mx-auto max-w-6xl scroll-mt-24 px-4 py-24 sm:px-6">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <motion.div
              initial={{ opacity: 0, y: 30, filter: "blur(8px)" }}
              whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{ duration: 0.8, ease: EASE }}
            >
              <span className="inline-flex items-center gap-2 text-sm font-medium text-primary">
                <Code2 className="h-4 w-4" />
                For developers
              </span>
              <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-5xl">
                Ship app bundles with a single request
              </h2>
              <p className="mt-4 text-muted-foreground sm:text-lg">
                Publish versioned files over HTTP. Each version is an immutable snapshot
                served from the edge, and a version endpoint tells apps exactly when to
                update.
              </p>
              <ul className="mt-8 space-y-3">
                {[
                  "API-key protected uploads",
                  "Immutable, CDN-cached version URLs",
                  "Version endpoint for over-the-air updates",
                ].map((item, i) => (
                  <motion.li
                    key={item}
                    initial={{ opacity: 0, x: -16 }}
                    whileInView={{ opacity: 1, x: 0 }}
                    viewport={{ once: true }}
                    transition={{ delay: 0.2 + i * 0.1, duration: 0.5, ease: EASE }}
                    className="flex items-center gap-3 text-sm"
                  >
                    <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
                    {item}
                  </motion.li>
                ))}
              </ul>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, scale: 0.94, rotateX: 12 }}
              whileInView={{ opacity: 1, scale: 1, rotateX: 0 }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{ duration: 0.9, ease: EASE }}
              style={{ transformPerspective: 1200 }}
            >
              <Terminal />
            </motion.div>
          </div>
        </section>

        {/* ---------- CTA ---------- */}
        <section className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
          <motion.div
            initial={{ opacity: 0, y: 40, scale: 0.97 }}
            whileInView={{ opacity: 1, y: 0, scale: 1 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ duration: 0.9, ease: EASE }}
            className="grain relative overflow-hidden rounded-[2rem] border bg-card/60 px-6 py-20 text-center backdrop-blur-xl"
          >
            <BorderBeam duration={9} />
            <div className="hero-beams opacity-70" />
            <Sparkles className="relative mx-auto h-8 w-8 text-primary" />
            <h2 className="relative mx-auto mt-6 max-w-2xl text-balance text-4xl font-semibold tracking-tight sm:text-6xl">
              Give your files the <span className="text-brand animate-shimmer">home they deserve</span>
            </h2>
            <p className="relative mx-auto mt-5 max-w-md text-muted-foreground">
              Create an account in seconds. No credit card required.
            </p>
            <div className="relative mt-10">
              <Magnetic>
                <Button
                  variant="brand"
                  className="h-12 gap-2 rounded-xl px-8 text-base"
                  render={<Link href={cta.href} />}
                >
                  {cta.label}
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Magnetic>
            </div>
          </motion.div>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-10 text-sm text-muted-foreground sm:flex-row sm:px-6">
          <Logo />
          <div className="flex items-center gap-6">
            <a href="#features" className="hover:text-foreground">Features</a>
            <a href="#developers" className="hover:text-foreground">Developers</a>
            <Link href="/login" className="hover:text-foreground">Sign in</Link>
          </div>
          <p>© {new Date().getFullYear()} File Manager</p>
        </div>
      </footer>
    </div>
  );
}
