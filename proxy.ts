import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function proxy(request: NextRequest) {
  // Public share pages and their download endpoint must work without a session.
  if (
    request.nextUrl.pathname.startsWith("/share/") ||
    request.nextUrl.pathname.startsWith("/api/public-share/")
  ) {
    return;
  }

  return await updateSession(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
