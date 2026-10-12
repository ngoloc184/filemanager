"use client";

import { startTransition, useActionState, useEffect, useState, type FormEvent } from "react";
import { MailCheck, RotateCw } from "lucide-react";
import {
  requestMagicLinkAction,
  requestPasswordResetAction,
  resendConfirmationAction,
  verifyEmailCodeAction,
} from "@/lib/auth/actions";
import { INITIAL_AUTH_STATE } from "@/lib/auth/form-state";
import { Field, FormAlert, SubmitButton, TextInput, fieldAria } from "@/components/auth/form-parts";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const RESEND_COOLDOWN_SECONDS = 60;

const RESEND_ACTIONS = {
  signup: resendConfirmationAction,
  magiclink: requestMagicLinkAction,
  recovery: requestPasswordResetAction,
};

/**
 * "Check your inbox" step shown after an e-mail was sent: resend with a
 * cooldown, optional 6-digit code entry (sign-up / sign-in e-mails), and a
 * way back to change the address.
 */
export function CheckEmailPanel({
  email,
  purpose,
  message,
  next,
  onChangeEmail,
}: {
  email: string;
  purpose: keyof typeof RESEND_ACTIONS;
  message: string;
  next?: string;
  onChangeEmail: () => void;
}) {
  const [resendState, resendAction, resending] = useActionState(
    RESEND_ACTIONS[purpose],
    INITIAL_AUTH_STATE
  );
  const [codeState, codeAction, verifying] = useActionState(verifyEmailCodeAction, INITIAL_AUTH_STATE);
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SECONDS);
  const [code, setCode] = useState("");

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  const resend = () => {
    const formData = new FormData();
    formData.set("email", email);
    if (next) formData.set("next", next);
    setCooldown(RESEND_COOLDOWN_SECONDS);
    startTransition(() => resendAction(formData));
  };

  const submitCode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    startTransition(() => codeAction(new FormData(event.currentTarget)));
  };

  const codeError = codeState.status === "error" ? (codeState.fieldErrors?.token ?? codeState.message) : undefined;

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3 rounded-2xl border bg-background/60 p-4 shadow-sm backdrop-blur">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <MailCheck className="h-5 w-5" />
        </span>
        <div className="space-y-1 text-sm">
          <p className="font-medium">Kiểm tra hộp thư của bạn</p>
          <p className="text-muted-foreground" role="status">
            {message}
          </p>
          <p className="text-xs text-muted-foreground">
            Không thấy email? Hãy kiểm tra thư mục Spam/Quảng cáo.
          </p>
        </div>
      </div>

      {resendState.status === "error" && resendState.message && (
        <FormAlert tone="error">{resendState.message}</FormAlert>
      )}
      {resendState.status === "success" && <FormAlert tone="success">Đã gửi lại email.</FormAlert>}

      {purpose !== "recovery" && (
        <form onSubmit={submitCode} className="space-y-3" noValidate>
          <input type="hidden" name="email" value={email} />
          {next && <input type="hidden" name="next" value={next} />}
          <Field id="otp" label="Hoặc nhập mã xác minh trong email" error={codeError}>
            <TextInput
              {...fieldAria("otp", codeError)}
              name="token"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={10}
              placeholder="123456"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
              className="text-center font-mono text-lg tracking-[0.4em]"
            />
          </Field>
          <SubmitButton pending={verifying} pendingLabel="Đang xác minh..." variant="outline" disabled={code.length < 6}>
            Xác minh mã
          </SubmitButton>
        </form>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          onClick={resend}
          disabled={resending || cooldown > 0}
          className={cn(buttonVariants({ variant: "ghost" }), "h-10 flex-1 rounded-xl")}
        >
          <RotateCw className={cn("h-4 w-4", resending && "animate-spin")} />
          {cooldown > 0 ? `Gửi lại sau ${cooldown}s` : "Gửi lại email"}
        </button>
        <button
          type="button"
          onClick={onChangeEmail}
          className={cn(buttonVariants({ variant: "ghost" }), "h-10 flex-1 rounded-xl")}
        >
          Dùng email khác
        </button>
      </div>
    </div>
  );
}
