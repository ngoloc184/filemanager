"use client";

import { startTransition, useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { vi } from "date-fns/locale";
import { BadgeCheck, KeyRound, Loader2, LogOut, Mail, MonitorSmartphone, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import {
  changeEmailAction,
  changePasswordAction,
  signOutEverywhereAction,
  unlinkGoogleAction,
} from "@/lib/auth/account-actions";
import { signOutAction } from "@/lib/auth/actions";
import { INITIAL_AUTH_STATE, type AuthFormState } from "@/lib/auth/form-state";
import type { Notice } from "@/lib/auth/notices";
import {
  isValidEmail,
  normalizeEmail,
  passwordProblemMessage,
  passwordProblems,
} from "@/lib/auth/validation";
import { resetBrowserSession } from "@/lib/supabase/client";
import { Field, FormAlert, PasswordInput, SubmitButton, TextInput, fieldAria } from "@/components/auth/form-parts";
import { GoogleButton, GoogleMark } from "@/components/auth/google-button";
import { PasswordChecklist } from "@/components/auth/password-checklist";
import { useAuthForm, type FieldErrors } from "@/components/auth/use-auth-form";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type AccountIdentity = {
  id: string;
  provider: string;
  email?: string;
  lastSignInAt?: string;
};

function formatDate(value?: string) {
  if (!value) return "—";
  return format(new Date(value), "HH:mm, dd/MM/yyyy", { locale: vi });
}

function Section({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Card className="rounded-2xl bg-card/70 backdrop-blur">
      <CardHeader className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          {icon}
        </span>
        <div className="min-w-0 space-y-1">
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function SignInMethods({
  identities,
  hasPassword,
}: {
  identities: AccountIdentity[];
  hasPassword: boolean;
}) {
  const router = useRouter();
  const [state, unlinkAction, unlinking] = useActionState(unlinkGoogleAction, INITIAL_AUTH_STATE);
  const google = identities.find((identity) => identity.provider === "google");
  const canUnlink = Boolean(google) && identities.length > 1;

  useEffect(() => {
    if (state.status === "success") {
      toast.success(state.message ?? "Đã cập nhật");
      router.refresh();
    }
  }, [state, router]);

  return (
    <div className="space-y-3">
      {state.status === "error" && state.message && <FormAlert tone="error">{state.message}</FormAlert>}

      <div className="flex flex-col gap-3 rounded-xl border bg-background/50 p-4 sm:flex-row sm:items-center">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
          <KeyRound className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Email và mật khẩu</p>
          <p className="text-[13px] text-muted-foreground">
            {hasPassword ? "Đã thiết lập mật khẩu." : "Chưa có mật khẩu — tạo mật khẩu ở mục bên dưới."}
          </p>
        </div>
        <Badge variant={hasPassword ? "secondary" : "outline"}>{hasPassword ? "Đang dùng" : "Chưa bật"}</Badge>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border bg-background/50 p-4 sm:flex-row sm:items-center">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
          <GoogleMark className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Google</p>
          <p className="break-words text-[13px] text-muted-foreground">
            {google
              ? `Đã liên kết${google.email ? ` với ${google.email}` : ""}.`
              : "Liên kết để đăng nhập nhanh bằng tài khoản Google."}
          </p>
        </div>
        {google ? (
          <button
            type="button"
            disabled={!canUnlink || unlinking}
            title={canUnlink ? undefined : "Cần ít nhất một phương thức đăng nhập khác"}
            onClick={() => startTransition(() => unlinkAction())}
            className={cn(buttonVariants({ variant: "outline" }), "h-9 rounded-lg")}
          >
            {unlinking && <Loader2 className="h-4 w-4 animate-spin" />}
            Hủy liên kết
          </button>
        ) : (
          <GoogleButton intent="link" label="Liên kết Google" className="sm:w-56" />
        )}
      </div>
      {google && !canUnlink && (
        <p className="text-[13px] text-muted-foreground">
          Google đang là phương thức đăng nhập duy nhất của tài khoản nên không thể hủy liên kết.
        </p>
      )}
    </div>
  );
}

function PasswordForm({ email, hasPassword }: { email: string; hasPassword: boolean }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [password, setPassword] = useState("");
  const validate = (formData: FormData): FieldErrors => {
    const errors: FieldErrors = {};
    const value = String(formData.get("password") ?? "");
    if (hasPassword && !formData.get("currentPassword")) {
      errors.currentPassword = "Vui lòng nhập mật khẩu hiện tại.";
    }
    const problem = passwordProblemMessage(passwordProblems(value, email));
    if (problem) errors.password = problem;
    if (value !== formData.get("confirmPassword")) errors.confirmPassword = "Mật khẩu nhập lại không khớp.";
    return errors;
  };
  const submitPassword = async (previous: AuthFormState, formData: FormData) => {
    const result = await changePasswordAction(previous, formData);
    if (result.status === "success") {
      toast.success(result.message ?? "Đã lưu mật khẩu");
      formRef.current?.reset();
      setPassword("");
      router.refresh();
    }
    return result;
  };
  const { state, pending, errors, formError, onSubmit, touch, showServer } = useAuthForm(
    submitPassword,
    validate
  );

  return (
    <form ref={formRef} onSubmit={onSubmit} className="space-y-4" noValidate>
      {formError && <FormAlert tone="error">{formError}</FormAlert>}
      {showServer && state.status === "success" && <FormAlert tone="success">{state.message}</FormAlert>}
      <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
      {hasPassword && (
        <Field id="current-password" label="Mật khẩu hiện tại" error={errors.currentPassword}>
          <PasswordInput
            {...fieldAria("current-password", errors.currentPassword)}
            name="currentPassword"
            autoComplete="current-password"
            onChange={() => touch("currentPassword")}
          />
        </Field>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="new-password" label="Mật khẩu mới" error={errors.password}>
          <PasswordInput
            {...fieldAria("new-password", errors.password)}
            name="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              touch("password");
            }}
          />
        </Field>
        <Field id="confirm-new-password" label="Xác nhận mật khẩu mới" error={errors.confirmPassword}>
          <PasswordInput
            {...fieldAria("confirm-new-password", errors.confirmPassword)}
            name="confirmPassword"
            autoComplete="new-password"
            onChange={() => touch("confirmPassword")}
          />
        </Field>
      </div>
      <PasswordChecklist password={password} email={email} />
      <SubmitButton pending={pending} pendingLabel="Đang lưu..." className="sm:w-auto sm:px-6">
        {hasPassword ? "Đổi mật khẩu" : "Tạo mật khẩu"}
      </SubmitButton>
    </form>
  );
}

function EmailForm({ email, pendingEmail }: { email: string; pendingEmail?: string }) {
  const validate = (formData: FormData): FieldErrors => {
    const value = normalizeEmail(formData.get("email"));
    if (!isValidEmail(value)) return { email: "Vui lòng nhập một địa chỉ email hợp lệ." };
    if (value === normalizeEmail(email)) return { email: "Đây đã là email hiện tại của bạn." };
    return {};
  };
  const { state, pending, errors, formError, onSubmit, touch, showServer } = useAuthForm(
    changeEmailAction,
    validate
  );

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      {formError && <FormAlert tone="error">{formError}</FormAlert>}
      {showServer && state.status === "success" && <FormAlert tone="success">{state.message}</FormAlert>}
      {pendingEmail && state.status !== "success" && (
        <FormAlert tone="info">
          Đang chờ xác nhận đổi sang <strong>{pendingEmail}</strong>. Hãy mở liên kết trong email để hoàn tất.
        </FormAlert>
      )}
      <Field id="new-email" label="Email mới" error={errors.email}>
        <TextInput
          {...fieldAria("new-email", errors.email)}
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="email-moi@vi-du.com"
          onChange={() => touch("email")}
        />
      </Field>
      <SubmitButton pending={pending} pendingLabel="Đang gửi..." variant="outline" className="sm:w-auto sm:px-6">
        Gửi email xác nhận
      </SubmitButton>
    </form>
  );
}

function Sessions() {
  const [busy, setBusy] = useState<"local" | "global" | null>(null);

  const signOut = async (scope: "local" | "global") => {
    setBusy(scope);
    resetBrowserSession();
    const result = scope === "global" ? await signOutEverywhereAction() : await signOutAction();
    if (result.status === "error" && result.message) toast.error(result.message);
    // Full page load: nothing from the signed-in session stays in memory.
    window.location.replace(
      `/login?message=${scope === "global" ? "signed_out_everywhere" : "signed_out"}`
    );
  };

  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => signOut("local")}
        className={cn(buttonVariants({ variant: "outline" }), "h-10 rounded-xl px-4")}
      >
        {busy === "local" ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
        Đăng xuất khỏi thiết bị này
      </button>
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => signOut("global")}
        className={cn(buttonVariants({ variant: "destructive" }), "h-10 rounded-xl px-4")}
      >
        {busy === "global" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldAlert className="h-4 w-4" />}
        Đăng xuất khỏi tất cả thiết bị
      </button>
    </div>
  );
}

export function AccountClient({
  email,
  pendingEmail,
  emailConfirmed,
  createdAt,
  lastSignInAt,
  identities,
  hasPassword,
  notice,
}: {
  email: string;
  pendingEmail?: string;
  emailConfirmed: boolean;
  createdAt: string;
  lastSignInAt?: string;
  identities: AccountIdentity[];
  hasPassword: boolean;
  notice: Notice | null;
}) {
  return (
    <div lang="vi" className="mx-auto max-w-3xl space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Tài khoản & bảo mật</h2>
        <p className="mt-1 text-muted-foreground">
          Quản lý cách bạn đăng nhập. Quyền truy cập file và thư mục không thay đổi khi bạn đổi phương thức đăng nhập.
        </p>
      </div>

      {notice && <FormAlert tone={notice.tone}>{notice.message}</FormAlert>}

      <Section icon={<Mail className="h-4 w-4" />} title="Hồ sơ">
        <dl className="grid gap-4 text-sm sm:grid-cols-3">
          <div className="min-w-0 sm:col-span-3">
            <dt className="text-muted-foreground">Email đăng nhập</dt>
            <dd className="mt-1 flex flex-wrap items-center gap-2 font-medium">
              <span className="truncate">{email}</span>
              {emailConfirmed ? (
                <Badge variant="secondary" className="gap-1 text-success">
                  <BadgeCheck /> Đã xác minh
                </Badge>
              ) : (
                <Badge variant="outline">Chưa xác minh</Badge>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Ngày tạo</dt>
            <dd className="mt-1">{formatDate(createdAt)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Đăng nhập gần nhất</dt>
            <dd className="mt-1">{formatDate(lastSignInAt)}</dd>
          </div>
        </dl>
      </Section>

      <Section
        icon={<BadgeCheck className="h-4 w-4" />}
        title="Phương thức đăng nhập"
        description="Liên kết Google yêu cầu bạn đang đăng nhập vào tài khoản này, nên chỉ chủ tài khoản mới thêm được."
      >
        <SignInMethods identities={identities} hasPassword={hasPassword} />
      </Section>

      <Section
        icon={<KeyRound className="h-4 w-4" />}
        title={hasPassword ? "Đổi mật khẩu" : "Tạo mật khẩu"}
        description={
          hasPassword
            ? "Sau khi đổi mật khẩu, các thiết bị khác sẽ bị đăng xuất."
            : "Tạo mật khẩu để đăng nhập bằng email ngoài Google."
        }
      >
        <PasswordForm email={email} hasPassword={hasPassword} />
      </Section>

      <Section
        icon={<Mail className="h-4 w-4" />}
        title="Đổi email đăng nhập"
        description="Email mới chỉ có hiệu lực sau khi bạn mở liên kết xác nhận được gửi tới."
      >
        <EmailForm email={email} pendingEmail={pendingEmail} />
      </Section>

      <Section
        icon={<MonitorSmartphone className="h-4 w-4" />}
        title="Phiên đăng nhập"
        description="Đăng xuất khỏi tất cả thiết bị nếu bạn nghi ngờ người khác đang dùng tài khoản của mình."
      >
        <Sessions />
      </Section>
    </div>
  );
}
