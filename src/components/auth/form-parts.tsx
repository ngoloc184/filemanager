"use client";

import { useState, type ComponentProps, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlertCircle, CheckCircle2, Eye, EyeOff, Info, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Small building blocks shared by the sign-in, sign-up, recovery and account
// forms, so every auth screen behaves (and announces errors) the same way.

const TONES = {
  error: {
    icon: AlertCircle,
    className: "border-destructive/30 bg-destructive/10 text-destructive",
  },
  success: {
    icon: CheckCircle2,
    className: "border-success/30 bg-success/10 text-success",
  },
  info: {
    icon: Info,
    className: "border-primary/25 bg-primary/10 text-foreground",
  },
} as const;

export type AlertTone = keyof typeof TONES;

/** Inline banner for form-level results; announced to screen readers. */
export function FormAlert({
  tone,
  children,
  className,
}: {
  tone: AlertTone;
  children: ReactNode;
  className?: string;
}) {
  const { icon: Icon, className: toneClass } = TONES[tone];
  return (
    <motion.div
      role={tone === "error" ? "alert" : "status"}
      aria-live={tone === "error" ? "assertive" : "polite"}
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-sm leading-relaxed",
        toneClass,
        className
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1 [&_a]:font-medium [&_a]:underline [&_a]:underline-offset-2">
        {children}
      </div>
    </motion.div>
  );
}

/** Label + control + error message, wired with aria attributes. */
export function Field({
  id,
  label,
  error,
  hint,
  action,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  hint?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {action}
      </div>
      {children}
      <AnimatePresence initial={false}>
        {error && (
          <motion.p
            key="error"
            id={`${id}-error`}
            role="alert"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="text-[13px] text-destructive"
          >
            {error}
          </motion.p>
        )}
      </AnimatePresence>
      {hint && (
        <div id={`${id}-hint`} className="text-[13px] text-muted-foreground">
          {hint}
        </div>
      )}
    </div>
  );
}

/** aria props for an input rendered inside <Field id=...>. */
export function fieldAria(id: string, error?: string, hasHint = false) {
  const describedBy = [error && `${id}-error`, hasHint && `${id}-hint`].filter(Boolean).join(" ");
  return {
    id,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy || undefined,
  } as const;
}

export function TextInput({ className, ...props }: ComponentProps<"input">) {
  return <Input className={cn("h-11 rounded-xl px-3.5", className)} {...props} />;
}

/** Password input with a show / hide toggle. */
export function PasswordInput({ className, ...props }: Omit<ComponentProps<"input">, "type">) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input
        type={visible ? "text" : "password"}
        className={cn("h-11 rounded-xl px-3.5 pr-11", className)}
        {...props}
      />
      <button
        type="button"
        onClick={() => setVisible((value) => !value)}
        className="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label={visible ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
        aria-pressed={visible}
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

/**
 * Native submit button (Base UI's Button defaults to type="button") with a
 * built-in loading state.
 */
export function SubmitButton({
  pending,
  pendingLabel,
  children,
  variant = "brand",
  className,
  disabled,
  ...props
}: ComponentProps<"button"> & {
  pending: boolean;
  pendingLabel: string;
  variant?: "brand" | "outline" | "default" | "secondary" | "destructive";
}) {
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      aria-busy={pending || undefined}
      className={cn(buttonVariants({ variant }), "h-11 w-full rounded-xl text-[15px]", className)}
      {...props}
    >
      {pending && <Loader2 className="h-4 w-4 animate-spin" />}
      {pending ? pendingLabel : children}
    </button>
  );
}

export function Divider({ label = "hoặc" }: { label?: string }) {
  return (
    <div className="relative my-6 flex items-center" role="separator">
      <span className="h-px flex-1 bg-border" />
      <span className="px-3 text-xs uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
