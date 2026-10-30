import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { FLOW_NEXT, failedOutcome, failurePath, flowOf, isSameOriginPost, requestOrigin, safeNext } from "@/lib/auth-links";

const TYPES = new Set<EmailOtpType>(["signup", "email", "recovery", "invite", "magiclink", "email_change"]);

/**
 * POST /auth/verify — the button on /auth/confirm. Only same-origin form
 * posts are accepted, so another site cannot sign a visitor into an account
 * by sending them to a link (login CSRF). On success the session cookie is
 * set and the user continues to `next` (same-site paths only).
 */
export async function POST(request: NextRequest) {
  const origin = requestOrigin(request.headers, request.nextUrl.origin);
  const form = await request.formData().catch(() => null);
  const field = (key: string) => {
    const value = form?.get(key);
    return typeof value === "string" ? value : null;
  };
  const type = field("type");
  const flow = flowOf(field("flow"), type);
  const go = (path: string) => NextResponse.redirect(new URL(path, origin), 303);

  if (!isSameOriginPost(request.headers, origin)) return go(failurePath(flow, "invalid"));

  const tokenHash = field("token_hash");
  if (!tokenHash || !type || !TYPES.has(type as EmailOtpType)) return go(failurePath(flow, "invalid", field("next")));

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: type as EmailOtpType });
  if (error) {
    // keep Supabase's reason ("otp_expired" also covers a link that was already used)
    return go(failurePath(flow, failedOutcome({ flow, hadCode: false, errorCode: error.code ?? "invalid" }), field("next")));
  }
  return go(safeNext(field("next"), FLOW_NEXT[flow ?? "signup"]));
}
