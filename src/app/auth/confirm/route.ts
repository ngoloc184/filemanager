import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { authErrorCode, isKnownAuthErrorCode } from "@/lib/auth/errors";
import { safeNextPath } from "@/lib/auth/redirect";
import { getSiteOrigin } from "@/lib/auth/request-context";

// Landing point for e-mail links built from the recommended templates
// (docs/AUTH_SETUP.md): {{ .SiteURL }}/auth/confirm?token_hash=...&type=...
// Unlike the PKCE `code` flow, this works when the link is opened on another
// device or browser, because the hashed token itself is verified.

const OTP_TYPES: EmailOtpType[] = ["signup", "invite", "magiclink", "recovery", "email_change", "email"];

const DEFAULT_NEXT: Partial<Record<EmailOtpType, string>> = {
  recovery: "/reset-password",
  email_change: "/account?email=updated",
};

export async function GET(request: NextRequest) {
  const origin = await getSiteOrigin();
  const { searchParams } = request.nextUrl;
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  if (!tokenHash || !type || !OTP_TYPES.includes(type)) {
    return NextResponse.redirect(new URL("/login?error=link_invalid", origin));
  }
  const next = safeNextPath(searchParams.get("next"), DEFAULT_NEXT[type]);

  const supabase = await createClient();
  const { data, error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
  if (error) {
    const code = authErrorCode(error);
    const url = new URL("/login", origin);
    url.searchParams.set("error", isKnownAuthErrorCode(code) && code !== "validation_failed" ? code : "link_invalid");
    return NextResponse.redirect(url);
  }

  // With "Secure email change", the first of the two confirmations returns
  // no session yet: the change completes once the other address confirms.
  if (!data.session) {
    const target = type === "email_change" ? "/account?email=pending" : "/login?message=email_confirmed";
    return NextResponse.redirect(new URL(target, origin));
  }

  return NextResponse.redirect(new URL(next, origin));
}
