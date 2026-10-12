import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "private, no-store, max-age=0" };

/**
 * Hands the browser a short-lived access token for direct Supabase data
 * calls. The proxy has already refreshed the session cookies for this
 * request; the refresh token itself stays in HttpOnly cookies.
 * Cross-origin pages cannot read this response (same-origin policy, no CORS).
 */
export async function GET() {
  const supabase = await createClient();
  const { data: claims, error } = await supabase.auth.getClaims();
  if (error || !claims) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401, headers: NO_STORE });
  }

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token || !session.expires_at) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401, headers: NO_STORE });
  }

  const expiresIn = Math.max(0, session.expires_at - Math.floor(Date.now() / 1000));
  return NextResponse.json(
    { accessToken: session.access_token, expiresIn },
    { headers: NO_STORE }
  );
}
