"use client";

import { startTransition, useActionState, useState } from "react";
import Link from "next/link";
import { LogIn, Mail } from "lucide-react";
import { resendConfirmationAction, signInAction } from "@/lib/auth/actions";
import { INITIAL_AUTH_STATE } from "@/lib/auth/form-state";
import type { Notice } from "@/lib/auth/notices";
import { isValidEmail, normalizeEmail } from "@/lib/auth/validation";
import { AuthShell } from "@/components/auth/auth-shell";
import {
  Divider,
  Field,
  FormAlert,
  PasswordInput,
  SubmitButton,
  TextInput,
  fieldAria,
} from "@/components/auth/form-parts";
import { GoogleButton } from "@/components/auth/google-button";
import { useAuthForm, type FieldErrors } from "@/components/auth/use-auth-form";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function validate(formData: FormData): FieldErrors {
  const errors: FieldErrors = {};
  if (!isValidEmail(normalizeEmail(formData.get("email")))) {
    errors.email = "Vui lòng nhập một địa chỉ email hợp lệ.";
  }
  if (!formData.get("password")) errors.password = "Vui lòng nhập mật khẩu.";
  return errors;
}

export function LoginForm({ next, notice }: { next: string; notice: Notice | null }) {
  const { state, pending, errors, formError, onSubmit, touch } = useAuthForm(signInAction, validate);
  const [resendState, resendAction, resending] = useActionState(
    resendConfirmationAction,
    INITIAL_AUTH_STATE
  );
  const [email, setEmail] = useState("");
  const [remember, setRemember] = useState(true);

  const resend = () => {
    const formData = new FormData();
    formData.set("email", state.email ?? email);
    startTransition(() => resendAction(formData));
  };

  return (
    <AuthShell
      lang="vi"
      icon={<LogIn className="h-5 w-5" />}
      title="Chào mừng trở lại"
      description="Đăng nhập để quản lý, chia sẻ và lưu trữ file của bạn"
      footer={
        <>
          Chưa có tài khoản?{" "}
          <Link href="/register" className="font-medium text-primary hover:underline">
            Đăng ký miễn phí
          </Link>
        </>
      }
    >
      <div className="space-y-5">
        {notice && state.status === "idle" && <FormAlert tone={notice.tone}>{notice.message}</FormAlert>}

        {formError && (
          <FormAlert tone="error">
            <p>{formError}</p>
            {state.code === "email_not_confirmed" && resendState.status === "idle" && (
              <button
                type="button"
                onClick={resend}
                disabled={resending}
                className="mt-2 font-medium underline underline-offset-2 disabled:opacity-60"
              >
                {resending ? "Đang gửi..." : "Gửi lại email xác minh"}
              </button>
            )}
          </FormAlert>
        )}
        {resendState.message && (
          <FormAlert tone={resendState.status === "success" ? "success" : "error"}>
            {resendState.message}
          </FormAlert>
        )}

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <input type="hidden" name="next" value={next} />
          <Field id="email" label="Email" error={errors.email}>
            <TextInput
              {...fieldAria("email", errors.email)}
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="ban@vi-du.com"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                touch("email");
              }}
              required
              autoFocus
            />
          </Field>

          <Field
            id="password"
            label="Mật khẩu"
            error={errors.password}
            action={
              <Link href="/forgot-password" className="text-[13px] font-medium text-primary hover:underline">
                Quên mật khẩu?
              </Link>
            }
          >
            <PasswordInput
              {...fieldAria("password", errors.password)}
              name="password"
              autoComplete="current-password"
              placeholder="••••••••"
              onChange={() => touch("password")}
              required
            />
          </Field>

          <label className="flex cursor-pointer select-none flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
            <input
              type="checkbox"
              name="remember"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
              className="h-4 w-4 cursor-pointer rounded border-input accent-[var(--primary)]"
            />
            <span>Ghi nhớ đăng nhập</span>
            <span className="text-xs text-muted-foreground">(30 ngày trên thiết bị này)</span>
          </label>

          <SubmitButton pending={pending} pendingLabel="Đang đăng nhập...">
            Đăng nhập
          </SubmitButton>
        </form>

        <Divider />

        <div className="space-y-3">
          <GoogleButton label="Tiếp tục với Google" next={next} remember={remember} />
          <Link
            href={next === "/dashboard" ? "/magic-link" : `/magic-link?next=${encodeURIComponent(next)}`}
            className={cn(
              buttonVariants({ variant: "ghost" }),
              "h-11 w-full gap-2 rounded-xl text-[15px] text-muted-foreground"
            )}
          >
            <Mail className="h-4 w-4" />
            Nhận liên kết đăng nhập qua email
          </Link>
        </div>
      </div>
    </AuthShell>
  );
}
