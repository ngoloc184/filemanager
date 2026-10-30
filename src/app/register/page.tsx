"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Eye, EyeOff, Loader2, MailCheck, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { AuthShell } from "@/components/auth/auth-shell";
import { CheckInbox } from "@/components/auth/check-inbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PASSWORD_MIN, authErrorMessage, confirmRedirect, nextFromSearch, passwordProblem, withNext } from "@/lib/auth-links";

function RegisterForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // "/register?verify=<email>": an account that still has to click its link (from sign-in)
  const verifyEmail = searchParams.get("verify");
  // where to continue once the account is confirmed (e.g. an invitation link)
  const next = nextFromSearch(searchParams);

  const [step, setStep] = useState<"details" | "inbox">(verifyEmail ? "inbox" : "details");
  const [email, setEmail] = useState(verifyEmail ?? "");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  /** from sign-in nothing was sent in this visit yet; with ?sent=1 it was */
  const [sent, setSent] = useState(!verifyEmail || searchParams.get("sent") === "1");

  const resend = async () => {
    const { error } = await createClient().auth.resend({
      type: "signup",
      email: email.trim(),
      options: { emailRedirectTo: confirmRedirect(window.location.origin, "signup", next) },
    });
    if (error) throw error;
    setSent(true);
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
      options: { emailRedirectTo: confirmRedirect(window.location.origin, "signup", next) },
    });
    setLoading(false);
    if (error) {
      toast.error(authErrorMessage(error));
      return;
    }
    if (data.session) {
      // e-mail confirmation is turned off on the server: signed in already
      toast.success("Account created successfully!");
      router.push(next ?? "/dashboard");
      router.refresh();
      return;
    }
    // An existing, confirmed address comes back without identities and gets
    // no e-mail; the same screen is shown on purpose so this page does not
    // reveal which addresses have accounts (the screen points to "Sign in").
    setPassword("");
    setConfirmPassword("");
    setSent(true);
    setStep("inbox");
  };

  if (step === "inbox") {
    return (
      <AuthShell
        icon={<MailCheck className="h-5 w-5" />}
        title="Confirm your e-mail"
        description="One last step to activate your account"
        footer={
          <>
            Already confirmed?{" "}
            <Link href={withNext("/login", next)} className="font-medium text-primary hover:underline">
              Sign in
            </Link>
            {" · "}
            <button
              type="button"
              onClick={() => {
                setStep("details");
                router.replace(withNext("/register", next));
              }}
              className="font-medium text-primary hover:underline"
            >
              Use a different e-mail
            </button>
          </>
        }
      >
        <CheckInbox email={email} action="confirm your account" send={resend} sent={sent} />
      </AuthShell>
    );
  }

  return (
    <AuthShell
      icon={<UserPlus className="h-5 w-5" />}
      title="Create your account"
      description="We'll e-mail you a link to confirm your address"
      footer={
        <>
          Already have an account?{" "}
          <Link href={withNext("/login", next)} className="font-medium text-primary hover:underline">
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
