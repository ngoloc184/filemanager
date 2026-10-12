import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
  REMEMBER_COOKIE,
  authCookieOptions,
  isPersistentSession,
  rememberCookieOptions,
  secureCookies,
} from "@/lib/auth/cookie-policy";
import { DEFAULT_AFTER_LOGIN, safeNextPath } from "@/lib/auth/redirect";
import { clientIpFromHeaders } from "@/lib/auth/request-context";

// Routes that are reachable without being signed in.
const PUBLIC_PATHS = ["/"]; // landing page (exact match)
const PUBLIC_PREFIXES = [
  "/login",
  "/register",
  "/forgot-password",
  "/magic-link",
  "/auth/",
  "/api/auth",
  "/setup",
];
/** Short-lived marker: the previous session was rejected (expired / revoked). */
const SESSION_ENDED_COOKIE = "fm-session-ended";
// Sign-in pages: a signed-in visitor is sent straight to the app instead.
const GUEST_ONLY_PATHS = ["/login", "/register", "/forgot-password", "/magic-link"];

function matchesPath(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}

function isNavigation(request: NextRequest): boolean {
  return request.method === "GET" || request.method === "HEAD";
}

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  });
  let cacheHeaders: Record<string, string> = {};
  const clientIp = clientIpFromHeaders(request.headers);

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: clientIp ? { headers: { "Sb-Forwarded-For": clientIp } } : undefined,
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          const policy = {
            persistent: isPersistentSession(request.cookies.get(REMEMBER_COOKIE)?.value),
            secure: secureCookies(),
          };
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, authCookieOptions(options, policy))
          );
          // Responses that refresh the session must never be cached.
          cacheHeaders = headers ?? {};
          Object.entries(cacheHeaders).forEach(([key, value]) =>
            supabaseResponse.headers.set(key, value)
          );
        },
      },
    }
  );

  // Read before getUser(), which clears the cookies of an invalid session.
  const hadSession = request.cookies
    .getAll()
    .some(
      ({ name, value }) =>
        value !== "" &&
        name.startsWith("sb-") &&
        name.includes("-auth-token") &&
        !name.includes("code-verifier")
    );

  // Validates the session with Supabase Auth and refreshes it when the
  // access token has expired (rotating the refresh token).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname, searchParams } = request.nextUrl;
  const isPublic =
    PUBLIC_PATHS.includes(pathname) ||
    PUBLIC_PREFIXES.some((prefix) =>
      prefix.endsWith("/") ? pathname.startsWith(prefix) : matchesPath(pathname, prefix)
    );

  // An invalid session is cleared by the first request that notices it
  // (often a background prefetch), so remember briefly that it expired to
  // explain the redirect to the sign-in page.
  const sessionEnded = !user && (hadSession || request.cookies.has(SESSION_ENDED_COOKIE));
  const finish = <T extends NextResponse>(response: T): T => {
    if (!user && hadSession) {
      response.cookies.set(SESSION_ENDED_COOKIE, "1", {
        ...rememberCookieOptions(secureCookies()),
        maxAge: 300,
      });
    } else if (user && request.cookies.has(SESSION_ENDED_COOKIE)) {
      response.cookies.delete(SESSION_ENDED_COOKIE);
    }
    return response;
  };

  const redirectTo = (url: URL) => {
    const response = NextResponse.redirect(url);
    // Keep any refreshed / cleared session cookies on the redirect.
    supabaseResponse.cookies.getAll().forEach((cookie) => response.cookies.set(cookie));
    Object.entries(cacheHeaders).forEach(([key, value]) => response.headers.set(key, value));
    return finish(response);
  };

  if (user && isNavigation(request) && GUEST_ONLY_PATHS.some((path) => matchesPath(pathname, path))) {
    return redirectTo(
      new URL(safeNextPath(searchParams.get("next"), DEFAULT_AFTER_LOGIN), request.url)
    );
  }

  // Page navigations are redirected; Server Action POSTs verify the session
  // themselves and report "not signed in" to the form instead.
  if (!user && !isPublic && isNavigation(request)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
    if (sessionEnded) url.searchParams.set("reason", "expired");
    return redirectTo(url);
  }

  return finish(supabaseResponse);
}
