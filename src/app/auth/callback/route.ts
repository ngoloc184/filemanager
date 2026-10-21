import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { FLOW_NEXT, failedOutcome, failurePath, flowOf, requestOrigin, safeNext } from "@/lib/auth-links";

/**
 * GET /auth/callback?code=… — Supabase's default e-mail link verified the
 * address and redirected with a PKCE code. The code can only be exchanged in
 * the browser that asked for the e-mail (its code verifier cookie), so a link
 * from someone else cannot sign a visitor in. Opened elsewhere, a sign-up is
 * still confirmed ("please sign in"); a reset has to be requested again.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const origin = requestOrigin(request.headers, request.nextUrl.origin);
  const flow = flowOf(searchParams.get("flow"), null);
  const code = searchParams.get("code");
  // which e-mail request this is (several can be in flight after "Resend")
  const flowId = searchParams.get("sb_flow_id");
  const go = (path: string) => NextResponse.redirect(new URL(path, origin));

  if (!code) return go(failurePath(flow, "invalid"));
  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code, flowId ? { flowId } : undefined);
  if (error) {
    const expired = /expired/.test(error.code ?? "") ? (error.code ?? null) : null;
    return go(failurePath(flow, failedOutcome({ flow, hadCode: !expired, errorCode: expired })));
  }
  return go(safeNext(searchParams.get("next"), FLOW_NEXT[flow ?? "signup"]));
}
