"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Google's multi-colour "G" mark, as required by Google's sign-in branding. */
export function GoogleMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className={className}>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

/**
 * Posts to /auth/google, which starts Google OAuth on the server (PKCE) and
 * redirects to Google's consent screen. Works without JavaScript.
 */
export function GoogleButton({
  label,
  intent = "signin",
  next,
  remember = true,
  disabled,
  className,
}: {
  label: string;
  intent?: "signin" | "link";
  next?: string;
  remember?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const [pending, setPending] = useState(false);

  // Coming back with the browser's Back button restores this page from the
  // back/forward cache: re-enable the button.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) setPending(false);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  return (
    <form
      action="/auth/google"
      method="post"
      onSubmit={() => setPending(true)}
      className={className}
    >
      <input type="hidden" name="intent" value={intent} />
      {next && <input type="hidden" name="next" value={next} />}
      <input type="hidden" name="remember" value={remember ? "on" : "off"} />
      <button
        type="submit"
        disabled={pending || disabled}
        aria-busy={pending || undefined}
        className={cn(
          buttonVariants({ variant: "outline" }),
          "h-11 w-full gap-3 rounded-xl bg-background/70 text-[15px] shadow-sm backdrop-blur hover:border-primary/30"
        )}
      >
        {pending ? <Loader2 className="h-5 w-5 animate-spin" /> : <GoogleMark className="h-5 w-5" />}
        {pending ? "Đang chuyển tới Google…" : label}
      </button>
    </form>
  );
}
