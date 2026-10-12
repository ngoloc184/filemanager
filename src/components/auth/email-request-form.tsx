"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requestMagicLinkAction, requestPasswordResetAction } from "@/lib/auth/actions";
import { isValidEmail, normalizeEmail } from "@/lib/auth/validation";
import { AuthShell } from "@/components/auth/auth-shell";
import { CheckEmailPanel } from "@/components/auth/check-email-panel";
import { Field, FormAlert, SubmitButton, TextInput, fieldAria } from "@/components/auth/form-parts";
import { useAuthForm, type FieldErrors } from "@/components/auth/use-auth-form";

function validate(formData: FormData): FieldErrors {
  return isValidEmail(normalizeEmail(formData.get("email")))
    ? {}
    : { email: "Vui lòng nhập một địa chỉ email hợp lệ." };
}

const VARIANTS = {
  recovery: {
    action: requestPasswordResetAction,
    title: "Quên mật khẩu?",
    sentTitle: "Kiểm tra email",
    description: "Nhập email đã đăng ký, chúng tôi sẽ gửi liên kết để đặt mật khẩu mới.",
    submit: "Gửi liên kết đặt lại mật khẩu",
  },
  magiclink: {
    action: requestMagicLinkAction,
    title: "Đăng nhập không cần mật khẩu",
    sentTitle: "Kiểm tra email",
    description: "Nhận một liên kết đăng nhập dùng một lần qua email đã đăng ký.",
    submit: "Gửi liên kết đăng nhập",
  },
} as const;

/** Single-field "send me an e-mail" screen: password reset or magic link. */
export function EmailRequestForm({
  variant,
  icon,
  next,
}: {
  variant: keyof typeof VARIANTS;
  icon: ReactNode;
  next?: string;
}) {
  const config = VARIANTS[variant];
  const { state, pending, errors, formError, onSubmit, touch } = useAuthForm(config.action, validate);
  const [email, setEmail] = useState("");
  const [showSent, setShowSent] = useState(true);
  const sent = state.status === "success" && showSent;

  return (
    <AuthShell
      lang="vi"
      icon={icon}
      title={sent ? config.sentTitle : config.title}
      description={config.description}
      footer={
        <Link href="/login" className="inline-flex items-center gap-1 hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" />
          Quay lại đăng nhập
        </Link>
      }
    >
      {sent ? (
        <CheckEmailPanel
          email={state.email ?? normalizeEmail(email)}
          purpose={variant}
          message={state.message ?? ""}
          next={next}
          onChangeEmail={() => setShowSent(false)}
        />
      ) : (
        <div className="space-y-5">
          {formError && <FormAlert tone="error">{formError}</FormAlert>}
          <form
            onSubmit={(event) => {
              setShowSent(true);
              onSubmit(event);
            }}
            className="space-y-4"
            noValidate
          >
            {next && <input type="hidden" name="next" value={next} />}
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
            <SubmitButton pending={pending} pendingLabel="Đang gửi...">
              {config.submit}
            </SubmitButton>
          </form>
        </div>
      )}
    </AuthShell>
  );
}
