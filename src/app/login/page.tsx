"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Eye, EyeOff, Loader2, LogIn } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthNotice } from "@/components/auth/check-inbox";
import { OUTCOME_MESSAGE, authErrorMessage, nextFromSearch, outcomeMessage, withNext, type ConfirmOutcome } from "@/lib/auth-links";

function LoginForm() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const router = useRouter();
  // the page a signed-out visitor asked for (set by the middleware), e.g. an invitation
  const next = nextFromSearch(searchParams);

  // /auth/confirm sends people here after a link that did not sign them in
  const notice = searchParams.get("notice") as ConfirmOutcome | null;
  const linkError = searchParams.get("error") as ConfirmOutcome | null;
  const linkMessage =
    notice === "confirmed"
      ? { tone: "success" as const, text: OUTCOME_MESSAGE.confirmed }
      : linkError && linkError in OUTCOME_MESSAGE
        ? { tone: "error" as const, text: outcomeMessage(linkError, "signup") }
        : null;

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    const { error } = await createClient().auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setLoading(false);
      if (/not confirmed/i.test(error.message) || error.code === "email_not_confirmed") {
        // the account still has to click its confirmation link
        toast.error("Confirm your e-mail first: click the link in the e-mail we sent you.");
        router.push(withNext(`/register?verify=${encodeURIComponent(email.trim())}`, next));
        return;
      }
      toast.error(authErrorMessage(error));
      return;
    }

    toast.success("Welcome back!");
    router.push(next ?? "/dashboard");
    router.refresh();
  };

  return (
    <AuthShell
      icon={<LogIn className="h-5 w-5" />}
      title="Welcome back"
      description="Sign in to manage your files"
      footer={
        <>
          Don&apos;t have an account?{" "}
          <Link href={withNext("/register", next)} className="font-medium text-primary hover:underline">
            Create one
          </Link>
        </>
      }
    >
      {linkMessage && <AuthNotice tone={linkMessage.tone}>{linkMessage.text}</AuthNotice>}
      <form onSubmit={handleLogin} className="space-y-4">
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
            className="h-10"
          />
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Password</Label>
            <Link
              href={withNext(email.trim() ? `/forgot-password?email=${encodeURIComponent(email.trim())}` : "/forgot-password", next)}
              className="text-xs font-medium text-primary hover:underline"
            >
              Forgot password?
            </Link>
          </div>
          <div className="relative">
            <Input
              id="password"
              type={showPassword ? "text" : "password"}
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
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
        <Button type="submit" variant="brand" className="h-10 w-full" disabled={loading}>
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          {loading ? "Signing in..." : "Sign in"}
        </Button>
      </form>
    </AuthShell>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
