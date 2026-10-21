"use client";

import { useEffect, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OTP_MAX, RESEND_COOLDOWN, authErrorMessage, cleanOtp } from "@/lib/auth-otp";

/** One field for the e-mailed code: numeric keyboard, paste and autofill friendly. */
export function OtpInput({
  value,
  onChange,
  disabled,
  autoFocus = true,
}: {
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor="otp">Verification code</Label>
      <Input
        id="otp"
        value={value}
        onChange={(e) => onChange(cleanOtp(e.target.value))}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={OTP_MAX + 4}
        placeholder="123456"
        autoFocus={autoFocus}
        disabled={disabled}
        aria-describedby="otp-help"
        className="h-12 text-center font-mono text-2xl tracking-[0.5em] placeholder:tracking-[0.5em] placeholder:text-muted-foreground/40"
      />
      <p id="otp-help" className="text-xs text-muted-foreground">
        Enter the code from the e-mail. It may take a minute to arrive — check your spam folder too.
      </p>
    </div>
  );
}

/** "Resend code" with a cooldown; `send` performs the request. */
export function ResendCode({ send, startCoolingDown = true }: { send: () => Promise<void>; startCoolingDown?: boolean }) {
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
          toast.success("A new code was sent.");
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
      {left > 0 ? `Resend code in ${left}s` : "Resend code"}
    </button>
  );
}
