"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Eye, EyeOff, KeyRound, Loader2, MailCheck } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { AuthShell } from "@/components/auth/auth-shell";
import { OtpInput, ResendCode } from "@/components/auth/otp-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PASSWORD_MIN, authErrorMessage, isOtpComplete, passwordProblem } from "@/lib/auth-otp";

type Step = "email" | "code" | "password";

function NewPasswordFields({
  password,
  confirm,
  onPassword,
  onConfirm,
  disabled,
}: {
  password: string;
  confirm: string;
  onPassword: (v: string) => void;
  onConfirm: (v: string) => void;
  disabled: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="new-password">New password</Label>
        <div className="relative">
          <Input
            id="new-password"
            type={show ? "text" : "password"}
            placeholder={`At least ${PASSWORD_MIN} characters`}
            value={password}
            onChange={(e) => onPassword(e.target.value)}
            required
            minLength={PASSWORD_MIN}
            autoComplete="new-password"
            disabled={disabled}
            className="h-10 pr-10"
          />
          <button
            type="button"
            onClick={() => setShow(!show)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            aria-label={show ? "Hide password" : "Show password"}
          >
            {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirm-new-password">Confirm new password</Label>
        <Input
          id="confirm-new-password"
          type={show ? "text" : "password"}
          placeholder="Re-enter the new password"
          value={confirm}
          onChange={(e) => onConfirm(e.target.value)}
          required
          minLength={PASSWORD_MIN}
          autoComplete="new-password"
          disabled={disabled}
          className="h-10"
        />
      </div>
    </>
  );
}

function ForgotPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // "?step=password": arrived through a reset link, already signed in by /auth/confirm
  const [step, setStep] = useState<Step>(searchParams.get("step") === "password" ? "password" : "email");
  const [email, setEmail] = useState(searchParams.get("email") ?? "");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);

  const sendCode = async () => {
    const { error } = await createClient().auth.resetPasswordForEmail(email.trim(), {
      // used only if the e-mail template still contains a link
      redirectTo: `${window.location.origin}/auth/confirm?next=${encodeURIComponent("/forgot-password?step=password")}`,
    });
    if (error) throw error;
  };

  const finish = async () => {
    toast.success("Your password was changed.");
    router.push("/dashboard");
    router.refresh();
  };

  const handleEmail = async (event: React.FormEvent) => {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    try {
      await sendCode();
      setStep("code");
      // never reveals whether the address has an account
      toast.success("If an account exists for this e-mail, we sent it a code.");
    } catch (err) {
      toast.error(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleCode = async (event: React.FormEvent) => {
    event.preventDefault();
    const problem = passwordProblem(password, confirm);
    if (problem) {
      toast.error(problem);
      return;
    }
    if (!isOtpComplete(code) || loading) return;
    setLoading(true);
    const supabase = createClient();
    const { error: verifyError } = await supabase.auth.verifyOtp({ email: email.trim(), token: code, type: "recovery" });
    if (verifyError) {
      setLoading(false);
      toast.error(authErrorMessage(verifyError));
      return;
    }
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      // the code is used up but the session exists: just set a password now
      setLoading(false);
      setStep("password");
      toast.error(authErrorMessage(error));
      return;
    }
    await finish();
  };

  const handlePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    const problem = passwordProblem(password, confirm);
    if (problem) {
      toast.error(problem);
      return;
    }
    setLoading(true);
    const { error } = await createClient().auth.updateUser({ password });
    if (error) {
      setLoading(false);
      toast.error(
        /session|not authenticated|jwt/i.test(error.message)
          ? "Your reset session has expired. Request a new code."
          : authErrorMessage(error)
      );
      return;
    }
    await finish();
  };

  const footer = (
    <>
      Remembered it?{" "}
      <Link href="/login" className="font-medium text-primary hover:underline">
        Back to sign in
      </Link>
    </>
  );

  if (step === "password") {
    return (
      <AuthShell icon={<KeyRound className="h-5 w-5" />} title="Choose a new password" description="Enter the password you want to use from now on" footer={footer}>
        <form onSubmit={handlePassword} className="space-y-4">
          <NewPasswordFields password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} disabled={loading} />
          <Button type="submit" variant="brand" className="h-10 w-full" disabled={loading}>
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {loading ? "Saving..." : "Change password"}
          </Button>
        </form>
      </AuthShell>
    );
  }

  if (step === "code") {
    return (
      <AuthShell
        icon={<MailCheck className="h-5 w-5" />}
        title="Enter the code"
        description={`We sent a code to ${email}`}
        footer={
          <>
            Wrong address?{" "}
            <button type="button" onClick={() => setStep("email")} className="font-medium text-primary hover:underline">
              Use a different e-mail
            </button>
          </>
        }
      >
        <form onSubmit={handleCode} className="space-y-4">
          <OtpInput value={code} onChange={setCode} disabled={loading} />
          <NewPasswordFields password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} disabled={loading} />
          <Button type="submit" variant="brand" className="h-10 w-full" disabled={loading || !isOtpComplete(code)}>
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {loading ? "Saving..." : "Reset password"}
          </Button>
          <div className="flex justify-center">
            <ResendCode send={sendCode} />
          </div>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell icon={<KeyRound className="h-5 w-5" />} title="Forgot your password?" description="We'll e-mail you a code to set a new one" footer={footer}>
      <form onSubmit={handleEmail} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            autoFocus
            className="h-10"
          />
        </div>
        <Button type="submit" variant="brand" className="h-10 w-full" disabled={loading || !email.trim()}>
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          {loading ? "Sending..." : "Send code"}
        </Button>
      </form>
    </AuthShell>
  );
}

export default function ForgotPasswordPage() {
  return (
    <Suspense>
      <ForgotPasswordForm />
    </Suspense>
  );
}
