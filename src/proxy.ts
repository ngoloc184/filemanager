import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// Public share pages, public downloads and the API-key protected SuperApp API
// must work without a session, so they skip the Supabase session refresh.
const SESSIONLESS_PREFIXES = [
  "/share/",
  "/api/public-share/",
  "/superapp/",
  "/api/superapp/",
  // uptime probes and Vercel Cron (authorised by CRON_SECRET, not a session)
  "/api/health",
  "/api/cron/",
];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (SESSIONLESS_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return;
  }

  return await updateSession(request);
}

export const config = {
  matcher: [
    // sw.js and the manifest are fetched by the browser without a session check
    "/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
