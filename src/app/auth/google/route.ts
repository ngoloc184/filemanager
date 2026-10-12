import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import {
  REMEMBER_COOKIE,
  rememberCookieOptions,
  secureCookies,
} from "@/lib/auth/cookie-policy";
import { authErrorCode, isKnownAuthErrorCode } from "@/lib/auth/errors";
import { safeNextPath } from "@/lib/auth/redirect";
import { getSiteOrigin, isSameOriginRequest } from "@/lib/auth/request-context";

// Starts Google OAuth 2.0 through Supabase Auth (PKCE). The browser is sent
// to Google's own consent screen; Supabase verifies Google's response on its
// server and redirects back to /auth/callback with a one-time code.
// Only the default identity scopes are requested: openid, email, profile.

const GOOGLE_QUERY = { prompt: "select_account" };

export async function POST(request: NextRequest) {
  const origin = await getSiteOrigin();
  if (!isSameOriginRequest(request)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const form = await request.formData();
  const intent = form.get("intent") === "link" ? "link" : "signin";
  const supabase = await createClient();

  const fail = (path: "/login" | "/account", error: unknown) => {
    const code = authErrorCode(error);
    const url = new URL(path, origin);
    url.searchParams.set("error", isKnownAuthErrorCode(code) ? code : "oauth_unavailable");
    return NextResponse.redirect(url, 303);
  };

  if (intent === "link") {
    // Adding Google to an account requires being signed in to that account
    // first (manual identity linking), so ownership of both is proven.
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return fail("/login", "session_expired");

    const { data, error } = await supabase.auth.linkIdentity({
      provider: "google",
      options: {
        redirectTo: `${origin}/auth/callback?next=${encodeURIComponent("/account?linked=google")}`,
        skipBrowserRedirect: true,
        queryParams: GOOGLE_QUERY,
      },
    });
    if (error || !data?.url) return fail("/account", error);
    return NextResponse.redirect(data.url, 303);
  }

  const next = safeNextPath(form.get("next"));
  const cookieStore = await cookies();
  if (form.get("remember") === "off") {
    cookieStore.set(REMEMBER_COOKIE, "0", rememberCookieOptions(secureCookies()));
  } else {
    cookieStore.delete(REMEMBER_COOKIE);
  }

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
      skipBrowserRedirect: true,
      queryParams: GOOGLE_QUERY,
    },
  });
  if (error || !data?.url) return fail("/login", error ?? "oauth_unavailable");
  return NextResponse.redirect(data.url, 303);
}
