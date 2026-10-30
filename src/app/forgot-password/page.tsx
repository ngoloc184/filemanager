"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { AuthShell } from "@/components/auth/auth-shell";
import { AuthNotice, CheckInbox } from "@/components/auth/check-inbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  OUTCOME_MESSAGE,
  PASSWORD_MIN,
  outcomeMessage,
  authErrorMessage,
  confirmRedirect,
  nextFromSearch,
  passwordProblem,
  withNext,
  type ConfirmOutcome,
} from "@/lib/auth-links";

type Step = "email" | "inbox" | "password";

function ForgotPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = nextFromSearch(searchParams);
  // "?step=password": the reset link signed the user in (/auth/confirm)
  const [step, setStep] = useState<Step>(searchParams.get("step") === "password" ? "password" : "email");
  const [email, setEmail] = useState(searchParams.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);

  // /auth/confirm sends people back here when a reset link did not work
  const outcome = searchParams.get("error") as ConfirmOutcome | null;
  const [linkError, setLinkError] = useState<string | null>(
    outcome && outcome in OUTCOME_MESSAGE ? outcomeMessage(outcome, "recovery") : null
  );

  // the password step needs the session the reset link created
  useEffect(() => {
    if (step !== "password") return;
    let cancelled = false;
    const check = async () => {
      const { data } = await createClient().auth.getUser();
      if (cancelled || data.user) return;
      setStep("email");
      setLinkError(OUTCOME_MESSAGE.expired);
    };
    void check();
    return () => {
      cancelled = true;
    };
  }, [step]);

  const sendLink = async () => {
    const { error } = await createClient().auth.resetPasswordForEmail(email.trim(), {
      redirectTo: confirmRedirect(window.location.origin, "recovery"),
    });
    if (error) throw error;
  };

  const handleEmail = async (event: React.FormEvent) => {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    try {
      await sendLink();
      // never reveals whether the address has an account
      setLinkError(null);
      setStep("inbox");
    } catch (err) {
      toast.error(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
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
      toast.error(authErrorMessage(error));
      return;
    }
    toast.success("Your password was changed.");
    router.push("/dashboard");
    router.refresh();
  };

  const footer = (
    <>
      Remembered it?{" "}
      <Link href={withNext("/login", next)} className="font-medium text-primary hover:underline">
        Back to sign in
      </Link>
    </>
  );

  if (step === "password") {
    return (
      <AuthShell icon={<KeyRound className="h-5 w-5" />} title="Choose a new password" description="Enter the password you want to use from now on" footer={footer}>
        <form onSubmit={handlePassword} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="new-password">New password</Label>
            <div className="relative">
              <Input
                id="new-password"
                type={show ? "text" : "password"}
                placeholder={`At least ${PASSWORD_MIN} characters`}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={PASSWORD_MIN}
                autoComplete="new-password"
                autoFocus
                disabled={loading}
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
              onChange={(e) => setConfirm(e.target.value)}
              required
              minLength={PASSWORD_MIN}
              autoComplete="new-password"
              disabled={loading}
              className="h-10"
            />
          </div>
          <Button type="submit" variant="brand" className="h-10 w-full" disabled={loading}>
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {loading ? "Saving..." : "Change password"}
          </Button>
        </form>
      </AuthShell>
    );
  }

  if (step === "inbox") {
    return (
      <AuthShell
        icon={<KeyRound className="h-5 w-5" />}
        title="Check your e-mail"
        description="If an account exists for this address, a reset link is on its way"
        footer={
          <>
            Wrong address?{" "}
            <button type="button" onClick={() => setStep("email")} className="font-medium text-primary hover:underline">
              Use a different e-mail
            </button>
            {" · "}
            <Link href={withNext("/login", next)} className="font-medium text-primary hover:underline">
              Back to sign in
            </Link>
          </>
        }
      >
        <CheckInbox email={email} action="choose a new password" send={sendLink} />
      </AuthShell>
    );
  }

  return (
    <AuthShell icon={<KeyRound className="h-5 w-5" />} title="Forgot your password?" description="We'll e-mail you a link to set a new one" footer={footer}>
      {linkError && <AuthNotice tone="error">{linkError}</AuthNotice>}
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
          {loading ? "Sending..." : "Send reset link"}
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
