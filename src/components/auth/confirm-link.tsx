"use client";

import { useState } from "react";
import { KeyRound, Loader2, MailCheck } from "lucide-react";
import { AuthShell } from "@/components/auth/auth-shell";
import { buttonVariants } from "@/components/ui/button";
import type { AuthFlow } from "@/lib/auth-links";
import { cn } from "@/lib/utils";

/**
 * The page an e-mail link opens: one button that confirms with a same-origin
 * POST (/auth/verify). Opening the link alone never signs anyone in.
 */
export function ConfirmLink({
  tokenHash,
  type,
  flow,
  next,
  signedInAs,
}: {
  tokenHash: string;
  type: string;
  flow: AuthFlow;
  next: string | null;
  signedInAs: string | null;
}) {
  const [submitting, setSubmitting] = useState(false);
  const reset = flow === "recovery";

  return (
    <AuthShell
      icon={reset ? <KeyRound className="h-5 w-5" /> : <MailCheck className="h-5 w-5" />}
      title={reset ? "Reset your password" : "Confirm your e-mail"}
      description={reset ? "Continue to choose a new password" : "Activate your account to start using File Manager"}
    >
      <form method="post" action="/auth/verify" onSubmit={() => setSubmitting(true)} className="space-y-4">
        <input type="hidden" name="token_hash" value={tokenHash} />
        <input type="hidden" name="type" value={type} />
        <input type="hidden" name="flow" value={flow} />
        {next && <input type="hidden" name="next" value={next} />}
        {signedInAs && (
          <p className="rounded-xl border border-warning/30 bg-warning/10 px-3.5 py-2.5 text-sm">
            You are signed in as <span className="font-medium break-all">{signedInAs}</span>. Continuing signs you in with
            the account of this link instead.
          </p>
        )}
        {/* a native submit button: Base UI buttons default to type="button" */}
        <button type="submit" disabled={submitting} className={cn(buttonVariants({ variant: "brand" }), "h-10 w-full")}>
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {reset ? "Continue" : "Confirm my e-mail"}
        </button>
      </form>
    </AuthShell>
  );
}
