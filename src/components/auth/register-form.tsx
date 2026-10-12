"use client";

import { useState } from "react";
import Link from "next/link";
import { UserPlus } from "lucide-react";
import { signUpAction } from "@/lib/auth/actions";
import {
  isValidEmail,
  normalizeEmail,
  passwordProblemMessage,
  passwordProblems,
} from "@/lib/auth/validation";
import { AuthShell } from "@/components/auth/auth-shell";
import { CheckEmailPanel } from "@/components/auth/check-email-panel";
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
import { PasswordChecklist } from "@/components/auth/password-checklist";
import { useAuthForm, type FieldErrors } from "@/components/auth/use-auth-form";

function validate(formData: FormData): FieldErrors {
  const errors: FieldErrors = {};
  const email = normalizeEmail(formData.get("email"));
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  if (!isValidEmail(email)) errors.email = "Vui lòng nhập một địa chỉ email hợp lệ.";
  const problem = passwordProblemMessage(passwordProblems(password, email));
  if (problem) errors.password = problem;
  if (!confirmPassword) errors.confirmPassword = "Vui lòng nhập lại mật khẩu.";
  else if (password !== confirmPassword) errors.confirmPassword = "Mật khẩu nhập lại không khớp.";
  return errors;
}

export function RegisterForm() {
  const { state, pending, errors, formError, onSubmit, touch } = useAuthForm(signUpAction, validate);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showCheckEmail, setShowCheckEmail] = useState(true);

  const sent = state.status === "success" && state.code === "check_email" && showCheckEmail;

  return (
    <AuthShell
      lang="vi"
      icon={<UserPlus className="h-5 w-5" />}
      title={sent ? "Xác minh email của bạn" : "Tạo tài khoản"}
      description={
        sent
          ? "Chỉ còn một bước nữa để bắt đầu sử dụng"
          : "Dùng bất kỳ địa chỉ email nào — không bắt buộc Gmail"
      }
      footer={
        <>
          Đã có tài khoản?{" "}
          <Link href="/login" className="font-medium text-primary hover:underline">
            Đăng nhập
          </Link>
        </>
      }
    >
      {sent ? (
        <CheckEmailPanel
          email={state.email ?? normalizeEmail(email)}
          purpose="signup"
          message={state.message ?? ""}
          onChangeEmail={() => setShowCheckEmail(false)}
        />
      ) : (
        <div className="space-y-5">
          {formError && <FormAlert tone="error">{formError}</FormAlert>}

          <form
            onSubmit={(event) => {
              setShowCheckEmail(true);
              onSubmit(event);
            }}
            className="space-y-4"
            noValidate
          >
            <Field
              id="email"
              label="Email"
              error={errors.email}
              hint={
                state.code === "user_already_exists" ? undefined : "Chúng tôi sẽ gửi liên kết xác minh tới email này."
              }
            >
              <TextInput
                {...fieldAria("email", errors.email, true)}
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
            {errors.email && state.code === "user_already_exists" && (
              <p className="-mt-2 text-[13px]">
                <Link href="/login" className="font-medium text-primary hover:underline">
                  Đăng nhập
                </Link>{" "}
                ·{" "}
                <Link href="/forgot-password" className="font-medium text-primary hover:underline">
                  Quên mật khẩu
                </Link>
              </p>
            )}

            <Field
              id="password"
              label="Mật khẩu"
              error={errors.password}
              hint={<PasswordChecklist password={password} email={email} />}
            >
              <PasswordInput
                {...fieldAria("password", errors.password, true)}
                name="password"
                autoComplete="new-password"
                placeholder="Tạo mật khẩu mạnh"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  touch("password");
                }}
                required
              />
            </Field>

            <Field id="confirm-password" label="Xác nhận mật khẩu" error={errors.confirmPassword}>
              <PasswordInput
                {...fieldAria("confirm-password", errors.confirmPassword)}
                name="confirmPassword"
                autoComplete="new-password"
                placeholder="Nhập lại mật khẩu"
                onChange={() => touch("confirmPassword")}
                required
              />
            </Field>

            <SubmitButton pending={pending} pendingLabel="Đang tạo tài khoản...">
              Tạo tài khoản
            </SubmitButton>
          </form>

          <Divider />
          <GoogleButton label="Đăng ký với Google" />
          <p className="text-center text-xs leading-relaxed text-muted-foreground">
            Với Google, bạn không cần tạo mật khẩu. Chúng tôi chỉ nhận email và tên hiển thị của bạn.
          </p>
        </div>
      )}
    </AuthShell>
  );
}
