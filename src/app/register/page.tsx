"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Eye, EyeOff, Loader2, MailCheck, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { AuthShell } from "@/components/auth/auth-shell";
import { OtpInput, ResendCode } from "@/components/auth/otp-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PASSWORD_MIN, authErrorMessage, isOtpComplete, passwordProblem } from "@/lib/auth-otp";

/** Where a confirmation link (if the e-mail template still has one) lands. */
const confirmUrl = () => `${window.location.origin}/auth/confirm?next=/dashboard`;

function RegisterForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // "/register?verify=<email>": an account that still needs its code (from sign-in)
  const verifyEmail = searchParams.get("verify");

  const [step, setStep] = useState<"details" | "code">(verifyEmail ? "code" : "details");
  const [email, setEmail] = useState(verifyEmail ?? "");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  /** coming from sign-in, no code was sent yet in this visit */
  const [codeSent, setCodeSent] = useState(!verifyEmail);

  const resend = async () => {
    const { error } = await createClient().auth.resend({
      type: "signup",
      email: email.trim(),
      options: { emailRedirectTo: confirmUrl() },
    });
    if (error) throw error;
    setCodeSent(true);
  };

  const handleRegister = async (event: React.FormEvent) => {
    event.preventDefault();
    const problem = passwordProblem(password, confirmPassword);
    if (problem) {
      toast.error(problem);
      return;
    }
    setLoading(true);
    const { data, error } = await createClient().auth.signUp({
      email: email.trim(),
      password,
      options: { emailRedirectTo: confirmUrl() },
    });
    setLoading(false);
    if (error) {
      toast.error(authErrorMessage(error));
      return;
    }
    if (data.session) {
      // e-mail confirmation is turned off on the server: signed in already
      toast.success("Account created successfully!");
      router.push("/dashboard");
      router.refresh();
      return;
    }
    // Supabase hides whether an address exists: an existing, confirmed
    // account comes back without identities and no e-mail is sent
    if (data.user && data.user.identities?.length === 0) {
      toast.error("This e-mail is already registered. Sign in, or reset your password.");
      return;
    }
    setPassword("");
    setConfirmPassword("");
    setCode("");
    setCodeSent(true);
    setStep("code");
    toast.success("We sent a verification code to your e-mail.");
  };

  const handleVerify = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!isOtpComplete(code) || loading) return;
    setLoading(true);
    const { data, error } = await createClient().auth.verifyOtp({ email: email.trim(), token: code, type: "email" });
    if (error || !data.session) {
      setLoading(false);
      toast.error(authErrorMessage(error));
      return;
    }
    toast.success("E-mail confirmed. Welcome!");
    router.push("/dashboard");
    router.refresh();
  };

  if (step === "code") {
    return (
      <AuthShell
        icon={<MailCheck className="h-5 w-5" />}
        title="Check your e-mail"
        description={codeSent ? `We sent a code to ${email}` : `Confirm ${email} with a code`}
        footer={
          <>
            Wrong address?{" "}
            <button
              type="button"
              onClick={() => {
                setStep("details");
                setCode("");
                router.replace("/register");
              }}
              className="font-medium text-primary hover:underline"
            >
              Use a different e-mail
            </button>
          </>
        }
      >
        <form onSubmit={handleVerify} className="space-y-4">
          <OtpInput value={code} onChange={setCode} disabled={loading} />
          <Button type="submit" variant="brand" className="h-10 w-full" disabled={loading || !isOtpComplete(code)}>
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {loading ? "Verifying..." : "Verify and continue"}
          </Button>
          <div className="flex justify-center">
            {/* from sign-in no code was sent yet: allow sending one right away */}
            <ResendCode send={resend} startCoolingDown={codeSent} />
          </div>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      icon={<UserPlus className="h-5 w-5" />}
      title="Create your account"
      description="We'll e-mail you a code to confirm your address"
      footer={
        <>
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-primary hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={handleRegister} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            autoComplete="email"
            className="h-10"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <div className="relative">
            <Input
              id="password"
              type={showPassword ? "text" : "password"}
              placeholder={`At least ${PASSWORD_MIN} characters`}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={PASSWORD_MIN}
              autoComplete="new-password"
              className="h-10 pr-10"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm-password">Confirm password</Label>
          <Input
            id="confirm-password"
            type={showPassword ? "text" : "password"}
            placeholder="Re-enter your password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            required
            minLength={PASSWORD_MIN}
            autoComplete="new-password"
            className="h-10"
          />
        </div>
        <Button type="submit" variant="brand" className="h-10 w-full" disabled={loading}>
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          {loading ? "Creating account..." : "Create account"}
        </Button>
      </form>
    </AuthShell>
  );
}

export default function RegisterPage() {
  return (
    <Suspense>
      <RegisterForm />
    </Suspense>
  );
}
