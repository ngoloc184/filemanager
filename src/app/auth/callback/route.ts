import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { authErrorCode, isKnownAuthErrorCode } from "@/lib/auth/errors";
import { safeNextPath } from "@/lib/auth/redirect";
import { getSiteOrigin } from "@/lib/auth/request-context";

// Landing point for Google sign-in / linking and for e-mail links sent with
// Supabase's default templates (PKCE). The one-time `code` is exchanged on
// the server for a session, which is stored in HttpOnly cookies.

function errorRedirect(origin: string, next: string, code: string) {
  // Linking flows start from the account page; report errors there.
  const url = new URL(next.startsWith("/account") ? "/account" : "/login", origin);
  url.searchParams.set("error", isKnownAuthErrorCode(code) ? code : "link_invalid");
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const origin = await getSiteOrigin();
  const { searchParams } = request.nextUrl;
  const next = safeNextPath(searchParams.get("next"));

  // Provider or Supabase reported an error (e.g. the user cancelled at Google).
  const providerError = searchParams.get("error_code") ?? searchParams.get("error");
  if (providerError) return errorRedirect(origin, next, providerError);

  const code = searchParams.get("code");
  if (!code) return errorRedirect(origin, next, "link_invalid");

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    const reason = authErrorCode(error);
    // A missing verifier means the link was opened in another browser; the
    // e-mail address is still confirmed, the user just has to sign in.
    return errorRedirect(
      origin,
      next,
      reason === "unknown" || reason === "validation_failed" ? "link_invalid" : reason
    );
  }

  return NextResponse.redirect(new URL(next, origin));
}
