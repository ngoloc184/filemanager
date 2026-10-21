"use client";

import { useEffect, useState } from "react";
import { Loader2, MailCheck, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { RESEND_COOLDOWN, authErrorMessage } from "@/lib/auth-links";

/** "Resend e-mail" with a cooldown; `send` performs the request. */
export function ResendEmail({ send, startCoolingDown = true }: { send: () => Promise<void>; startCoolingDown?: boolean }) {
  const [left, setLeft] = useState(startCoolingDown ? RESEND_COOLDOWN : 0);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (left <= 0) return;
    const timer = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [left]);

  return (
    <button
      type="button"
      disabled={left > 0 || sending}
      onClick={async () => {
        setSending(true);
        try {
          await send();
          toast.success("We sent you a new e-mail.");
          setLeft(RESEND_COOLDOWN);
        } catch (err) {
          toast.error(authErrorMessage(err));
        } finally {
          setSending(false);
        }
      }}
      className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
    >
      {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
      {left > 0 ? `Resend e-mail in ${left}s` : "Resend e-mail"}
    </button>
  );
}

/** "Check your inbox": what to do with the link we e-mailed. */
export function CheckInbox({
  email,
  action,
  send,
  sent = true,
}: {
  email: string;
  /** what the link does, e.g. "confirm your account" */
  action: string;
  send: () => Promise<void>;
  /** false when nothing was sent yet in this visit (offer "Send" right away) */
  sent?: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="flex gap-3 rounded-2xl border bg-background/60 p-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary ring-1 ring-inset ring-primary/20">
          <MailCheck className="h-4 w-4" />
        </span>
        <div className="space-y-1 text-sm">
          <p className="font-medium">{sent ? <>We sent a link to <span className="break-all">{email}</span></> : <>Send a link to <span className="break-all">{email}</span></>}</p>
          <p className="text-muted-foreground">
            Open the e-mail and click the link to {action}. Use this browser if you can. It may take a minute to arrive — check your spam folder too.
          </p>
        </div>
      </div>
      <div className="flex justify-center">
        <ResendEmail send={send} startCoolingDown={sent} />
      </div>
    </div>
  );
}

/** A message that stays above the form (outcome of an e-mail link). */
export function AuthNotice({ tone, children }: { tone: "success" | "error"; children: React.ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={
        tone === "success"
          ? "mb-4 rounded-xl border border-success/30 bg-success/10 px-3.5 py-2.5 text-sm text-foreground"
          : "mb-4 rounded-xl border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-sm text-foreground"
      }
    >
      {children}
    </div>
  );
}
