import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { safeNext } from "@/lib/auth-otp";

const TYPES = new Set<EmailOtpType>(["signup", "email", "recovery", "invite", "magiclink", "email_change"]);

/**
 * GET /auth/confirm — where links in Supabase e-mails land (the app itself
 * uses codes, but a template may still contain a link):
 *   ?token_hash=…&type=email|signup|recovery…  (template: {{ .TokenHash }})
 *   ?code=…                                    (PKCE link, same browser)
 * On success the session cookie is set and the user goes to `next`
 * (same-site paths only); otherwise to /login with an explanation.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const code = searchParams.get("code");
  const next = safeNext(searchParams.get("next"), type === "recovery" ? "/forgot-password?step=password" : "/dashboard");

  const supabase = await createClient();
  let failed = true;
  if (tokenHash && type && TYPES.has(type)) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    failed = Boolean(error);
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    failed = Boolean(error);
  }

  if (failed) {
    const url = new URL("/login", origin);
    url.searchParams.set("error", "link");
    return NextResponse.redirect(url);
  }
  return NextResponse.redirect(new URL(next, origin));
}
