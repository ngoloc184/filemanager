import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// Public share pages, public downloads and the API-key protected SuperApp API
// must work without a session, so they skip the Supabase session refresh.
const SESSIONLESS_PREFIXES = [
  "/share/",
  "/api/public-share/",
  "/superapp/",
  "/api/superapp/",
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
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
