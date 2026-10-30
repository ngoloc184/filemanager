import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Routes that are reachable without being signed in.
const PUBLIC_PATHS = ["/"]; // landing page (exact match)
const PUBLIC_PREFIXES = ["/login", "/register", "/forgot-password", "/auth/", "/api/auth", "/setup"];

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isPublic =
    PUBLIC_PATHS.includes(pathname) ||
    PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
  if (!user && !isPublic) {
    // API callers expect JSON, not the login page
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    // pages come back after sign-in (e.g. an invitation link); API calls do not
    if (request.method === "GET" && !pathname.startsWith("/api/")) {
      const search = new URLSearchParams(request.nextUrl.search);
      search.delete("_rsc"); // Next's internal cache-busting parameter
      const query = search.toString();
      url.searchParams.set("next", query ? `${pathname}?${query}` : pathname);
    }
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
