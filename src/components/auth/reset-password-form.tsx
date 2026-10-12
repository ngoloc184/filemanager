"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { updatePasswordAction } from "@/lib/auth/actions";
import { passwordProblemMessage, passwordProblems } from "@/lib/auth/validation";
import { AuthShell } from "@/components/auth/auth-shell";
import { Field, FormAlert, PasswordInput, SubmitButton, fieldAria } from "@/components/auth/form-parts";
import { PasswordChecklist } from "@/components/auth/password-checklist";
import { useAuthForm, type FieldErrors } from "@/components/auth/use-auth-form";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ResetPasswordForm({ email }: { email?: string }) {
  const validate = (formData: FormData): FieldErrors => {
    const errors: FieldErrors = {};
    const value = String(formData.get("password") ?? "");
    const problem = passwordProblemMessage(passwordProblems(value, email));
    if (problem) errors.password = problem;
    if (value !== formData.get("confirmPassword")) errors.confirmPassword = "Mật khẩu nhập lại không khớp.";
    return errors;
  };
  const { state, pending, errors, formError, onSubmit, touch } = useAuthForm(updatePasswordAction, validate);
  const [password, setPassword] = useState("");
  const router = useRouter();
  const done = state.status === "success";

  useEffect(() => {
    if (!done) return;
    const id = setTimeout(() => router.replace("/dashboard"), 2500);
    return () => clearTimeout(id);
  }, [done, router]);

  return (
    <AuthShell
      lang="vi"
      icon={<ShieldCheck className="h-5 w-5" />}
      title="Đặt mật khẩu mới"
      description={email ? `Cho tài khoản ${email}` : "Chọn một mật khẩu mạnh mà bạn chưa dùng ở nơi khác"}
    >
      {done ? (
        <div className="space-y-5">
          <FormAlert tone="success">{state.message}</FormAlert>
          <Link href="/dashboard" className={cn(buttonVariants({ variant: "brand" }), "h-11 w-full rounded-xl")}>
            Tới trang quản lý file <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      ) : (
        <div className="space-y-5">
          {formError && <FormAlert tone="error">{formError}</FormAlert>}
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            {/* Lets password managers attach the new password to the right account. */}
            <input type="email" name="username" autoComplete="username" value={email ?? ""} readOnly hidden />
            <Field
              id="password"
              label="Mật khẩu mới"
              error={errors.password}
              hint={<PasswordChecklist password={password} email={email} />}
            >
              <PasswordInput
                {...fieldAria("password", errors.password, true)}
                name="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  touch("password");
                }}
                autoFocus
                required
              />
            </Field>
            <Field id="confirm-password" label="Xác nhận mật khẩu mới" error={errors.confirmPassword}>
              <PasswordInput
                {...fieldAria("confirm-password", errors.confirmPassword)}
                name="confirmPassword"
                autoComplete="new-password"
                onChange={() => touch("confirmPassword")}
                required
              />
            </Field>
            <SubmitButton pending={pending} pendingLabel="Đang lưu...">
              Lưu mật khẩu mới
            </SubmitButton>
          </form>
        </div>
      )}
    </AuthShell>
  );
}
