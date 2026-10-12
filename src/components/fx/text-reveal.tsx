"use client";

import { motion } from "motion/react";
import { cn } from "@/lib/utils";

/** Splits text into words that rise in one after another, unblurring. */
export function TextReveal({
  text,
  className,
  wordClassName,
  delay = 0,
  stagger = 0.06,
  highlight,
}: {
  text: string;
  className?: string;
  wordClassName?: string;
  delay?: number;
  stagger?: number;
  /** Words (exact match) rendered with the brand gradient. */
  highlight?: string[];
}) {
  const words = text.split(" ");
  return (
    <span className={cn("inline", className)} aria-label={text}>
      {words.map((word, i) => (
        <span key={`${word}-${i}`} aria-hidden className="inline-block overflow-hidden pb-[0.12em] align-bottom">
          <motion.span
            className={cn(
              "inline-block",
              highlight?.includes(word) && "text-brand animate-shimmer",
              wordClassName
            )}
            initial={{ y: "80%", opacity: 0, filter: "blur(10px)" }}
            animate={{ y: "0%", opacity: 1, filter: "blur(0px)" }}
            transition={{
              duration: 0.8,
              ease: [0.22, 1, 0.36, 1],
              delay: delay + i * stagger,
            }}
          >
            {word}
          </motion.span>
          {i < words.length - 1 && " "}
        </span>
      ))}
    </span>
  );
}
